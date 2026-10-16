//! Recursive-descent parser for M expressions (written from the public language specification).
use crate::ast::*;
use crate::lexer::{lex, ParseError, Tok, Token};

pub fn parse(src: &str) -> Result<Expr, ParseError> {
    let toks = lex(src)?;
    let mut p = Parser { toks, pos: 0, src };
    let e = p.expr()?;
    if !matches!(p.peek(), Tok::Eof) {
        return Err(p.error_here("Unexpected text after the end of the expression."));
    }
    Ok(e)
}

struct Parser<'a> {
    toks: Vec<Token>,
    pos: usize,
    src: &'a str,
}

type R<T> = Result<T, ParseError>;

impl<'a> Parser<'a> {
    fn peek(&self) -> &Tok {
        &self.toks[self.pos].tok
    }
    fn peek_at(&self, n: usize) -> &Tok {
        &self.toks[(self.pos + n).min(self.toks.len() - 1)].tok
    }
    fn span(&self) -> Span {
        self.toks[self.pos].span.clone()
    }
    fn prev_end(&self) -> usize {
        if self.pos == 0 {
            0
        } else {
            self.toks[self.pos - 1].span.end
        }
    }
    fn bump(&mut self) -> Token {
        let t = self.toks[self.pos].clone();
        if self.pos < self.toks.len() - 1 {
            self.pos += 1;
        }
        t
    }
    fn error_here(&self, msg: impl Into<String>) -> ParseError {
        let s = self.span();
        ParseError { message: msg.into(), start: s.start, end: s.end.max(s.start) }
    }
    fn is_punct(&self, p: &str) -> bool {
        matches!(self.peek(), Tok::Punct(x) if *x == p)
    }
    fn is_kw(&self, k: &str) -> bool {
        matches!(self.peek(), Tok::Keyword(x) if *x == k)
    }
    fn eat_punct(&mut self, p: &str) -> bool {
        if self.is_punct(p) {
            self.bump();
            true
        } else {
            false
        }
    }
    fn eat_kw(&mut self, k: &str) -> bool {
        if self.is_kw(k) {
            self.bump();
            true
        } else {
            false
        }
    }
    fn expect_punct(&mut self, p: &str) -> R<()> {
        if self.eat_punct(p) {
            Ok(())
        } else {
            Err(self.error_here(format!("Expected \"{p}\".")))
        }
    }
    fn expect_kw(&mut self, k: &str) -> R<()> {
        if self.eat_kw(k) {
            Ok(())
        } else {
            Err(self.error_here(format!("Expected \"{k}\".")))
        }
    }

    pub fn expr(&mut self) -> R<Expr> {
        match self.peek() {
            Tok::Keyword("let") => self.let_expr(),
            Tok::Keyword("if") => {
                self.bump();
                let c = self.expr()?;
                self.expect_kw("then")?;
                let t = self.expr()?;
                self.expect_kw("else")?;
                let e = self.expr()?;
                Ok(Expr::If(Box::new(c), Box::new(t), Box::new(e)))
            }
            Tok::Keyword("each") => {
                self.bump();
                let body = self.expr()?;
                Ok(Expr::Each(Box::new(body)))
            }
            Tok::Keyword("try") => {
                self.bump();
                let body = self.expr()?;
                let otherwise = if self.eat_kw("otherwise") { Some(Box::new(self.expr()?)) } else { None };
                Ok(Expr::Try(Box::new(body), otherwise))
            }
            Tok::Keyword("error") => {
                self.bump();
                Ok(Expr::Error(Box::new(self.expr()?)))
            }
            Tok::Punct("(") => {
                if let Some(f) = self.try_function()? {
                    return Ok(f);
                }
                self.binary(0)
            }
            _ => self.binary(0),
        }
    }

