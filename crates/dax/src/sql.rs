//! Compilation of aggregations to DuckDB SQL "where semantics allow".
//!
//! An aggregation over a model column (SUM, AVERAGE, MIN/MAX on non-text columns, COUNT) or COUNTROWS of a
//! model table is compiled when the result is provably the same as the engine's own evaluation:
//! - the column is stored (not calculated), and every filter that reaches the table is a value filter on
//!   stored columns (no row-set filters from table filters or context transition);
//! - no cross-filter (bidirectional / many-to-many) semi-join applies to the table;
//! - relationship paths become LEFT JOINs (an unmatched key sees NULLs, i.e. the blank row);
//! - text keys compare case-insensitively (`lower(...)`), BLANK keys as `IS NULL`.
//!
//! Otherwise the engine evaluates the aggregation itself. Tests check both paths give the same answers.

use crate::data::ModelData;
use crate::eval::{Env, Evaluator};
use crate::filter::{Filter, FilterCtx, Graph};
use crate::model::{ColId, DataType, TableId};
use crate::value::{serial_to_datetime, EvalError, Key, VResult, Value};
use std::collections::BTreeMap;

/// Runs a SQL query that returns one row with one column.
pub trait SqlExecutor {
    fn query_scalar(&self, sql: &str) -> Result<Value, String>;
}

pub fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn quote_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// True when some cross-filter (bidirectional or many-to-many) could restrict `t` in this context.
fn would_semijoin(data: &ModelData, g: &Graph, ctx: &FilterCtx, t: TableId) -> bool {
    fn filtered(data: &ModelData, g: &Graph, ctx: &FilterCtx, t: TableId, visiting: &mut Vec<TableId>) -> bool {
        if ctx.filters.iter().any(|f| g.applies(f, t) && !visiting.iter().any(|&v| g.applies(f, v))) {
            return true;
        }
        edges_filter(data, g, ctx, t, visiting)
    }
    fn edges_filter(data: &ModelData, g: &Graph, ctx: &FilterCtx, t: TableId, visiting: &mut Vec<TableId>) -> bool {
        visiting.push(t);
        let mut any = false;
        for (i, r) in data.model.relationships.iter().enumerate() {
            let st = g.states[i];
            if !st.active {
                continue;
            }
            let (other, ok) = if r.to.table == t {
                (r.from.table, st.from_filters_to)
            } else if r.from.table == t {
                (r.to.table, st.to_filters_from)
            } else {
                continue;
            };
            if ok && !visiting.contains(&other) && filtered(data, g, ctx, other, visiting) {
                any = true;
                break;
            }
        }
        visiting.pop();
        any
    }
    edges_filter(data, g, ctx, t, &mut vec![])
}

fn literal(data: &ModelData, c: ColId, k: &Key) -> Option<String> {
    let dt = data.model.column(c).data_type;
    Some(match k {
        Key::Blank => return None,
        Key::Bool(b) => b.to_string(),
        Key::Str(s) => quote_str(s),
        Key::Int(i) if dt == DataType::DateTime => format!("TIMESTAMP {}", quote_str(&serial_to_datetime(*i as f64)?.format("%Y-%m-%d %H:%M:%S").to_string())),
        Key::Float(bits) if dt == DataType::DateTime => format!("TIMESTAMP {}", quote_str(&serial_to_datetime(f64::from_bits(*bits))?.format("%Y-%m-%d %H:%M:%S%.6f").to_string())),
        Key::Int(i) => i.to_string(),
        Key::Float(bits) => {
            let f = f64::from_bits(*bits);
            if !f.is_finite() {
                return Some("NULL".into());
            }
            format!("{f:?}")
        }
    })
}

fn col_expr(data: &ModelData, alias: &str, c: ColId) -> String {
    let name = format!("{alias}.{}", quote_ident(&data.model.column(c).name));
    if data.model.column(c).data_type == DataType::String {
        format!("lower({name})")
    } else {
        name
    }
}

