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

use crate::ast::{BinOp, UnOp};
use crate::bind::{BExpr, BKind, MeasureRef};
use crate::data::ModelData;
use crate::eval::{Env, Evaluator};
use crate::filter::{Filter, FilterCtx, Graph};
use crate::model::{ColId, DataType, TableId};
use crate::value::{serial_to_datetime, EvalError, Key, VResult, Value};
use std::collections::{BTreeMap, HashMap};

/// Runs a SQL query that returns one row with one column.
pub trait SqlExecutor {
    fn query_scalar(&self, sql: &str) -> Result<Value, String>;

    /// Runs a SQL query and returns all its rows (needed to evaluate a whole group-by at once).
    fn query_rows(&self, _sql: &str) -> Result<Vec<Vec<Value>>, String> {
        Err("This data source cannot return rows.".to_string())
    }
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
    from_where_ex(ev, ctx, t, &[]).map(|(sql, _)| sql)
}

/// Joins `t` (alias `t0`) to the table of `c` along the active relationships, adding an alias per table reached.
fn ensure_alias(data: &ModelData, g: &Graph, t: TableId, c: ColId, aliases: &mut BTreeMap<TableId, String>, joins: &mut Vec<String>) -> Option<()> {
    if aliases.contains_key(&c.table) {
        return Some(());
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
    Some(())
}

/// Like [`from_where`], also joining the tables of `extra` columns (needed by an expression) and returning the
/// alias of every table in the statement.
pub fn from_where_ex(ev: &Evaluator, ctx: &FilterCtx, t: TableId, extra: &[ColId]) -> Option<(String, BTreeMap<TableId, String>)> {
    let data = ev.data;
    let g = ev.graph(ctx);
    if would_semijoin(data, &g, ctx, t) {
        return None;
    }
    let mut aliases: BTreeMap<TableId, String> = BTreeMap::new();
    aliases.insert(t, "t0".into());
    let mut joins = Vec::new();
    let mut conds = Vec::new();
    // recorded from Power BI: the rows of a fact table used as a filter also restrict the tables they point to, which a
    // join cannot express; found by running the recorded conformance cases with SQL enabled
    if ctx.filters.iter().any(|f| matches!(f, Filter::Rows { table: src, .. } if *src != t && g.reaches(*src, t))) {
        return None;
    }
    for c in extra {
        ensure_alias(data, &g, t, *c, &mut aliases, &mut joins)?;
    }
    for f in ctx.filters.iter().filter(|f| g.applies(f, t)) {
        let Filter::Values { cols, set } = f else { return None };
        if cols.iter().any(|c| data.model.column(*c).expression.is_some()) {
            return None;
        }
        for c in cols {
            ensure_alias(data, &g, t, *c, &mut aliases, &mut joins)?;
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
    Some((sql, aliases))
}

// ---------------------------------------------------------------------------------------------------------------
// Row expressions of SUMX and friends

const MAX_EXPR_LEN: usize = 6000;

fn numeric_col(data: &ModelData, c: ColId) -> bool {
    let col = data.model.column(c);
    col.expression.is_none() && matches!(col.data_type, DataType::Int64 | DataType::Double)
}

/// Columns of other tables that `e` reads through RELATED, and whether `e` can be translated at all.
fn collect_columns(ev: &Evaluator, e: &BExpr, t: TableId, g: &Graph, out: &mut Vec<ColId>) -> bool {
    match &e.kind {
        BKind::Const(Value::Int(_)) | BKind::Const(Value::Double(_)) => true,
        BKind::Col(c) => c.table == t && numeric_col(ev.data, *c),
        BKind::Call { name, args } if name == "RELATED" && args.len() == 1 => match args[0].kind {
            BKind::Col(c) if c.table != t && numeric_col(ev.data, c) => {
                // RELATED follows many-to-one relationships only
                let forward = g.path(t, c.table).is_some_and(|p| p.iter().all(|h| h.forward));
                if forward {
                    out.push(c);
                }
                forward
            }
            _ => false,
        },
        BKind::Call { name, args } if name == "DIVIDE" && args.len() == 2 => collect_columns(ev, &args[0], t, g, out) && collect_columns(ev, &args[1], t, g, out),
        BKind::Unary(UnOp::Neg, x) | BKind::Unary(UnOp::Plus, x) => collect_columns(ev, x, t, g, out),
        BKind::Binary(BinOp::Add | BinOp::Sub | BinOp::Mul, a, b) => collect_columns(ev, a, t, g, out) && collect_columns(ev, b, t, g, out),
        BKind::Binary(BinOp::Div, a, b) => matches!(&b.kind, BKind::Const(Value::Int(i)) if *i != 0) | matches!(&b.kind, BKind::Const(Value::Double(f)) if *f != 0.0) && collect_columns(ev, a, t, g, out),
        _ => false,
    }
}

fn is_const(e: &BExpr) -> bool {
    matches!(e.kind, BKind::Const(_))
}

/// SQL for a row expression with DAX's BLANK arithmetic (BLANK + x = x, BLANK - x = -x, BLANK * x = BLANK).
fn row_sql(ev: &Evaluator, e: &BExpr, aliases: &BTreeMap<TableId, String>, t: TableId) -> Option<String> {
    let sql = match &e.kind {
        BKind::Const(Value::Int(i)) => format!("CAST({i} AS BIGINT)"),
        BKind::Const(Value::Double(f)) if f.is_finite() => format!("CAST({f:?} AS DOUBLE)"),
        BKind::Col(c) => format!("{}.{}", aliases.get(&c.table)?, quote_ident(&ev.data.model.column(*c).name)),
        BKind::Call { name, args } if name == "RELATED" => match args[0].kind {
            BKind::Col(c) => format!("{}.{}", aliases.get(&c.table)?, quote_ident(&ev.data.model.column(c).name)),
            _ => return None,
        },
        BKind::Call { name, args } if name == "DIVIDE" => {
            let (a, b) = (row_sql(ev, &args[0], aliases, t)?, row_sql(ev, &args[1], aliases, t)?);
            format!("(CASE WHEN {b} IS NULL OR {b} = 0 THEN NULL ELSE CAST({a} AS DOUBLE) / {b} END)")
        }
        BKind::Unary(UnOp::Neg, x) => format!("(-{})", row_sql(ev, x, aliases, t)?),
        BKind::Unary(UnOp::Plus, x) => row_sql(ev, x, aliases, t)?,
        BKind::Binary(op, a, b) => {
            let (sa, sb) = (row_sql(ev, a, aliases, t)?, row_sql(ev, b, aliases, t)?);
            match op {
                BinOp::Mul => format!("({sa} * {sb})"),
                BinOp::Div => format!("(CAST({sa} AS DOUBLE) / {sb})"),
                BinOp::Add | BinOp::Sub => {
                    let plus = *op == BinOp::Add;
                    let o = if plus { "+" } else { "-" };
                    match (is_const(a), is_const(b)) {
                        (true, true) => format!("({sa} {o} {sb})"),
                        (true, false) => format!("({sa} {o} coalesce({sb}, 0))"),
                        (false, true) => format!("(coalesce({sa}, 0) {o} {sb})"),
                        (false, false) => {
                            let neg = if plus { sb.clone() } else { format!("(-{sb})") };
                            format!("(CASE WHEN {sa} IS NULL THEN {neg} WHEN {sb} IS NULL THEN {sa} ELSE {sa} {o} {sb} END)")
                        }
                    }
                }
                _ => return None,
            }
        }
        _ => return None,
    };
    (sql.len() <= MAX_EXPR_LEN).then_some(sql)
}

/// Compiles SUMX / AVERAGEX / MINX / MAXX over a model table with a numeric row expression (columns of the table,
/// RELATED stored columns of tables on the one side, constants, + - * /, DIVIDE), if possible.
pub fn try_iterator(ev: &Evaluator, func: &str, table: TableId, expr: &BExpr, env: &Env) -> VResult<Option<Value>> {
    if ev.sql.is_none() {
        return Ok(None);
    }
    let agg = match func {
        "SUMX" => "SUM",
        "AVERAGEX" => "AVG",
        "MINX" => "MIN",
        "MAXX" => "MAX",
        _ => return Ok(None),
    };
    let g = ev.graph(&env.filter);
    let mut extra = Vec::new();
    if !collect_columns(ev, expr, table, &g, &mut extra) {
        return Ok(None);
    }
    let Some((fw, aliases)) = from_where_ex(ev, &env.filter, table, &extra) else { return Ok(None) };
    let Some(row) = row_sql(ev, expr, &aliases, table) else { return Ok(None) };
    let mut v = run(ev, &format!("SELECT {agg}({row}) {fw}"))?;
    if agg == "AVG" {
        if let Some(f) = v.as_f64().filter(|_| !v.is_blank()) {
            v = Value::Double(f);
        }
    }
    Ok(Some(v))
}

/// Compiles DISTINCTCOUNT of a stored column of a table, if possible. BLANK counts as one value when present.
pub fn try_distinct_count(ev: &Evaluator, c: ColId, env: &Env) -> VResult<Option<Value>> {
    if ev.sql.is_none() || ev.data.model.column(c).expression.is_some() {
        return Ok(None);
    }
    let Some(fw) = from_where(ev, &env.filter, c.table) else { return Ok(None) };
    let col = quote_ident(&ev.data.model.column(c).name);
    let x = if ev.data.model.column(c).data_type == DataType::String { format!("lower(t0.{col})") } else { format!("t0.{col}") };
    let v = run(ev, &format!("SELECT count(DISTINCT {x}) + (CASE WHEN count(*) > count(t0.{col}) THEN 1 ELSE 0 END) {fw}"))?;
    Ok(Some(if v == Value::Int(0) { Value::Blank } else { v }))
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

// ---------------------------------------------------------------------------------------------------------------
// Whole group-by at once (SUMMARIZECOLUMNS)

/// How the SQL result of an aggregate becomes the DAX value.
#[derive(Clone, Copy, PartialEq)]
enum Post {
    Plain,
    /// COUNT / COUNTROWS / DISTINCTCOUNT: 0 is BLANK
    CountBlank,
    /// AVERAGE: always a Double
    Avg,
    /// SUM of a Double column: a Double even when the SQL sum is integral
    SumDouble,
}

struct AggSql {
    table: TableId,
    /// The aggregate over the alias `t0` of the table.
    sql: String,
    post: Post,
    /// Columns of other tables the aggregate reads (RELATED).
    extra: Vec<ColId>,
    /// SUMX and friends: the row expression is rendered once the aliases are known.
    iter: bool,
}

fn post_value(post: Post, mut v: Value) -> Value {
    match post {
        Post::Plain => v,
        Post::CountBlank => {
            if v == Value::Int(0) {
                Value::Blank
            } else {
                v
            }
        }
        Post::Avg => {
            if let Some(f) = v.as_f64().filter(|_| !v.is_blank()) {
                v = Value::Double(f);
            }
            v
        }
        Post::SumDouble => {
            if let Value::Int(i) = v {
                v = Value::Double(i as f64);
            }
            v
        }
    }
}

/// The SQL aggregate a measure expression compiles to, when it is one of the shapes the per-aggregate compilers
/// handle (SUM, AVERAGE, MIN, MAX, COUNT, COUNTROWS, DISTINCTCOUNT of a stored column, SUMX and friends over a table), possibly
/// through measure references.
fn agg_of(ev: &Evaluator, e: &BExpr, ctx: &FilterCtx, depth: usize) -> Option<AggSql> {
    if depth > 8 {
        return None;
    }
    let data = ev.data;
    match &e.kind {
        BKind::Measure(m @ (MeasureRef::Model(_) | MeasureRef::Query(_))) => agg_of(ev, ev.measure_body(*m)?, ctx, depth + 1),
        BKind::Call { name, args } => {
            let col_arg = |i: usize| match args.get(i)?.kind {
                BKind::Col(c) if data.model.column(c).expression.is_none() => Some(c),
                _ => None,
            };
            match name.as_str() {
                "SUM" | "AVERAGE" | "MIN" | "MAX" if args.len() == 1 => {
                    let c = col_arg(0)?;
                    let col = data.model.column(c);
                    let numeric = matches!(col.data_type, DataType::Int64 | DataType::Double | DataType::Decimal);
                    let q = format!("t0.{}", quote_ident(&col.name));
                    let (agg, post) = match name.as_str() {
                        "SUM" if numeric => ("SUM", if col.data_type == DataType::Double { Post::SumDouble } else { Post::Plain }),
                        "AVERAGE" if numeric => ("AVG", Post::Avg),
                        "MIN" | "MAX" if numeric || matches!(col.data_type, DataType::DateTime | DataType::Boolean) => (name.as_str(), Post::Plain),
                        _ => return None,
                    };
                    Some(AggSql { table: c.table, sql: format!("{agg}({q})"), post, extra: vec![], iter: false })
                }
                "COUNT" if args.len() == 1 => {
                    let c = col_arg(0)?;
                    let col = data.model.column(c);
                    if col.data_type == DataType::Boolean {
                        return None;
                    }
                    Some(AggSql { table: c.table, sql: format!("COUNT(t0.{})", quote_ident(&col.name)), post: Post::CountBlank, extra: vec![], iter: false })
                }
                "COUNTROWS" if args.len() == 1 => {
                    let t = args[0].table()?;
                    Some(AggSql { table: t, sql: "COUNT(*)".into(), post: Post::CountBlank, extra: vec![], iter: false })
                }
                "DISTINCTCOUNT" if args.len() == 1 => {
                    let c = col_arg(0)?;
                    let col = data.model.column(c);
                    let q = format!("t0.{}", quote_ident(&col.name));
                    let x = if col.data_type == DataType::String { format!("lower({q})") } else { q.clone() };
                    Some(AggSql { table: c.table, sql: format!("(count(DISTINCT {x}) + (CASE WHEN count(*) > count({q}) THEN 1 ELSE 0 END))"), post: Post::CountBlank, extra: vec![], iter: false })
                }
                "SUMX" | "AVERAGEX" | "MINX" | "MAXX" if args.len() == 2 => {
                    let t = args[0].table()?;
                    let agg = match name.as_str() {
                        "SUMX" => "SUM",
                        "AVERAGEX" => "AVG",
                        "MINX" => "MIN",
                        _ => "MAX",
                    };
                    let g = ev.graph(ctx);
                    let mut extra = Vec::new();
                    if !collect_columns(ev, &args[1], t, &g, &mut extra) {
                        return None;
                    }
                    Some(AggSql { table: t, sql: String::new(), post: if agg == "AVG" { Post::Avg } else { Post::Plain }, extra, iter: true })
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// The values of aggregate expressions for every combination of the group columns, computed by one SQL
/// `GROUP BY` per fact table. Entry `i` is None when expression `i` is not a plain aggregate (it is then evaluated
/// per combination by the caller). Combinations missing from the map have no rows: BLANK.
pub fn try_batch(ev: &Evaluator, ctx: &FilterCtx, groups: &[ColId], exprs: &[&BExpr]) -> VResult<Vec<Option<HashMap<Vec<Key>, Value>>>> {
    let mut out: Vec<Option<HashMap<Vec<Key>, Value>>> = vec![None; exprs.len()];
    let Some(exec) = ev.sql else { return Ok(out) };
    if groups.is_empty() || groups.iter().any(|c| ev.data.model.column(*c).expression.is_some()) {
        return Ok(out);
    }
    // the aggregate of each expression, by table
    let mut aggs: Vec<Option<(AggSql, &BExpr)>> = Vec::new();
    for e in exprs {
        aggs.push(agg_of_expr(ev, e, ctx).map(|a| (a, *e)));
    }
    let tables: Vec<TableId> = {
        let mut t: Vec<TableId> = aggs.iter().flatten().map(|(a, _)| a.table).collect();
        t.sort();
        t.dedup();
        t
    };
    // context with a value filter on every group column: used to check that no cross-filter changes the result
    let mut probe = ctx.clone();
    for c in groups {
        probe = probe.push(Filter::single(*c, Key::Blank));
    }
    for t in tables {
        let g = ev.graph(&probe);
        if would_semijoin(ev.data, &g, &probe, t) {
            continue;
        }
        let members: Vec<usize> = (0..exprs.len()).filter(|&i| aggs[i].as_ref().is_some_and(|(a, _)| a.table == t)).collect();
        let mut extra: Vec<ColId> = groups.to_vec();
        for &i in &members {
            extra.extend(aggs[i].as_ref().unwrap().0.extra.iter().copied());
        }
        let Some((fw, aliases)) = from_where_ex(ev, ctx, t, &extra) else { continue };
        let group_sql: Option<Vec<String>> = groups
            .iter()
            .map(|c| {
                let col = ev.data.model.column(*c);
                let q = format!("{}.{}", aliases.get(&c.table)?, quote_ident(&col.name));
                Some(if col.data_type == DataType::String { format!("lower({q})") } else { q })
            })
            .collect();
        let Some(group_sql) = group_sql else { continue };
        let mut select = group_sql.clone();
        let mut ok = true;
        for &i in &members {
            let (a, e) = aggs[i].as_ref().unwrap();
            // SUMX and friends carry the row expression: render it with the final aliases
            let sql = if a.iter {
                match iterator_sql(ev, e, &aliases, t, 0) {
                    Some(s) => s,
                    None => {
                        ok = false;
                        break;
                    }
                }
            } else {
                a.sql.clone()
            };
            select.push(sql);
        }
        if !ok {
            continue;
        }
        let sql = format!("SELECT {} {fw} GROUP BY {}", select.join(", "), group_sql.join(", "));
        let rows = exec.query_rows(&sql).map_err(|e| EvalError::eval(format!("The data engine failed: {e}")))?;
        ev.sql_hits.set(ev.sql_hits.get() + 1);
        let n = groups.len();
        let mut maps: Vec<HashMap<Vec<Key>, Value>> = members.iter().map(|_| HashMap::new()).collect();
        for r in rows {
            let key: Vec<Key> = r[..n].iter().map(|v| v.key()).collect();
            for (k, &i) in members.iter().enumerate() {
                let (a, _) = aggs[i].as_ref().unwrap();
                maps[k].insert(key.clone(), post_value(a.post, r[n + k].clone()));
            }
        }
        for (k, &i) in members.iter().enumerate() {
            out[i] = Some(std::mem::take(&mut maps[k]));
        }
    }
    Ok(out)
}

fn agg_of_expr(ev: &Evaluator, e: &BExpr, ctx: &FilterCtx) -> Option<AggSql> {
    agg_of(ev, e, ctx, 0)
}

/// The aggregate of SUMX / AVERAGEX / MINX / MAXX `e` (possibly behind measure references) with the row expression
/// rendered against `aliases`.
fn iterator_sql(ev: &Evaluator, e: &BExpr, aliases: &BTreeMap<TableId, String>, t: TableId, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match &e.kind {
        BKind::Measure(m) => iterator_sql(ev, ev.measure_body(*m)?, aliases, t, depth + 1),
        BKind::Call { name, args } if args.len() == 2 => {
            let agg = match name.as_str() {
                "SUMX" => "SUM",
                "AVERAGEX" => "AVG",
                "MINX" => "MIN",
                "MAXX" => "MAX",
                _ => return None,
            };
            Some(format!("{agg}({})", row_sql(ev, &args[1], aliases, t)?))
        }
        _ => None,
    }
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