    fn let_expr(&mut self) -> R<Expr> {
        self.expect_kw("let")?;
        let mut bindings = Vec::new();
        loop {
            let name_tok = self.bump();
            let (name, raw) = match &name_tok.tok {
                Tok::Ident { name, quoted } => (name.clone(), if *quoted { self.src[name_tok.span.start..name_tok.span.end].to_string() } else { name.clone() }),
                _ => {
                    return Err(ParseError { message: "Expected a step name.".into(), start: name_tok.span.start, end: name_tok.span.end });
                }
            };
            self.expect_punct("=")?;
            let start = self.span().start;
            let expr = self.expr()?;
            let end = self.prev_end();
            bindings.push(Binding { name, raw_name: raw, name_span: name_tok.span, expr_span: Span { start, end }, expr });
            if self.eat_punct(",") {
                continue;
            }
            break;
        }
        self.expect_kw("in")?;
        let bstart = self.span().start;
        let body = self.expr()?;
        let bend = self.prev_end();
        Ok(Expr::Let { bindings, body: Box::new(body), body_span: Span { start: bstart, end: bend } })
    }

    /// `(a, optional b as number) as text => body`; returns None (and rewinds) when this is not a function.
    fn try_function(&mut self) -> R<Option<Expr>> {
        let save = self.pos;
        self.bump(); // (
        let mut params = Vec::new();
        if !self.is_punct(")") {
            loop {
                let optional = matches!(self.peek(), Tok::Ident { name, quoted: false } if name == "optional");
                if optional {
                    self.bump();
                }
                match self.peek().clone() {
                    Tok::Ident { name, .. } => {
                        self.bump();
                        let ty = if self.eat_kw("as") {
                            match self.type_expr() {
                                Ok(t) => Some(t),
                                Err(_) => {
                                    self.pos = save;
                                    return Ok(None);
                                }
                            }
                        } else {
                            None
                        };
                        params.push(Param { name, optional, ty });
                    }
                    _ => {
                        self.pos = save;
                        return Ok(None);
                    }
                }
                if self.eat_punct(",") {
                    continue;
                }
                break;
            }
        }
        if !self.eat_punct(")") {
            self.pos = save;
            return Ok(None);
        }
        let ret = if self.eat_kw("as") {
            match self.type_expr() {
                Ok(t) => Some(t),
                Err(_) => {
                    self.pos = save;
                    return Ok(None);
                }
            }
        } else {
            None
        };
        if !self.eat_punct("=>") {
            self.pos = save;
            return Ok(None);
        }
        let body = self.expr()?;
        Ok(Some(Expr::Func { params, ret, body: Box::new(body) }))
    }

    fn type_expr(&mut self) -> R<TypeExpr> {
        match self.peek().clone() {
            Tok::Ident { name, quoted: false } if name == "nullable" => {
                self.bump();
                Ok(TypeExpr::Nullable(Box::new(self.type_expr()?)))
            }
            Tok::Ident { name, .. } if name == "table" && matches!(self.peek_at(1), Tok::Punct("[")) => {
                self.bump();
                let (fields, _) = self.type_fields()?;
                Ok(TypeExpr::Table { fields })
            }
            Tok::Ident { name, .. } if name == "record" && matches!(self.peek_at(1), Tok::Punct("[")) => {
                self.bump();
                let (fields, open) = self.type_fields()?;
                Ok(TypeExpr::Record { fields, open })
            }
            Tok::Ident { name, .. } => {
                self.bump();
                Ok(TypeExpr::Named(name))
            }
            Tok::Keyword("null") => {
                self.bump();
                Ok(TypeExpr::Named("null".into()))
            }
            Tok::Punct("{") => {
                self.bump();
                let t = self.type_expr()?;
                self.expect_punct("}")?;
                Ok(TypeExpr::List(Box::new(t)))
            }
            Tok::Punct("(") => {
                self.bump();
                let t = self.type_expr()?;
                self.expect_punct(")")?;
                Ok(t)
            }
            _ => Err(self.error_here("Expected a type.")),
        }
    }

    fn type_fields(&mut self) -> R<(Vec<(String, Option<TypeExpr>)>, bool)> {
        self.expect_punct("[")?;
        let mut fields = Vec::new();
        let mut open = false;
        while !self.is_punct("]") {
            if self.eat_punct("...") {
                open = true;
                break;
            }
            if matches!(self.peek(), Tok::Ident { name, quoted: false } if name == "optional") {
                self.bump();
            }
            let name = self.field_name()?;
            let ty = if self.eat_punct("=") { Some(self.type_expr()?) } else { None };
            fields.push((name, ty));
            if !self.eat_punct(",") {
                break;
            }
        }
        self.expect_punct("]")?;
        Ok((fields, open))
    }

