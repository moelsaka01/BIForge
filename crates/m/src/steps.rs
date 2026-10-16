//! Applied Steps: the steps of a query's top-level `let` as editable data, and text edits that keep references intact.
//! Edits rebuild the `let` text from the steps (expression text is kept verbatim; comments between steps are not kept).
use crate::ast::Expr;
use crate::lexer::{lex, Tok};
use crate::parse;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInfo {
    pub name: String,
    pub raw_name: String,
    /// Text of the step's expression.
    pub expr: String,
    /// Name of the function the expression calls first (`Table.SelectRows`), when it is a call.
    pub function: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedQuery {
    pub steps: Vec<StepInfo>,
    /// Text of the `in` expression.
    pub output: String,
}

/// M identifier or `#"quoted"` form of a step name.
pub fn raw_name(name: &str) -> String {
    let plain = !name.is_empty()
        && name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_alphanumeric() || c == '_')
        && !matches!(
            name,
            "and" | "as" | "each" | "else" | "error" | "false" | "if" | "in" | "is" | "let" | "meta" | "not" | "null" | "or" | "otherwise" | "section" | "shared" | "then" | "true" | "try" | "type"
        );
    if plain {
        name.to_string()
    } else {
        format!("#\"{}\"", name.replace('"', "\"\""))
    }
}

/// M text literal.
pub fn m_text(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\"").replace('\r', "#(cr)").replace('\n', "#(lf)").replace('\t', "#(tab)"))
}

fn call_name(e: &Expr) -> Option<String> {
    match e {
        Expr::Invoke(f, _) => match &**f {
            Expr::Ident(n) => Some(n.clone()),
            _ => None,
        },
        _ => None,
    }
}

pub fn parse_query(text: &str) -> Result<ParsedQuery, String> {
    let e = parse(text).map_err(|e| e.to_string())?;
    match e {
        Expr::Let { bindings, body_span, .. } => Ok(ParsedQuery {
            steps: bindings
                .iter()
                .map(|b| StepInfo {
                    name: b.name.clone(),
                    raw_name: b.raw_name.clone(),
                    expr: text[b.expr_span.start..b.expr_span.end].to_string(),
                    function: call_name(&b.expr),
                })
                .collect(),
            output: text[body_span.start..body_span.end].to_string(),
        }),
        _ => Err("This query is not a let ... in expression, so it has no applied steps.".into()),
    }
}

/// Canonical text of a query.
pub fn build_query(steps: &[(String, String)], output: &str) -> String {
    let body: Vec<String> = steps.iter().map(|(n, e)| format!("    {n} = {e}")).collect();
    format!("let\n{}\nin\n    {output}", body.join(",\n"))
}

fn to_pairs(q: &ParsedQuery) -> Vec<(String, String)> {
    q.steps.iter().map(|s| (s.raw_name.clone(), s.expr.clone())).collect()
}

/// Replaces identifier tokens named `old` in `expr` by `new_raw`.
fn rewrite(expr: &str, old: &str, new_raw: &str) -> String {
    let Ok(toks) = lex(expr) else { return expr.to_string() };
    let mut out = String::new();
    let mut last = 0;
    for t in toks {
        if let Tok::Ident { name, .. } = &t.tok {
            if name == old {
                out.push_str(&expr[last..t.span.start]);
                out.push_str(new_raw);
                last = t.span.end;
            }
        }
    }
    out.push_str(&expr[last..]);
    out
}

fn refs(expr: &str, name: &str) -> bool {
    lex(expr).map(|t| t.iter().any(|t| matches!(&t.tok, Tok::Ident { name: n, .. } if n == name))).unwrap_or(false)
}

pub fn unique_step_name(text: &str, base: &str) -> String {
    let existing: Vec<String> = parse_query(text).map(|q| q.steps.into_iter().map(|s| s.name).collect()).unwrap_or_default();
    if !existing.iter().any(|n| n == base) {
        return base.to_string();
    }
    let mut i = 1;
    loop {
        let n = format!("{base}{i}");
        if !existing.iter().any(|e| *e == n) {
            return n;
        }
        i += 1;
    }
}

/// Inserts a step after `after` (None = after the last step). Later steps and the output that used `after` now use the new step.
pub fn insert_step(text: &str, after: Option<&str>, name: &str, expr: &str) -> Result<String, String> {
    let q = parse_query(text)?;
    if q.steps.iter().any(|s| s.name == name) {
        return Err(format!("A step named \"{name}\" already exists."));
    }
    let pos = match after {
        Some(a) => q.steps.iter().position(|s| s.name == a).ok_or_else(|| format!("The step \"{a}\" does not exist."))?,
        None => q.steps.len().checked_sub(1).ok_or("The query has no steps.")?,
    };
    let anchor = q.steps[pos].name.clone();
    let new_raw = raw_name(name);
    let mut pairs = Vec::new();
    for (i, (n, e)) in to_pairs(&q).into_iter().enumerate() {
        if i > pos {
            pairs.push((n, rewrite(&e, &anchor, &new_raw)));
        } else {
            pairs.push((n, e));
        }
        if i == pos {
            pairs.push((new_raw.clone(), expr.to_string()));
        }
    }
    let output = rewrite(&q.output, &anchor, &new_raw);
    Ok(build_query(&pairs, &output))
}

