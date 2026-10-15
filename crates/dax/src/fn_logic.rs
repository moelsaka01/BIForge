//! Logical tranche and the information functions: IF.EAGER, IFERROR, SWITCH, BIT*, ISERROR, ISNUMBER, ISTEXT,
//! ISNONTEXT, ISLOGICAL, ISEVEN, ISODD, HASONEFILTER, CONTAINS, CONTAINSROW, CONTAINSSTRING(EXACT),
//! LOOKUPVALUE, USERCULTURE.

use crate::ast::BinOp;
use crate::bind::BExpr;
use crate::diag::ErrorCode;
use crate::eval::{binary, Env, Evaluator, Val};
use crate::functions::{col_arg, distinct_values, err};
use crate::model::ColId;
use crate::table::TableVal;
use crate::value::{self, VResult, Value};

pub const NAMES: &[&str] = &[
    "IF.EAGER", "IFERROR", "SWITCH", "BITAND", "BITOR", "BITXOR", "BITLSHIFT", "BITRSHIFT", "ISERROR", "ISNUMBER", "ISTEXT", "ISNONTEXT", "ISLOGICAL", "ISEVEN", "ISODD",
    "HASONEFILTER", "CONTAINS", "CONTAINSROW", "CONTAINSSTRING", "CONTAINSSTRINGEXACT", "LOOKUPVALUE", "USERCULTURE",
];

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env).map(Val::S))
}

/// Position of a model column in a table value.
fn col_index(ev: &Evaluator, t: &TableVal, c: ColId) -> Option<usize> {
    match t {
        TableVal::Base { table, .. } if *table == c.table => ev.data.model.columns_of(*table).position(|x| x == c),
        TableVal::Base { .. } => None,
        TableVal::Mat(m) => m.cols.iter().position(|x| x.lineage == Some(c)),
    }
}

/// A recoverable evaluation error: IFERROR / ISERROR catch these, but not a missing implementation.
fn caught(e: &value::EvalError) -> bool {
    e.code != ErrorCode::NotImplemented
}

