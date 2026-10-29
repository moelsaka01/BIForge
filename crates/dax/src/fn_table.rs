//! Table and filter functions beyond the core: FILTERS, NONVISUAL, EVALUATEANDLOG, GENERATESERIES, UNION, INTERSECT,
//! EXCEPT, GENERATE, GENERATEALL, NATURALINNERJOIN, NATURALLEFTOUTERJOIN, TOPN, GROUPBY, CURRENTGROUP, DATATABLE.
//! (SUMMARIZE with extension columns lives in functions.rs next to SUMMARIZECOLUMNS.)

use crate::bind::{BExpr, BKind};
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, Val};
use crate::functions::{col_arg, err, for_each_row};
use crate::model::ColId;
use crate::table::{MatTable, TCol, TableVal};
use crate::value::{self, Key, VResult, Value};
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

pub const NAMES: &[&str] = &[
    "FILTERS", "NONVISUAL", "EVALUATEANDLOG", "GENERATESERIES", "UNION", "INTERSECT", "EXCEPT", "GENERATE", "GENERATEALL", "NATURALINNERJOIN", "NATURALLEFTOUTERJOIN", "TOPN", "TOPNSKIP", "GROUPBY",
    "CURRENTGROUP", "DATATABLE",
];

thread_local! {
    static GROUPS: RefCell<Vec<Rc<MatTable>>> = const { RefCell::new(Vec::new()) };
}

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env))
}

fn keys(row: &[Value]) -> Vec<Key> {
    row.iter().map(|v| v.key()).collect()
}

fn mat(ev: &Evaluator, t: &TableVal) -> Rc<MatTable> {
    t.to_mat(ev.data)
}

fn same_width(name: &str, tables: &[Rc<MatTable>]) -> VResult<()> {
    if tables.iter().any(|t| t.cols.len() != tables[0].cols.len()) {
        return Err(err(ErrorCode::InvalidParameter, format!("The tables passed to {name} must have the same number of columns.")));
    }
    Ok(())
}

