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
    /// The same rows with the error-flag columns (`__err__<column>`, true = error cell) after the visible ones; None
    /// when no column has error cells.
    pub flags_sql: Option<String>,
    /// The columns that have error flags.
    pub flagged: Vec<String>,
}

fn to_out(c: &[Col]) -> Vec<ColumnOut> {
    c.iter().filter(|c| c.ty != NESTED_TY && !c.is_flag()).map(|c| ColumnOut { name: c.name.clone(), duckdb_type: c.ty.clone() }).collect()
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
            let flagged = rel.flagged();
            let flags_sql = if flagged.is_empty() { None } else { Some(rel.to_sql_flags(limit)) };
            Ok(TableSql { sql: rel.to_sql(limit), columns: to_out(&rel.cols), flags_sql, flagged })
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

/// The data type the values of each text column convert to without an error: "int64", "number", "logical", "date",
/// "datetime", or "text" (no other type fits, or the column is empty or not text). Looks at every row.
pub fn detect_types(be: &dyn Backend, queries: &BTreeMap<String, String>, query: &str, step: Option<&str>, columns: &[String]) -> MResult<Vec<(String, String)>> {
    let ev = Ev::new(be, queries);
    let v = match step {
        Some(s) => {
            let (scope, _) = ev.open_let(query)?.ok_or_else(|| MError::expr(format!("The query \"{query}\" has no steps.")))?;
            ev.lookup(&scope, s)?.ok_or_else(|| MError::expr(format!("The step \"{s}\" does not exist.")))?
        }
        None => ev.lookup(&ev.global, query)?.ok_or_else(|| MError::expr(format!("The query \"{query}\" does not exist.")))?,
    };
    let Value::Table(rel) = v else { return Err(MError::expr("The value is not a table.")) };
    let mut out = Vec::new();
    for name in columns {
        let col = rel.col(name).ok_or_else(|| MError::expr(format!("The column '{name}' of the table wasn't found.")))?;
        if !col.ty.eq_ignore_ascii_case("VARCHAR") {
            out.push((name.clone(), "text".to_string()));
            continue;
        }
        let tried = |t: &str| -> MResult<String> {
            let e = ev.convert_sql("v", "VARCHAR", &crate::ast::TypeExpr::Named(t.into()))?.unwrap_or_else(|| "v".into());
            Ok(e.replace("CAST(", "TRY_CAST(").replace("strptime(", "try_strptime("))
        };
        let stripped = "NULLIF(replace(trim(v), ',', ''), '')";
        let date = tried("date")?;
        let datetime = tried("datetime")?;
        let candidates: [(&str, String); 5] = [
            ("logical", "lower(trim(v)) IN ('true', 'false')".to_string()),
            ("int64", format!("regexp_matches({stripped}, '^[+-]?[0-9]+$')")),
            ("number", format!("regexp_matches({stripped}, '^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?$')")),
            ("date", format!("{date} IS NOT NULL")),
            ("datetime", format!("{datetime} IS NOT NULL")),
        ];
        let mut sel = vec!["count(*) FILTER (WHERE NULLIF(trim(v), '') IS NOT NULL)".to_string()];
        sel.extend(candidates.iter().map(|(_, p)| format!("count(*) FILTER (WHERE NULLIF(trim(v), '') IS NOT NULL AND ({p}))")));
        let sql = format!("{}SELECT {} FROM (SELECT {} AS v FROM {}) AS d", rel.prefix(), sel.join(", "), qi(name), qi(&rel.name));
        let row = be.rows(&sql, 1).map_err(MError::expr)?.into_iter().next().unwrap_or_default();
        let n = |i: usize| row.get(i).and_then(|c| c.as_deref()).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        let total = n(0);
        let found = if total == 0 { "text" } else { candidates.iter().enumerate().find(|(i, _)| n(i + 1) == total).map(|(_, (t, _))| *t).unwrap_or("text") };
        out.push((name.clone(), found.to_string()));
    }
    Ok(out)
}

/// A query or step whose value is not a table (a parameter, `Table.RowCount(...)`, a statistic, a list), shown as text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueOut {
    /// "number", "text", "logical", "null", "list" or "record".
    pub kind: String,
    /// The value as the editor shows it (a list says how many items it has).
    pub text: String,
    /// The first items of a list or the fields of a record ("name: value"), empty for a single value.
    pub items: Vec<String>,
}

fn render(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", *n as i64),
        Value::Num(n) => format!("{n}"),
        Value::Text(t) => t.clone(),
        Value::List(items) => format!("List ({} item{})", items.len(), if items.len() == 1 { "" } else { "s" }),
        Value::Record(f) => format!("Record ({} field{})", f.len(), if f.len() == 1 { "" } else { "s" }),
        other => format!("[{}]", other.type_name()),
    }
}

/// The value of `step` of `query` (or of the whole query), when it is not a table.
pub fn value_out(be: &dyn Backend, queries: &BTreeMap<String, String>, query: &str, step: Option<&str>) -> MResult<ValueOut> {
    let ev = Ev::new(be, queries);
    let v = match step {
        Some(s) => {
            let (scope, _) = ev.open_let(query)?.ok_or_else(|| MError::expr(format!("The query \"{query}\" has no steps.")))?;
            ev.lookup(&scope, s)?.ok_or_else(|| MError::expr(format!("The step \"{s}\" does not exist.")))?
        }
        None => ev.lookup(&ev.global, query)?.ok_or_else(|| MError::expr(format!("The query \"{query}\" does not exist.")))?,
    };
    let items: Vec<String> = match &v {
        Value::List(items) => items.iter().take(1000).map(render).collect(),
        Value::Record(f) => f.iter().take(1000).map(|(k, x)| format!("{k}: {}", render(x))).collect(),
        _ => vec![],
    };
    match v {
        Value::Table(_) => Err(MError::expr("The value is a table.")),
        other if other.is_symbolic() => Err(MError::expr(format!("The value is {}, not a single value.", other.type_name()))),
        other => Ok(ValueOut { kind: other.type_name().to_string(), text: render(&other), items }),
    }
}
