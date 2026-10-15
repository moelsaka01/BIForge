//! Generic TMDL (Tabular Model Definition Language) reader and writer.
//!
//! This layer is purely syntactic: it turns TMDL text into a tree of objects
//! (`kind name = default` + properties + children) and prints it back in a
//! canonical form. Interpreting object kinds (tables, measures, ...) is the job
//! of a typed layer above this one. Rules implemented are described in
//! `research/pbip-tmdl-format.md`.
//!
//! Known limitation: within one object, properties are stored separately from
//! child objects, so the printer emits all properties first, then children.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    /// 1-based line number.
    pub line: usize,
    pub message: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for ParseError {}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Document {
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Node {
    /// Lines of the `///` description block above the object (without the marker).
    pub description: Vec<String>,
    /// Object type token, e.g. `table`, `measure`; `ref table` for ref statements.
    pub kind: String,
    /// Unquoted object name.
    pub name: Option<String>,
    /// Default property / expression given after `=` in the declaration.
    pub default: Option<Expr>,
    pub props: Vec<Prop>,
    pub children: Vec<Node>,
}

/// Expression text; lines are joined with `\n`, outer indentation removed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Expr {
    pub text: String,
    /// Was written between triple-backtick fences (kept verbatim).
    pub verbatim: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prop {
    pub key: String,
    pub value: PropValue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropValue {
    /// Bare property name, meaning "true".
    Flag,
    /// `key: value` (surrounding double quotes removed).
    Text(String),
    /// `key = expression`, single or multi-line.
    Expr(Expr),
}

impl Node {
    pub fn new(kind: &str, name: Option<&str>) -> Self {
        Node {
            kind: kind.to_string(),
            name: name.map(str::to_string),
            ..Node::default()
        }
    }

    pub fn prop(&self, key: &str) -> Option<&PropValue> {
        self.props.iter().find(|p| p.key == key).map(|p| &p.value)
    }

    pub fn text_prop(&self, key: &str) -> Option<&str> {
        match self.prop(key) {
            Some(PropValue::Text(s)) => Some(s),
            _ => None,
        }
    }

    pub fn has_flag(&self, key: &str) -> bool {
        matches!(self.prop(key), Some(PropValue::Flag))
    }
}

// ---------------------------------------------------------------- parsing

#[derive(Clone, Copy, PartialEq, Eq)]
enum IndentStyle {
    Tabs,
    Spaces(usize),
}

struct Line<'a> {
    num: usize,
    text: &'a str,
}

enum Classified<'a> {
    Flag(&'a str),
    Prop(&'a str, &'a str),
    PropEq(&'a str, &'a str),
    Decl(&'a str, &'a str),
}

struct Parser<'a> {
    lines: Vec<Line<'a>>,
    style: IndentStyle,
    pos: usize,
}

pub fn parse(input: &str) -> Result<Document, ParseError> {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let lines: Vec<Line> = input
        .split('\n')
        .enumerate()
        .map(|(i, l)| Line {
            num: i + 1,
            text: l.strip_suffix('\r').unwrap_or(l),
        })
        .collect();
    let style = detect_style(&lines)?;
    let mut p = Parser { lines, style, pos: 0 };
    let mut nodes = Vec::new();
    let mut desc: Vec<String> = Vec::new();
    let mut desc_line = 0;
    while p.pos < p.lines.len() {
        let line = &p.lines[p.pos];
        if is_blank(line.text) {
            if !desc.is_empty() {
                return Err(err(desc_line, "description is not directly above an object"));
            }
            p.pos += 1;
            continue;
        }
        let (lvl, rest) = p.level_of(line.text);
        if lvl != 0 {
            return Err(err(line.num, "unexpected indentation at top level"));
        }
        p.check_header_indent(line, rest)?;
        if let Some(d) = description_text(rest) {
            if desc.is_empty() {
                desc_line = line.num;
            }
            desc.push(d);
            p.pos += 1;
            continue;
        }
        match classify(rest) {
            Classified::Decl(kind, tail) => {
                let d = std::mem::take(&mut desc);
                nodes.push(p.parse_decl(0, kind, tail, d)?);
            }
            _ => return Err(err(line.num, "expected an object declaration at top level")),
        }
    }
    if !desc.is_empty() {
        return Err(err(desc_line, "description is not followed by an object"));
    }
    Ok(Document { nodes })
}

