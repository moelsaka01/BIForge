//! Parser tests: grammar (precedence, references, calls, tables, VAR, queries) and every diagnostic code
//! listed in research/dax-parser.md section 3.

use biforge_dax::ast::*;
use biforge_dax::{diagnose, parse_expression, parse_formula, parse_query, Catalog, ErrorCode};

/// Compact S-expression rendering so tests read like the grammar.
fn sx(e: &Expr) -> String {
    match &e.kind {
        ExprKind::Int(v) => v.to_string(),
        ExprKind::Number(v) => format!("{v:?}"),
        ExprKind::Str(s) => format!("{s:?}"),
        ExprKind::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        ExprKind::DateTime(s) => format!("dt{s:?}"),
        ExprKind::ColumnRef { table, column } => format!("{table}[{column}]"),
        ExprKind::BracketRef(n) => format!("[{n}]"),
        ExprKind::Name(n) => n.clone(),
        ExprKind::TableRef(n) => format!("'{n}'"),
        ExprKind::Call { name, args, .. } => format!("{name}({})", args.iter().map(sx).collect::<Vec<_>>().join(", ")),
        ExprKind::Missing => "_".into(),
        ExprKind::Unary { op, expr } => format!("({} {})", match op { UnOp::Neg => "-", UnOp::Plus => "+", UnOp::Not => "NOT" }, sx(expr)),
        ExprKind::Binary { op, left, right } => format!("({} {} {})", sx(left), op.symbol(), sx(right)),
        ExprKind::In { left, right } => format!("({} IN {})", sx(left), sx(right)),
        ExprKind::Tuple(items) => format!("<{}>", items.iter().map(sx).collect::<Vec<_>>().join(", ")),
        ExprKind::TableConstructor(rows) => format!(
            "{{{}}}",
            rows.iter().map(|r| format!("[{}]", r.iter().map(sx).collect::<Vec<_>>().join(", "))).collect::<Vec<_>>().join(" ")
        ),
        ExprKind::VarBlock { vars, body } => format!(
            "(LET {} IN {})",
            vars.iter().map(|v| format!("{}={}", v.name, sx(&v.expr))).collect::<Vec<_>>().join(" "),
            sx(body)
        ),
        ExprKind::SortOrder(d) => if *d { "DESC" } else { "ASC" }.into(),
    }
}

fn p(src: &str) -> String {
    match parse_expression(src) {
        Ok(e) => sx(&e),
        Err(d) => panic!("{src}: {:?} {}", d.code, d.message),
    }
}

fn code(src: &str) -> ErrorCode {
    match parse_expression(src) {
        Ok(e) => panic!("{src} parsed as {}", sx(&e)),
        Err(d) => d.code,
    }
}

#[test]
fn arithmetic_precedence_and_associativity() {
    assert_eq!(p("1 + 2 * 3"), "(1 + (2 * 3))");
    assert_eq!(p("(1 + 2) * 3"), "((1 + 2) * 3)");
    assert_eq!(p("10 - 4 - 3"), "((10 - 4) - 3)");
    assert_eq!(p("8 / 4 / 2"), "((8 / 4) / 2)");
    assert_eq!(p("2 ^ 3 ^ 2"), "((2 ^ 3) ^ 2)");
    assert_eq!(p("-2 ^ 2"), "(- (2 ^ 2))");
    assert_eq!(p("-a * b"), "((- a) * b)");
    assert_eq!(p("1 + -2"), "(1 + (- 2))");
    assert_eq!(p("- -1"), "(- (- 1))");
    // "--" starts a comment, so "--1" is an empty formula
    assert_eq!(code("--1"), ErrorCode::GrammaticalError);
}

