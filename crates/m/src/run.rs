//! Entry points used by the engine and the app: evaluate a query, its steps, or get the SQL of its result.
use crate::backend::Backend;
use crate::eval::Ev;
use crate::value::*;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnOut {
    pub name: String,
    pub duckdb_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorOut {
    pub reason: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub name: String,
    /// "table" when the step is a table (it has columns), otherwise the kind of value ("number", "text", "list", ...).
    pub kind: String,
    pub columns: Vec<ColumnOut>,
    pub error: Option<ErrorOut>,
}

/// A table result as a SQL statement (ordered, without the hidden ordering column).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSql {
    pub sql: String,
    pub columns: Vec<ColumnOut>,
}

fn to_out(c: &[Col]) -> Vec<ColumnOut> {
    c.iter().filter(|c| c.ty != NESTED_TY).map(|c| ColumnOut { name: c.name.clone(), duckdb_type: c.ty.clone() }).collect()
}

fn step_result(name: &str, r: MResult<Value>) -> StepResult {
    match r {
        Ok(Value::Table(rel)) => StepResult { name: name.into(), kind: "table".into(), columns: to_out(&rel.cols), error: None },
        Ok(v) => StepResult { name: name.into(), kind: v.type_name().into(), columns: vec![], error: None },
        Err(e) => StepResult { name: name.into(), kind: "error".into(), columns: vec![], error: Some(ErrorOut { reason: e.reason, message: e.message }) },
    }
}

/// Evaluates every step of `query` on its own (a failing step does not stop the others; its dependents fail too).
pub fn analyze_steps(be: &dyn Backend, queries: &BTreeMap<String, String>, query: &str) -> MResult<Vec<StepResult>> {
    let ev = Ev::new(be, queries);
    match ev.open_let(query)? {
        Some((scope, names)) => Ok(names
            .iter()
            .map(|n| {
                let r = ev.lookup(&scope, n).map(|v| v.unwrap_or(Value::Null));
                step_result(n, r)
            })
            .collect()),
        None => {
            let r = ev.lookup(&ev.global, query).map(|v| v.unwrap_or(Value::Null));
            Ok(vec![step_result("(result)", r)])
        }
    }
}

/// The table produced by `step` of `query`, or by the whole query when `step` is None.
pub fn table_sql(be: &dyn Backend, queries: &BTreeMap<String, String>, query: &str, step: Option<&str>, limit: Option<usize>) -> MResult<TableSql> {
    let ev = Ev::new(be, queries);
    let v = match step {
        Some(s) => {
            let (scope, _) = ev.open_let(query)?.ok_or_else(|| MError::expr(format!("The query \"{query}\" has no steps.")))?;
            ev.lookup(&scope, s)?.ok_or_else(|| MError::expr(format!("The step \"{s}\" does not exist.")))?
        }
        None => ev.lookup(&ev.global, query)?.ok_or_else(|| MError::expr(format!("The query \"{query}\" does not exist.")))?,
    };
    match v {
        Value::Table(rel) => {
            if !rel.nested.is_empty() {
                return Err(MError::unsupported("The result still has a nested table column; expand or remove it."));
            }
            Ok(TableSql { sql: rel.to_sql(limit), columns: to_out(&rel.cols) })
        }
        other => Err(MError::expr(format!("The query result is {}, not a table.", other.type_name()))),
    }
}

/// Kind of value a query produces (for the queries pane): "table", "function", "number", ...
pub fn query_kind(be: &dyn Backend, queries: &BTreeMap<String, String>, query: &str) -> String {
    let ev = Ev::new(be, queries);
    match ev.lookup(&ev.global, query) {
        Ok(Some(v)) => v.type_name().to_string(),
        Ok(None) => "unknown".into(),
        Err(_) => "error".into(),
    }
}

/// Names of other queries that the text of `query` refers to (identifier tokens that name a query).
pub fn dependencies(queries: &BTreeMap<String, String>, query: &str) -> Vec<String> {
    let Some(text) = queries.get(query) else { return vec![] };
    let Ok(toks) = crate::lexer::lex(text) else { return vec![] };
    let own_steps: Vec<String> = match crate::parse(text) {
        Ok(crate::ast::Expr::Let { bindings, .. }) => bindings.into_iter().map(|b| b.name).collect(),
        _ => vec![],
    };
    let mut out: Vec<String> = Vec::new();
    for t in toks {
        if let crate::lexer::Tok::Ident { name, .. } = t.tok {
            if name != query && queries.contains_key(&name) && !own_steps.contains(&name) && !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}
