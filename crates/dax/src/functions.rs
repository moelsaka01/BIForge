//! Function implementations. Adding a function: implement it in `call`, add its name to `IMPLEMENTED`,
//! and (if it consumes a filter context or returns a table) make sure `is_scalar_expr` /
//! `row_level_columns` treat it correctly. The catalog (catalog/functions.json) holds its signature.

use crate::bind::{BExpr, BKind};
use crate::catalog::Catalog;
use crate::diag::{Diagnostic, ErrorCode, Span};
use crate::eval::{Env, Evaluator, RowRef, Val};
use crate::filter::Filter;
use crate::model::ColId;
use crate::table::{MatTable, TCol, TableVal};
use crate::value::{self, EvalError, Key, VResult, Value};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// Functions BIForge evaluates today. Everything else in the catalog reports "not implemented".
pub const IMPLEMENTED: &[&str] = &[
    // filter / context
    "CALCULATE", "CALCULATETABLE", "FILTER", "ALL", "ALLEXCEPT", "ALLNOBLANKROW", "REMOVEFILTERS", "KEEPFILTERS", "VALUES", "DISTINCT", "SELECTEDVALUE", "EARLIER", "EARLIEST",
    "TREATAS", "ALLSELECTED", "ALLCROSSFILTERED",
    // relationships
    "RELATED", "RELATEDTABLE", "USERELATIONSHIP", "CROSSFILTER",
    // information
    "BLANK", "ISBLANK", "ISFILTERED", "ISCROSSFILTERED", "HASONEVALUE", "ISEMPTY",
    // logical (core)
    "IF", "AND", "OR", "NOT", "TRUE", "FALSE", "COALESCE",
    // aggregation (core)
    "SUM", "SUMX", "COUNTROWS", "COUNT", "COUNTA", "COUNTBLANK", "COUNTX", "COUNTAX", "AVERAGE", "AVERAGEX", "MIN", "MAX", "MINX", "MAXX", "DISTINCTCOUNT", "DISTINCTCOUNTNOBLANK",
    // math (core)
    "DIVIDE",
    // table construction (core, for queries)
    "ADDCOLUMNS", "SELECTCOLUMNS", "ROW", "SUMMARIZECOLUMNS", "SUMMARIZE", "CROSSJOIN",
];

pub fn is_implemented(name: &str) -> bool {
    IMPLEMENTED.contains(&name) || MODULE_NAMES.iter().any(|n| n.contains(&name))
}

/// All implemented function names (core list plus the tranche modules), sorted.
pub fn implemented_names() -> Vec<&'static str> {
    let mut v: Vec<&str> = IMPLEMENTED.to_vec();
    for m in MODULE_NAMES {
        v.extend(m.iter().copied());
    }
    v.sort_unstable();
    v.dedup();
    v
}

/// Names implemented by the tranche modules (each module owns its list).
const MODULE_NAMES: &[&[&str]] = &[crate::fn_agg::NAMES, crate::fn_logic::NAMES, crate::fn_math::NAMES, crate::fn_text::NAMES, crate::fn_date::NAMES, crate::fn_table::NAMES, crate::fn_time::NAMES, crate::fn_stats::NAMES];

type ModuleFn = for<'a> fn(&'a Evaluator<'a>, &str, &'a [BExpr], &Env<'a>) -> Option<VResult<Val>>;
const MODULES: &[ModuleFn] = &[crate::fn_agg::call, crate::fn_logic::call, crate::fn_math::call, crate::fn_text::call, crate::fn_date::call, crate::fn_table::call, crate::fn_time::call, crate::fn_stats::call];

/// Evaluates every argument to a scalar; an omitted argument (a gap in the list) is None.
pub(crate) fn eval_args<'a>(ev: &'a Evaluator<'a>, args: &'a [BExpr], env: &Env<'a>) -> VResult<Vec<Option<Value>>> {
    args.iter().map(|a| if a.is_missing() { Ok(None) } else { ev.scalar(a, env).map(Some) }).collect()
}