fn series_value(base: &Value, x: f64, int: bool) -> Value {
    match base {
        Value::DateTime(_) => Value::DateTime(x),
        _ if int => Value::Int(x as i64),
        _ => Value::Double(x),
    }
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Val> {
    let t = |v: TableVal| Ok(Val::T(v));
    match name {
        "EVALUATEANDLOG" => ev.eval(&args[0], env),
        // recorded from Power BI: only valid as a value filter of SUMMARIZECOLUMNS (handled there)
        "NONVISUAL" => Err(err(ErrorCode::InvalidParameter, "The NONVISUAL function can only be used as a value filter of SUMMARIZECOLUMNS.")),
        "FILTERS" => {
            let c = col_arg(name, args, 0)?;
            // only the filters that name this column directly (cross-filters from other tables do not count)
            let direct: Vec<_> = env.filter.filters.iter().filter(|f| f.cols().contains(&c)).cloned().collect();
            let mut ctx = env.filter.clear();
            for f in direct {
                ctx = ctx.push(f);
            }
            let rows = ev.table_rows(&ctx, c.table, true);
            let vals = ev.distinct_combos(&[c], &rows);
            t(crate::functions::col_table(ev, &[c], vals))
        }
        "GENERATESERIES" => {
            let start = ev.scalar(&args[0], env)?;
            let end = ev.scalar(&args[1], env)?;
            let step = if args.len() > 2 && !args[2].is_missing() { ev.scalar(&args[2], env)? } else { Value::Int(1) };
            let (a, b, s) = (start.to_f64()?, end.to_f64()?, step.to_f64()?);
            if s <= 0.0 {
                // recorded from Power BI
                return Err(err(ErrorCode::InvalidValue, "GENERATESERIES cannot have an increment value less than or equal to zero."));
            }
            if a > b {
                return t(TableVal::mat(vec![TCol { name: "Value".into(), lineage: None, renamed: false }], vec![]));
            }
            let int = matches!((&start, &step), (Value::Int(_), Value::Int(_)));
            let n = ((b - a) / s + 1e-9).floor() as usize + 1;
            if n > 10_000_000 {
                return Err(err(ErrorCode::InvalidValue, "GENERATESERIES would produce too many rows."));
            }
            let rows = (0..n).map(|i| vec![series_value(&start, a + s * i as f64, int)]).collect();
            t(TableVal::mat(vec![TCol { name: "Value".into(), lineage: None, renamed: false }], rows))
        }
        "UNION" | "INTERSECT" | "EXCEPT" => {
            let tables = args.iter().map(|a| ev.table(a, env).map(|x| mat(ev, &x))).collect::<VResult<Vec<_>>>()?;
            same_width(name, &tables)?;
            let first = &tables[0];
            let cols: Vec<TCol> = first
                .cols
                .iter()
                .enumerate()
                .map(|(i, c)| TCol { name: c.name.clone(), lineage: if tables.iter().all(|t| t.cols[i].lineage == c.lineage) { c.lineage } else { None }, renamed: false })
                .collect();
            let rows: Vec<Vec<Value>> = match name {
                "UNION" => tables.iter().flat_map(|t| t.rows.iter().cloned()).collect(),
                _ => {
                    let other: HashSet<Vec<Key>> = tables[1].rows.iter().map(|r| keys(r)).collect();
                    first.rows.iter().filter(|r| other.contains(&keys(r)) == (name == "INTERSECT")).cloned().collect()
                }
            };
            t(TableVal::mat(cols, rows))
        }
        "GENERATE" | "GENERATEALL" => {
            let left = ev.table(&args[0], env)?;
            let mut cols = left.cols(ev.data);
            let mut rows = Vec::new();
            let mut right_cols: Option<Vec<TCol>> = None;
            let mut results: Vec<(usize, Rc<MatTable>)> = Vec::new();
            for_each_row(ev, &left, env, |i, e2| {
                let r = mat(ev, &ev.table(&args[1], e2)?);
                right_cols.get_or_insert_with(|| r.cols.clone());
                results.push((i, r));
                Ok(true)
            })?;
            let width = match &right_cols {
                Some(c) => c.len(),
                None => ev.table(&args[1], &Env::empty()).map(|x| x.ncols(ev.data)).unwrap_or(0),
            };
            for (i, r) in results {
                let l = left.row(ev.data, i);
                if r.rows.is_empty() {
                    if name == "GENERATEALL" {
                        let mut row = l;
                        row.extend(std::iter::repeat_n(Value::Blank, width));
                        rows.push(row);
                    }
                    continue;
                }
                for x in &r.rows {
                    let mut row = l.clone();
                    row.extend(x.iter().cloned());
                    rows.push(row);
                }
            }
            let right_cols = right_cols.unwrap_or_default();
            // recorded from Power BI: the two tables must not share a column name
            if let Some(dup) = right_cols.iter().find(|c| cols.iter().any(|l| l.name.eq_ignore_ascii_case(&c.name))) {
                return Err(err(ErrorCode::InvalidParameter, format!("Function {name} does not allow two columns with the same name [{}].", dup.name)));
            }
            cols.extend(right_cols);
            t(TableVal::mat(cols, rows))
        }
        "NATURALINNERJOIN" | "NATURALLEFTOUTERJOIN" => {
            let l = mat(ev, &ev.table(&args[0], env)?);
            let r = mat(ev, &ev.table(&args[1], env)?);
            // join columns: columns of the two tables that come from the same model column
            let pairs: Vec<(usize, usize)> = l
                .cols
                .iter()
                .enumerate()
                .filter_map(|(i, c)| c.lineage.and_then(|lin| r.cols.iter().position(|x| x.lineage == Some(lin))).map(|j| (i, j)))
                .collect();
            if pairs.is_empty() {
                return Err(err(ErrorCode::InvalidParameter, format!("{name}: the two tables have no common columns (columns must come from the same model column).")));
            }
            let extra: Vec<usize> = (0..r.cols.len()).filter(|j| !pairs.iter().any(|p| p.1 == *j)).collect();
            let mut cols = l.cols.clone();
            cols.extend(extra.iter().map(|&j| r.cols[j].clone()));
            let mut rows = Vec::new();
            for lr in &l.rows {
                let mut hit = false;
                for rr in &r.rows {
                    if pairs.iter().all(|&(i, j)| lr[i].key() == rr[j].key()) {
                        hit = true;
                        let mut row = lr.clone();
                        row.extend(extra.iter().map(|&j| rr[j].clone()));
                        rows.push(row);
                    }
                }
                if !hit && name == "NATURALLEFTOUTERJOIN" {
                    let mut row = lr.clone();
                    row.extend(std::iter::repeat_n(Value::Blank, extra.len()));
                    rows.push(row);
                }
            }
            t(TableVal::mat(cols, rows))
        }
        "TOPN" | "TOPNSKIP" => {
            // TOPNSKIP(rows, skip, table, order...) is TOPN with a skipped prefix and no ties
            let skip_form = name == "TOPNSKIP";
            let off = usize::from(skip_form);
            let n = ev.scalar(&args[0], env)?.to_f64()?;
            let skip = if skip_form { ev.scalar(&args[1], env)?.to_f64()?.max(0.0).floor() as usize } else { 0 };
            let src = ev.table(&args[1 + off], env)?;
            if n < 1.0 {
                return t(TableVal::mat(src.cols(ev.data), vec![]));
            }
            let n = n.floor() as usize;
            // (expression, ascending) pairs; the order argument is 0/FALSE/DESC (default) or 1/TRUE/ASC
            let mut keys_spec: Vec<(&'a BExpr, bool)> = Vec::new();
            let mut i = 2 + off;
            while i < args.len() {
                if args[i].is_missing() {
                    i += 1;
                    continue;
                }
                let expr = &args[i];
                let mut asc = false;
                if let Some(next) = args.get(i + 1) {
                    match &next.kind {
                        BKind::Sort(desc) => {
                            asc = !*desc;
                            i += 1;
                        }
                        BKind::Const(Value::Int(v)) => {
                            asc = *v != 0;
                            i += 1;
                        }
                        BKind::Const(Value::Bool(b)) => {
                            asc = *b;
                            i += 1;
                        }
                        _ => {}
                    }
                }
                keys_spec.push((expr, asc));
                i += 1;
            }
            if keys_spec.is_empty() {
                // without an order-by Desktop returns the first n rows in the table's own order (recorded cases filter.topn.noorder.*)
                let rows: Vec<usize> = (skip.min(src.nrows())..src.nrows().min(skip + n)).collect();
                return t(match &src {
                    TableVal::Base { table, rows: base } => TableVal::Base { table: *table, rows: Rc::new(rows.iter().map(|&i| base[i]).collect()) },
                    other => TableVal::mat(other.cols(ev.data), rows.iter().map(|&i| other.row(ev.data, i)).collect()),
                });
            }
            let mut scored: Vec<(Vec<Value>, usize)> = Vec::new();
            for_each_row(ev, &src, env, |r, e2| {
                scored.push((keys_spec.iter().map(|(k, _)| ev.scalar(k, e2)).collect::<VResult<Vec<_>>>()?, r));
                Ok(true)
            })?;
            let cmp = |a: &Vec<Value>, b: &Vec<Value>| {
                for (k, (_, asc)) in keys_spec.iter().enumerate() {
                    let o = value::sort_cmp(&a[k], &b[k]);
                    let o = if *asc { o } else { o.reverse() };
                    if o != std::cmp::Ordering::Equal {
                        return o;
                    }
                }
                std::cmp::Ordering::Equal
            };
            scored.sort_by(|a, b| cmp(&a.0, &b.0));
            // keep n rows plus every row tied with the nth
            if skip_form {
                scored = scored.into_iter().skip(skip).take(n).collect();
            }
            let keep = if skip_form || scored.len() <= n {
                scored.len()
            } else {
                let last = &scored[n - 1].0;
                scored.iter().take_while(|s| cmp(&s.0, last) != std::cmp::Ordering::Greater).count().max(n)
            };
            let rows: Vec<usize> = scored[..keep].iter().map(|s| s.1).collect();
            t(match &src {
                TableVal::Base { table, rows: base } => TableVal::Base { table: *table, rows: Rc::new(rows.iter().map(|&i| base[i]).collect()) },
                other => TableVal::mat(other.cols(ev.data), rows.iter().map(|&i| other.row(ev.data, i)).collect()),
            })
        }
        "CURRENTGROUP" => GROUPS
            .with(|g| g.borrow().last().cloned())
            .map(|m| Val::T(TableVal::Mat(m)))
            .ok_or_else(|| err(ErrorCode::InvalidValue, "CURRENTGROUP can only be used inside GROUPBY.")),
        "GROUPBY" => groupby(ev, args, env).map(Val::T),
        "DATATABLE" => {
            let (spec, last) = args.split_at(args.len() - 1);
            if spec.len() % 2 != 0 || spec.is_empty() {
                return Err(err(ErrorCode::MissingParameters, "DATATABLE expects pairs of a column name and a data type, then the rows."));
            }
            let mut cols = Vec::new();
            let mut types = Vec::new();
            for p in spec.chunks(2) {
                cols.push(TCol { name: ev.scalar(&p[0], env)?.to_text(), lineage: None, renamed: false });
                types.push(p[1].ident().unwrap_or("STRING").to_string());
            }
            let data = ev.table(&last[0], env)?;
            if data.ncols(ev.data) != cols.len() {
                return Err(err(ErrorCode::InvalidParameter, "DATATABLE: the rows do not match the number of columns."));
            }
            let mut rows = Vec::new();
            for r in 0..data.nrows() {
                let mut row = Vec::new();
                for (c, ty) in types.iter().enumerate() {
                    let v = data.value(ev.data, r, c);
                    row.push(coerce(&v, ty)?);
                }
                rows.push(row);
            }
            t(TableVal::mat(cols, rows))
        }
        _ => unreachable!("{name}"),
    }
}

fn coerce(v: &Value, ty: &str) -> VResult<Value> {
    if v.is_blank() {
        return Ok(Value::Blank);
    }
    Ok(match ty {
        "INTEGER" => Value::Int(v.to_f64()?.round() as i64),
        "DOUBLE" => Value::Double(v.to_f64()?),
        "STRING" => Value::str(&v.to_text()),
        "BOOLEAN" => Value::Bool(v.to_bool()?),
        "CURRENCY" => Value::Currency((v.to_f64()? * value::CURRENCY_SCALE as f64).round() as i64),
        "DATETIME" => match v {
            Value::Str(s) => Value::DateTime(value::parse_datetime_literal(s).ok_or_else(|| err(ErrorCode::TypeMismatch, format!("Cannot convert '{s}' to a date.")))?),
            other => Value::DateTime(other.to_f64()?),
        },
        other => return Err(err(ErrorCode::InvalidParameter, format!("DATATABLE: unknown data type {other}."))),
    })
}

/// GROUPBY(table, groupCol..., name, expression, ...): groups the rows of the table value; expressions see the
/// group through CURRENTGROUP().
fn groupby<'a>(ev: &'a Evaluator<'a>, args: &'a [BExpr], env: &Env<'a>) -> VResult<TableVal> {
    let src = mat(ev, &ev.table(&args[0], env)?);
    let mut group_idx: Vec<usize> = Vec::new();
    let mut i = 1;
    while i < args.len() && !matches!(&args[i].kind, BKind::Const(Value::Str(_))) {
        let c: ColId = col_arg("GROUPBY", args, i)?;
        let idx = src.cols.iter().position(|x| x.lineage == Some(c)).ok_or_else(|| err(ErrorCode::InvalidParameter, format!("GROUPBY: column {} is not in the table.", ev.data.model.column_name(c))))?;
        group_idx.push(idx);
        i += 1;
    }
    let pairs = crate::functions::name_expr_pairs(ev, &args[i..], env, "GROUPBY")?;
    let mut order: Vec<Vec<Key>> = Vec::new();
    let mut groups: std::collections::HashMap<Vec<Key>, Vec<Vec<Value>>> = std::collections::HashMap::new();
    for r in &src.rows {
        let k: Vec<Key> = group_idx.iter().map(|&g| r[g].key()).collect();
        if !groups.contains_key(&k) {
            order.push(k.clone());
        }
        groups.entry(k).or_default().push(r.clone());
    }
    let mut cols: Vec<TCol> = group_idx.iter().map(|&g| src.cols[g].clone()).collect();
    cols.extend(pairs.iter().map(|(n, _)| TCol { name: n.clone(), lineage: None, renamed: false }));
    let mut rows = Vec::new();
    for k in order {
        let members = groups.remove(&k).unwrap();
        let first = members[0].clone();
        let group = Rc::new(MatTable { cols: src.cols.clone(), rows: members });
        GROUPS.with(|g| g.borrow_mut().push(group));
        let vals: VResult<Vec<Value>> = pairs.iter().map(|(_, x)| ev.scalar(x, env)).collect();
        GROUPS.with(|g| g.borrow_mut().pop());
        let mut row: Vec<Value> = group_idx.iter().map(|&g| first[g].clone()).collect();
        row.extend(vals?);
        rows.push(row);
    }
    Ok(TableVal::mat(cols, rows))
}
