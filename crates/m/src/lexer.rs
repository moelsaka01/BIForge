//! M lexer. Offsets are byte offsets into the source.
use crate::ast::Span;

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    /// Identifier; `quoted` is true for `#"..."`.
    Ident { name: String, quoted: bool },
    Keyword(&'static str),
    Number(f64, String),
    Text(String),
    Punct(&'static str),
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub tok: Tok,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub message: String,
    pub start: usize,
    pub end: usize,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (at {})", self.message, self.start)
    }
}
impl std::error::Error for ParseError {}

const KEYWORDS: &[&str] = &[
    "and", "as", "each", "else", "error", "false", "if", "in", "is", "let", "meta", "not", "null", "or", "otherwise", "section",
    "shared", "then", "true", "try", "type",
];

const PUNCT3: &[&str] = &["..."];
const PUNCT2: &[&str] = &["=>", "<=", ">=", "<>", ".."];
const PUNCT1: &[&str] = &["(", ")", "[", "]", "{", "}", ",", ";", "=", "<", ">", "+", "-", "*", "/", "&", "@", "!", "?"];

fn err(message: impl Into<String>, start: usize, end: usize) -> ParseError {
    ParseError { message: message.into(), start, end }
}

pub fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_'
}
pub fn is_ident_part(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Parses the body of a text literal (after the opening quote); returns the text and the offset after the closing quote.
fn lex_text(src: &str, mut i: usize) -> Result<(String, usize), ParseError> {
    let start = i - 1;
    let mut out = String::new();
    loop {
        if i >= src.len() {
            return Err(err("The text literal is not closed.", start, src.len()));
        }
        let c = src[i..].chars().next().unwrap();
        match c {
            '"' => {
                if src[i + 1..].starts_with('"') {
                    out.push('"');
                    i += 2;
                } else {
                    return Ok((out, i + 1));
                }
            }
            '#' if src[i + 1..].starts_with('(') => {
                let close = src[i..].find(')').ok_or_else(|| err("An escape sequence #( is not closed.", i, src.len()))? + i;
                let inner = &src[i + 2..close];
                for part in inner.split(',') {
                    let p = part.trim();
                    match p {
                        "cr" => out.push('\r'),
                        "lf" => out.push('\n'),
                        "tab" => out.push('\t'),
                        "#" => out.push('#'),
                        _ => {
                            if (p.len() == 4 || p.len() == 8) && p.chars().all(|c| c.is_ascii_hexdigit()) {
                                let cp = u32::from_str_radix(p, 16).unwrap();
                                out.push(char::from_u32(cp).ok_or_else(|| err("Invalid character escape.", i, close))?);
                            } else {
                                return Err(err(format!("Unknown escape sequence \"{p}\"."), i, close + 1));
                            }
                        }
                    }
                }
                i = close + 1;
            }
            _ => {
                out.push(c);
                i += c.len_utf8();
            }
        }
    }
}

pub fn lex(src: &str) -> Result<Vec<Token>, ParseError> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < src.len() {
        let c = src[i..].chars().next().unwrap();
        if c.is_whitespace() || c == '\u{feff}' {
            i += c.len_utf8();
            continue;
        }
        if src[i..].starts_with("//") {
            i = src[i..].find('\n').map(|n| i + n).unwrap_or(src.len());
            continue;
        }
        if src[i..].starts_with("/*") {
            let end = src[i + 2..].find("*/").ok_or_else(|| err("The comment is not closed.", i, src.len()))?;
            i += 2 + end + 2;
            continue;
        }
        let start = i;
        if c == '"' {
            let (t, next) = lex_text(src, i + 1)?;
            out.push(Token { tok: Tok::Text(t), span: Span { start, end: next } });
            i = next;
            continue;
        }
        if c == '#' {
            if src[i + 1..].starts_with('"') {
                let (t, next) = lex_text(src, i + 2)?;
                out.push(Token { tok: Tok::Ident { name: t, quoted: true }, span: Span { start, end: next } });
                i = next;
                continue;
            }
            // intrinsic names: #table, #date, ...
            let rest = &src[i + 1..];
            let n = rest.find(|ch: char| !is_ident_part(ch)).unwrap_or(rest.len());
            if n == 0 {
                return Err(err("Unexpected character \"#\".", i, i + 1));
            }
            let name = format!("#{}", &rest[..n]);
            i += 1 + n;
            match name.as_str() {
                "#infinity" => out.push(Token { tok: Tok::Number(f64::INFINITY, name), span: Span { start, end: i } }),
                "#nan" => out.push(Token { tok: Tok::Number(f64::NAN, name), span: Span { start, end: i } }),
                "#binary" | "#date" | "#datetime" | "#datetimezone" | "#duration" | "#sections" | "#shared" | "#table" | "#time" => {
                    out.push(Token { tok: Tok::Ident { name, quoted: false }, span: Span { start, end: i } })
                }
                _ => return Err(err(format!("Unknown intrinsic \"{name}\"."), start, i)),
            }
            continue;
        }
        if c.is_ascii_digit() {
            let rest = &src[i..];
            if rest.starts_with("0x") || rest.starts_with("0X") {
                let n = rest[2..].find(|ch: char| !ch.is_ascii_hexdigit()).unwrap_or(rest.len() - 2);
                if n == 0 {
                    return Err(err("A hexadecimal number needs digits.", i, i + 2));
                }
                let v = u64::from_str_radix(&rest[2..2 + n], 16).map_err(|_| err("The hexadecimal number is too large.", i, i + 2 + n))? as f64;
                out.push(Token { tok: Tok::Number(v, rest[..2 + n].to_string()), span: Span { start, end: i + 2 + n } });
                i += 2 + n;
                continue;
            }
            let bytes = rest.as_bytes();
            let mut n = 0;
            while n < bytes.len() && bytes[n].is_ascii_digit() {
                n += 1;
            }
            if n + 1 < bytes.len() && bytes[n] == b'.' && bytes[n + 1].is_ascii_digit() {
                n += 1;
                while n < bytes.len() && bytes[n].is_ascii_digit() {
                    n += 1;
                }
            }
            if n < bytes.len() && (bytes[n] == b'e' || bytes[n] == b'E') {
                let mut m = n + 1;
                if m < bytes.len() && (bytes[m] == b'+' || bytes[m] == b'-') {
                    m += 1;
                }
                if m < bytes.len() && bytes[m].is_ascii_digit() {
                    while m < bytes.len() && bytes[m].is_ascii_digit() {
                        m += 1;
                    }
                    n = m;
                }
            }
            let text = &rest[..n];
            let v: f64 = text.parse().map_err(|_| err(format!("\"{text}\" is not a valid number."), i, i + n))?;
            out.push(Token { tok: Tok::Number(v, text.to_string()), span: Span { start, end: i + n } });
            i += n;
            continue;
        }
        if is_ident_start(c) {
            let mut end = i;
            loop {
                let rest = &src[end..];
                let n = rest.find(|ch: char| !is_ident_part(ch)).unwrap_or(rest.len());
                end += n;
                // dotted names: Table.SelectRows
                let after = &src[end..];
                if after.starts_with('.') && !after.starts_with("..") && after[1..].chars().next().is_some_and(is_ident_start) {
                    end += 1;
                } else {
                    break;
                }
            }
            let word = &src[i..end];
            if let Some(k) = KEYWORDS.iter().find(|k| **k == word) {
                out.push(Token { tok: Tok::Keyword(k), span: Span { start, end } });
            } else {
                out.push(Token { tok: Tok::Ident { name: word.to_string(), quoted: false }, span: Span { start, end } });
            }
            i = end;
            continue;
        }
        let rest = &src[i..];
        if let Some(p) = PUNCT3.iter().chain(PUNCT2).chain(PUNCT1).find(|p| rest.starts_with(**p)) {
            out.push(Token { tok: Tok::Punct(p), span: Span { start, end: i + p.len() } });
            i += p.len();
            continue;
        }
        return Err(err(format!("Unexpected character \"{c}\"."), i, i + c.len_utf8()));
    }
    out.push(Token { tok: Tok::Eof, span: Span { start: src.len(), end: src.len() } });
    Ok(out)
}
