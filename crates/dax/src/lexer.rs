//! DAX tokenizer. Token set from research/dax-parser.md section 2: `//`, `--` and `/* */` comments,
//! operators (`<> <= >= && || == = < > ^ + - * / &`), parentheses, braces, comma, dot, string, number and
//! `dt"..."` date-time literals, plain / 'quoted' / [bracketed] identifiers, and keywords.

use crate::diag::{Diagnostic, ErrorCode, Span};

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    /// Plain identifier (function, table, variable or keyword-like name such as `DESC`). May contain dots
    /// and digits after the first character (`PERCENTILE.EXC`, `T.DIST.2T`).
    Ident(String),
    /// `'Quoted Table'`
    Quoted(String),
    /// `[Column or measure]`
    Bracket(String),
    Str(String),
    /// Number literal; `is_int` is true when it has no decimal point or exponent.
    Num { text: String, is_int: bool },
    /// `dt"2024-01-31"` or `dt"2024-01-31T10:00:00"`
    DateTime(String),
    Kw(Kw),
    Op(Op),
    LParen,
    RParen,
    LBrace,
    RBrace,
    Comma,
    Eof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kw {
    Var,
    Return,
    Not,
    In,
    Evaluate,
    Define,
    Measure,
    Column,
    Table,
    Function,
    Order,
    By,
    Asc,
    Desc,
    Start,
    At,
    True,
    False,
}

