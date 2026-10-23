//! Calculation group functions: SELECTEDMEASURE, SELECTEDMEASURENAME, ISSELECTEDMEASURE. They only mean something inside a
//! calculation item, where they stand for the measure the item replaces.

use crate::bind::{BExpr, BKind};
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, Val};
use crate::functions::err;
use crate::value::{VResult, Value};

pub const NAMES: &[&str] = &["SELECTEDMEASURE", "SELECTEDMEASURENAME", "ISSELECTEDMEASURE", "NAMEOF", "ISINSCOPE"];

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env).map(Val::S))
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    // ISINSCOPE(column): the query groups by the column at the current level
    if name == "ISINSCOPE" {
        return match args.first().and_then(|a| a.col()) {
            Some(c) => Ok(Value::Bool(env.filter.scope.contains(&c))),
            None => Err(err(ErrorCode::InvalidParameter, "ISINSCOPE expects a column reference.")),
        };
    }
    // NAMEOF(Table[Column]) or NAMEOF([Measure]): the name of a field as text, for field parameters
    if name == "NAMEOF" {
        let q = |t: &str| t.replace('\x27', "''");
        return match args.first().map(|a| &a.kind) {
            Some(BKind::Col(c)) => Ok(Value::str(&format!("'{}'[{}]", q(&ev.data.model.tables[c.table].name), ev.data.model.column(*c).name))),
            Some(BKind::Measure(m)) => Ok(Value::str(&format!("[{}]", ev.measure_name(*m)))),
            _ => Err(err(ErrorCode::InvalidParameter, "NAMEOF expects a column or a measure.")),
        };
    }
    let current = ev.selected_measures.borrow().last().copied();
    let Some(m) = current else {
        return Err(err(ErrorCode::InvalidValue, format!("{name} can only be used in a calculation item.")));
    };
    match name {
        "SELECTEDMEASURE" => ev.eval_measure_with(m, env, false),
        "SELECTEDMEASURENAME" => Ok(Value::str(&ev.measure_name(m))),
        _ => {
            let hit = args.iter().any(|a| matches!(&a.kind, BKind::Measure(x) if *x == m));
            Ok(Value::Bool(hit))
        }
    }
}