#[test]
fn concat_comparison_logic_precedence() {
    assert_eq!(p("\"a\" & 1 + 2"), "(\"a\" & (1 + 2))");
    assert_eq!(p("a & b = c"), "((a & b) = c)");
    assert_eq!(p("a = 1 && b = 2 || c"), "(((a = 1) && (b = 2)) || c)");
    assert_eq!(p("a || b && c"), "(a || (b && c))");
    assert_eq!(p("NOT a = b"), "(NOT (a = b))");
    assert_eq!(p("NOT a && b"), "((NOT a) && b)");
    assert_eq!(p("NOT(a)"), "(NOT a)");
    assert_eq!(p("a <> b"), "(a <> b)");
    assert_eq!(p("a == BLANK()"), "(a == BLANK())");
    assert_eq!(p("1 < 2 = TRUE"), "((1 < 2) = TRUE)");
}

#[test]
fn references() {
    assert_eq!(p("Sales[Amount]"), "Sales[Amount]");
    assert_eq!(p("'Sales Table'[Net Amount]"), "Sales Table[Net Amount]");
    assert_eq!(p("[Total Sales]"), "[Total Sales]");
    assert_eq!(p("Sales"), "Sales");
    assert_eq!(p("'Date'"), "'Date'");
    assert_eq!(p("Date[Date]"), "Date[Date]");
    assert_eq!(p("'it''s'[a]]b]"), "it's[a]b]");
}

#[test]
fn literals() {
    assert_eq!(p("42"), "42");
    assert_eq!(p("1.5"), "1.5");
    assert_eq!(p("1e3"), "1000.0");
    assert_eq!(p("99999999999999999999"), "1e20");
    assert_eq!(p("\"say \"\"hi\"\"\""), "\"say \\\"hi\\\"\"");
    assert_eq!(p("TRUE"), "TRUE");
    assert_eq!(p("FALSE()"), "FALSE");
    assert_eq!(p("dt\"2024-02-29\""), "dt\"2024-02-29\"");
}

#[test]
fn calls_with_nested_and_missing_arguments() {
    assert_eq!(p("CALCULATE(SUM(Sales[Amount]), Product[Color] = \"Red\", ALL(Customer))"), "CALCULATE(SUM(Sales[Amount]), (Product[Color] = \"Red\"), ALL(Customer))");
    assert_eq!(p("BLANK()"), "BLANK()");
    assert_eq!(p("F(a, , c)"), "F(a, _, c)");
    assert_eq!(p("F(a,)"), "F(a, _)");
    assert_eq!(p("TOPN(3, Sales, Sales[Amount], DESC)"), "TOPN(3, Sales, Sales[Amount], DESC)");
    assert_eq!(p("PERCENTILE.INC(T[x], 0.5)"), "PERCENTILE.INC(T[x], 0.5)");
}

#[test]
fn table_constructors_and_in() {
    assert_eq!(p("{1, 2, 3}"), "{[1] [2] [3]}");
    assert_eq!(p("{(1, \"a\"), (2, \"b\")}"), "{[1, \"a\"] [2, \"b\"]}");
    assert_eq!(p("Product[Color] IN {\"Red\", \"Blue\"}"), "(Product[Color] IN {[\"Red\"] [\"Blue\"]})");
    assert_eq!(p("(a, b) IN {(1, 2)}"), "(<a, b> IN {[1, 2]})");
    assert_eq!(p("NOT x IN VALUES(T[c])"), "(NOT (x IN VALUES(T[c])))");
    assert_eq!(p("x IN t && y"), "((x IN t) && y)");
}

#[test]
fn var_return_blocks_nest() {
    assert_eq!(p("VAR a = 1 VAR b = a + 1 RETURN a * b"), "(LET a=1 b=(a + 1) IN (a * b))");
    assert_eq!(p("SUMX(T, VAR x = T[a] RETURN x * 2)"), "SUMX(T, (LET x=T[a] IN (x * 2)))");
    assert_eq!(p("VAR a = VAR b = 2 RETURN b RETURN a"), "(LET a=(LET b=2 IN b) IN a)");
}

