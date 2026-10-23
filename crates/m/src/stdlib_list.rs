//! List functions of the M standard library that work on concrete lists (literals, step results). Lists of values computed
//! in SQL from table columns are not supported here; the aggregates in stdlib.rs cover those. Cases: tests/m/stdlib/list*.json.
use crate::eval::Ev;
use crate::stdlib::values_equal;
use crate::value::*;
use std::cmp::Ordering;

type R<T> = MResult<T>;

pub const LIST_FNS: &[&str] = &[
    "List.Accumulate", "List.AllTrue", "List.AnyTrue", "List.ContainsAll", "List.ContainsAny", "List.Difference", "List.FirstN",
    "List.Generate", "List.InsertRange", "List.Intersect", "List.IsDistinct", "List.LastN", "List.MatchesAll", "List.MatchesAny",
    "List.MaxN", "List.MinN", "List.Mode", "List.Modes", "List.PositionOf", "List.PositionOfAny", "List.Positions", "List.Product",
    "List.Range", "List.RemoveFirstN", "List.RemoveItems", "List.RemoveLastN", "List.RemoveMatchingItems", "List.RemoveNulls",
    "List.RemoveRange", "List.Repeat", "List.ReplaceMatchingItems", "List.ReplaceRange", "List.ReplaceValue", "List.Single",
    "List.SingleOrDefault", "List.Skip", "List.Split", "List.TransformMany", "List.Zip",
];

fn items<'v>(a: &'v [Value], i: usize, f: &str) -> R<&'v [Value]> {
    match a.get(i) {
        Some(Value::List(l)) if !l.iter().any(|x| x.is_symbolic()) => Ok(l),
        Some(Value::List(_)) => Err(MError::unsupported(format!("{f} works on lists of values, not on a column or on values computed from columns."))),
        Some(other) => Err(MError::expr(format!("{f}: a list was expected, found {}.", other.type_name()))),
        None => Err(MError::expr(format!("{f}: argument {} is missing.", i + 1))),
    }
}

fn count(a: &[Value], i: usize, default: Option<usize>, f: &str) -> R<usize> {
    match a.get(i) {
        Some(Value::Num(n)) if *n >= 0.0 && n.fract() == 0.0 => Ok(*n as usize),
        Some(Value::Num(_)) => Err(MError::expr(format!("{f}: the count must be a whole number of at least 0."))),
        Some(Value::Null) | None => default.ok_or_else(|| MError::expr(format!("{f}: argument {} is missing.", i + 1))),
        Some(other) => Err(MError::expr(format!("{f}: a number was expected, found {}.", other.type_name()))),
    }
}

fn truth(v: Value, f: &str) -> R<bool> {
    match v {
        Value::Bool(b) => Ok(b),
        other => Err(MError::expr(format!("{f}: the condition must give a logical value, found {}.", other.type_name()))),
    }
}

fn compare(x: &Value, y: &Value) -> Ordering {
    match (x, y) {
        (Value::Num(p), Value::Num(q)) => p.partial_cmp(q).unwrap_or(Ordering::Equal),
        (Value::Text(p), Value::Text(q)) => p.cmp(q),
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Null, _) => Ordering::Less,
        (_, Value::Null) => Ordering::Greater,
        _ => Ordering::Equal,
    }
}

fn contains(list: &[Value], v: &Value) -> bool {
    list.iter().any(|x| values_equal(x, v))
}

/// Removes one matching occurrence per item of `remove` (List.Difference).
fn difference(a: &[Value], b: &[Value]) -> Vec<Value> {
    let mut rest: Vec<&Value> = b.iter().collect();
    let mut out = Vec::new();
    for x in a {
        if let Some(i) = rest.iter().position(|r| values_equal(r, x)) {
            rest.remove(i);
        } else {
            out.push(x.clone());
        }
    }
    out
}

fn positions(list: &[Value], matches: impl Fn(&Value) -> bool, occurrence: f64) -> Value {
    let found: Vec<usize> = list.iter().enumerate().filter(|(_, x)| matches(x)).map(|(i, _)| i).collect();
    match occurrence as i64 {
        2 => Value::List(found.into_iter().map(|i| Value::Num(i as f64)).collect()),
        1 => Value::Num(found.last().map(|i| *i as f64).unwrap_or(-1.0)),
        _ => Value::Num(found.first().map(|i| *i as f64).unwrap_or(-1.0)),
    }
}