fn to_bits(name: &str, v: &Value) -> VResult<i64> {
    let f = v.to_f64()?;
    if !f.is_finite() || f.abs() >= 9.2e18 {
        return Err(err(ErrorCode::InvalidValue, format!("The function {name} cannot work with a value of this size.")));
    }
    Ok(f.trunc() as i64)
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    match name {
        "IF.EAGER" => {
            let c = ev.scalar(&args[0], env)?.to_bool()?;
            let yes = ev.scalar(&args[1], env)?;
            let no = if args.len() > 2 && !args[2].is_missing() { ev.scalar(&args[2], env)? } else { Value::Blank };
            Ok(if c { yes } else { no })
        }
        "IFERROR" => match ev.scalar(&args[0], env) {
            Err(e) if caught(&e) => ev.scalar(&args[1], env),
            other => other,
        },
        "ISERROR" => Ok(Value::Bool(matches!(ev.scalar(&args[0], env), Err(ref e) if caught(e)))),
        "SWITCH" => {
            let subject = ev.scalar(&args[0], env)?;
            let rest = &args[1..];
            let pairs = rest.len() / 2;
            for p in 0..pairs {
                let candidate = ev.scalar(&rest[2 * p], env)?;
                if binary(BinOp::Eq, &subject, &candidate)? == Value::Bool(true) {
                    return ev.scalar(&rest[2 * p + 1], env);
                }
            }
            if rest.len() % 2 == 1 {
                ev.scalar(&rest[rest.len() - 1], env)
            } else {
                Ok(Value::Blank)
            }
        }
        "BITAND" | "BITOR" | "BITXOR" => {
            let (a, b) = (ev.scalar(&args[0], env)?, ev.scalar(&args[1], env)?);
            if a.is_blank() || b.is_blank() {
                return Ok(Value::Blank);
            }
            let (x, y) = (to_bits(name, &a)?, to_bits(name, &b)?);
            Ok(Value::Int(match name {
                "BITAND" => x & y,
                "BITOR" => x | y,
                _ => x ^ y,
            }))
        }
        "BITLSHIFT" | "BITRSHIFT" => {
            let (a, b) = (ev.scalar(&args[0], env)?, ev.scalar(&args[1], env)?);
            if a.is_blank() || b.is_blank() {
                return Ok(Value::Blank);
            }
            let (x, mut n) = (to_bits(name, &a)?, to_bits(name, &b)?);
            // a negative shift count shifts the other way
            let mut left = name == "BITLSHIFT";
            if n < 0 {
                left = !left;
                n = -n;
            }
            Ok(Value::Int(if n >= 64 {
                0
            } else if left {
                ((x as u64) << n) as i64
            } else {
                ((x as u64) >> n) as i64
            }))
        }
        "ISNUMBER" => Ok(Value::Bool(matches!(ev.scalar(&args[0], env)?, Value::Int(_) | Value::Double(_) | Value::Currency(_)))),
        "ISTEXT" => Ok(Value::Bool(matches!(ev.scalar(&args[0], env)?, Value::Str(_)))),
        "ISNONTEXT" => Ok(Value::Bool(!matches!(ev.scalar(&args[0], env)?, Value::Str(_)))),
        "ISLOGICAL" => Ok(Value::Bool(matches!(ev.scalar(&args[0], env)?, Value::Bool(_)))),
        "ISEVEN" | "ISODD" => {
            let v = ev.scalar(&args[0], env)?;
            if v.is_blank() {
                return Ok(Value::Blank);
            }
            let n = v.to_f64()?.trunc();
            let even = n % 2.0 == 0.0;
            Ok(Value::Bool(if name == "ISEVEN" { even } else { !even }))
        }
        "HASONEFILTER" => {
            let c = col_arg(name, args, 0)?;
            Ok(Value::Bool(env.filter.is_filtered_column(c) && distinct_values(ev, c, env, true).len() == 1))
        }
        "USERCULTURE" => Ok(Value::str("en-US")),
        "CONTAINSSTRING" | "CONTAINSSTRINGEXACT" => {
            let within = ev.scalar(&args[0], env)?;
            let find = ev.scalar(&args[1], env)?;
            let (w, f) = (within.to_text(), find.to_text());
            Ok(Value::Bool(if name == "CONTAINSSTRING" { w.to_lowercase().contains(&f.to_lowercase()) } else { w.contains(&f) }))
        }
        "CONTAINS" => {
            let t = ev.table(&args[0], env)?;
            if args.len() < 3 || args.len() % 2 == 0 {
                return Err(err(ErrorCode::MissingParameters, "CONTAINS expects a table followed by pairs of a column and a value."));
            }
            let mut want = Vec::new();
            for p in args[1..].chunks(2) {
                let c = p[0].col().ok_or_else(|| err(ErrorCode::InvalidParameter, "CONTAINS expects column references."))?;
                let i = col_index(ev, &t, c).ok_or_else(|| err(ErrorCode::InvalidParameter, format!("CONTAINS: column {} is not in the table.", ev.data.model.column_name(c))))?;
                want.push((i, ev.scalar(&p[1], env)?));
            }
            let found = (0..t.nrows()).any(|r| want.iter().all(|(i, v)| value::compare(&t.value(ev.data, r, *i), v).map(|o| o.is_eq()).unwrap_or(false)));
            Ok(Value::Bool(found))
        }
        "CONTAINSROW" => {
            let t = ev.table(&args[0], env)?;
            let vals = args[1..].iter().map(|a| ev.scalar(a, env)).collect::<VResult<Vec<_>>>()?;
            if vals.len() != t.ncols(ev.data) {
                return Err(err(ErrorCode::InvalidParameter, format!("CONTAINSROW: the table has {} column(s) but {} value(s) were given.", t.ncols(ev.data), vals.len())));
            }
            let found = (0..t.nrows()).any(|r| vals.iter().enumerate().all(|(i, v)| value::strict_eq(v, &t.value(ev.data, r, i)).unwrap_or(false)));
            Ok(Value::Bool(found))
        }
        "LOOKUPVALUE" => {
            let result = col_arg(name, args, 0)?;
            let n = args.len() - 1;
            let (pairs, alt) = if n % 2 == 1 { (&args[1..args.len() - 1], Some(&args[args.len() - 1])) } else { (&args[1..], None) };
            if pairs.is_empty() {
                return Err(err(ErrorCode::MissingParameters, "LOOKUPVALUE expects at least one search column and value."));
            }
            let mut tests = Vec::new();
            for p in pairs.chunks(2) {
                let c = p[0].col().ok_or_else(|| err(ErrorCode::InvalidParameter, "LOOKUPVALUE expects column references as search columns."))?;
                if c.table != result.table {
                    return Err(err(ErrorCode::NotImplemented, "LOOKUPVALUE with search columns from another table is not implemented in BIForge yet."));
                }
                tests.push((c, ev.scalar(&p[1], env)?));
            }
            let mut found: Option<Value> = None;
            for r in ev.all_rows(result.table, false) {
                if tests.iter().all(|(c, v)| value::compare(ev.data.value(*c, r), v).map(|o| o.is_eq()).unwrap_or(false)) {
                    let x = ev.data.value(result, r).clone();
                    match &found {
                        None => found = Some(x),
                        Some(prev) if value::strict_eq(prev, &x).unwrap_or(false) => {}
                        Some(_) => return Err(err(ErrorCode::InvalidValue, "A table of multiple values was supplied where a single value was expected.")),
                    }
                }
            }
            match (found, alt) {
                (Some(v), _) => Ok(v),
                (None, Some(a)) => ev.scalar(a, env),
                (None, None) => Ok(Value::Blank),
            }
        }
        _ => unreachable!(),
    }
}