fn err(line: usize, message: &str) -> ParseError {
    ParseError {
        line,
        message: message.to_string(),
    }
}

fn is_blank(s: &str) -> bool {
    s.trim().is_empty()
}

fn detect_style(lines: &[Line]) -> Result<IndentStyle, ParseError> {
    for l in lines {
        if is_blank(l.text) || !l.text.starts_with([' ', '\t']) {
            continue;
        }
        if l.text.starts_with('\t') {
            return Ok(IndentStyle::Tabs);
        }
        let n = l.text.len() - l.text.trim_start_matches(' ').len();
        return Ok(IndentStyle::Spaces(n));
    }
    Ok(IndentStyle::Tabs)
}

fn description_text(rest: &str) -> Option<String> {
    let t = rest.strip_prefix("///")?;
    let t = t.strip_prefix(' ').unwrap_or(t);
    Some(t.trim_end().to_string())
}

/// Splits a header line into its first token and what follows.
fn classify(text: &str) -> Classified<'_> {
    let end = text
        .find(|c: char| c.is_whitespace() || c == ':' || c == '=')
        .unwrap_or(text.len());
    let (tok, rest) = text.split_at(end);
    let rest = rest.trim_start();
    if rest.is_empty() {
        Classified::Flag(tok)
    } else if let Some(v) = rest.strip_prefix(':') {
        Classified::Prop(tok, v.trim())
    } else if let Some(v) = rest.strip_prefix('=') {
        Classified::PropEq(tok, v.trim())
    } else {
        Classified::Decl(tok, rest)
    }
}

/// Reads a possibly single-quoted name; returns (name, remaining text).
fn parse_name(s: &str) -> Result<(String, &str), String> {
    if let Some(body) = s.strip_prefix('\'') {
        let mut name = String::new();
        let mut chars = body.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            if c == '\'' {
                if let Some(&(_, '\'')) = chars.peek() {
                    name.push('\'');
                    chars.next();
                } else {
                    return Ok((name, body[i + 1..].trim_start()));
                }
            } else {
                name.push(c);
            }
        }
        Err("unterminated quoted name".to_string())
    } else {
        let end = s
            .find(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or(s.len());
        Ok((s[..end].to_string(), s[end..].trim_start()))
    }
}

fn unquote_value(v: &str) -> String {
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        v[1..v.len() - 1].replace("\"\"", "\"")
    } else {
        v.to_string()
    }
}