    /// A generalized identifier: words separated by spaces (`Sales Amount`) or a quoted name.
    fn field_name(&mut self) -> R<String> {
        if let Tok::Ident { name, quoted: true } = self.peek().clone() {
            self.bump();
            return Ok(name);
        }
        if let Tok::Text(t) = self.peek().clone() {
            self.bump();
            return Ok(t);
        }
        let first = self.span();
        let mut last_end = None;
        loop {
            match self.peek() {
                Tok::Ident { quoted: false, .. } | Tok::Keyword(_) | Tok::Number(..) => {
                    last_end = Some(self.span().end);
                    self.bump();
                }
                Tok::Punct(".") => {
                    last_end = Some(self.span().end);
                    self.bump();
                }
                _ => break,
            }
        }
        match last_end {
            Some(e) => Ok(self.src[first.start..e].to_string()),
            None => Err(self.error_here("Expected a field name.")),
        }
    }

    fn binop(&self) -> Option<(BinOp, u8)> {
        Some(match self.peek() {
            Tok::Keyword("or") => (BinOp::Or, 1),
            Tok::Keyword("and") => (BinOp::And, 2),
            Tok::Punct("=") => (BinOp::Eq, 4),
            Tok::Punct("<>") => (BinOp::Ne, 4),
            Tok::Punct("<") => (BinOp::Lt, 5),
            Tok::Punct(">") => (BinOp::Gt, 5),
            Tok::Punct("<=") => (BinOp::Le, 5),
            Tok::Punct(">=") => (BinOp::Ge, 5),
            Tok::Punct("+") => (BinOp::Add, 6),
            Tok::Punct("-") => (BinOp::Sub, 6),
            Tok::Punct("&") => (BinOp::Concat, 6),
            Tok::Punct("*") => (BinOp::Mul, 7),
            Tok::Punct("/") => (BinOp::Div, 7),
            Tok::Keyword("meta") => (BinOp::Meta, 8),
            _ => return None,
        })
    }