impl Kw {
    pub fn from_ident(s: &str) -> Option<Kw> {
        Some(match s.to_ascii_uppercase().as_str() {
            "VAR" => Kw::Var,
            "RETURN" => Kw::Return,
            "NOT" => Kw::Not,
            "IN" => Kw::In,
            "EVALUATE" => Kw::Evaluate,
            "DEFINE" => Kw::Define,
            "MEASURE" => Kw::Measure,
            "COLUMN" => Kw::Column,
            "TABLE" => Kw::Table,
            "FUNCTION" => Kw::Function,
            "ORDER" => Kw::Order,
            "BY" => Kw::By,
            "ASC" => Kw::Asc,
            "DESC" => Kw::Desc,
            "START" => Kw::Start,
            "AT" => Kw::At,
            "TRUE" => Kw::True,
            "FALSE" => Kw::False,
            _ => return None,
        })
    }
    pub fn text(self) -> &'static str {
        match self {
            Kw::Var => "VAR",
            Kw::Return => "RETURN",
            Kw::Not => "NOT",
            Kw::In => "IN",
            Kw::Evaluate => "EVALUATE",
            Kw::Define => "DEFINE",
            Kw::Measure => "MEASURE",
            Kw::Column => "COLUMN",
            Kw::Table => "TABLE",
            Kw::Function => "FUNCTION",
            Kw::Order => "ORDER",
            Kw::By => "BY",
            Kw::Asc => "ASC",
            Kw::Desc => "DESC",
            Kw::Start => "START",
            Kw::At => "AT",
            Kw::True => "TRUE",
            Kw::False => "FALSE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    Amp,
    Eq,
    StrictEq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
    Dot,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub tok: Tok,
    pub span: Span,
}

/// A comment, kept so editors can colour it.
#[derive(Debug, Clone, PartialEq)]
pub struct Comment {
    pub span: Span,
}

#[derive(Debug, Default)]
pub struct Lexed {
    pub tokens: Vec<Token>,
    pub comments: Vec<Comment>,
    pub errors: Vec<Diagnostic>,
}

/// Tokenizes the whole input. Never panics; malformed input produces diagnostics and the lexer continues.
pub fn lex(src: &str) -> Lexed {
    let mut out = Lexed::default();
    let b = src.as_bytes();
    let mut i = 0;
    let n = b.len();
    let push = |out: &mut Lexed, tok: Tok, s: usize, e: usize| out.tokens.push(Token { tok, span: Span::new(s, e) });
    while i < n {
        let c = b[i];
        let start = i;
        // whitespace (including non-breaking space)
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if src[i..].starts_with('\u{a0}') {
            i += '\u{a0}'.len_utf8();
            continue;
        }
        // comments
        if src[i..].starts_with("//") || src[i..].starts_with("--") {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            out.comments.push(Comment { span: Span::new(start, i) });
            continue;
        }
        if src[i..].starts_with("/*") {
            match src[i + 2..].find("*/") {
                Some(e) => i = i + 2 + e + 2,
                None => {
                    i = n;
                    out.errors.push(Diagnostic::new(ErrorCode::GrammaticalError, "Unterminated comment: missing */.", Span::new(start, n)));
                }
            }
            out.comments.push(Comment { span: Span::new(start, i) });
            continue;
        }
        match c {
            b'(' => {
                push(&mut out, Tok::LParen, i, i + 1);
                i += 1;
            }
            b')' => {
                push(&mut out, Tok::RParen, i, i + 1);
                i += 1;
            }
            b'{' => {
                push(&mut out, Tok::LBrace, i, i + 1);
                i += 1;
            }
            b'}' => {
                push(&mut out, Tok::RBrace, i, i + 1);
                i += 1;
            }
            b',' => {
                push(&mut out, Tok::Comma, i, i + 1);
                i += 1;
            }
            b'+' | b'-' | b'*' | b'/' | b'^' | b'&' | b'|' | b'=' | b'<' | b'>' => {
                let two = if i + 1 < n { &src[i..i + 2] } else { "" };
                let (op, len) = match two {
                    "<>" => (Some(Op::Ne), 2),
                    "<=" => (Some(Op::Le), 2),
                    ">=" => (Some(Op::Ge), 2),
                    "&&" => (Some(Op::And), 2),
                    "||" => (Some(Op::Or), 2),
                    "==" => (Some(Op::StrictEq), 2),
                    _ => (
                        match c {
                            b'+' => Some(Op::Plus),
                            b'-' => Some(Op::Minus),
                            b'*' => Some(Op::Star),
                            b'/' => Some(Op::Slash),
                            b'^' => Some(Op::Caret),
                            b'&' => Some(Op::Amp),
                            b'=' => Some(Op::Eq),
                            b'<' => Some(Op::Lt),
                            b'>' => Some(Op::Gt),
                            _ => None, // single '|'
                        },
                        1,
                    ),
                };
                match op {
                    Some(op) => push(&mut out, Tok::Op(op), i, i + len),
                    None => out.errors.push(Diagnostic::new(ErrorCode::InvalidNameCharacter, "Unexpected character '|'. Did you mean '||'?", Span::new(i, i + 1))),
                }
                i += len;
            }
            b'"' => {
                let (s, end, ok) = quoted(src, i, b'"');
                if !ok {
                    out.errors.push(Diagnostic::new(ErrorCode::GrammaticalError, "Unterminated text: missing closing \".", Span::new(i, end)));
                }
                push(&mut out, Tok::Str(s), i, end);
                i = end;
            }
            b'\'' => {
                let (s, end, ok) = quoted(src, i, b'\'');
                if !ok {
                    out.errors.push(Diagnostic::new(ErrorCode::InvalidIdentifier, "Unterminated table name: missing closing '.", Span::new(i, end)));
                } else if s.trim().is_empty() {
                    out.errors.push(Diagnostic::new(ErrorCode::InvalidIdentifier, "A table name cannot be empty.", Span::new(i, end)));
                }
                push(&mut out, Tok::Quoted(s), i, end);
                i = end;
            }
            b'[' => {
                // ']]' inside brackets is an escaped ']'
                let mut s = String::new();
                let mut j = i + 1;
                let mut ok = false;
                while j < n {
                    if b[j] == b']' {
                        if j + 1 < n && b[j + 1] == b']' {
                            s.push(']');
                            j += 2;
                            continue;
                        }
                        ok = true;
                        j += 1;
                        break;
                    }
                    let ch = src[j..].chars().next().unwrap();
                    if ch == '\n' {
                        break;
                    }
                    s.push(ch);
                    j += ch.len_utf8();
                }
                if !ok {
                    out.errors.push(Diagnostic::new(ErrorCode::InvalidIdentifier, "Unterminated column or measure name: missing ].", Span::new(i, j)));
                } else if s.trim().is_empty() {
                    out.errors.push(Diagnostic::new(ErrorCode::InvalidIdentifier, "A column or measure name cannot be empty.", Span::new(i, j)));
                }
                push(&mut out, Tok::Bracket(s), i, j);
                i = j;
            }
            b'0'..=b'9' | b'.' => {
                if c == b'.' && !(i + 1 < n && b[i + 1].is_ascii_digit()) {
                    push(&mut out, Tok::Op(Op::Dot), i, i + 1);
                    i += 1;
                    continue;
                }
                let (tok, end, err) = number(src, i);
                if let Some(msg) = err {
                    out.errors.push(Diagnostic::new(ErrorCode::IncompleteNumber, msg, Span::new(i, end)));
                }
                push(&mut out, tok, i, end);
                i = end;
            }
            _ => {
                let ch = src[i..].chars().next().unwrap();
                if ch.is_alphabetic() || ch == '_' {
                    let mut j = i + ch.len_utf8();
                    while j < n {
                        let d = src[j..].chars().next().unwrap();
                        if d.is_alphanumeric() || d == '_' || d == '.' {
                            j += d.len_utf8();
                        } else {
                            break;
                        }
                    }
                    let word = &src[i..j];
                    // dt"..." typed date-time literal
                    if word.eq_ignore_ascii_case("dt") && j < n && b[j] == b'"' {
                        let (s, end, ok) = quoted(src, j, b'"');
                        if !ok {
                            out.errors.push(Diagnostic::new(ErrorCode::GrammaticalError, "Unterminated date-time literal.", Span::new(i, end)));
                        }
                        push(&mut out, Tok::DateTime(s), i, end);
                        i = end;
                        continue;
                    }
                    let tok = match Kw::from_ident(word) {
                        Some(k) => Tok::Kw(k),
                        None => Tok::Ident(word.to_string()),
                    };
                    push(&mut out, tok, i, j);
                    i = j;
                } else {
                    let len = ch.len_utf8();
                    out.errors.push(Diagnostic::new(
                        ErrorCode::InvalidNameCharacter,
                        format!("The character '{ch}' is not valid here."),
                        Span::new(i, i + len),
                    ));
                    i += len;
                }
            }
        }
        debug_assert!(i > start);
    }
    out.tokens.push(Token { tok: Tok::Eof, span: Span::new(n, n) });
    out
}

/// Reads a quoted run starting at `i` (the opening quote); a doubled quote is an escaped quote.
fn quoted(src: &str, i: usize, q: u8) -> (String, usize, bool) {
    let b = src.as_bytes();
    let mut s = String::new();
    let mut j = i + 1;
    while j < b.len() {
        if b[j] == q {
            if j + 1 < b.len() && b[j + 1] == q {
                s.push(q as char);
                j += 2;
                continue;
            }
            return (s, j + 1, true);
        }
        let ch = src[j..].chars().next().unwrap();
        s.push(ch);
        j += ch.len_utf8();
    }
    (s, b.len(), false)
}

fn number(src: &str, i: usize) -> (Tok, usize, Option<String>) {
    let b = src.as_bytes();
    let n = b.len();
    let mut j = i;
    let mut is_int = true;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if j < n && b[j] == b'.' {
        is_int = false;
        j += 1;
        while j < n && b[j].is_ascii_digit() {
            j += 1;
        }
    }
    let mut err = None;
    if j < n && (b[j] == b'e' || b[j] == b'E') {
        // only an exponent if followed by digits (or a sign and digits); "1e" is an incomplete number
        is_int = false;
        let mut k = j + 1;
        if k < n && (b[k] == b'+' || b[k] == b'-') {
            k += 1;
        }
        if k < n && b[k].is_ascii_digit() {
            while k < n && b[k].is_ascii_digit() {
                k += 1;
            }
        } else {
            err = Some(format!("Incomplete number '{}': the exponent has no digits.", &src[i..k]));
        }
        j = k;
    }
    // a number running straight into letters (e.g. 12abc) is malformed
    if err.is_none() && j < n {
        let ch = src[j..].chars().next().unwrap();
        if ch.is_alphabetic() || ch == '_' {
            let mut k = j;
            while k < n {
                let d = src[k..].chars().next().unwrap();
                if d.is_alphanumeric() || d == '_' {
                    k += d.len_utf8();
                } else {
                    break;
                }
            }
            err = Some(format!("Incomplete number '{}'.", &src[i..k]));
            j = k;
        }
    }
    (Tok::Num { text: src[i..j].to_string(), is_int }, j, err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &str) -> Vec<Tok> {
        let l = lex(s);
        assert!(l.errors.is_empty(), "{:?}", l.errors);
        l.tokens.into_iter().map(|t| t.tok).filter(|t| *t != Tok::Eof).collect()
    }

    #[test]
    fn operators_and_punctuation() {
        use Op::*;
        assert_eq!(
            toks("<> <= >= && || == = < > ^ + - * / & ( ) { } ,"),
            vec![
                Tok::Op(Ne),
                Tok::Op(Le),
                Tok::Op(Ge),
                Tok::Op(And),
                Tok::Op(Or),
                Tok::Op(StrictEq),
                Tok::Op(Eq),
                Tok::Op(Lt),
                Tok::Op(Gt),
                Tok::Op(Caret),
                Tok::Op(Plus),
                Tok::Op(Minus),
                Tok::Op(Star),
                Tok::Op(Slash),
                Tok::Op(Amp),
                Tok::LParen,
                Tok::RParen,
                Tok::LBrace,
                Tok::RBrace,
                Tok::Comma
            ]
        );
    }

    #[test]
    fn identifiers_of_all_three_kinds_with_escapes() {
        assert_eq!(
            toks("'Sales ''2024''' [Net ]]Amount] PERCENTILE.EXC T.DIST.2T _x Größe"),
            vec![
                Tok::Quoted("Sales '2024'".into()),
                Tok::Bracket("Net ]Amount".into()),
                Tok::Ident("PERCENTILE.EXC".into()),
                Tok::Ident("T.DIST.2T".into()),
                Tok::Ident("_x".into()),
                Tok::Ident("Größe".into()),
            ]
        );
    }

    #[test]
    fn literals() {
        assert_eq!(
            toks(r#"12 1.5 .5 1e3 2.5E-2 "a ""b""" dt"2024-01-31" TRUE false"#),
            vec![
                Tok::Num { text: "12".into(), is_int: true },
                Tok::Num { text: "1.5".into(), is_int: false },
                Tok::Num { text: ".5".into(), is_int: false },
                Tok::Num { text: "1e3".into(), is_int: false },
                Tok::Num { text: "2.5E-2".into(), is_int: false },
                Tok::Str("a \"b\"".into()),
                Tok::DateTime("2024-01-31".into()),
                Tok::Kw(Kw::True),
                Tok::Kw(Kw::False),
            ]
        );
    }

    #[test]
    fn three_comment_styles_are_skipped_and_recorded() {
        let l = lex("1 // a\n-- b\n/* c\n d */ 2");
        let t: Vec<_> = l.tokens.iter().map(|t| t.tok.clone()).collect();
        assert_eq!(t, vec![Tok::Num { text: "1".into(), is_int: true }, Tok::Num { text: "2".into(), is_int: true }, Tok::Eof]);
        assert_eq!(l.comments.len(), 3);
        assert!(l.errors.is_empty());
    }

    #[test]
    fn keywords_are_case_insensitive() {
        assert_eq!(toks("var Return evaluate ORDER by"), vec![Tok::Kw(Kw::Var), Tok::Kw(Kw::Return), Tok::Kw(Kw::Evaluate), Tok::Kw(Kw::Order), Tok::Kw(Kw::By)]);
    }

    #[test]
    fn spans_point_at_the_source() {
        let l = lex("SUM ( [x] )");
        assert_eq!(l.tokens[0].span, Span::new(0, 3));
        assert_eq!(l.tokens[2].span, Span::new(6, 9));
    }

    #[test]
    fn errors_have_codes_and_lexing_continues() {
        let l = lex("1e + 2abc $ [open");
        let codes: Vec<_> = l.errors.iter().map(|e| e.code).collect();
        assert_eq!(codes, vec![ErrorCode::IncompleteNumber, ErrorCode::IncompleteNumber, ErrorCode::InvalidNameCharacter, ErrorCode::InvalidIdentifier]);
        assert_eq!(lex("[]").errors[0].code, ErrorCode::InvalidIdentifier);
        assert_eq!(lex("\"abc").errors[0].code, ErrorCode::GrammaticalError);
        assert_eq!(lex("a | b").errors[0].code, ErrorCode::InvalidNameCharacter);
    }
}
