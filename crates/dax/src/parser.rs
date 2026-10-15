//! Recursive-descent / precedence-climbing parser for DAX expressions, formulas (`Name = expr`) and
//! queries (`DEFINE ... EVALUATE ... ORDER BY ... START AT`).
//!
//! Operator precedence, highest first (Microsoft's public DAX operator reference):
//! `^`, unary sign, `* /`, `+ -`, `&`, comparisons and `IN`, `NOT`, `&&`, `||`. Binary operators are
//! left-associative. Because `^` binds tighter than the sign, `-2^2` is `-(2^2)`.

use crate::ast::*;
use crate::catalog::Catalog;
use crate::diag::{Diagnostic, ErrorCode, Span};
use crate::lexer::{lex, Kw, Op, Tok, Token};

pub type PResult<T> = Result<T, Diagnostic>;

/// Binding powers: higher binds tighter.
const P_OR: u8 = 1;
const P_AND: u8 = 2;
const P_NOT: u8 = 3;
const P_CMP: u8 = 4;
const P_CONCAT: u8 = 5;
const P_ADD: u8 = 6;
const P_MUL: u8 = 7;
const P_SIGN: u8 = 8;
const P_POW: u8 = 9;

struct Parser<'a> {
    src: &'a str,
    toks: Vec<Token>,
    pos: usize,
}

/// Parses a single DAX expression. Lexer errors are reported first.
pub fn parse_expression(src: &str) -> PResult<Expr> {
    let mut p = Parser::new(src)?;
    let e = p.expr(0)?;
    p.expect_eof()?;
    check_tuples(&e, false)?;
    Ok(e)
}

/// Parses `Name = expression` as typed in the formula bar for a measure or calculated column.
/// The name may contain spaces or be written in brackets.
pub fn parse_formula(src: &str) -> PResult<(String, Expr)> {
    let lexed = lex(src);
    if let Some(e) = lexed.errors.into_iter().next() {
        return Err(e);
    }
    let eq = lexed.tokens.iter().position(|t| t.tok == Tok::Op(Op::Eq));
    let Some(eq) = eq else {
        return Err(Diagnostic::new(
            ErrorCode::CantSeparateNameAndExpression,
            "The formula needs a name, an equals sign and an expression, as in: Total = SUM(Sales[Amount]).",
            Span::new(0, src.len()),
        ));
    };
    let eq_span = lexed.tokens[eq].span;
    let raw = src[..eq_span.start].trim();
    let name = raw.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(raw).trim().to_string();
    if name.is_empty() {
        return Err(Diagnostic::new(ErrorCode::CantSeparateNameAndExpression, "The formula has no name before the equals sign.", Span::new(0, eq_span.end)));
    }
    let mut p = Parser { src, toks: lexed.tokens, pos: eq + 1 };
    if p.peek() == &Tok::Eof {
        return Err(Diagnostic::new(ErrorCode::CantSeparateNameAndExpression, "The formula has no expression after the equals sign.", eq_span));
    }
    let e = p.expr(0)?;
    p.expect_eof()?;
    check_tuples(&e, false)?;
    Ok((name, e))
}