pub fn delete_step(text: &str, name: &str) -> Result<String, String> {
    let q = parse_query(text)?;
    let pos = q.steps.iter().position(|s| s.name == name).ok_or_else(|| format!("The step \"{name}\" does not exist."))?;
    if q.steps.len() == 1 {
        return Err("The last remaining step cannot be deleted.".into());
    }
    // what depended on this step now depends on its input (the first argument of its call)
    let input = match parse(&q.steps[pos].expr) {
        Ok(Expr::Invoke(_, args)) => match args.first() {
            Some(Expr::Ident(n)) if q.steps.iter().any(|s| s.name == *n) => Some(n.clone()),
            _ => None,
        },
        Ok(Expr::Ident(n)) if q.steps.iter().any(|s| s.name == n) => Some(n),
        _ => None,
    };
    let dependents = q.steps.iter().enumerate().any(|(i, s)| i != pos && refs(&s.expr, name)) || refs(&q.output, name);
    let replacement = match (&input, dependents) {
        (Some(i), _) => Some(raw_name(i)),
        (None, true) => return Err(format!("The step \"{name}\" cannot be deleted: later steps use it and it has no input step to fall back to.")),
        (None, false) => None,
    };
    let mut pairs = Vec::new();
    for (i, (n, e)) in to_pairs(&q).into_iter().enumerate() {
        if i == pos {
            continue;
        }
        pairs.push((n, match &replacement {
            Some(r) => rewrite(&e, name, r),
            None => e,
        }));
    }
    let output = match &replacement {
        Some(r) => rewrite(&q.output, name, r),
        None => q.output.clone(),
    };
    Ok(build_query(&pairs, &output))
}

pub fn rename_step(text: &str, old: &str, new: &str) -> Result<String, String> {
    let q = parse_query(text)?;
    if new.trim().is_empty() {
        return Err("A step name cannot be empty.".into());
    }
    if !q.steps.iter().any(|s| s.name == old) {
        return Err(format!("The step \"{old}\" does not exist."));
    }
    if old != new && q.steps.iter().any(|s| s.name == new) {
        return Err(format!("A step named \"{new}\" already exists."));
    }
    let new_raw = raw_name(new);
    let pairs: Vec<(String, String)> = to_pairs(&q)
        .into_iter()
        .map(|(n, e)| (if n == raw_name(old) || n == old { new_raw.clone() } else { n }, rewrite(&e, old, &new_raw)))
        .collect();
    Ok(build_query(&pairs, &rewrite(&q.output, old, &new_raw)))
}

pub fn set_step_expr(text: &str, name: &str, expr: &str) -> Result<String, String> {
    let q = parse_query(text)?;
    parse(expr).map_err(|e| e.to_string())?;
    let pos = q.steps.iter().position(|s| s.name == name).ok_or_else(|| format!("The step \"{name}\" does not exist."))?;
    let mut pairs = to_pairs(&q);
    pairs[pos].1 = expr.trim().to_string();
    Ok(build_query(&pairs, &q.output))
}

/// Moves a step up (`delta` < 0) or down; refuses when it would make steps depend on each other in a cycle.
pub fn move_step(text: &str, name: &str, delta: i32) -> Result<String, String> {
    let q = parse_query(text)?;
    let pos = q.steps.iter().position(|s| s.name == name).ok_or_else(|| format!("The step \"{name}\" does not exist."))?;
    let to = pos as i32 + delta;
    if to < 0 || to as usize >= q.steps.len() {
        return Err("The step cannot move further.".into());
    }
    let mut steps = q.steps.clone();
    let s = steps.remove(pos);
    steps.insert(to as usize, s);
    // a step may only use steps above it (the Power Query editor shows steps top to bottom)
    for (i, s) in steps.iter().enumerate() {
        for later in &steps[i..] {
            if later.name != s.name && refs(&s.expr, &later.name) {
                return Err(format!("The step \"{}\" uses \"{}\", so it cannot move above it.", s.name, later.name));
            }
        }
    }
    let pairs = steps.iter().map(|s| (s.raw_name.clone(), s.expr.clone())).collect::<Vec<_>>();
    Ok(build_query(&pairs, &q.output))
}

/// Deletes `name` and every step after it ("Delete Until End").
pub fn delete_from(text: &str, name: &str) -> Result<String, String> {
    let q = parse_query(text)?;
    let pos = q.steps.iter().position(|s| s.name == name).ok_or_else(|| format!("The step \"{name}\" does not exist."))?;
    if pos == 0 {
        return Err("The first step cannot be deleted together with everything after it.".into());
    }
    let kept = &q.steps[..pos];
    let last = raw_name(&kept[kept.len() - 1].name);
    let pairs = kept.iter().map(|s| (s.raw_name.clone(), s.expr.clone())).collect::<Vec<_>>();
    Ok(build_query(&pairs, &last))
}

/// Steps (in order) that the step `name` depends on, directly or not.
pub fn step_dependencies(text: &str, name: &str) -> Result<Vec<String>, String> {
    let q = parse_query(text)?;
    let mut seen: Vec<String> = Vec::new();
    let mut todo = vec![name.to_string()];
    while let Some(n) = todo.pop() {
        if let Some(s) = q.steps.iter().find(|s| s.name == n) {
            for other in &q.steps {
                if other.name != n && refs(&s.expr, &other.name) && !seen.contains(&other.name) {
                    seen.push(other.name.clone());
                    todo.push(other.name.clone());
                }
            }
        }
    }
    Ok(q.steps.iter().map(|s| s.name.clone()).filter(|n| seen.contains(n)).collect())
}

/// Replaces every use of the name `old` in `text` (a whole query) with `new`; used when a query is renamed.
pub fn rename_references(text: &str, old: &str, new: &str) -> String {
    rewrite(text, old, &raw_name(new))
}