impl<'a> Parser<'a> {
    /// Returns (level, text after indentation units). Extra spaces beyond whole
    /// units stay in the returned text so block lines keep relative indentation.
    fn level_of<'t>(&self, text: &'t str) -> (usize, &'t str) {
        match self.style {
            IndentStyle::Tabs => {
                let n = text.len() - text.trim_start_matches('\t').len();
                (n, &text[n..])
            }
            IndentStyle::Spaces(unit) => {
                let n = text.len() - text.trim_start_matches(' ').len();
                let lvl = n / unit;
                (lvl, &text[lvl * unit..])
            }
        }
    }

    fn check_header_indent(&self, line: &Line, rest: &str) -> Result<(), ParseError> {
        if rest.starts_with([' ', '\t']) {
            return Err(err(line.num, "inconsistent indentation"));
        }
        Ok(())
    }

    fn strip_units<'t>(&self, text: &'t str, units: usize) -> &'t str {
        match self.style {
            IndentStyle::Tabs => {
                let have = text.len() - text.trim_start_matches('\t').len();
                &text[have.min(units)..]
            }
            IndentStyle::Spaces(unit) => {
                let have = text.len() - text.trim_start_matches(' ').len();
                &text[have.min(units * unit)..]
            }
        }
    }

    /// Parses an object whose declaration line is at `self.pos`.
    fn parse_decl(
        &mut self,
        level: usize,
        kind: &str,
        tail: &str,
        description: Vec<String>,
    ) -> Result<Node, ParseError> {
        let line_num = self.lines[self.pos].num;
        self.pos += 1;
        let (kind, tail) = if kind == "ref" {
            let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
            if end == 0 || end == tail.len() {
                return Err(err(line_num, "ref needs an object type and a name"));
            }
            (format!("ref {}", &tail[..end]), tail[end..].trim_start())
        } else {
            (kind.to_string(), tail)
        };
        let (name, after) = parse_name(tail).map_err(|m| err(line_num, &m))?;
        let mut node = Node {
            description,
            kind,
            name: Some(name),
            ..Node::default()
        };
        if let Some(d) = after.strip_prefix('=') {
            node.default = Some(self.read_expr(d.trim(), level + 2, line_num)?);
        } else if !after.is_empty() {
            return Err(err(line_num, "unexpected text after object name"));
        }
        self.parse_body(level, &mut node)?;
        Ok(node)
    }

    fn parse_body(&mut self, level: usize, node: &mut Node) -> Result<(), ParseError> {
        let mut desc: Vec<String> = Vec::new();
        let mut desc_line = 0;
        while self.pos < self.lines.len() {
            let text = self.lines[self.pos].text;
            let num = self.lines[self.pos].num;
            if is_blank(text) {
                if !desc.is_empty() {
                    return Err(err(desc_line, "description is not directly above an object"));
                }
                self.pos += 1;
                continue;
            }
            let (lvl, rest) = self.level_of(text);
            if lvl <= level {
                break;
            }
            if lvl != level + 1 {
                return Err(err(num, "unexpected indentation"));
            }
            if rest.starts_with([' ', '\t']) {
                return Err(err(num, "inconsistent indentation"));
            }
            if let Some(d) = description_text(rest) {
                if desc.is_empty() {
                    desc_line = num;
                }
                desc.push(d);
                self.pos += 1;
                continue;
            }
            match classify(rest) {
                Classified::Decl(kind, tail) => {
                    let d = std::mem::take(&mut desc);
                    let child = self.parse_decl(level + 1, kind, tail, d)?;
                    node.children.push(child);
                }
                other => {
                    if !desc.is_empty() {
                        return Err(err(desc_line, "description is not directly above an object"));
                    }
                    self.pos += 1;
                    let prop = match other {
                        Classified::Flag(k) => Prop {
                            key: k.to_string(),
                            value: PropValue::Flag,
                        },
                        Classified::Prop(k, v) => Prop {
                            key: k.to_string(),
                            value: PropValue::Text(unquote_value(v)),
                        },
                        Classified::PropEq(k, v) => Prop {
                            key: k.to_string(),
                            value: PropValue::Expr(self.read_expr(v, lvl + 1, num)?),
                        },
                        Classified::Decl(..) => unreachable!(),
                    };
                    node.props.push(prop);
                }
            }
        }
        if !desc.is_empty() {
            return Err(err(desc_line, "description is not followed by an object"));
        }
        Ok(())
    }

    /// Reads an expression whose first line text is `first` (the text after `=`).
    /// `self.pos` is already past the line carrying the `=`.
    fn read_expr(&mut self, first: &str, base: usize, line_num: usize) -> Result<Expr, ParseError> {
        if first == "```" {
            return self.read_fence(line_num);
        }
        if !first.is_empty() {
            return Ok(Expr {
                text: first.to_string(),
                verbatim: false,
            });
        }
        let mut collected: Vec<String> = Vec::new();
        let mut last_real = 0usize; // number of collected lines up to last non-blank
        let mut j = self.pos;
        let mut next_pos = self.pos;
        while j < self.lines.len() {
            let text = self.lines[j].text;
            if is_blank(text) {
                collected.push(String::new());
            } else {
                let (lvl, _) = self.level_of(text);
                if lvl < base {
                    break;
                }
                collected.push(self.strip_units(text, base).trim_end().to_string());
                last_real = collected.len();
                next_pos = j + 1;
            }
            j += 1;
        }
        collected.truncate(last_real);
        self.pos = next_pos;
        Ok(Expr {
            text: collected.join("\n"),
            verbatim: false,
        })
    }

    fn read_fence(&mut self, open_line: usize) -> Result<Expr, ParseError> {
        let mut body: Vec<&str> = Vec::new();
        let mut j = self.pos;
        while j < self.lines.len() {
            let t = self.lines[j].text;
            if t.trim() == "```" {
                let fence_indent = t.len() - t.trim_start().len();
                let lines: Vec<String> = body
                    .iter()
                    .map(|l| {
                        let have = l.len() - l.trim_start().len();
                        l[have.min(fence_indent)..].to_string()
                    })
                    .collect();
                self.pos = j + 1;
                return Ok(Expr {
                    text: lines.join("\n"),
                    verbatim: true,
                });
            }
            body.push(t);
            j += 1;
        }
        Err(err(open_line, "unterminated ``` block"))
    }
}