/// Parses a DAX query with optional `DEFINE` and one or more `EVALUATE` statements.
pub fn parse_query(src: &str) -> PResult<Query> {
    let mut p = Parser::new(src)?;
    let mut q = Query::default();
    if p.eat_kw(Kw::Define) {
        loop {
            match p.peek().clone() {
                Tok::Kw(Kw::Measure) => {
                    let start = p.bump().span;
                    let (table, name) = p.qualified_name("a measure")?;
                    p.expect_op(Op::Eq)?;
                    let expr = p.expr(0)?;
                    q.defines.push(Define::Measure { table, name, span: start.to(expr.span), expr });
                }
                Tok::Kw(Kw::Column) => {
                    let start = p.bump().span;
                    let (table, name) = p.qualified_name("a column")?;
                    p.expect_op(Op::Eq)?;
                    let expr = p.expr(0)?;
                    q.defines.push(Define::Column { table, name, span: start.to(expr.span), expr });
                }
                Tok::Kw(Kw::Table) => {
                    let start = p.bump().span;
                    let name = p.table_name()?;
                    p.expect_op(Op::Eq)?;
                    let expr = p.expr(0)?;
                    q.defines.push(Define::Table { name, span: start.to(expr.span), expr });
                }
                Tok::Kw(Kw::Var) => {
                    p.bump();
                    q.defines.push(Define::Var(p.var_def()?));
                }
                Tok::Kw(Kw::Function) => {
                    let start = p.bump().span;
                    let name = p.ident("a function name")?;
                    p.expect_op(Op::Eq)?;
                    p.expect(Tok::LParen, "(")?;
                    let mut params = Vec::new();
                    if p.peek() != &Tok::RParen {
                        loop {
                            params.push(p.ident("a parameter name")?);
                            if !p.eat(&Tok::Comma) {
                                break;
                            }
                        }
                    }
                    p.expect(Tok::RParen, ")")?;
                    p.expect_op(Op::Eq)?;
                    p.expect_op(Op::Gt)?;
                    let body = p.expr(0)?;
                    q.defines.push(Define::Function { name, params, span: start.to(body.span), body });
                }
                _ => break,
            }
        }
        if q.defines.is_empty() {
            return Err(p.err_here(ErrorCode::GrammaticalError, "DEFINE must be followed by MEASURE, VAR, COLUMN, TABLE or FUNCTION."));
        }
    }
    while p.eat_kw(Kw::Evaluate) {
        let start = p.toks[p.pos - 1].span;
        let expr = p.expr(0)?;
        check_tuples(&expr, false)?;
        let mut ev = Evaluate { span: start.to(expr.span), expr, order_by: vec![], start_at: vec![] };
        if p.eat_kw(Kw::Order) {
            if !p.eat_kw(Kw::By) {
                return Err(p.err_here(ErrorCode::GrammaticalError, "Expected BY after ORDER."));
            }
            loop {
                let expr = p.expr(0)?;
                let descending = if p.eat_kw(Kw::Desc) {
                    true
                } else {
                    p.eat_kw(Kw::Asc);
                    false
                };
                ev.order_by.push(OrderKey { expr, descending });
                if !p.eat(&Tok::Comma) {
                    break;
                }
            }
            if p.eat_kw(Kw::Start) {
                if !p.eat_kw(Kw::At) {
                    return Err(p.err_here(ErrorCode::GrammaticalError, "Expected AT after START."));
                }
                loop {
                    ev.start_at.push(p.expr(0)?);
                    if !p.eat(&Tok::Comma) {
                        break;
                    }
                }
                if ev.start_at.len() > ev.order_by.len() {
                    return Err(Diagnostic::new(ErrorCode::GrammaticalError, "START AT has more values than ORDER BY has columns.", ev.start_at.last().unwrap().span));
                }
            }
        }
        q.evaluates.push(ev);
    }
    if q.evaluates.is_empty() {
        return Err(p.err_here(ErrorCode::GrammaticalError, "A query needs at least one EVALUATE statement."));
    }
    p.expect_eof()?;
    for d in &q.defines {
        let e = match d {
            Define::Measure { expr, .. } | Define::Column { expr, .. } | Define::Table { expr, .. } => expr,
            Define::Var(v) => &v.expr,
            Define::Function { body, .. } => body,
        };
        check_tuples(e, false)?;
    }
    Ok(q)
}

