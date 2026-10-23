//! Runs DAX queries: `DEFINE` (MEASURE, VAR, TABLE) and one or more `EVALUATE` with ORDER BY / START AT.

use crate::ast::{Define, Query};
use crate::bind::{BExpr, Binder, QueryScope};
use crate::diag::ErrorCode;
use crate::eval::{Engine, Env, Evaluator, QueryMeasure, RowRef};
use crate::sql::SqlExecutor;
use crate::table::{header, TableVal};
use crate::value::{sort_cmp, EvalError, VResult, Value};
use std::cell::OnceCell;
use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq)]
pub struct ResultTable {
    /// `Table[Column]` for model columns, `[Name]` for computed ones.
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

impl Engine {
    /// Parses and runs a query; one result per EVALUATE.
    pub fn query(&self, src: &str) -> VResult<Vec<ResultTable>> {
        self.query_with(src, None)
    }

    pub fn query_with(&self, src: &str, sql: Option<&dyn SqlExecutor>) -> VResult<Vec<ResultTable>> {
        let q = crate::parser::parse_query(src)?;
        run_query(self, &q, sql)
    }
}

struct Bound {
    vars: Vec<(usize, BExpr)>,
    evaluates: Vec<(BExpr, Vec<(BExpr, bool)>, Vec<BExpr>)>,
}

fn run_query(engine: &Engine, q: &Query, sql: Option<&dyn SqlExecutor>) -> VResult<Vec<ResultTable>> {
    let model = &engine.data.model;
    let mut scope = QueryScope::default();
    let mut measure_defs = Vec::new();
    let mut table_defs = Vec::new();
    for d in &q.defines {
        match d {
            Define::Measure { table, name, expr, .. } => {
                let t = model.table_id(table).ok_or_else(|| EvalError::new(ErrorCode::UnrecognizedIdentifier, format!("Cannot find table '{table}'.")))?;
                scope.measures.insert(name.to_lowercase(), measure_defs.len());
                measure_defs.push((name.clone(), t, expr));
            }
            Define::Table { name, expr, .. } => {
                scope.tables.insert(name.to_lowercase(), table_defs.len());
                table_defs.push(expr);
            }
            Define::Column { .. } => return Err(EvalError::new(ErrorCode::NotImplemented, "DEFINE COLUMN is not implemented in BIForge yet.")),
            Define::Function { .. } => return Err(EvalError::new(ErrorCode::NotImplemented, "DEFINE FUNCTION is not implemented in BIForge yet.")),
            Define::Var(_) => {}
        }
    }
    // query variables: bound in order, each visible to the later definitions and to every EVALUATE
    let mut slot = 0;
    let mut bound = Bound { vars: vec![], evaluates: vec![] };
    for d in &q.defines {
        if let Define::Var(v) = d {
            let b = Binder::new(model, &scope, slot + 1000).bind(&v.expr)?;
            scope.vars.push((v.name.to_lowercase(), slot));
            bound.vars.push((slot, b));
            slot += 1;
        }
    }
    let first = 1000 + 10_000;
    let mut ev = Evaluator::new(&engine.data);
    if let Some(s) = sql {
        ev = ev.with_sql(s);
    }
    for (name, t, expr) in &measure_defs {
        let b = Binder::new(model, &scope, first).bind(expr)?;
        ev.query_measures.push(QueryMeasure { name: name.clone(), table: *t, expr: b });
    }
    for expr in &table_defs {
        let b = Binder::new(model, &scope, first).bind(expr)?;
        ev.query_tables.push((b, OnceCell::new()));
    }
    for e in &q.evaluates {
        let mut b = Binder::new(model, &scope, first);
        let main = b.bind(&e.expr)?;
        let keys = e.order_by.iter().map(|k| Ok((b.bind(&k.expr)?, k.descending))).collect::<VResult<Vec<_>>>()?;
        let start = e.start_at.iter().map(|x| b.bind(x).map_err(EvalError::from)).collect::<VResult<Vec<_>>>()?;
        bound.evaluates.push((main, keys, start));
    }
    let mut env = Env::empty();
    for (slot, expr) in &bound.vars {
        let v = ev.eval(expr, &env)?;
        env = env.bind_value(*slot, v);
    }
    let mut out = Vec::new();
    for (main, keys, start) in &bound.evaluates {
        out.push(evaluate_one(&ev, main, keys, start, &env)?);
    }
    if let Some(e) = engine.data.take_load_error() {
        return Err(EvalError::eval(format!("The data engine failed: {e}")));
    }
    Ok(out)
}

fn evaluate_one<'a>(ev: &'a Evaluator<'a>, main: &'a BExpr, keys: &'a [(BExpr, bool)], start: &'a [BExpr], env: &Env<'a>) -> VResult<ResultTable> {
    let t = match ev.eval(main, env)? {
        crate::eval::Val::T(t) => t,
        crate::eval::Val::S(_) => return Err(EvalError::new(ErrorCode::InvalidParameter, "The expression specified in the query is not a valid table expression.")),
    };
    let cols = t.cols(ev.data);
    let m = t.to_mat(ev.data);
    let mut rows: Vec<(Vec<Value>, Vec<Value>)> = Vec::with_capacity(m.rows.len());
    for i in 0..m.rows.len() {
        let row_env = match &t {
            TableVal::Base { table, rows } => env.push_row(RowRef::Base { table: *table, row: rows[i] }),
            TableVal::Mat(mm) => env.push_row(RowRef::Mat { t: mm.clone(), row: i }),
        };
        let k = keys.iter().map(|(x, _)| ev.scalar(x, &row_env)).collect::<VResult<Vec<_>>>()?;
        rows.push((k, m.rows[i].clone()));
    }
    if !keys.is_empty() {
        rows.sort_by(|a, b| {
            for (i, (_, desc)) in keys.iter().enumerate() {
                let o = sort_cmp(&a.0[i], &b.0[i]);
                let o = if *desc { o.reverse() } else { o };
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        });
    }
    if !start.is_empty() {
        let sv = start.iter().map(|x| ev.scalar(x, env)).collect::<VResult<Vec<_>>>()?;
        let pos = rows.iter().position(|(k, _)| {
            for (i, s) in sv.iter().enumerate() {
                let o = sort_cmp(&k[i], s);
                let o = if keys[i].1 { o.reverse() } else { o };
                if o != Ordering::Equal {
                    return o == Ordering::Greater;
                }
            }
            true
        });
        rows.drain(..pos.unwrap_or(rows.len()));
    }
    Ok(ResultTable { columns: cols.iter().map(|c| header(ev.data, c)).collect(), rows: rows.into_iter().map(|(_, r)| r).collect() })
}