/// Bind-time checks of argument kinds.
pub fn check_args(name: &str, args: &[BExpr], span: Span) -> Result<(), Diagnostic> {
    let need_col = |i: usize| -> Result<(), Diagnostic> {
        match args.get(i) {
            Some(a) if a.col().is_some() => Ok(()),
            Some(a) => Err(Diagnostic::new(ErrorCode::InvalidParameter, format!("The function {name} expects a column reference as argument number {}.", i + 1), a.span)),
            None => Ok(()),
        }
    };
    match name {
        "SUM" | "MEDIAN" | "GEOMEAN" | "STDEV.S" | "STDEV.P" | "VAR.S" | "VAR.P" | "PERCENTILE.INC" | "PERCENTILE.EXC" | "AVERAGEA" | "MINA" | "MAXA" | "PRODUCT" | "APPROXIMATEDISTINCTCOUNT" | "HASONEFILTER" | "COUNT" | "COUNTA" | "COUNTBLANK" | "AVERAGE" | "DISTINCTCOUNT" | "DISTINCTCOUNTNOBLANK" | "RELATED" | "EARLIER" | "EARLIEST" | "SELECTEDVALUE" | "HASONEVALUE" => need_col(0),
        "MIN" | "MAX" if args.len() == 1 => need_col(0),
        "USERELATIONSHIP" | "CROSSFILTER" => {
            need_col(0)?;
            need_col(1)
        }
        "ALLEXCEPT" => {
            if args[0].table().is_none() {
                return Err(Diagnostic::new(ErrorCode::InvalidParameter, "The first argument of ALLEXCEPT must be a table reference.", args[0].span));
            }
            (1..args.len()).try_for_each(need_col)
        }
        "RELATEDTABLE" if args[0].table().is_none() => Err(Diagnostic::new(ErrorCode::InvalidParameter, "RELATEDTABLE expects a table reference.", span)),
        _ => Ok(()),
    }
}

/// True when the expression certainly returns a scalar (used to tell boolean filters from table filters).
pub fn is_scalar_expr(e: &BExpr) -> bool {
    match &e.kind {
        BKind::Const(_) | BKind::Col(_) | BKind::RowCol(_) | BKind::Measure(_) | BKind::Unary(..) | BKind::Binary(..) | BKind::In(..) => true,
        BKind::Call { name, .. } => Catalog::builtin().get(name).is_some_and(|f| !f.returns_table),
        BKind::Let(_, body) => is_scalar_expr(body),
        _ => false,
    }
}

/// Functions whose arguments are evaluated per row of the current row context (no aggregation), so a
/// column inside them is a row-level reference.
fn is_row_level(name: &str) -> bool {
    let Some(f) = Catalog::builtin().get(name) else { return false };
    if f.returns_table {
        return false;
    }
    matches!(f.category.as_str(), "Logical" | "Math" | "Text" | "DateTime")
        || matches!(name, "ISBLANK" | "ISNUMBER" | "ISTEXT" | "ISNONTEXT" | "ISLOGICAL" | "ISERROR" | "ISEVEN" | "ISODD" | "BLANK" | "CONTAINSSTRING" | "CONTAINSSTRINGEXACT")
}