// --------------------------------------------------------------- printing

fn needs_quotes_name(n: &str) -> bool {
    n.is_empty() || n.chars().any(|c| c.is_whitespace() || matches!(c, '.' | '=' | ':' | '\''))
}

fn quote_name(n: &str) -> String {
    if needs_quotes_name(n) {
        format!("'{}'", n.replace('\'', "''"))
    } else {
        n.to_string()
    }
}

fn quote_value(v: &str) -> String {
    let needs = v.starts_with('"')
        || v.ends_with('"')
        || v.starts_with(char::is_whitespace)
        || v.ends_with(char::is_whitespace);
    if needs {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

fn needs_fence(e: &Expr) -> bool {
    e.verbatim
        || e.text.starts_with('\n')
        || e.text.ends_with('\n')
        || e.text.split('\n').any(|l| l.ends_with([' ', '\t']))
        || e.text.split('\n').any(|l| l.trim() == "```")
}

fn write_expr_tail(out: &mut String, e: &Expr, block_level: usize) {
    let ind = "\t".repeat(block_level);
    if needs_fence(e) {
        out.push_str(" = ```\n");
        for l in e.text.split('\n') {
            if !l.is_empty() {
                out.push_str(&ind);
                out.push_str(l);
            }
            out.push('\n');
        }
        out.push_str(&ind);
        out.push_str("```\n");
    } else if e.text.contains('\n') {
        out.push_str(" =\n");
        for l in e.text.split('\n') {
            if !l.is_empty() {
                out.push_str(&ind);
                out.push_str(l);
            }
            out.push('\n');
        }
    } else if e.text.is_empty() {
        out.push_str(" =\n");
    } else {
        out.push_str(" = ");
        out.push_str(&e.text);
        out.push('\n');
    }
}

fn print_node(out: &mut String, n: &Node, level: usize) {
    let ind = "\t".repeat(level);
    for d in &n.description {
        out.push_str(&ind);
        out.push_str("///");
        if !d.is_empty() {
            out.push(' ');
            out.push_str(d);
        }
        out.push('\n');
    }
    out.push_str(&ind);
    out.push_str(&n.kind);
    if let Some(name) = &n.name {
        out.push(' ');
        out.push_str(&quote_name(name));
    }
    match &n.default {
        Some(e) => write_expr_tail(out, e, level + 2),
        None => out.push('\n'),
    }
    let pind = "\t".repeat(level + 1);
    for p in &n.props {
        out.push_str(&pind);
        out.push_str(&p.key);
        match &p.value {
            PropValue::Flag => out.push('\n'),
            PropValue::Text(v) => {
                out.push(':');
                if !v.is_empty() {
                    out.push(' ');
                    out.push_str(&quote_value(v));
                }
                out.push('\n');
            }
            PropValue::Expr(e) => write_expr_tail(out, e, level + 2),
        }
    }
    for c in &n.children {
        out.push('\n');
        print_node(out, c, level + 1);
    }
}

/// Prints a document in canonical form (tabs, LF, blank line between objects,
/// consecutive `ref` lines of the same kind kept together).
pub fn print(doc: &Document) -> String {
    let mut out = String::new();
    let mut prev: Option<&Node> = None;
    for n in &doc.nodes {
        if let Some(p) = prev {
            let both_refs_same = n.kind.starts_with("ref ")
                && p.kind == n.kind
                && n.description.is_empty()
                && p.props.is_empty()
                && p.children.is_empty();
            if !both_refs_same {
                out.push('\n');
            }
        }
        print_node(&mut out, n, 0);
        prev = Some(n);
    }
    out
}