impl<'a> Parser<'a> {
    fn new(src: &'a str) -> PResult<Parser<'a>> {
        let lexed = lex(src);
        if let Some(e) = lexed.errors.into_iter().next() {
            return Err(e);
        }
        Ok(Parser { src, toks: lexed.tokens, pos: 0 })
    }

    fn peek(&self) -> &Tok {
        &self.toks[self.pos].tok
    }
    fn peek_at(&self, k: usize) -> &Tok {
        &self.toks[(self.pos + k).min(self.toks.len() - 1)].tok
    }
    fn span(&self) -> Span {
        self.toks[self.pos].span
    }
    fn bump(&mut self) -> Token {
        let t = self.toks[self.pos].clone();
        if self.pos < self.toks.len() - 1 {
            self.pos += 1;
        }
        t
    }
    fn eat(&mut self, t: &Tok) -> bool {
        if self.peek() == t {
            self.bump();
            true
        } else {
            false
        }
    }
    fn eat_kw(&mut self, k: Kw) -> bool {
        self.eat(&Tok::Kw(k))
    }
    fn describe(&self) -> String {
        let s = self.span();
        if self.peek() == &Tok::Eof {
            "the end of the formula".into()
        } else {
            format!("'{}'", &self.src[s.start..s.end])
        }
    }
    fn err_here(&self, code: ErrorCode, msg: &str) -> Diagnostic {
        Diagnostic::new(code, format!("{msg} Found {}.", self.describe()), self.span())
    }
    fn expect(&mut self, t: Tok, what: &str) -> PResult<Token> {
        if self.peek() == &t {
            Ok(self.bump())
        } else {
            Err(self.err_here(ErrorCode::GrammaticalError, &format!("Expected {what}.")))
        }
    }
    fn expect_op(&mut self, op: Op) -> PResult<Token> {
        let sym = match op {
            Op::Eq => "=",
            Op::Gt => ">",
            _ => "an operator",
        };
        self.expect(Tok::Op(op), sym)
    }
    fn expect_eof(&mut self) -> PResult<()> {
        if self.peek() == &Tok::Eof {
            Ok(())
        } else {
            Err(self.err_here(ErrorCode::GrammaticalError, "Unexpected text after the end of the expression."))
        }
    }
    fn ident(&mut self, what: &str) -> PResult<String> {
        match self.peek().clone() {
            Tok::Ident(s) => {
                self.bump();
                Ok(s)
            }
            Tok::Kw(_) if what.contains("variable") => Err(self.err_here(ErrorCode::VariableNameReserved, "This name is reserved and cannot be used for a variable.")),
            _ => Err(self.err_here(ErrorCode::GrammaticalError, &format!("Expected {what}."))),
        }
    }
    fn table_name(&mut self) -> PResult<String> {
        match self.peek().clone() {
            Tok::Ident(s) | Tok::Quoted(s) => {
                self.bump();
                Ok(s)
            }
            _ => Err(self.err_here(ErrorCode::GrammaticalError, "Expected a table name.")),
        }
    }
    /// `Table[Name]` or `'Table'[Name]` (in DEFINE MEASURE / COLUMN).
    fn qualified_name(&mut self, what: &str) -> PResult<(String, String)> {
        let table = self.table_name().map_err(|_| self.err_here(ErrorCode::GrammaticalError, &format!("Expected {what} as Table[Name].")))?;
        match self.peek().clone() {
            Tok::Bracket(n) => {
                self.bump();
                Ok((table, n))
            }
            _ => Err(self.err_here(ErrorCode::GrammaticalError, &format!("Expected {what} as Table[Name]."))),
        }
    }
    fn var_def(&mut self) -> PResult<VarDef> {
        let span = self.span();
        let name = self.ident("a variable name")?;
        self.expect_op(Op::Eq)?;
        let expr = self.expr(0)?;
        Ok(VarDef { name, span, expr })
    }

    fn infix(&self) -> Option<(u8, BinOp)> {
        Some(match self.peek() {
            Tok::Op(Op::Or) => (P_OR, BinOp::Or),
            Tok::Op(Op::And) => (P_AND, BinOp::And),
            Tok::Op(Op::Eq) => (P_CMP, BinOp::Eq),
            Tok::Op(Op::StrictEq) => (P_CMP, BinOp::StrictEq),
            Tok::Op(Op::Ne) => (P_CMP, BinOp::Ne),
            Tok::Op(Op::Lt) => (P_CMP, BinOp::Lt),
            Tok::Op(Op::Le) => (P_CMP, BinOp::Le),
            Tok::Op(Op::Gt) => (P_CMP, BinOp::Gt),
            Tok::Op(Op::Ge) => (P_CMP, BinOp::Ge),
            Tok::Op(Op::Amp) => (P_CONCAT, BinOp::Concat),
            Tok::Op(Op::Plus) => (P_ADD, BinOp::Add),
            Tok::Op(Op::Minus) => (P_ADD, BinOp::Sub),
            Tok::Op(Op::Star) => (P_MUL, BinOp::Mul),
            Tok::Op(Op::Slash) => (P_MUL, BinOp::Div),
            Tok::Op(Op::Caret) => (P_POW, BinOp::Pow),
            _ => return None,
        })
    }

    fn expr(&mut self, min: u8) -> PResult<Expr> {
        let mut left = self.prefix()?;
        loop {
            if self.peek() == &Tok::Kw(Kw::In) && P_CMP >= min {
                self.bump();
                let right = self.expr(P_CMP + 1)?;
                if is_scalar_literal(&right) {
                    return Err(Diagnostic::new(ErrorCode::InRightArgumentNotTable, "The right side of IN must be a table, such as { 1, 2 } or VALUES(Table[Column]).", right.span));
                }
                let span = left.span.to(right.span);
                left = Expr::new(ExprKind::In { left: Box::new(left), right: Box::new(right) }, span);
                continue;
            }
            let Some((prec, op)) = self.infix() else { break };
            if prec < min {
                break;
            }
            self.bump();
            let right = self.expr(prec + 1)?;
            let span = left.span.to(right.span);
            left = Expr::new(ExprKind::Binary { op, left: Box::new(left), right: Box::new(right) }, span);
        }
        Ok(left)
    }

    fn prefix(&mut self) -> PResult<Expr> {
        let start = self.span();
        match self.peek().clone() {
            Tok::Kw(Kw::Not) => {
                self.bump();
                let e = self.expr(P_NOT.max(P_CMP))?;
                let span = start.to(e.span);
                Ok(Expr::new(ExprKind::Unary { op: UnOp::Not, expr: Box::new(e) }, span))
            }
            Tok::Op(Op::Minus) | Tok::Op(Op::Plus) => {
                let neg = self.peek() == &Tok::Op(Op::Minus);
                self.bump();
                let e = self.expr(P_SIGN)?;
                let span = start.to(e.span);
                Ok(Expr::new(ExprKind::Unary { op: if neg { UnOp::Neg } else { UnOp::Plus }, expr: Box::new(e) }, span))
            }
            _ => self.primary(),
        }
    }

    fn primary(&mut self) -> PResult<Expr> {
        let t = self.bump();
        let span = t.span;
        let e = |k| Ok(Expr::new(k, span));
        match t.tok {
            Tok::Num { text, is_int } => {
                if is_int {
                    if let Ok(v) = text.parse::<i64>() {
                        return e(ExprKind::Int(v));
                    }
                }
                let v: f64 = text.parse().map_err(|_| Diagnostic::new(ErrorCode::IncompleteNumber, format!("'{text}' is not a valid number."), span))?;
                e(ExprKind::Number(v))
            }
            Tok::Str(s) => e(ExprKind::Str(s)),
            Tok::DateTime(s) => e(ExprKind::DateTime(s)),
            Tok::Kw(k @ (Kw::True | Kw::False)) => {
                // TRUE and TRUE() are the same
                if self.peek() == &Tok::LParen && self.peek_at(1) == &Tok::RParen {
                    self.bump();
                    let end = self.bump().span;
                    return Ok(Expr::new(ExprKind::Bool(k == Kw::True), span.to(end)));
                }
                e(ExprKind::Bool(k == Kw::True))
            }
            Tok::Kw(Kw::Asc) => e(ExprKind::SortOrder(false)),
            Tok::Kw(Kw::Desc) => e(ExprKind::SortOrder(true)),
            Tok::Kw(Kw::Var) => {
                let mut vars = vec![self.var_def()?];
                while self.eat_kw(Kw::Var) {
                    vars.push(self.var_def()?);
                }
                if !self.eat_kw(Kw::Return) {
                    return Err(self.err_here(ErrorCode::GrammaticalError, "Expected RETURN after the variable definitions."));
                }
                let body = self.expr(0)?;
                let span = span.to(body.span);
                Ok(Expr::new(ExprKind::VarBlock { vars, body: Box::new(body) }, span))
            }
            Tok::Ident(name) => match self.peek().clone() {
                Tok::LParen => self.call(name, span),
                Tok::Bracket(col) => {
                    let end = self.bump().span;
                    Ok(Expr::new(ExprKind::ColumnRef { table: name, column: col }, span.to(end)))
                }
                _ => e(ExprKind::Name(name)),
            },
            Tok::Quoted(name) => match self.peek().clone() {
                Tok::Bracket(col) => {
                    let end = self.bump().span;
                    Ok(Expr::new(ExprKind::ColumnRef { table: name, column: col }, span.to(end)))
                }
                Tok::LParen => Err(Diagnostic::new(ErrorCode::FunctionCallOnNonFunction, format!("'{name}' is a table name and cannot be called like a function."), span)),
                _ => e(ExprKind::TableRef(name)),
            },
            Tok::Bracket(name) => {
                if self.peek() == &Tok::LParen {
                    return Err(Diagnostic::new(ErrorCode::FunctionCallOnNonFunction, format!("[{name}] is a column or measure and cannot be called like a function."), span));
                }
                e(ExprKind::BracketRef(name))
            }
            Tok::LParen => {
                let mut items = vec![self.expr(0)?];
                while self.eat(&Tok::Comma) {
                    items.push(self.expr(0)?);
                }
                let end = self.expect(Tok::RParen, ") to close the parenthesis")?.span;
                if items.len() == 1 {
                    let mut inner = items.pop().unwrap();
                    inner.span = span.to(end);
                    Ok(inner)
                } else {
                    Ok(Expr::new(ExprKind::Tuple(items), span.to(end)))
                }
            }
            Tok::LBrace => {
                let mut rows = Vec::new();
                if self.peek() == &Tok::RBrace {
                    return Err(self.err_here(ErrorCode::GrammaticalError, "A table constructor needs at least one value."));
                }
                loop {
                    let item = self.expr(0)?;
                    rows.push(match item.kind {
                        ExprKind::Tuple(items) => items,
                        _ => vec![item],
                    });
                    if !self.eat(&Tok::Comma) {
                        break;
                    }
                }
                let end = self.expect(Tok::RBrace, "} to close the table constructor")?.span;
                let width = rows[0].len();
                if rows.iter().any(|r| r.len() != width) {
                    return Err(Diagnostic::new(ErrorCode::GrammaticalError, "Every row of a table constructor must have the same number of values.", span.to(end)));
                }
                Ok(Expr::new(ExprKind::TableConstructor(rows), span.to(end)))
            }
            Tok::Eof => Err(Diagnostic::new(ErrorCode::GrammaticalError, "The expression is incomplete: unexpected end of the formula.", span)),
            _ => Err(Diagnostic::new(ErrorCode::GrammaticalError, format!("Unexpected '{}'.", &self.src[span.start..span.end]), span)),
        }
    }

    fn call(&mut self, name: String, name_span: Span) -> PResult<Expr> {
        self.bump(); // (
        let mut args = Vec::new();
        if self.peek() != &Tok::RParen {
            loop {
                if matches!(self.peek(), Tok::Comma | Tok::RParen) {
                    args.push(Expr::new(ExprKind::Missing, self.span()));
                } else {
                    args.push(self.expr(0)?);
                }
                if !self.eat(&Tok::Comma) {
                    break;
                }
            }
        }
        let end = self.expect(Tok::RParen, &format!(") to close the call to {name}"))?.span;
        Ok(Expr::new(ExprKind::Call { name, name_span, args }, name_span.to(end)))
    }
}

fn is_scalar_literal(e: &Expr) -> bool {
    matches!(e.kind, ExprKind::Int(_) | ExprKind::Number(_) | ExprKind::Str(_) | ExprKind::Bool(_) | ExprKind::DateTime(_))
}

/// Tuples are only allowed as rows of a table constructor and on the left of `IN`.
fn check_tuples(e: &Expr, allowed: bool) -> PResult<()> {
    match &e.kind {
        ExprKind::Tuple(items) => {
            if !allowed {
                return Err(Diagnostic::new(ErrorCode::InvalidTupleLocation, "A list of values in parentheses is only allowed in a table constructor or before IN.", e.span));
            }
            items.iter().try_for_each(|i| check_tuples(i, false))
        }
        ExprKind::In { left, right } => {
            check_tuples(left, true)?;
            check_tuples(right, false)
        }
        ExprKind::TableConstructor(rows) => rows.iter().flatten().try_for_each(|i| check_tuples(i, false)),
        ExprKind::Call { args, .. } => args.iter().try_for_each(|a| check_tuples(a, false)),
        ExprKind::Unary { expr, .. } => check_tuples(expr, false),
        ExprKind::Binary { left, right, .. } => {
            check_tuples(left, false)?;
            check_tuples(right, false)
        }
        ExprKind::VarBlock { vars, body } => {
            vars.iter().try_for_each(|v| check_tuples(&v.expr, false))?;
            check_tuples(body, false)
        }
        _ => Ok(()),
    }
}

/// Checks every function call against the catalog: unknown names and argument counts.
pub fn check_calls(e: &Expr, catalog: &Catalog) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    e.walk(&mut |x| {
        if let ExprKind::Call { name, name_span, args } = &x.kind {
            match catalog.get(name) {
                None => out.push(Diagnostic::new(
                    ErrorCode::UnrecognizedIdentifier,
                    format!("Failed to resolve name '{name}'. It is not a valid table, variable, or function name."),
                    *name_span,
                )),
                Some(f) => {
                    let n = args.len();
                    if n < f.min_args {
                        out.push(Diagnostic::new(ErrorCode::MissingParameters, format!("Too few arguments were passed to the {} function. The minimum argument count for the function is {}.", f.name, f.min_args), x.span));
                    } else if f.max_args.is_some_and(|m| n > m) {
                        out.push(Diagnostic::new(
                            ErrorCode::TooManyParameters,
                            format!("Too many arguments were passed to the {} function. The maximum argument count for the function is {}.", f.name, f.max_args.unwrap()),
                            x.span,
                        ));
                    }
                }
            }
        }
    });
    out
}

/// Parses an expression and validates it against the catalog: the full set of diagnostics an editor shows.
pub fn diagnose(src: &str, catalog: &Catalog) -> Vec<Diagnostic> {
    let lexed = lex(src);
    if !lexed.errors.is_empty() {
        return lexed.errors;
    }
    match parse_expression(src) {
        Ok(e) => check_calls(&e, catalog),
        Err(d) => vec![d],
    }
}