    fn binary(&mut self, min: u8) -> R<Expr> {
        let mut left = self.unary()?;
        loop {
            // `is` / `as` bind between `and` and equality (precedence 3)
            if min <= 3 {
                if self.is_kw("is") {
                    self.bump();
                    let t = self.type_expr()?;
                    left = Expr::Is(Box::new(left), t);
                    continue;
                }
                if self.is_kw("as") {
                    self.bump();
                    let t = self.type_expr()?;
                    left = Expr::As(Box::new(left), t);
                    continue;
                }
            }
            let Some((op, prec)) = self.binop() else { break };
            if prec < min.max(1) || prec < min {
                break;
            }
            self.bump();
            let right = self.binary(prec + 1)?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn unary(&mut self) -> R<Expr> {
        match self.peek() {
            Tok::Keyword("not") => {
                self.bump();
                Ok(Expr::Unary(UnOp::Not, Box::new(self.unary()?)))
            }
            Tok::Punct("-") => {
                self.bump();
                Ok(Expr::Unary(UnOp::Neg, Box::new(self.unary()?)))
            }
            Tok::Punct("+") => {
                self.bump();
                Ok(Expr::Unary(UnOp::Pos, Box::new(self.unary()?)))
            }
            Tok::Keyword("type") => {
                self.bump();
                Ok(Expr::Type(self.type_expr()?))
            }
            _ => self.postfix(),
        }
    }

    fn postfix(&mut self) -> R<Expr> {
        let mut e = self.primary()?;
        loop {
            if self.is_punct("(") {
                self.bump();
                let mut args = Vec::new();
                if !self.is_punct(")") {
                    loop {
                        args.push(self.expr()?);
                        if !self.eat_punct(",") {
                            break;
                        }
                    }
                }
                self.expect_punct(")")?;
                e = Expr::Invoke(Box::new(e), args);
            } else if self.is_punct("{") {
                self.bump();
                let idx = self.expr()?;
                self.expect_punct("}")?;
                let opt = self.eat_punct("?");
                e = Expr::Item(Box::new(e), Box::new(idx), opt);
            } else if self.is_punct("[") {
                self.bump();
                if self.is_punct("[") {
                    let mut names = Vec::new();
                    loop {
                        self.expect_punct("[")?;
                        names.push(self.field_name()?);
                        self.expect_punct("]")?;
                        if !self.eat_punct(",") {
                            break;
                        }
                    }
                    self.expect_punct("]")?;
                    let opt = self.eat_punct("?");
                    e = Expr::Project(Box::new(e), names, opt);
                } else {
                    let name = self.field_name()?;
                    self.expect_punct("]")?;
                    let opt = self.eat_punct("?");
                    e = Expr::Field(Box::new(e), name, opt);
                }
            } else {
                break;
            }
        }
        Ok(e)
    }

    fn primary(&mut self) -> R<Expr> {
        let t = self.span();
        match self.peek().clone() {
            Tok::Number(v, text) => {
                self.bump();
                Ok(Expr::Number(v, text))
            }
            Tok::Text(s) => {
                self.bump();
                Ok(Expr::Text(s))
            }
            Tok::Keyword("null") => {
                self.bump();
                Ok(Expr::Null)
            }
            Tok::Keyword("true") => {
                self.bump();
                Ok(Expr::Bool(true))
            }
            Tok::Keyword("false") => {
                self.bump();
                Ok(Expr::Bool(false))
            }
            Tok::Ident { name, quoted } => {
                self.bump();
                if name == "_" && !quoted {
                    Ok(Expr::Underscore)
                } else {
                    Ok(Expr::Ident(name))
                }
            }
            Tok::Punct("@") => {
                self.bump();
                match self.bump().tok {
                    Tok::Ident { name, .. } => Ok(Expr::Ident(name)),
                    _ => Err(ParseError { message: "Expected a name after \"@\".".into(), start: t.start, end: t.end }),
                }
            }
            Tok::Punct("(") => {
                self.bump();
                let e = self.expr()?;
                self.expect_punct(")")?;
                Ok(e)
            }
            Tok::Punct("{") => {
                self.bump();
                let mut items = Vec::new();
                if !self.is_punct("}") {
                    loop {
                        let item = self.expr()?;
                        if self.eat_punct("..") {
                            let hi = self.expr()?;
                            items.push(Expr::Binary(BinOp::Meta, Box::new(item), Box::new(hi))); // range marker, rejected by the evaluator
                        } else {
                            items.push(item);
                        }
                        if !self.eat_punct(",") {
                            break;
                        }
                    }
                }
                self.expect_punct("}")?;
                Ok(Expr::List(items))
            }
            Tok::Punct("[") => {
                self.bump();
                if self.eat_punct("]") {
                    return Ok(Expr::Record(vec![]));
                }
                // implicit field access: [Name] or [Name]?
                let save = self.pos;
                if let Ok(name) = self.field_name() {
                    if self.is_punct("]") {
                        self.bump();
                        let opt = self.eat_punct("?");
                        return Ok(Expr::ImplicitField(name, opt));
                    }
                }
                self.pos = save;
                let mut fields = Vec::new();
                loop {
                    let name = self.field_name()?;
                    self.expect_punct("=")?;
                    let v = self.expr()?;
                    fields.push((name, v));
                    if !self.eat_punct(",") {
                        break;
                    }
                }
                self.expect_punct("]")?;
                Ok(Expr::Record(fields))
            }
            Tok::Keyword("let") | Tok::Keyword("if") | Tok::Keyword("each") | Tok::Keyword("try") | Tok::Keyword("error") => self.expr(),
            Tok::Keyword("section") | Tok::Keyword("shared") => Err(self.error_here("Section documents are not supported.")),
            Tok::Eof => Err(self.error_here("The expression is incomplete.")),
            _ => Err(self.error_here("Unexpected token.")),
        }
    }
}
