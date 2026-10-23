//! Window functions: INDEX, OFFSET, WINDOW, RANK, ROWNUMBER (with ORDERBY, PARTITIONBY and MATCHBY as their arguments).
//!
//! Semantics follow Microsoft's public description: the relation is ordered inside the partition of the current row;
//! OFFSET / INDEX / WINDOW return rows of the relation, RANK / ROWNUMBER the position of the current row. The current
//! row is found from the row context, or from the columns of the ORDERBY / PARTITIONBY / MATCHBY lists that have
//! exactly one visible value in the filter context (the group-by columns of a visual). When it cannot be found the
//! function says so instead of guessing. The \`relation\` argument is required, and \`blanks\` and \`reset\` are not
//! supported. These semantics are not recorded from Power BI Desktop (tests/dax/cases/extra.json waits for a recording).

use crate::bind::{BExpr, BKind};
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, Val};
use crate::functions::{distinct_values, err, for_each_row};
use crate::table::TableVal;
use crate::value::{sort_cmp, Key, VResult, Value};
use std::cmp::Ordering;

pub const NAMES: &[&str] = &["INDEX", "OFFSET", "WINDOW", "RANK", "ROWNUMBER", "ORDERBY", "PARTITIONBY", "MATCHBY"];

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env))
}

struct Parts<'a> {
    leading: Vec<&'a BExpr>,
    relation: Option<&'a BExpr>,
    /// (expression, descending)
    order: Vec<(&'a BExpr, bool)>,
    partition: Vec<&'a BExpr>,
    match_by: Vec<&'a BExpr>,
    ties_dense: bool,
}

fn helper<'a>(e: &'a BExpr, name: &str) -> Option<&'a [BExpr]> {
    match &e.kind {
        BKind::Call { name: n, args } if n == name => Some(args),
        _ => None,
    }
}