/// Columns referenced at row level by a boolean filter predicate (not inside aggregations).
pub fn row_level_columns(e: &BExpr) -> Vec<ColId> {
    fn go(e: &BExpr, out: &mut Vec<ColId>) {
        match &e.kind {
            BKind::Col(c) => {
                if !out.contains(c) {
                    out.push(*c)
                }
            }
            BKind::Unary(_, x) => go(x, out),
            BKind::Binary(_, l, r) | BKind::In(l, r) => {
                go(l, out);
                go(r, out);
            }
            BKind::Tuple(items) => items.iter().for_each(|i| go(i, out)),
            BKind::Let(vars, body) => {
                vars.iter().for_each(|(_, v)| go(v, out));
                go(body, out);
            }
            BKind::Call { name, args } if is_row_level(name) => args.iter().for_each(|a| go(a, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    go(e, &mut out);
    out
}

pub(crate) fn err(code: ErrorCode, msg: impl Into<String>) -> EvalError {
    EvalError::new(code, msg)
}

pub(crate) fn col_arg(name: &str, args: &[BExpr], i: usize) -> VResult<ColId> {
    args.get(i).and_then(|a| a.col()).ok_or_else(|| err(ErrorCode::InvalidParameter, format!("The function {name} expects a column reference as argument number {}.", i + 1)))
}

pub(crate) fn as_count(n: usize) -> Value {
    if n == 0 {
        Value::Blank
    } else {
        Value::Int(n as i64)
    }
}

/// Iterates the rows of a table value, giving the row-context environment for each.
pub(crate) fn for_each_row<'a>(ev: &'a Evaluator<'a>, t: &TableVal, env: &Env<'a>, mut f: impl FnMut(usize, &Env<'a>) -> VResult<bool>) -> VResult<()> {
    match t {
        TableVal::Base { table, rows } => {
            for (i, &r) in rows.iter().enumerate() {
                if !f(i, &env.push_row(RowRef::Base { table: *table, row: r }))? {
                    break;
                }
            }
        }
        TableVal::Mat(m) => {
            for i in 0..m.rows.len() {
                if !f(i, &env.push_row(RowRef::Mat { t: m.clone(), row: i }))? {
                    break;
                }
            }
        }
    }
    let _ = ev;
    Ok(())
}

/// Visible values of a column (blank row included when visible).
pub(crate) fn column_values(ev: &Evaluator, c: ColId, env: &Env) -> Vec<Value> {
    let rows = ev.table_rows(&env.filter, c.table, true);
    rows.into_iter().map(|r| ev.data.value(c, r).clone()).collect()
}

pub(crate) fn distinct_values(ev: &Evaluator, c: ColId, env: &Env, with_blank_row: bool) -> Vec<Value> {
    let rows = ev.table_rows(&env.filter, c.table, with_blank_row);
    ev.distinct_combos(&[c], &rows).into_iter().map(|mut v| v.pop().unwrap()).collect()
}

pub(crate) fn col_table(ev: &Evaluator, cols: &[ColId], vals: Vec<Vec<Value>>) -> TableVal {
    TableVal::mat(cols.iter().map(|&c| TCol { name: ev.data.model.column(c).name.clone(), lineage: Some(c) }).collect(), vals)
}

/// Sums non-blank values with DAX addition (Integer stays Integer, Currency stays Currency).
pub(crate) fn sum_values(name: &str, vals: impl Iterator<Item = Value>) -> VResult<Value> {
    let mut acc = Value::Blank;
    for v in vals {
        match v {
            Value::Blank => {}
            Value::Str(_) => return Err(err(ErrorCode::TypeMismatch, format!("The function {name} cannot work with values of type String."))),
            Value::Bool(_) => return Err(err(ErrorCode::TypeMismatch, format!("The function {name} cannot work with values of type Boolean."))),
            v => acc = value::add(&acc, &v)?,
        }
    }
    Ok(acc)
}

pub(crate) fn average_values(name: &str, vals: impl Iterator<Item = Value>) -> VResult<Value> {
    let mut n = 0usize;
    let mut s = 0f64;
    for v in vals {
        match v {
            Value::Blank => {}
            Value::Str(_) | Value::Bool(_) => return Err(err(ErrorCode::TypeMismatch, format!("The function {name} cannot work with values of type {}.", v.type_name()))),
            v => {
                n += 1;
                s += v.as_f64().unwrap();
            }
        }
    }
    Ok(if n == 0 { Value::Blank } else { Value::Double(s / n as f64) })
}

pub(crate) fn extreme(vals: impl Iterator<Item = Value>, max: bool) -> VResult<Value> {
    let mut best: Option<Value> = None;
    for v in vals {
        if v.is_blank() {
            continue;
        }
        best = Some(match best {
            None => v,
            Some(b) => {
                let o = value::compare(&v, &b)?;
                if (max && o == std::cmp::Ordering::Greater) || (!max && o == std::cmp::Ordering::Less) {
                    v
                } else {
                    b
                }
            }
        });
    }
    Ok(best.unwrap_or(Value::Blank))
}

/// Evaluates a function call.
pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], whole: &'a BExpr, env: &Env<'a>) -> VResult<Val> {
    let _ = whole;
    let s = |v: Value| Ok(Val::S(v));
    let t = |v: TableVal| Ok(Val::T(v));
    match name {
        // ---------------------------------------------------------------- filter context
        "CALCULATE" => {
            let ctx = ev.calculate_ctx(&args[1..].iter().collect::<Vec<_>>(), env)?;
            s(ev.scalar(&args[0], &env.with_filter(ctx))?)
        }
        "CALCULATETABLE" => {
            let ctx = ev.calculate_ctx(&args[1..].iter().collect::<Vec<_>>(), env)?;
            t(ev.table(&args[0], &env.with_filter(ctx))?)
        }
        "FILTER" => {
            let src = ev.table(&args[0], env)?;
            let mut keep = Vec::new();
            for_each_row(ev, &src, env, |i, e2| {
                if ev.scalar(&args[1], e2)?.to_bool()? {
                    keep.push(i);
                }
                Ok(true)
            })?;
            t(match &src {
                TableVal::Base { table, rows } => TableVal::Base { table: *table, rows: Rc::new(keep.iter().map(|&i| rows[i]).collect()) },
                TableVal::Mat(m) => TableVal::Mat(Rc::new(MatTable { cols: m.cols.clone(), rows: keep.iter().map(|&i| m.rows[i].clone()).collect() })),
            })
        }
        "ALL" | "ALLNOBLANKROW" => {
            let with_blank = name == "ALL";
            if args.is_empty() {
                return Err(err(ErrorCode::InvalidParameter, "ALL() without arguments can only be used as a filter argument of CALCULATE."));
            }
            if let Some(tb) = args[0].table() {
                return t(TableVal::Base { table: tb, rows: Rc::new(ev.all_rows(tb, with_blank)) });
            }
            let cols = (0..args.len()).map(|i| col_arg(name, args, i)).collect::<VResult<Vec<_>>>()?;
            if cols.iter().any(|c| c.table != cols[0].table) {
                return Err(err(ErrorCode::InvalidParameter, format!("All column arguments of {name} must come from the same table.")));
            }
            let rows = ev.all_rows(cols[0].table, with_blank);
            t(col_table(ev, &cols, ev.distinct_combos(&cols, &rows)))
        }
        "ALLSELECTED" => {
            let g = ev.graph(&env.filter);
            if let Some(tb) = args.first().and_then(|a| a.table()) {
                let cols: HashSet<ColId> = g.expanded_columns(ev.data, tb).into_iter().collect();
                let ctx = env.filter.restore_selected(ev.data, &g, Some(&cols));
                return t(TableVal::Base { table: tb, rows: Rc::new(ev.table_rows(&ctx, tb, true)) });
            }
            let cols = (0..args.len()).map(|i| col_arg(name, args, i)).collect::<VResult<Vec<_>>>()?;
            if cols.is_empty() || cols.iter().any(|c| c.table != cols[0].table) {
                return Err(err(ErrorCode::InvalidParameter, "ALLSELECTED expects a table or columns of one table (without arguments it can only be a filter argument of CALCULATE)."));
            }
            let ctx = env.filter.restore_selected(ev.data, &g, Some(&cols.iter().copied().collect()));
            let rows = ev.table_rows(&ctx, cols[0].table, true);
            t(col_table(ev, &cols, ev.distinct_combos(&cols, &rows)))
        }
        "REMOVEFILTERS" | "KEEPFILTERS" | "USERELATIONSHIP" | "CROSSFILTER" | "ALLEXCEPT" | "ALLCROSSFILTERED" => {
            Err(err(ErrorCode::InvalidParameter, format!("{name} can only be used as a filter argument of CALCULATE or CALCULATETABLE.")))
        }
        "VALUES" | "DISTINCT" => {
            let with_blank = name == "VALUES";
            if let Some(tb) = args[0].table() {
                let rows = ev.table_rows(&env.filter, tb, with_blank);
                let rows = if with_blank {
                    rows
                } else {
                    // DISTINCT(table) drops duplicate rows
                    let mut seen = HashSet::new();
                    rows.into_iter().filter(|r| seen.insert(ev.data.tables[tb].dup_group(*r)[0])).collect()
                };
                return t(TableVal::Base { table: tb, rows: Rc::new(rows) });
            }
            if let Some(c) = args[0].col() {
                let vals = distinct_values(ev, c, env, with_blank);
                return t(col_table(ev, &[c], vals.into_iter().map(|v| vec![v]).collect()));
            }
            // a table expression: distinct rows
            let src = ev.table(&args[0], env)?;
            let m = src.to_mat(ev.data);
            let mut seen = HashSet::new();
            let rows = m.rows.iter().filter(|r| seen.insert(r.iter().map(|v| v.key()).collect::<Vec<_>>())).cloned().collect();
            t(TableVal::mat(m.cols.clone(), rows))
        }
        "SELECTEDVALUE" => {
            let c = col_arg(name, args, 0)?;
            let vals = distinct_values(ev, c, env, true);
            if vals.len() == 1 {
                s(vals.into_iter().next().unwrap())
            } else if args.len() > 1 {
                s(ev.scalar(&args[1], env)?)
            } else {
                s(Value::Blank)
            }
        }
        "EARLIER" | "EARLIEST" => {
            let c = col_arg(name, args, 0)?;
            let skip = if name == "EARLIEST" {
                ev.row_depth_of(c, env).saturating_sub(1)
            } else if args.len() > 1 {
                let n = ev.scalar(&args[1], env)?.to_f64()? as i64;
                if n < 1 {
                    return Err(err(ErrorCode::InvalidParameter, "The second argument of EARLIER must be 1 or more."));
                }
                n as usize
            } else {
                1
            };
            match ev.row_value_nth(c, env, skip)? {
                Some(v) => s(v),
                None => Err(err(ErrorCode::InvalidValue, format!("EARLIER/EARLIEST refers to an earlier row context which doesn't exist for column {}.", ev.data.model.column_name(c)))),
            }
        }
        "TREATAS" => {
            let src = ev.table(&args[0], env)?;
            let cols = (1..args.len()).map(|i| col_arg(name, args, i)).collect::<VResult<Vec<_>>>()?;
            if src.ncols(ev.data) != cols.len() {
                return Err(err(ErrorCode::InvalidParameter, format!("TREATAS: the table has {} column(s) but {} target column(s) were given.", src.ncols(ev.data), cols.len())));
            }
            let m = src.to_mat(ev.data);
            t(col_table(ev, &cols, m.rows.clone()))
        }
        // ---------------------------------------------------------------- relationships
        "RELATED" => {
            let c = col_arg(name, args, 0)?;
            let g = ev.graph(&env.filter);
            let mut cur = env.rows.clone();
            while let Some(f) = cur {
                if let RowRef::Base { table, row } = &f.row {
                    if *table == c.table {
                        return s(ev.data.value(c, *row).clone());
                    }
                    if let Some(r) = g.follow(ev.data, *table, *row, c.table) {
                        return s(ev.data.value(c, r).clone());
                    }
                }
                cur = f.parent.clone();
            }
            Err(err(ErrorCode::InvalidValue, format!("The column {} either doesn't exist or doesn't have a relationship to any table available in the current context.", ev.data.model.column_name(c))))
        }
        "RELATEDTABLE" => {
            let ctx = ev.calculate_ctx(&[], env)?;
            t(ev.table(&args[0], &env.with_filter(ctx))?)
        }
        // ---------------------------------------------------------------- information
        "BLANK" => s(Value::Blank),
        "ISBLANK" => s(Value::Bool(ev.scalar(&args[0], env)?.is_blank())),
        "ISFILTERED" => {
            if let Some(c) = args[0].col() {
                return s(Value::Bool(env.filter.is_filtered_column(c)));
            }
            if let Some(tb) = args[0].table() {
                return s(Value::Bool(env.filter.filters.iter().any(|f| f.cols().iter().any(|c| c.table == tb))));
            }
            Err(err(ErrorCode::InvalidParameter, "ISFILTERED expects a table or column reference."))
        }
        "ISCROSSFILTERED" => {
            let tb = args[0].col().map(|c| c.table).or(args[0].table()).ok_or_else(|| err(ErrorCode::InvalidParameter, "ISCROSSFILTERED expects a table or column reference."))?;
            s(Value::Bool(ev.visible(&env.filter, tb).1))
        }
        "HASONEVALUE" => {
            let c = col_arg(name, args, 0)?;
            s(Value::Bool(distinct_values(ev, c, env, true).len() == 1))
        }
        "ISEMPTY" => s(Value::Bool(ev.table(&args[0], env)?.nrows() == 0)),
        // ---------------------------------------------------------------- logical
        "IF" => {
            if ev.scalar(&args[0], env)?.to_bool()? {
                s(ev.scalar(&args[1], env)?)
            } else if args.len() > 2 && !args[2].is_missing() {
                s(ev.scalar(&args[2], env)?)
            } else {
                s(Value::Blank)
            }
        }
        "AND" => s(Value::Bool(ev.scalar(&args[0], env)?.to_bool()? && ev.scalar(&args[1], env)?.to_bool()?)),
        "OR" => s(Value::Bool(ev.scalar(&args[0], env)?.to_bool()? || ev.scalar(&args[1], env)?.to_bool()?)),
        "NOT" => s(Value::Bool(!ev.scalar(&args[0], env)?.to_bool()?)),
        "TRUE" => s(Value::Bool(true)),
        "FALSE" => s(Value::Bool(false)),
        "COALESCE" => {
            for a in args {
                let v = ev.scalar(a, env)?;
                if !v.is_blank() {
                    return s(v);
                }
            }
            s(Value::Blank)
        }
        // ---------------------------------------------------------------- aggregation
        "SUM" => {
            let c = col_arg(name, args, 0)?;
            if let Some(v) = crate::sql::try_aggregate(ev, name, c, env)? {
                return s(v);
            }
            s(sum_values(name, column_values(ev, c, env).into_iter())?)
        }
        "AVERAGE" => {
            let c = col_arg(name, args, 0)?;
            if let Some(v) = crate::sql::try_aggregate(ev, name, c, env)? {
                return s(v);
            }
            s(average_values(name, column_values(ev, c, env).into_iter())?)
        }
        "MIN" | "MAX" => {
            if args.len() == 2 {
                let a = ev.scalar(&args[0], env)?;
                let b = ev.scalar(&args[1], env)?;
                let o = value::compare(&a, &b)?;
                let pick_a = if name == "MIN" { o != std::cmp::Ordering::Greater } else { o != std::cmp::Ordering::Less };
                return s(if pick_a { a } else { b });
            }
            let c = col_arg(name, args, 0)?;
            if let Some(v) = crate::sql::try_aggregate(ev, name, c, env)? {
                return s(v);
            }
            s(extreme(column_values(ev, c, env).into_iter(), name == "MAX")?)
        }
        "COUNT" | "COUNTA" => {
            let c = col_arg(name, args, 0)?;
            if let Some(v) = crate::sql::try_aggregate(ev, "COUNT", c, env)? {
                return s(v);
            }
            s(as_count(column_values(ev, c, env).iter().filter(|v| !v.is_blank()).count()))
        }
        "COUNTBLANK" => {
            let c = col_arg(name, args, 0)?;
            s(as_count(column_values(ev, c, env).iter().filter(|v| v.is_blank()).count()))
        }
        "COUNTROWS" => {
            if let Some(tb) = args[0].table() {
                if let Some(v) = crate::sql::try_count_rows(ev, tb, env)? {
                    return s(v);
                }
            }
            s(as_count(ev.table(&args[0], env)?.nrows()))
        }
        "DISTINCTCOUNT" | "DISTINCTCOUNTNOBLANK" => {
            let c = col_arg(name, args, 0)?;
            let vals = distinct_values(ev, c, env, true);
            let n = if name == "DISTINCTCOUNT" { vals.len() } else { vals.iter().filter(|v| !v.is_blank()).count() };
            s(as_count(n))
        }
        "SUMX" | "AVERAGEX" | "MINX" | "MAXX" | "COUNTX" | "COUNTAX" => {
            let src = ev.table(&args[0], env)?;
            let mut vals = Vec::with_capacity(src.nrows());
            for_each_row(ev, &src, env, |_, e2| {
                vals.push(ev.scalar(&args[1], e2)?);
                Ok(true)
            })?;
            s(match name {
                "SUMX" => sum_values(name, vals.into_iter())?,
                "AVERAGEX" => average_values(name, vals.into_iter())?,
                "MINX" => extreme(vals.into_iter(), false)?,
                "MAXX" => extreme(vals.into_iter(), true)?,
                _ => as_count(vals.iter().filter(|v| !v.is_blank()).count()),
            })
        }
        // ---------------------------------------------------------------- math
        "DIVIDE" => {
            let a = ev.scalar(&args[0], env)?;
            let b = ev.scalar(&args[1], env)?;
            if b.is_blank() || b.to_f64()? == 0.0 {
                return s(if args.len() > 2 && !args[2].is_missing() { ev.scalar(&args[2], env)? } else { Value::Blank });
            }
            s(value::div(&a, &b)?)
        }
        // ---------------------------------------------------------------- tables
        "ADDCOLUMNS" => {
            let src = ev.table(&args[0], env)?;
            let pairs = name_expr_pairs(ev, &args[1..], env, name)?;
            let mut cols = src.cols(ev.data);
            for (n, _) in &pairs {
                cols.push(TCol { name: n.clone(), lineage: None });
            }
            let mut rows = Vec::with_capacity(src.nrows());
            for_each_row(ev, &src, env, |i, e2| {
                let mut r = src.row(ev.data, i);
                for (_, x) in &pairs {
                    r.push(ev.scalar(x, e2)?);
                }
                rows.push(r);
                Ok(true)
            })?;
            t(TableVal::mat(cols, rows))
        }
        "SELECTCOLUMNS" => {
            let src = ev.table(&args[0], env)?;
            let pairs = name_expr_pairs(ev, &args[1..], env, name)?;
            let cols = pairs.iter().map(|(n, x)| TCol { name: n.clone(), lineage: x.col() }).collect();
            let mut rows = Vec::with_capacity(src.nrows());
            for_each_row(ev, &src, env, |_, e2| {
                rows.push(pairs.iter().map(|(_, x)| ev.scalar(x, e2)).collect::<VResult<Vec<_>>>()?);
                Ok(true)
            })?;
            t(TableVal::mat(cols, rows))
        }
        "ROW" => {
            let pairs = name_expr_pairs(ev, args, env, name)?;
            let cols = pairs.iter().map(|(n, _)| TCol { name: n.clone(), lineage: None }).collect();
            let row = pairs.iter().map(|(_, x)| ev.scalar(x, env)).collect::<VResult<Vec<_>>>()?;
            t(TableVal::mat(cols, vec![row]))
        }
        "CROSSJOIN" => {
            let tables = args.iter().map(|a| ev.table(a, env).map(|x| x.to_mat(ev.data))).collect::<VResult<Vec<_>>>()?;
            let mut cols = Vec::new();
            for m in &tables {
                cols.extend(m.cols.iter().cloned());
            }
            let mut rows: Vec<Vec<Value>> = vec![vec![]];
            for m in &tables {
                let mut next = Vec::with_capacity(rows.len() * m.rows.len());
                for r in &rows {
                    for x in &m.rows {
                        let mut v = r.clone();
                        v.extend(x.iter().cloned());
                        next.push(v);
                    }
                }
                rows = next;
            }
            t(TableVal::mat(cols, rows))
        }
        "SUMMARIZECOLUMNS" => t(summarize_columns(ev, args, env)?),
        "SUMMARIZE" => t(summarize(ev, args, env)?),
        _ => {
            for m in MODULES {
                if let Some(r) = m(ev, name, args, env) {
                    return r;
                }
            }
            Err(err(ErrorCode::NotImplemented, format!("The function {name} is not implemented in BIForge yet.")))
        }
    }
}

pub(crate) fn name_expr_pairs<'a>(ev: &'a Evaluator<'a>, args: &'a [BExpr], env: &Env<'a>, func: &str) -> VResult<Vec<(String, &'a BExpr)>> {
    if args.len() % 2 != 0 {
        return Err(err(ErrorCode::MissingParameters, format!("{func} expects pairs of a column name and an expression.")));
    }
    let mut out = Vec::new();
    for p in args.chunks(2) {
        let n = match &p[0].kind {
            BKind::Const(Value::Str(n)) => n.to_string(),
            _ => match ev.scalar(&p[0], env)? {
                Value::Str(n) => n.to_string(),
                _ => return Err(err(ErrorCode::InvalidParameter, format!("{func}: column names must be text."))),
            },
        };
        out.push((n, &p[1]));
    }
    Ok(out)
}

/// SUMMARIZECOLUMNS(groupBy..., filterTable..., name, expression, ...): groups by columns (combinations
/// that exist within each table, cross-joined across tables), applies filter tables like CALCULATE, adds
/// the expressions, and drops rows where every expression is BLANK.
fn summarize_columns<'a>(ev: &'a Evaluator<'a>, args: &'a [BExpr], env: &Env<'a>) -> VResult<TableVal> {
    let mut groups: Vec<ColId> = Vec::new();
    let mut filters: Vec<&'a BExpr> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(c) = a.col() {
            if !groups.contains(&c) {
                groups.push(c);
            }
            i += 1;
        } else if matches!(&a.kind, BKind::Const(Value::Str(_))) {
            break;
        } else {
            filters.push(a);
            i += 1;
        }
    }
    let pairs = name_expr_pairs(ev, &args[i..], env, "SUMMARIZECOLUMNS")?;
    let ctx = {
        // filter tables are evaluated and applied like CALCULATE filter arguments (no context transition)
        let plain = Env { filter: env.filter.clone(), rows: None, vars: env.vars.clone() };
        ev.calculate_ctx(&filters, &plain)?.with_shadow()
    };
    // group combinations: per table, existing combinations; then cross join
    let mut by_table: Vec<(usize, Vec<ColId>)> = Vec::new();
    for &c in &groups {
        match by_table.iter_mut().find(|(t, _)| *t == c.table) {
            Some((_, v)) => v.push(c),
            None => by_table.push((c.table, vec![c])),
        }
    }
    let mut combos: Vec<Vec<Value>> = vec![vec![]];
    let mut order: Vec<ColId> = Vec::new();
    for (tb, cols) in &by_table {
        let rows = ev.table_rows(&ctx, *tb, true);
        let vals = ev.distinct_combos(cols, &rows);
        let mut next = Vec::new();
        for c in &combos {
            for v in &vals {
                let mut r = c.clone();
                r.extend(v.iter().cloned());
                next.push(r);
            }
        }
        combos = next;
        order.extend(cols.iter().copied());
    }
    let mut out_rows = Vec::new();
    let g = ev.graph(&ctx);
    for combo in combos {
        if pairs.is_empty() {
            out_rows.push(combo);
            continue;
        }
        let mut c2 = ctx.remove_columns(ev.data, &g, &order.iter().copied().collect());
        for (k, &c) in order.iter().enumerate() {
            c2 = c2.push(Filter::single(c, combo[k].key()));
        }
        let e2 = Env { filter: c2, rows: None, vars: env.vars.clone() };
        let vals = pairs.iter().map(|(_, x)| ev.scalar(x, &e2)).collect::<VResult<Vec<_>>>()?;
        if vals.iter().all(|v| v.is_blank()) {
            continue;
        }
        let mut r = combo;
        r.extend(vals);
        out_rows.push(r);
    }
    let mut cols: Vec<TCol> = order.iter().map(|&c| TCol { name: ev.data.model.column(c).name.clone(), lineage: Some(c) }).collect();
    cols.extend(pairs.iter().map(|(n, _)| TCol { name: n.clone(), lineage: None }));
    Ok(TableVal::mat(cols, out_rows))
}