pub fn call(ev: &Ev, name: &str, a: &[Value]) -> Option<R<Value>> {
    if !LIST_FNS.contains(&name) {
        return None;
    }
    Some(dispatch(ev, name, a))
}

fn dispatch(ev: &Ev, name: &str, a: &[Value]) -> R<Value> {
    let arg = |i: usize| a.get(i).ok_or_else(|| MError::expr(format!("{name}: argument {} is missing.", i + 1)));
    let list = |i: usize| items(a, i, name);
    let occ = |i: usize| match a.get(i) {
        Some(Value::Num(n)) => *n,
        _ => 0.0,
    };
    match name {
        "List.Accumulate" => {
            let f = arg(2)?;
            let mut state = arg(1)?.clone();
            for x in list(0)? {
                state = ev.apply(f, vec![state, x.clone()])?;
            }
            Ok(state)
        }
        "List.AllTrue" | "List.AnyTrue" => {
            let mut all = true;
            let mut any = false;
            for x in list(0)? {
                let b = truth(x.clone(), name)?;
                all &= b;
                any |= b;
            }
            Ok(Value::Bool(if name == "List.AllTrue" { all } else { any }))
        }
        "List.MatchesAll" | "List.MatchesAny" => {
            let f = arg(1)?;
            let mut all = true;
            let mut any = false;
            for x in list(0)? {
                let b = truth(ev.apply(f, vec![x.clone()])?, name)?;
                all &= b;
                any |= b;
            }
            Ok(Value::Bool(if name == "List.MatchesAll" { all } else { any }))
        }
        "List.ContainsAll" => {
            let l = list(0)?;
            Ok(Value::Bool(list(1)?.iter().all(|v| contains(l, v))))
        }
        "List.ContainsAny" => {
            let l = list(0)?;
            Ok(Value::Bool(list(1)?.iter().any(|v| contains(l, v))))
        }
        "List.Difference" => Ok(Value::List(difference(list(0)?, list(1)?))),
        "List.RemoveItems" | "List.RemoveMatchingItems" => {
            let drop = list(1)?;
            Ok(Value::List(list(0)?.iter().filter(|x| !contains(drop, x)).cloned().collect()))
        }
        "List.Intersect" => {
            let Value::List(lists) = arg(0)? else {
                return Err(MError::expr("List.Intersect needs a list of lists."));
            };
            let mut it = lists.iter();
            let Some(Value::List(first)) = it.next() else {
                return Ok(Value::List(vec![]));
            };
            let mut out: Vec<Value> = Vec::new();
            for x in first {
                if contains(&out, x) {
                    continue;
                }
                if it.clone().all(|l| matches!(l, Value::List(l) if contains(l, x))) {
                    out.push(x.clone());
                }
            }
            Ok(Value::List(out))
        }
        "List.FirstN" => {
            let l = list(0)?;
            if let Some(Value::Num(_)) = a.get(1) {
                return Ok(Value::List(l.iter().take(count(a, 1, None, name)?).cloned().collect()));
            }
            let f = arg(1)?;
            let mut out = Vec::new();
            for x in l {
                if !truth(ev.apply(f, vec![x.clone()])?, name)? {
                    break;
                }
                out.push(x.clone());
            }
            Ok(Value::List(out))
        }
        "List.LastN" => {
            let l = list(0)?;
            let n = count(a, 1, None, name)?;
            Ok(Value::List(l[l.len().saturating_sub(n)..].to_vec()))
        }
        "List.Skip" => {
            let l = list(0)?;
            if let Some(f @ (Value::Func(_) | Value::Builtin(_))) = a.get(1) {
                let mut i = 0;
                while i < l.len() && truth(ev.apply(f, vec![l[i].clone()])?, name)? {
                    i += 1;
                }
                return Ok(Value::List(l[i..].to_vec()));
            }
            Ok(Value::List(l.iter().skip(count(a, 1, Some(1), name)?).cloned().collect()))
        }
        "List.RemoveFirstN" => Ok(Value::List(list(0)?.iter().skip(count(a, 1, Some(1), name)?).cloned().collect())),
        "List.RemoveLastN" => {
            let l = list(0)?;
            Ok(Value::List(l[..l.len().saturating_sub(count(a, 1, Some(1), name)?)].to_vec()))
        }
        "List.MaxN" | "List.MinN" => {
            let mut v: Vec<Value> = list(0)?.iter().filter(|x| !matches!(x, Value::Null)).cloned().collect();
            v.sort_by(compare);
            if name == "List.MaxN" {
                v.reverse();
            }
            v.truncate(count(a, 1, None, name)?);
            Ok(Value::List(v))
        }
        "List.Generate" => {
            let (init, cond, next) = (arg(0)?, arg(1)?, arg(2)?);
            let mut cur = ev.apply(init, vec![])?;
            let mut out = Vec::new();
            for _ in 0..1_000_000 {
                if !truth(ev.apply(cond, vec![cur.clone()])?, name)? {
                    return Ok(Value::List(out));
                }
                out.push(match a.get(3) {
                    Some(sel) if !matches!(sel, Value::Null) => ev.apply(sel, vec![cur.clone()])?,
                    _ => cur.clone(),
                });
                cur = ev.apply(next, vec![cur])?;
            }
            Err(MError::expr("List.Generate did not end after a million items."))
        }
        "List.IsDistinct" => {
            let l = list(0)?;
            Ok(Value::Bool(l.iter().enumerate().all(|(i, x)| !contains(&l[..i], x))))
        }
        "List.Mode" | "List.Modes" => {
            let l = list(0)?;
            if l.is_empty() {
                return Err(MError::expr(format!("{name} needs a list with at least one item.")));
            }
            let mut counts: Vec<(&Value, usize)> = Vec::new();
            for x in l {
                match counts.iter_mut().find(|(v, _)| values_equal(v, x)) {
                    Some((_, n)) => *n += 1,
                    None => counts.push((x, 1)),
                }
            }
            let best = counts.iter().map(|(_, n)| *n).max().unwrap_or(0);
            let top: Vec<Value> = counts.into_iter().filter(|(_, n)| *n == best).map(|(v, _)| v.clone()).collect();
            if name == "List.Modes" {
                Ok(Value::List(top))
            } else {
                Ok(top.into_iter().next().unwrap_or(Value::Null))
            }
        }
        "List.Product" => {
            let mut p = 1.0;
            let mut any = false;
            for x in list(0)? {
                match x {
                    Value::Num(n) => {
                        p *= n;
                        any = true;
                    }
                    Value::Null => {}
                    other => return Err(MError::expr(format!("List.Product: a list item is {} instead of a number.", other.type_name()))),
                }
            }
            Ok(if any { Value::Num(p) } else { Value::Null })
        }
        "List.Positions" => Ok(Value::List((0..list(0)?.len()).map(|i| Value::Num(i as f64)).collect())),
        "List.PositionOf" => {
            let v = arg(1)?;
            Ok(positions(list(0)?, |x| values_equal(x, v), occ(2)))
        }
        "List.PositionOfAny" => {
            let vs = list(1)?;
            Ok(positions(list(0)?, |x| contains(vs, x), occ(2)))
        }
        "List.Range" => {
            let l = list(0)?;
            let off = count(a, 1, None, name)?;
            if off > l.len() {
                return Err(MError::expr("List.Range: the offset is beyond the end of the list."));
            }
            let n = count(a, 2, Some(l.len() - off), name)?;
            if off + n > l.len() {
                return Err(MError::expr("List.Range: there are not enough items in the list."));
            }
            Ok(Value::List(l[off..off + n].to_vec()))
        }
        "List.RemoveRange" => {
            let l = list(0)?;
            let off = count(a, 1, None, name)?;
            let n = count(a, 2, Some(1), name)?;
            if off + n > l.len() {
                return Err(MError::expr("List.RemoveRange: there are not enough items in the list."));
            }
            Ok(Value::List(l[..off].iter().chain(&l[off + n..]).cloned().collect()))
        }
        "List.ReplaceRange" => {
            let l = list(0)?;
            let off = count(a, 1, None, name)?;
            let n = count(a, 2, None, name)?;
            if off + n > l.len() {
                return Err(MError::expr("List.ReplaceRange: there are not enough items in the list."));
            }
            Ok(Value::List(l[..off].iter().chain(list(3)?).chain(&l[off + n..]).cloned().collect()))
        }
        "List.InsertRange" => {
            let l = list(0)?;
            let off = count(a, 1, None, name)?;
            if off > l.len() {
                return Err(MError::expr("List.InsertRange: the offset is beyond the end of the list."));
            }
            Ok(Value::List(l[..off].iter().chain(list(2)?).chain(&l[off..]).cloned().collect()))
        }
        "List.RemoveNulls" => Ok(Value::List(list(0)?.iter().filter(|x| !matches!(x, Value::Null)).cloned().collect())),
        "List.Repeat" => {
            let l = list(0)?;
            let n = count(a, 1, None, name)?;
            Ok(Value::List((0..n).flat_map(|_| l.iter().cloned()).collect()))
        }
        "List.ReplaceMatchingItems" => {
            let pairs: Vec<(&Value, &Value)> = list(1)?
                .iter()
                .map(|p| match p {
                    Value::List(p) if p.len() == 2 => Ok((&p[0], &p[1])),
                    _ => Err(MError::expr("List.ReplaceMatchingItems: each replacement must be a list of two values.")),
                })
                .collect::<R<_>>()?;
            Ok(Value::List(list(0)?.iter().map(|x| pairs.iter().find(|(o, _)| values_equal(o, x)).map(|(_, n)| (*n).clone()).unwrap_or_else(|| x.clone())).collect()))
        }
        "List.ReplaceValue" => {
            let (old, new) = (arg(1)?, arg(2)?);
            let text = matches!(arg(3)?, Value::Builtin(n) if n == "Replacer.ReplaceText");
            let value = matches!(arg(3)?, Value::Builtin(n) if n == "Replacer.ReplaceValue");
            if !text && !value {
                return Err(MError::unsupported("List.ReplaceValue supports Replacer.ReplaceValue and Replacer.ReplaceText."));
            }
            let mut out = Vec::new();
            for x in list(0)? {
                out.push(if text {
                    match (x, old, new) {
                        (Value::Text(t), Value::Text(o), Value::Text(n)) => Value::Text(t.replace(o.as_str(), n)),
                        (Value::Null, _, _) => Value::Null,
                        _ => return Err(MError::expr("Replacer.ReplaceText needs text values.")),
                    }
                } else if values_equal(x, old) {
                    new.clone()
                } else {
                    x.clone()
                });
            }
            Ok(Value::List(out))
        }
        "List.Single" | "List.SingleOrDefault" => {
            let l = list(0)?;
            match l.len() {
                1 => Ok(l[0].clone()),
                0 if name == "List.SingleOrDefault" => Ok(a.get(1).cloned().unwrap_or(Value::Null)),
                0 => Err(MError::expr("List.Single: the list is empty.")),
                _ => Err(MError::expr("List.Single: the list has more than one item.")),
            }
        }
        "List.Split" => {
            let l = list(0)?;
            let n = count(a, 1, None, name)?;
            if n == 0 {
                return Err(MError::expr("List.Split: the page size must be at least 1."));
            }
            Ok(Value::List(l.chunks(n).map(|c| Value::List(c.to_vec())).collect()))
        }
        "List.TransformMany" => {
            let (f1, f2) = (arg(1)?, arg(2)?);
            let mut out = Vec::new();
            for x in list(0)? {
                match ev.apply(f1, vec![x.clone()])? {
                    Value::List(ys) => {
                        for y in ys {
                            out.push(ev.apply(f2, vec![x.clone(), y])?);
                        }
                    }
                    other => return Err(MError::expr(format!("List.TransformMany: the collection must be a list, found {}.", other.type_name()))),
                }
            }
            Ok(Value::List(out))
        }
        "List.Zip" => {
            let Value::List(lists) = arg(0)? else {
                return Err(MError::expr("List.Zip needs a list of lists."));
            };
            let rows: Vec<&[Value]> = lists.iter().map(|l| if let Value::List(l) = l { Ok(l.as_slice()) } else { Err(MError::expr("List.Zip needs a list of lists.")) }).collect::<R<_>>()?;
            let n = rows.iter().map(|r| r.len()).max().unwrap_or(0);
            Ok(Value::List((0..n).map(|i| Value::List(rows.iter().map(|r| r.get(i).cloned().unwrap_or(Value::Null)).collect())).collect()))
        }
        _ => Err(MError::unsupported(format!("{name} is not supported yet."))),
    }
}
