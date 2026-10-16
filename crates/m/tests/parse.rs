use biforge_m::ast::*;
use biforge_m::parse;

fn p(s: &str) -> Expr {
    parse(s).unwrap_or_else(|e| panic!("{s}: {e}"))
}

#[test]
fn literals_and_precedence() {
    assert_eq!(p("1 + 2 * 3"), Expr::Binary(BinOp::Add, Box::new(Expr::Number(1.0, "1".into())), Box::new(Expr::Binary(BinOp::Mul, Box::new(Expr::Number(2.0, "2".into())), Box::new(Expr::Number(3.0, "3".into()))))));
    assert!(matches!(p("1 - 2 - 3"), Expr::Binary(BinOp::Sub, l, _) if matches!(*l, Expr::Binary(BinOp::Sub, _, _))));
    assert!(matches!(p("a or b and c"), Expr::Binary(BinOp::Or, _, r) if matches!(*r, Expr::Binary(BinOp::And, _, _))));
    assert_eq!(p("\"a\"\"b#(lf)#(0041)\""), Expr::Text("a\"b\nA".into()));
    assert_eq!(p("0xFF"), Expr::Number(255.0, "0xFF".into()));
    assert_eq!(p("1e3"), Expr::Number(1000.0, "1e3".into()));
    assert!(matches!(p("not true"), Expr::Unary(UnOp::Not, _)));
    assert!(matches!(p("-5"), Expr::Unary(UnOp::Neg, _)));
}

#[test]
fn let_bindings_keep_their_source_ranges() {
    let src = "let\n    Source = Csv.Document(File.Contents(\"C:/a.csv\")),\n    #\"Changed Type\" = Table.TransformColumnTypes(Source, {{\"A\", Int64.Type}})\nin\n    #\"Changed Type\"";
    let Expr::Let { bindings, body, body_span } = p(src) else { panic!() };
    assert_eq!(bindings.len(), 2);
    assert_eq!(bindings[0].name, "Source");
    assert_eq!(bindings[1].name, "Changed Type");
    assert_eq!(bindings[1].raw_name, "#\"Changed Type\"");
    assert_eq!(&src[bindings[0].expr_span.start..bindings[0].expr_span.end], "Csv.Document(File.Contents(\"C:/a.csv\"))");
    assert_eq!(&src[body_span.start..body_span.end], "#\"Changed Type\"");
    assert_eq!(*body, Expr::Ident("Changed Type".into()));
}

#[test]
fn records_fields_items_and_calls() {
    assert!(matches!(p("[a=1, b=2]"), Expr::Record(f) if f.len() == 2));
    assert!(matches!(p("[Sales Amount]"), Expr::ImplicitField(n, false) if n == "Sales Amount"));
    assert!(matches!(p("Source{[Item=\"S\",Kind=\"Sheet\"]}[Data]"), Expr::Field(inner, n, false) if n == "Data" && matches!(*inner, Expr::Item(..))));
    assert!(matches!(p("x[a]?"), Expr::Field(_, _, true)));
    assert!(matches!(p("x[[a],[b]]"), Expr::Project(_, n, false) if n == vec!["a".to_string(), "b".to_string()]));
    assert!(matches!(p("Table.SelectRows(t, each [A] > 1 and [B] <> null)"), Expr::Invoke(_, a) if a.len() == 2 && matches!(a[1], Expr::Each(_))));
    assert!(matches!(p("#table({\"a\"}, {{1}})"), Expr::Invoke(f, _) if matches!(*f, Expr::Ident(ref n) if n == "#table")));
    assert!(matches!(p("{1, 2, 3}"), Expr::List(v) if v.len() == 3));
    assert!(matches!(p("{}"), Expr::List(v) if v.is_empty()));
}

#[test]
fn functions_types_and_control_flow() {
    assert!(matches!(p("(x) => x + 1"), Expr::Func { params, .. } if params.len() == 1));
    assert!(matches!(p("(x as number, optional y as nullable text) as number => x"), Expr::Func { params, ret: Some(_), .. } if params.len() == 2 && params[1].optional));
    assert!(matches!(p("(1 + 2) * 3"), Expr::Binary(BinOp::Mul, ..)));
    assert!(matches!(p("if a then b else c"), Expr::If(..)));
    assert!(matches!(p("try 1/0 otherwise 0"), Expr::Try(_, Some(_))));
    assert!(matches!(p("error \"boom\""), Expr::Error(_)));
    assert!(matches!(p("type table [a = text, b = number]"), Expr::Type(TypeExpr::Table { fields }) if fields.len() == 2));
    assert!(matches!(p("type nullable number"), Expr::Type(TypeExpr::Nullable(_))));
    assert!(matches!(p("x is text"), Expr::Is(..)));
    assert!(matches!(p("x as number"), Expr::As(..)));
    assert!(matches!(p("// comment\n1 /* c */ + 2"), Expr::Binary(BinOp::Add, ..)));
}

#[test]
fn errors_have_positions() {
    let e = parse("let a = 1 in").unwrap_err();
    assert!(e.message.contains("incomplete"), "{e}");
    let e = parse("1 + ").unwrap_err();
    assert!(e.start >= 3);
    let e = parse("\"abc").unwrap_err();
    assert!(e.message.contains("not closed"));
    assert!(parse("1 2").unwrap_err().message.contains("Unexpected text"));
    assert!(parse("let a = 1, in a").is_err());
    assert!(parse("section Foo;").is_err());
}

#[test]
fn parses_generated_partition_text() {
    let m = "let\n\tSource = Csv.Document(File.Contents(\"C:/data/Sales.csv\"), [Delimiter=\",\", Columns=3, Encoding=65001, QuoteStyle=QuoteStyle.Csv]),\n\t#\"Promoted Headers\" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),\n\t#\"Changed Type\" = Table.TransformColumnTypes(#\"Promoted Headers\", {{\"Id\", Int64.Type}, {\"Amount\", type number}}, \"en-US\")\nin\n\t#\"Changed Type\"";
    assert!(matches!(p(m), Expr::Let { bindings, .. } if bindings.len() == 3));
}