/// SUMMARIZE(table, groupBy...): distinct combinations of the group-by columns over the table's rows
/// (group-by columns may come from related tables). Extension columns are not supported yet.
fn summarize<'a>(ev: &'a Evaluator<'a>, args: &'a [BExpr], env: &Env<'a>) -> VResult<TableVal> {
    let src = ev.table(&args[0], env)?;
    let mut cols = Vec::new();
    let mut split = args.len();
    for (n, a) in args.iter().enumerate().skip(1) {
        match a.col() {
            Some(c) => cols.push(c),
            None if matches!(&a.kind, BKind::Const(Value::Str(_))) => {
                split = n;
                break;
            }
            None => return Err(err(ErrorCode::InvalidParameter, "SUMMARIZE: group-by arguments must be column references; added columns come as name, expression pairs.")),
        }
    }
    let pairs = name_expr_pairs(ev, &args[split..], env, "SUMMARIZE")?;
    let TableVal::Base { table, rows } = &src else {
        return Err(err(ErrorCode::NotImplemented, "SUMMARIZE over a computed table is not implemented in BIForge yet."));
    };
    let g = ev.graph(&env.filter);
    let mut seen: HashMap<Vec<Key>, ()> = HashMap::new();
    let mut out = Vec::new();
    for &r in rows.iter() {
        let vals: Vec<Value> = cols
            .iter()
            .map(|&c| if c.table == *table { ev.data.value(c, r).clone() } else { g.value_through(ev.data, *table, r, c).clone() })
            .collect();
        if cols.iter().any(|c| !g.reaches(*table, c.table)) {
            return Err(err(ErrorCode::InvalidParameter, "SUMMARIZE: a group-by column is not related to the table."));
        }
        if seen.insert(vals.iter().map(|v| v.key()).collect(), ()).is_none() {
            out.push(vals);
        }
    }
    if pairs.is_empty() {
        return Ok(col_table(ev, &cols, out));
    }
    // added columns: evaluated per group in the filter context of the group-by values
    let g = ev.graph(&env.filter);
    let group_cols: HashSet<ColId> = cols.iter().copied().collect();
    let mut rows = Vec::with_capacity(out.len());
    for mut vals in out {
        let mut c2 = env.filter.remove_columns(ev.data, &g, &group_cols);
        for (k, &c) in cols.iter().enumerate() {
            c2 = c2.push(Filter::single(c, vals[k].key()));
        }
        let e2 = Env { filter: c2, rows: None, vars: env.vars.clone() };
        for (_, x) in &pairs {
            vals.push(ev.scalar(x, &e2)?);
        }
        rows.push(vals);
    }
    let mut tcols: Vec<TCol> = cols.iter().map(|&c| TCol { name: ev.data.model.column(c).name.clone(), lineage: Some(c) }).collect();
    tcols.extend(pairs.iter().map(|(n, _)| TCol { name: n.clone(), lineage: None }));
    Ok(TableVal::mat(tcols, rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_implemented_name_is_in_the_catalog_once() {
        let cat = Catalog::builtin();
        let names = implemented_names();
        for n in &names {
            assert!(cat.get(n).is_some(), "{n} is implemented but missing from the catalog");
        }
        let total = IMPLEMENTED.len() + MODULE_NAMES.iter().map(|m| m.len()).sum::<usize>();
        assert_eq!(names.len(), total, "a function is listed twice");
    }
}
