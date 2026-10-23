//! Record and Value functions of the M standard library, on concrete records and values. Cases: tests/m/stdlib/record.json, value.json.
use crate::ast::BinOp;
use crate::eval::Ev;
use crate::stdlib::{value_is, values_equal};
use crate::value::*;

type R<T> = MResult<T>;

pub const REC_FNS: &[&str] = &[
    "Record.AddField", "Record.Combine", "Record.FieldCount", "Record.FieldOrDefault", "Record.FieldValues", "Record.FromList",
    "Record.HasFields", "Record.RemoveFields", "Record.RenameFields", "Record.ReorderFields", "Record.SelectFields",
    "Record.ToList", "Record.TransformFields", "Value.Add", "Value.Subtract", "Value.Multiply", "Value.Divide", "Value.Equals",
    "Value.Compare", "Value.Is", "Value.As",
];

fn record<'v>(a: &'v [Value], i: usize, f: &str) -> R<&'v Vec<(String, Value)>> {
    match a.get(i) {
        Some(Value::Record(r)) => Ok(r),
        Some(other) => Err(MError::expr(format!("{f}: a record was expected, found {}.", other.type_name()))),
        None => Err(MError::expr(format!("{f}: argument {} is missing.", i + 1))),
    }
}

/// A field name or a list of field names.
fn names(a: &[Value], i: usize, f: &str) -> R<Vec<String>> {
    match a.get(i) {
        Some(Value::Text(t)) => Ok(vec![t.clone()]),
        Some(Value::List(l)) => l.iter().map(|x| if let Value::Text(t) = x { Ok(t.clone()) } else { Err(MError::expr(format!("{f}: field names must be text."))) }).collect(),
        _ => Err(MError::expr(format!("{f}: a field name or a list of field names was expected."))),
    }
}

pub fn call(ev: &Ev, name: &str, a: &[Value]) -> Option<R<Value>> {
    if !REC_FNS.contains(&name) {
        return None;
    }
    Some(dispatch(ev, name, a))
}