/// Builds `FROM ... WHERE ...` for the visible rows of `t`, or None when it cannot be expressed exactly.
pub fn from_where(ev: &Evaluator, ctx: &FilterCtx, t: TableId) -> Option<String> {
    let data = ev.data;
    let g = ev.graph(ctx);
    if would_semijoin(data, &g, ctx, t) {
        return None;
    }
    let mut aliases: BTreeMap<TableId, String> = BTreeMap::new();
    aliases.insert(t, "t0".into());
    let mut joins = Vec::new();
    let mut conds = Vec::new();
    for f in ctx.filters.iter().filter(|f| g.applies(f, t)) {
        let Filter::Values { cols, set } = f else { return None };
        if cols.iter().any(|c| data.model.column(*c).expression.is_some()) {
            return None;
        }
        for c in cols {
            if aliases.contains_key(&c.table) {
                continue;
            }
            // join along the path t -> c.table, creating aliases for intermediate tables
            let path = g.path(t, c.table)?.clone();
            let mut cur = t;
            for h in path {
                let rel = &data.model.relationships[h.rel];
                let (next, on_from, on_to) = if h.forward { (rel.to.table, rel.from, rel.to) } else { (rel.from.table, rel.to, rel.from) };
                if !aliases.contains_key(&next) {
                    let a = format!("t{}", aliases.len());
                    joins.push(format!(
                        "LEFT JOIN {} {a} ON {}.{} = {a}.{}",
                        quote_ident(&data.model.tables[next].name),
                        aliases[&cur],
                        quote_ident(&data.model.column(on_from).name),
                        quote_ident(&data.model.column(on_to).name)
                    ));
                    aliases.insert(next, a);
                }
                cur = next;
            }
        }
        if set.is_empty() {
            conds.push("FALSE".to_string());
            continue;
        }
        if cols.len() == 1 {
            let c = cols[0];
            let e = col_expr(data, &aliases[&c.table], c);
            let mut lits = Vec::new();
            let mut blank = false;
            for k in set.iter() {
                match literal(data, c, &k[0]) {
                    Some(l) => lits.push(l),
                    None => blank = true,
                }
            }
            let mut parts = Vec::new();
            if !lits.is_empty() {
                lits.sort();
                parts.push(format!("{e} IN ({})", lits.join(", ")));
            }
            if blank {
                parts.push(format!("{} IS NULL", e));
            }
            conds.push(format!("({})", parts.join(" OR ")));
        } else {
            let mut alts = Vec::new();
            for tuple in set.iter() {
                let mut ands = Vec::new();
                for (c, k) in cols.iter().zip(tuple) {
                    let e = col_expr(data, &aliases[&c.table], *c);
                    ands.push(match literal(data, *c, k) {
                        Some(l) => format!("{e} = {l}"),
                        None => format!("{e} IS NULL"),
                    });
                }
                alts.push(format!("({})", ands.join(" AND ")));
            }
            conds.push(format!("({})", alts.join(" OR ")));
        }
    }
    let mut sql = format!("FROM {} t0", quote_ident(&data.model.tables[t].name));
    for j in joins {
        sql.push(' ');
        sql.push_str(&j);
    }
    if !conds.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conds.join(" AND "));
    }
    Some(sql)
}

fn run(ev: &Evaluator, sql: &str) -> VResult<Value> {
    let exec = ev.sql.expect("checked");
    let v = exec.query_scalar(sql).map_err(|e| EvalError::eval(format!("The data engine failed: {e}")))?;
    ev.sql_hits.set(ev.sql_hits.get() + 1);
    Ok(v)
}

/// Compiles SUM / AVERAGE / MIN / MAX / COUNT of a stored column, if possible.
pub fn try_aggregate(ev: &Evaluator, func: &str, c: ColId, env: &Env) -> VResult<Option<Value>> {
    if ev.sql.is_none() {
        return Ok(None);
    }
    let col = ev.data.model.column(c);
    if col.expression.is_some() {
        return Ok(None);
    }
    let numeric = matches!(col.data_type, DataType::Int64 | DataType::Double | DataType::Decimal);
    let agg = match func {
        "SUM" | "AVERAGE" if numeric => if func == "SUM" { "SUM" } else { "AVG" },
        "MIN" | "MAX" if numeric || matches!(col.data_type, DataType::DateTime | DataType::Boolean) => func,
        "COUNT" => "COUNT",
        _ => return Ok(None),
    };
    let Some(fw) = from_where(ev, &env.filter, c.table) else { return Ok(None) };
    let sql = format!("SELECT {agg}(t0.{}) {fw}", quote_ident(&col.name));
    let mut v = run(ev, &sql)?;
    if agg == "COUNT" && v == Value::Int(0) {
        v = Value::Blank;
    }
    if agg == "AVG" {
        if let Some(f) = v.as_f64().filter(|_| !v.is_blank()) {
            v = Value::Double(f);
        }
    }
    if agg == "SUM" && col.data_type == DataType::Double {
        if let Value::Int(i) = v {
            v = Value::Double(i as f64);
        }
    }
    Ok(Some(v))
}

/// Compiles COUNTROWS(Table), if possible.
pub fn try_count_rows(ev: &Evaluator, t: TableId, env: &Env) -> VResult<Option<Value>> {
    if ev.sql.is_none() {
        return Ok(None);
    }
    let Some(fw) = from_where(ev, &env.filter, t) else { return Ok(None) };
    let v = run(ev, &format!("SELECT COUNT(*) {fw}"))?;
    Ok(Some(if v == Value::Int(0) { Value::Blank } else { v }))
}