fn parts<'a>(name: &str, args: &'a [BExpr]) -> VResult<Parts<'a>> {
    let n_leading = match name {
        "OFFSET" | "INDEX" => 1,
        "WINDOW" => 4,
        _ => 0,
    };
    let mut p = Parts { leading: vec![], relation: None, order: vec![], partition: vec![], match_by: vec![], ties_dense: false };
    let mut rest = args;
    if name == "RANK" {
        if let Some(BKind::Ident(w)) = rest.first().map(|a| &a.kind) {
            p.ties_dense = w == "DENSE";
            rest = &rest[1..];
        }
    }
    if rest.len() < n_leading {
        return Err(err(ErrorCode::MissingParameters, format!("{name} is missing arguments.")));
    }
    p.leading = rest[..n_leading].iter().collect();
    for a in &rest[n_leading..] {
        if a.is_missing() || matches!(a.kind, BKind::Ident(_)) {
            continue;
        }
        if let Some(h) = helper(a, "ORDERBY") {
            let mut i = 0;
            while i < h.len() {
                let expr = &h[i];
                let mut desc = false;
                if let Some(BKind::Ident(w)) = h.get(i + 1).map(|x| &x.kind) {
                    desc = w == "DESC";
                    i += 1;
                } else if let Some(BKind::Const(Value::Int(d))) = h.get(i + 1).map(|x| &x.kind) {
                    desc = *d == 0;
                    i += 1;
                } else if let Some(BKind::Sort(d)) = h.get(i + 1).map(|x| &x.kind) {
                    desc = *d;
                    i += 1;
                }
                p.order.push((expr, desc));
                i += 1;
            }
        } else if let Some(h) = helper(a, "PARTITIONBY") {
            p.partition.extend(h.iter());
        } else if let Some(h) = helper(a, "MATCHBY") {
            p.match_by.extend(h.iter());
        } else if p.relation.is_none() {
            p.relation = Some(a);
        }
    }
    Ok(p)
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Val> {
    if matches!(name, "ORDERBY" | "PARTITIONBY" | "MATCHBY") {
        return Err(err(ErrorCode::InvalidParameter, format!("{name} can only be used as an argument of a window function.")));
    }
    let p = parts(name, args)?;
    let Some(rel_expr) = p.relation else {
        return Err(err(ErrorCode::MissingParameters, format!("{name}: the relation argument is required in BIForge (for example ALLSELECTED(Table[Column])).")));
    };
    let rel = ev.table(rel_expr, env)?;
    let mat = rel.to_mat(ev.data);
    let n = mat.rows.len();
    // sort keys, partition keys and match keys of every row of the relation
    let mut order_keys: Vec<Vec<Value>> = vec![Vec::new(); n];
    let mut part_keys: Vec<Vec<Value>> = vec![Vec::new(); n];
    let mut match_keys: Vec<Vec<Value>> = vec![Vec::new(); n];
    for_each_row(ev, &rel, env, |i, e2| {
        for (e, _) in &p.order {
            order_keys[i].push(ev.scalar(e, e2)?);
        }
        for e in &p.partition {
            part_keys[i].push(ev.scalar(e, e2)?);
        }
        for e in &p.match_by {
            match_keys[i].push(ev.scalar(e, e2)?);
        }
        Ok(true)
    })?;
    // the current row: the row of the relation whose columns have the values of the context (the row context, or the single
    // visible value of the column, as for the group-by columns of a visual)
    let mut known: Vec<(usize, Value)> = Vec::new();
    for (ci, c) in mat.cols.iter().enumerate() {
        if let Some(col) = c.lineage {
            if let Some(v) = ev.row_value_nth(col, env, 0)? {
                known.push((ci, v));
                continue;
            }
            let vals = distinct_values(ev, col, env, true);
            if vals.len() == 1 {
                known.push((ci, vals[0].clone()));
            }
        }
    }
    if known.is_empty() {
        return Err(err(ErrorCode::InvalidValue, format!("{name}: the current row cannot be determined here (no row context, and no column of the relation has a single value).")));
    }
    let matches_known = |r: usize| known.iter().all(|(ci, v)| mat.rows[r][*ci].key() == v.key());
    let Some(cur) = (0..n).find(|&r| matches_known(r)) else {
        return Ok(match name {
            "RANK" | "ROWNUMBER" => Val::S(Value::Blank),
            _ => Val::T(TableVal::mat(mat.cols.clone(), vec![])),
        });
    };
    // the partition of the current row, ordered
    let pkey: Vec<Key> = part_keys[cur].iter().map(|v| v.key()).collect();
    let mut rows: Vec<usize> = (0..n).filter(|&r| part_keys[r].iter().map(|v| v.key()).collect::<Vec<_>>() == pkey).collect();
    let cmp = |a: &usize, b: &usize| -> Ordering {
        for (k, (_, desc)) in p.order.iter().enumerate() {
            let o = sort_cmp(&order_keys[*a][k], &order_keys[*b][k]);
            if o != Ordering::Equal {
                return if *desc { o.reverse() } else { o };
            }
        }
        // without an ORDERBY the relation is ordered by all its columns
        if p.order.is_empty() {
            for c in 0..mat.cols.len() {
                let o = sort_cmp(&mat.rows[*a][c], &mat.rows[*b][c]);
                if o != Ordering::Equal {
                    return o;
                }
            }
        }
        Ordering::Equal
    };
    rows.sort_by(&cmp);
    let pos = rows.iter().position(|&r| r == cur).unwrap_or(0);
    let take = |idx: &[usize]| Val::T(TableVal::mat(mat.cols.clone(), idx.iter().map(|&r| mat.rows[r].clone()).collect()));
    let int_arg = |i: usize| -> VResult<i64> { Ok(ev.scalar(p.leading[i], env)?.to_f64()?.trunc() as i64) };
    match name {
        "ROWNUMBER" => Ok(Val::S(Value::Int(pos as i64 + 1))),
        "RANK" => {
            let rank = if p.ties_dense {
                let mut distinct: Vec<&Vec<Value>> = Vec::new();
                for &r in &rows {
                    if !distinct.iter().any(|d| d.iter().zip(&order_keys[r]).all(|(a, b)| a.key() == b.key())) {
                        distinct.push(&order_keys[r]);
                    }
                    if cmp(&r, &cur) == Ordering::Equal {
                        break;
                    }
                }
                distinct.len()
            } else {
                rows.iter().take_while(|&&r| cmp(&r, &cur) == Ordering::Less).count() + 1
            };
            Ok(Val::S(Value::Int(rank as i64)))
        }
        "OFFSET" => {
            let target = pos as i64 + int_arg(0)?;
            Ok(if target < 0 || target >= rows.len() as i64 { take(&[]) } else { take(&[rows[target as usize]]) })
        }
        "INDEX" => {
            let k = int_arg(0)?;
            let idx = if k > 0 { k - 1 } else { rows.len() as i64 + k };
            Ok(if k == 0 || idx < 0 || idx >= rows.len() as i64 { take(&[]) } else { take(&[rows[idx as usize]]) })
        }
        "WINDOW" => {
            let kind = |e: &BExpr| matches!(&e.kind, BKind::Ident(w) if w == "ABS");
            let at = |v: i64, abs: bool| if abs { if v > 0 { v - 1 } else { rows.len() as i64 + v } } else { pos as i64 + v };
            let from = at(int_arg(0)?, kind(p.leading[1]));
            let to = at(int_arg(2)?, kind(p.leading[3]));
            let (lo, hi) = (from.max(0), to.min(rows.len() as i64 - 1));
            Ok(if lo > hi { take(&[]) } else { take(&rows[lo as usize..=hi as usize]) })
        }
        _ => unreachable!(),
    }
}