fn dispatch(ev: &Ev, name: &str, a: &[Value]) -> R<Value> {
    let arg = |i: usize| a.get(i).ok_or_else(|| MError::expr(format!("{name}: argument {} is missing.", i + 1)));
    let missing_ok = matches!(a.get(2), Some(Value::Num(n)) if *n == 1.0 || *n == 2.0);
    let has = |r: &Vec<(String, Value)>, n: &str| r.iter().any(|(k, _)| k == n);
    match name {
        "Record.AddField" => {
            let mut r = record(a, 0, name)?.clone();
            let Value::Text(n) = arg(1)? else {
                return Err(MError::expr("The field name must be text."));
            };
            if has(&r, n) {
                return Err(MError::expr(format!("The field '{n}' already exists in the record.")));
            }
            r.push((n.clone(), arg(2)?.clone()));
            Ok(Value::Record(r))
        }
        "Record.Combine" => {
            let Value::List(rs) = arg(0)? else {
                return Err(MError::expr("Record.Combine needs a list of records."));
            };
            let mut out: Vec<(String, Value)> = Vec::new();
            for r in rs {
                let Value::Record(fields) = r else {
                    return Err(MError::expr("Record.Combine needs a list of records."));
                };
                for (k, v) in fields {
                    match out.iter_mut().find(|(n, _)| n == k) {
                        Some(slot) => slot.1 = v.clone(),
                        None => out.push((k.clone(), v.clone())),
                    }
                }
            }
            Ok(Value::Record(out))
        }
        "Record.FieldCount" => Ok(Value::Num(record(a, 0, name)?.len() as f64)),
        "Record.FieldOrDefault" => {
            let r = record(a, 0, name)?;
            let Value::Text(n) = arg(1)? else {
                return Err(MError::expr("The field name must be text."));
            };
            Ok(r.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()).unwrap_or_else(|| a.get(2).cloned().unwrap_or(Value::Null)))
        }
        "Record.FieldValues" | "Record.ToList" => Ok(Value::List(record(a, 0, name)?.iter().map(|(_, v)| v.clone()).collect())),
        "Record.FromList" => {
            let Value::List(values) = arg(0)? else {
                return Err(MError::expr("Record.FromList needs a list of values."));
            };
            let ns = names(a, 1, name)?;
            if ns.len() != values.len() {
                return Err(MError::expr("Record.FromList: the list of field names and the list of values must have the same length."));
            }
            Ok(Value::Record(ns.into_iter().zip(values.iter().cloned()).collect()))
        }
        "Record.HasFields" => {
            let r = record(a, 0, name)?;
            Ok(Value::Bool(names(a, 1, name)?.iter().all(|n| has(r, n))))
        }
        "Record.RemoveFields" => {
            let r = record(a, 0, name)?;
            let drop = names(a, 1, name)?;
            if !missing_ok {
                if let Some(m) = drop.iter().find(|n| !has(r, n)) {
                    return Err(MError::expr(format!("The field '{m}' of the record wasn't found.")));
                }
            }
            Ok(Value::Record(r.iter().filter(|(k, _)| !drop.contains(k)).cloned().collect()))
        }
        "Record.SelectFields" => {
            let r = record(a, 0, name)?;
            let keep = names(a, 1, name)?;
            let mut out = Vec::new();
            for n in &keep {
                match r.iter().find(|(k, _)| k == n) {
                    Some(f) => out.push(f.clone()),
                    None if missing_ok => {
                        if matches!(a.get(2), Some(Value::Num(m)) if *m == 2.0) {
                            out.push((n.clone(), Value::Null));
                        }
                    }
                    None => return Err(MError::expr(format!("The field '{n}' of the record wasn't found."))),
                }
            }
            Ok(Value::Record(out))
        }
        "Record.ReorderFields" => {
            let r = record(a, 0, name)?;
            let order = names(a, 1, name)?;
            let mut out: Vec<(String, Value)> = Vec::new();
            for n in &order {
                match r.iter().find(|(k, _)| k == n) {
                    Some(f) => out.push(f.clone()),
                    None if missing_ok => {}
                    None => return Err(MError::expr(format!("The field '{n}' of the record wasn't found."))),
                }
            }
            out.extend(r.iter().filter(|(k, _)| !order.contains(k)).cloned());
            Ok(Value::Record(out))
        }
        "Record.RenameFields" => {
            let r = record(a, 0, name)?;
            let Value::List(pairs) = arg(1)? else {
                return Err(MError::expr("Record.RenameFields needs a list of {old, new} pairs."));
            };
            let pairs: Vec<(String, String)> = if pairs.len() == 2 && pairs.iter().all(|p| matches!(p, Value::Text(_))) {
                match (&pairs[0], &pairs[1]) {
                    (Value::Text(o), Value::Text(n)) => vec![(o.clone(), n.clone())],
                    _ => vec![],
                }
            } else {
                pairs
                    .iter()
                    .map(|p| match p {
                        Value::List(p) if p.len() == 2 => match (&p[0], &p[1]) {
                            (Value::Text(o), Value::Text(n)) => Ok((o.clone(), n.clone())),
                            _ => Err(MError::expr("The names must be text.")),
                        },
                        _ => Err(MError::expr("Record.RenameFields needs a list of {old, new} pairs.")),
                    })
                    .collect::<R<_>>()?
            };
            for (o, _) in &pairs {
                if !has(r, o) && !missing_ok {
                    return Err(MError::expr(format!("The field '{o}' of the record wasn't found.")));
                }
            }
            let out: Vec<(String, Value)> = r.iter().map(|(k, v)| (pairs.iter().find(|(o, _)| o == k).map(|(_, n)| n.clone()).unwrap_or_else(|| k.clone()), v.clone())).collect();
            for (i, (k, _)) in out.iter().enumerate() {
                if out[..i].iter().any(|(k2, _)| k2 == k) {
                    return Err(MError::expr(format!("The field '{k}' already exists in the record.")));
                }
            }
            Ok(Value::Record(out))
        }
        "Record.TransformFields" => {
            let r = record(a, 0, name)?;
            let Value::List(ops) = arg(1)? else {
                return Err(MError::expr("Record.TransformFields needs a list of {name, function} pairs."));
            };
            let single = ops.len() == 2 && matches!(ops[0], Value::Text(_));
            let ops: Vec<&[Value]> = if single {
                vec![ops.as_slice()]
            } else {
                ops.iter().map(|o| if let Value::List(p) = o { Ok(p.as_slice()) } else { Err(MError::expr("Each transformation must be a {name, function} pair.")) }).collect::<R<_>>()?
            };
            let mut out = r.clone();
            for op in ops {
                let (Some(Value::Text(n)), Some(f)) = (op.first(), op.get(1)) else {
                    return Err(MError::expr("Each transformation must be a {name, function} pair."));
                };
                match out.iter_mut().find(|(k, _)| k == n) {
                    Some(slot) => slot.1 = ev.apply(f, vec![slot.1.clone()])?,
                    None if missing_ok => {}
                    None => return Err(MError::expr(format!("The field '{n}' of the record wasn't found."))),
                }
            }
            Ok(Value::Record(out))
        }
        "Value.Add" => ev.binary(BinOp::Add, arg(0)?.clone(), arg(1)?.clone()),
        "Value.Subtract" => ev.binary(BinOp::Sub, arg(0)?.clone(), arg(1)?.clone()),
        "Value.Multiply" => ev.binary(BinOp::Mul, arg(0)?.clone(), arg(1)?.clone()),
        "Value.Divide" => ev.binary(BinOp::Div, arg(0)?.clone(), arg(1)?.clone()),
        "Value.Equals" => ev.binary(BinOp::Eq, arg(0)?.clone(), arg(1)?.clone()),
        "Value.Compare" => match (arg(0)?, arg(1)?) {
            (Value::Num(x), Value::Num(y)) => Ok(Value::Num(match x.partial_cmp(y) {
                Some(std::cmp::Ordering::Less) => -1.0,
                Some(std::cmp::Ordering::Greater) => 1.0,
                _ => 0.0,
            })),
            (Value::Text(x), Value::Text(y)) => Ok(Value::Num(match x.cmp(y) {
                std::cmp::Ordering::Less => -1.0,
                std::cmp::Ordering::Greater => 1.0,
                std::cmp::Ordering::Equal => 0.0,
            })),
            (x, y) if values_equal(x, y) => Ok(Value::Num(0.0)),
            (Value::Null, _) => Ok(Value::Num(-1.0)),
            (_, Value::Null) => Ok(Value::Num(1.0)),
            _ => Err(MError::expr("Value.Compare compares two numbers or two texts.")),
        },
        "Value.Is" | "Value.As" => {
            let Value::Type(t) = arg(1)? else {
                return Err(MError::expr(format!("{name}: the second argument must be a type.")));
            };
            let ok = value_is(arg(0)?, t)?;
            if name == "Value.Is" {
                Ok(Value::Bool(ok))
            } else if ok {
                Ok(arg(0)?.clone())
            } else {
                Err(MError::expr("We cannot convert the value to the requested type."))
            }
        }
        _ => Err(MError::unsupported(format!("{name} is not supported yet."))),
    }
}