#[test]
fn comments_anywhere() {
    assert_eq!(p("SUM( // total\n Sales[Amount] /* col */ ) -- end"), "SUM(Sales[Amount])");
}

#[test]
fn formula_bar_form() {
    let (n, e) = parse_formula("Total Sales = SUM(Sales[Amount])").unwrap();
    assert_eq!(n, "Total Sales");
    assert_eq!(sx(&e), "SUM(Sales[Amount])");
    let (n, e) = parse_formula("[Margin %] = DIVIDE([a], [b])").unwrap();
    assert_eq!(n, "Margin %");
    assert_eq!(sx(&e), "DIVIDE([a], [b])");
    // only the first '=' separates; later ones are comparisons
    let (_, e) = parse_formula("Flag = Sales[Qty] = 1").unwrap();
    assert_eq!(sx(&e), "(Sales[Qty] = 1)");
    assert_eq!(parse_formula("SUM(Sales[Amount])").unwrap_err().code, ErrorCode::CantSeparateNameAndExpression);
    assert_eq!(parse_formula(" = 1").unwrap_err().code, ErrorCode::CantSeparateNameAndExpression);
    assert_eq!(parse_formula("Name = ").unwrap_err().code, ErrorCode::CantSeparateNameAndExpression);
}

#[test]
fn queries() {
    let q = parse_query(
        "DEFINE
            MEASURE Sales[Total] = SUM(Sales[Amount])
            VAR Threshold = 10
            COLUMN Sales[Double] = Sales[Amount] * 2
            TABLE Small = FILTER(Sales, Sales[Amount] < Threshold)
            FUNCTION AddOne = (x) => x + 1
         EVALUATE SUMMARIZECOLUMNS(Product[Color], \"T\", [Total])
         ORDER BY Product[Color] DESC, [T]
         START AT \"Red\"
         EVALUATE {1}",
    )
    .unwrap();
    assert_eq!(q.defines.len(), 5);
    assert!(matches!(&q.defines[0], Define::Measure { table, name, .. } if table == "Sales" && name == "Total"));
    assert!(matches!(&q.defines[4], Define::Function { params, .. } if params == &vec!["x".to_string()]));
    assert_eq!(q.evaluates.len(), 2);
    let e = &q.evaluates[0];
    assert_eq!(e.order_by.len(), 2);
    assert!(e.order_by[0].descending && !e.order_by[1].descending);
    assert_eq!(e.start_at.len(), 1);
    assert_eq!(parse_query("DEFINE EVALUATE {1}").unwrap_err().code, ErrorCode::GrammaticalError);
    assert_eq!(parse_query("SUM(1)").unwrap_err().code, ErrorCode::GrammaticalError);
    assert_eq!(parse_query("EVALUATE {1} ORDER [x]").unwrap_err().code, ErrorCode::GrammaticalError);
    assert_eq!(parse_query("EVALUATE {1} ORDER BY [x] START AT 1, 2").unwrap_err().code, ErrorCode::GrammaticalError);
}

#[test]
fn spans_cover_the_source() {
    let src = "SUM(Sales[Amount]) + 1";
    let e = parse_expression(src).unwrap();
    assert_eq!((e.span.start, e.span.end), (0, src.len()));
    if let ExprKind::Binary { left, .. } = &e.kind {
        assert_eq!(&src[left.span.start..left.span.end], "SUM(Sales[Amount])");
    } else {
        panic!()
    }
}

// ---- diagnostic codes ----

#[test]
fn grammatical_errors() {
    assert_eq!(code("1 +"), ErrorCode::GrammaticalError);
    assert_eq!(code("SUM(1"), ErrorCode::GrammaticalError);
    assert_eq!(code("(1 + 2"), ErrorCode::GrammaticalError);
    assert_eq!(code("1 2"), ErrorCode::GrammaticalError);
    assert_eq!(code("VAR x = 1"), ErrorCode::GrammaticalError);
    assert_eq!(code("{}"), ErrorCode::GrammaticalError);
    assert_eq!(code("{(1, 2), 3}"), ErrorCode::GrammaticalError);
    assert_eq!(code(")"), ErrorCode::GrammaticalError);
}

#[test]
fn lexical_error_codes() {
    assert_eq!(code("1e"), ErrorCode::IncompleteNumber);
    assert_eq!(code("1.5E+"), ErrorCode::IncompleteNumber);
    assert_eq!(code("12abc"), ErrorCode::IncompleteNumber);
    assert_eq!(code("Sales[Amount"), ErrorCode::InvalidIdentifier);
    assert_eq!(code("[]"), ErrorCode::InvalidIdentifier);
    assert_eq!(code("'Sales"), ErrorCode::InvalidIdentifier);
    assert_eq!(code("1 $ 2"), ErrorCode::InvalidNameCharacter);
    assert_eq!(code("a | b"), ErrorCode::InvalidNameCharacter);
}

#[test]
fn structural_error_codes() {
    assert_eq!(code("'Sales'(1)"), ErrorCode::FunctionCallOnNonFunction);
    assert_eq!(code("[Total](1)"), ErrorCode::FunctionCallOnNonFunction);
    assert_eq!(code("(1, 2)"), ErrorCode::InvalidTupleLocation);
    assert_eq!(code("SUM((1, 2))"), ErrorCode::InvalidTupleLocation);
    assert_eq!(code("{((1, 2), 3)}"), ErrorCode::InvalidTupleLocation);
    assert_eq!(code("x IN 5"), ErrorCode::InRightArgumentNotTable);
    assert_eq!(code("x IN \"a\""), ErrorCode::InRightArgumentNotTable);
    assert_eq!(code("VAR RETURN = 1 RETURN 2"), ErrorCode::VariableNameReserved);
    assert_eq!(code("VAR In = 1 RETURN 2"), ErrorCode::VariableNameReserved);
}

#[test]
fn catalog_checks_names_and_argument_counts() {
    let c = Catalog::builtin();
    let codes = |s: &str| diagnose(s, c).into_iter().map(|d| d.code).collect::<Vec<_>>();
    assert_eq!(codes("SUM(Sales[Amount])"), vec![]);
    assert_eq!(codes("sum(Sales[Amount])"), vec![]);
    assert_eq!(codes("SUMM(Sales[Amount])"), vec![ErrorCode::UnrecognizedIdentifier]);
    assert_eq!(codes("SUM()"), vec![ErrorCode::MissingParameters]);
    assert_eq!(codes("IF(TRUE)"), vec![ErrorCode::MissingParameters]);
    assert_eq!(codes("SUM(a, b)"), vec![ErrorCode::TooManyParameters]);
    assert_eq!(codes("IF(1, 2, 3, 4)"), vec![ErrorCode::TooManyParameters]);
    assert_eq!(codes("CALCULATE([m], a, b, c, d, e)"), vec![]);
    assert_eq!(codes("ADDCOLUMNS(T, \"x\")"), vec![ErrorCode::MissingParameters]);
    // nested problems are all reported
    assert_eq!(codes("IF(SUMM(1), BLANK(1), 0)"), vec![ErrorCode::UnrecognizedIdentifier, ErrorCode::TooManyParameters]);
    // lexer errors come first and carry a span for squiggles
    let d = diagnose("SUM(Sales[Amount) + 1", c);
    assert_eq!(d[0].code, ErrorCode::InvalidIdentifier);
    assert_eq!(d[0].span.start, 9);
}

#[test]
fn never_panics_on_garbage() {
    for s in ["", " ", "(", ")", "[", "'", "\"", "{", "}", ",", "VAR", "RETURN", "IN", "NOT", "--", "/*", "dt\"", "EVALUATE", "a[", "1..2", "...", "&&&", "==="] {
        let _ = parse_expression(s);
        let _ = parse_query(s);
        let _ = parse_formula(s);
    }
}
