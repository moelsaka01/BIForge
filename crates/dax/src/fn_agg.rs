//! Aggregation tranche beyond the core: AVERAGEA, MINA, MAXA, PRODUCT, PRODUCTX, APPROXIMATEDISTINCTCOUNT.

use crate::bind::BExpr;
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, Val};
use crate::functions::{col_arg, column_values, distinct_values, err, for_each_row};
use crate::value::{VResult, Value};

pub const NAMES: &[&str] = &["AVERAGEA", "MINA", "MAXA", "PRODUCT", "PRODUCTX", "APPROXIMATEDISTINCTCOUNT"];

/// The "A" aggregations count text as 0 and booleans as 1 / 0; BLANK is skipped.
fn a_value(v: Value) -> Option<Value> {
    match v {
        Value::Blank => None,
        Value::Str(_) => Some(Value::Int(0)),
        Value::Bool(b) => Some(Value::Int(b as i64)),
        v => Some(v),
    }
}

fn product(name: &str, vals: impl Iterator<Item = Value>) -> VResult<Value> {
    let mut acc: Option<f64> = None;
    for v in vals {
        match v {
            Value::Blank => {}
            Value::Str(_) | Value::Bool(_) => return Err(err(ErrorCode::TypeMismatch, format!("The function {name} cannot work with values of type {}.", v.type_name()))),
            v => acc = Some(acc.unwrap_or(1.0) * v.as_f64().unwrap()),
        }
    }
    Ok(acc.map(Value::Double).unwrap_or(Value::Blank))
}

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env).map(Val::S))
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    match name {
        "AVERAGEA" => {
            let c = col_arg(name, args, 0)?;
            let vals: Vec<f64> = column_values(ev, c, env).into_iter().filter_map(a_value).map(|v| v.as_f64().unwrap()).collect();
            Ok(if vals.is_empty() { Value::Blank } else { Value::Double(vals.iter().sum::<f64>() / vals.len() as f64) })
        }
        "MINA" | "MAXA" => {
            let c = col_arg(name, args, 0)?;
            crate::functions::extreme(column_values(ev, c, env).into_iter().filter_map(a_value), name == "MAXA")
        }
        "PRODUCT" => {
            let c = col_arg(name, args, 0)?;
            product(name, column_values(ev, c, env).into_iter())
        }
        "PRODUCTX" => {
            let src = ev.table(&args[0], env)?;
            let mut vals = Vec::with_capacity(src.nrows());
            for_each_row(ev, &src, env, |_, e2| {
                vals.push(ev.scalar(&args[1], e2)?);
                Ok(true)
            })?;
            product(name, vals.into_iter())
        }
        "APPROXIMATEDISTINCTCOUNT" => {
            // BIForge counts exactly, which is a valid (error-free) approximation.
            let c = col_arg(name, args, 0)?;
            let n = distinct_values(ev, c, env, true).len();
            Ok(crate::functions::as_count(n))
        }
        _ => unreachable!(),
    }
}
