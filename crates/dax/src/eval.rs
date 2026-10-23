//! The evaluator: environments (filter context, row contexts, variables), measures, CALCULATE with
//! context transition, and the scalar / table evaluation of bound expressions.

use crate::ast::{BinOp, UnOp};
use crate::bind::{BExpr, BKind, Binder, MeasureRef, QueryScope};
use crate::data::{DataSource, ModelData};
use crate::diag::{Diagnostic, ErrorCode};
use crate::filter::{self, Filter, FilterCtx, Graph, RelState, RowSet};
use crate::model::{ColId, Model, TableId};
use crate::sql::SqlExecutor;
use crate::table::{MatTable, TCol, TableVal};
use crate::value::{self, EvalError, Key, VResult, Value};
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// A scalar or a table.
#[derive(Clone, Debug)]
pub enum Val {
    S(Value),
    T(TableVal),
}

#[derive(Clone, Debug)]
pub enum RowRef {
    Base { table: TableId, row: u32 },
    Mat { t: Rc<MatTable>, row: usize },
}

pub struct RowFrame {
    pub row: RowRef,
    pub parent: Option<Rc<RowFrame>>,
}

pub struct VarFrame<'a> {
    slot: usize,
    expr: Option<&'a BExpr>,
    env: Option<Env<'a>>,
    cell: OnceCell<VResult<Val>>,
    parent: Option<Rc<VarFrame<'a>>>,
}

#[derive(Clone)]
pub struct Env<'a> {
    pub filter: FilterCtx,
    pub rows: Option<Rc<RowFrame>>,
    pub vars: Option<Rc<VarFrame<'a>>>,
}

impl<'a> Env<'a> {
    pub fn empty() -> Env<'a> {
        Env { filter: FilterCtx::empty(), rows: None, vars: None }
    }
    pub fn with_filter(&self, filter: FilterCtx) -> Env<'a> {
        Env { filter, rows: self.rows.clone(), vars: self.vars.clone() }
    }
    pub fn push_row(&self, row: RowRef) -> Env<'a> {
        Env { filter: self.filter.clone(), rows: Some(Rc::new(RowFrame { row, parent: self.rows.clone() })), vars: self.vars.clone() }
    }
    /// Binds a variable to an already computed value.
    pub fn bind_value(&self, slot: usize, v: Val) -> Env<'a> {
        let cell = OnceCell::new();
        let _ = cell.set(Ok(v));
        Env { filter: self.filter.clone(), rows: self.rows.clone(), vars: Some(Rc::new(VarFrame { slot, expr: None, env: None, cell, parent: self.vars.clone() })) }
    }
    fn bind_lazy(&self, slot: usize, expr: &'a BExpr) -> Env<'a> {
        let frame = VarFrame { slot, expr: Some(expr), env: Some(self.clone()), cell: OnceCell::new(), parent: self.vars.clone() };
        Env { filter: self.filter.clone(), rows: self.rows.clone(), vars: Some(Rc::new(frame)) }
    }
    fn row_frames(&self) -> Vec<RowRef> {
        let mut v = Vec::new();
        let mut cur = self.rows.clone();
        while let Some(f) = cur {
            v.push(f.row.clone());
            cur = f.parent.clone();
        }
        v
    }
}

pub struct QueryMeasure {
    pub name: String,
    pub table: TableId,
    pub expr: BExpr,
}

pub struct Evaluator<'e> {
    pub data: &'e ModelData,
    graphs: RefCell<HashMap<Vec<RelState>, Rc<Graph>>>,
    vis: RefCell<HashMap<(u64, TableId), Rc<(RowSet, bool)>>>,
    model_measures: Vec<OnceCell<Result<BExpr, EvalError>>>,
    pub query_measures: Vec<QueryMeasure>,
    pub query_tables: Vec<(BExpr, OnceCell<VResult<TableVal>>)>,
    measure_stack: RefCell<Vec<MeasureRef>>,
    pub sql: Option<&'e dyn SqlExecutor>,
    /// Number of aggregations answered by compiled SQL (for tests and diagnostics).
    pub sql_hits: Cell<usize>,
    depth: Cell<usize>,
}

const MAX_DEPTH: usize = 400;

impl From<Diagnostic> for EvalError {
    fn from(d: Diagnostic) -> EvalError {
        EvalError::new(d.code, d.message)
    }
}

impl<'e> Evaluator<'e> {
    pub fn new(data: &'e ModelData) -> Evaluator<'e> {
        Evaluator {
            data,
            graphs: RefCell::new(HashMap::new()),
            vis: RefCell::new(HashMap::new()),
            model_measures: (0..data.model.measures.len()).map(|_| OnceCell::new()).collect(),
            query_measures: vec![],
            query_tables: vec![],
            measure_stack: RefCell::new(vec![]),
            sql: None,
            sql_hits: Cell::new(0),
            depth: Cell::new(0),
        }
    }

    pub fn with_sql(mut self, sql: &'e dyn SqlExecutor) -> Evaluator<'e> {
        self.sql = Some(sql);
        self
    }

    pub fn model(&self) -> &Model {
        &self.data.model
    }

    // ---- relationships and visibility ----

    pub fn graph(&self, ctx: &FilterCtx) -> Rc<Graph> {
        let states = filter::rel_states(self.data, ctx);
        if let Some(g) = self.graphs.borrow().get(&states) {
            return g.clone();
        }
        let g = Rc::new(Graph::new(self.data, states.clone()));
        self.graphs.borrow_mut().insert(states, g.clone());
        g
    }

    /// Visible rows of `t` (including the blank row when visible) and whether anything filters `t`.
    pub fn visible(&self, ctx: &FilterCtx, t: TableId) -> Rc<(RowSet, bool)> {
        if let Some(v) = self.vis.borrow().get(&(ctx.id, t)) {
            return v.clone();
        }
        let g = self.graph(ctx);
        let v = Rc::new(filter::visible(self.data, &g, ctx, t));
        let mut cache = self.vis.borrow_mut();
        if cache.len() > 200_000 {
            cache.clear();
        }
        cache.insert((ctx.id, t), v.clone());
        v
    }

    /// Rows of a table reference: visible rows without the blank row.
    pub fn table_rows(&self, ctx: &FilterCtx, t: TableId, with_blank: bool) -> Vec<u32> {
        let n = self.data.nrows(t) as u32;
        self.visible(ctx, t).0.iter().filter(|&r| with_blank || r < n).collect()
    }

    // ---- measures ----

    fn model_measure(&self, i: usize) -> Result<&BExpr, EvalError> {
        self.model_measures[i]
            .get_or_init(|| {
                let m = &self.data.model.measures[i];
                let e = crate::parser::parse_expression(&m.expression).map_err(|d| {
                    EvalError::new(d.code, format!("Measure '{}' has a syntax error: {}", m.name, d.message))
                })?;
                let scope = QueryScope::default();
                let mut b = Binder::new(&self.data.model, &scope, 0);
                b.bind(&e).map_err(|d| EvalError::new(d.code, format!("Measure '{}': {}", m.name, d.message)))
            })
            .as_ref()
            .map_err(|e| e.clone())
    }

    /// The bound expression of a measure (None when it does not bind).
    pub(crate) fn measure_body(&self, m: MeasureRef) -> Option<&BExpr> {
        match m {
            MeasureRef::Model(i) => self.model_measure(i).ok(),
            MeasureRef::Query(i) => self.query_measures.get(i).map(|q| &q.expr),
        }
    }

    pub fn measure_name(&self, m: MeasureRef) -> String {
        match m {
            MeasureRef::Model(i) => self.data.model.measures[i].name.clone(),
            MeasureRef::Query(i) => self.query_measures[i].name.clone(),
        }
    }

    /// `[Measure]`: an implicit CALCULATE (context transition) of the measure's expression, evaluated
    /// without the caller's row contexts or variables.
    pub fn eval_measure<'a>(&'a self, m: MeasureRef, env: &Env<'a>) -> VResult<Value> {
        if self.measure_stack.borrow().contains(&m) {
            return Err(EvalError::new(ErrorCode::CircularDependency, format!("A circular dependency was detected: measure '{}' refers to itself.", self.measure_name(m))));
        }
        let expr: &'a BExpr = match m {
            MeasureRef::Model(i) => self.model_measure(i)?,
            MeasureRef::Query(i) => &self.query_measures[i].expr,
        };
        let filter = self.context_transition(env)?;
        self.measure_stack.borrow_mut().push(m);
        let r = self.scalar(expr, &Env { filter, rows: None, vars: None });
        self.measure_stack.borrow_mut().pop();
        r
    }

    // ---- evaluation ----

    pub fn eval<'a>(&'a self, e: &'a BExpr, env: &Env<'a>) -> VResult<Val> {
        let d = self.depth.get();
        if d > MAX_DEPTH {
            return Err(EvalError::eval("The expression is nested too deeply."));
        }
        self.depth.set(d + 1);
        let r = self.eval_inner(e, env);
        self.depth.set(d);
        r
    }

    fn eval_inner<'a>(&'a self, e: &'a BExpr, env: &Env<'a>) -> VResult<Val> {
        Ok(match &e.kind {
            BKind::Const(v) => Val::S(v.clone()),
            BKind::Col(c) => Val::S(self.row_value(*c, env)?),
            BKind::RowCol(name) => Val::S(self.row_value_by_name(name, env)?),
            BKind::Measure(m) => Val::S(self.eval_measure(*m, env)?),
            BKind::Var(slot) => self.var(*slot, env)?,
            BKind::Table(t) => Val::T(TableVal::Base { table: *t, rows: Rc::new(self.table_rows(&env.filter, *t, false)) }),
            BKind::QueryTable(i) => {
                let (expr, cell) = &self.query_tables[*i];
                Val::T(cell.get_or_init(|| self.table(expr, &Env::empty())).clone()?)
            }
            BKind::Call { name, args } => crate::functions::call(self, name, args, e, env)?,
            BKind::Unary(op, x) => {
                let v = self.scalar(x, env)?;
                Val::S(match op {
                    UnOp::Neg => value::neg(&v)?,
                    UnOp::Plus => v,
                    UnOp::Not => Value::Bool(!v.to_bool()?),
                })
            }
            BKind::Binary(op, l, r) => {
                let a = self.scalar(l, env)?;
                let b = self.scalar(r, env)?;
                Val::S(binary(*op, &a, &b)?)
            }
            BKind::In(l, r) => {
                let left: Vec<Value> = match &l.kind {
                    BKind::Tuple(items) => items.iter().map(|i| self.scalar(i, env)).collect::<VResult<_>>()?,
                    _ => vec![self.scalar(l, env)?],
                };
                let t = self.table(r, env)?;
                if t.ncols(self.data) != left.len() {
                    return Err(EvalError::eval(format!("IN needs a table with {} column(s) on its right side.", left.len())));
                }
                let mut found = false;
                'rows: for row in 0..t.nrows() {
                    for (c, lv) in left.iter().enumerate() {
                        if !value::strict_eq(lv, &t.value(self.data, row, c)).unwrap_or(false) {
                            continue 'rows;
                        }
                    }
                    found = true;
                    break;
                }
                Val::S(Value::Bool(found))
            }
            BKind::Tuple(_) => return Err(EvalError::new(ErrorCode::InvalidTupleLocation, "A list of values in parentheses is only allowed in a table constructor or before IN.")),
            BKind::TableCtor(rows) => {
                let width = rows.first().map(|r| r.len()).unwrap_or(0);
                let cols = (0..width)
                    .map(|i| TCol { name: if width == 1 { "Value".into() } else { format!("Value{}", i + 1) }, lineage: None, renamed: false })
                    .collect();
                let vals = rows.iter().map(|r| r.iter().map(|x| self.scalar(x, env)).collect::<VResult<Vec<_>>>()).collect::<VResult<Vec<_>>>()?;
                Val::T(TableVal::mat(cols, vals))
            }
            BKind::Let(vars, body) => {
                let mut env2 = env.clone();
                for (slot, x) in vars {
                    env2 = env2.bind_lazy(*slot, x);
                }
                self.eval(body, &env2)?
            }
            BKind::Sort(_) | BKind::Ident(_) | BKind::Missing => {
                return Err(EvalError::eval("This keyword can only be used as an argument of specific functions."))
            }
        })
    }

    fn var<'a>(&'a self, slot: usize, env: &Env<'a>) -> VResult<Val> {
        let mut cur = env.vars.clone();
        while let Some(f) = cur {
            if f.slot == slot {
                return f
                    .cell
                    .get_or_init(|| match (f.expr, &f.env) {
                        (Some(e), Some(captured)) => self.eval(e, captured),
                        _ => Err(EvalError::eval("variable has no value")),
                    })
                    .clone();
            }
            cur = f.parent.clone();
        }
        Err(EvalError::eval("The variable is not defined in this scope."))
    }

    /// Evaluates to a scalar; a one-column table with at most one row converts to its value.
    pub fn scalar<'a>(&'a self, e: &'a BExpr, env: &Env<'a>) -> VResult<Value> {
        match self.eval(e, env)? {
            Val::S(v) => Ok(v),
            Val::T(t) => self.table_to_scalar(&t),
        }
    }

    pub fn table_to_scalar(&self, t: &TableVal) -> VResult<Value> {
        if t.ncols(self.data) != 1 {
            return Err(EvalError::new(ErrorCode::InvalidValue, "The expression refers to multiple columns. Multiple columns cannot be converted to a scalar value."));
        }
        match t.nrows() {
            0 => Ok(Value::Blank),
            1 => Ok(t.value(self.data, 0, 0)),
            _ => Err(EvalError::new(ErrorCode::InvalidValue, "A table of multiple values was supplied where a single value was expected.")),
        }
    }

    pub fn table<'a>(&'a self, e: &'a BExpr, env: &Env<'a>) -> VResult<TableVal> {
        match self.eval(e, env)? {
            Val::T(t) => Ok(t),
            Val::S(_) => Err(EvalError::new(ErrorCode::InvalidParameter, "A table expression was expected, but the expression returns a single value.")),
        }
    }

    // ---- row context ----

    /// Value of a model column in the innermost row context that contains it.
    pub fn row_value(&self, c: ColId, env: &Env) -> VResult<Value> {
        self.row_value_nth(c, env, 0)?.ok_or_else(|| {
            EvalError::new(
                ErrorCode::InvalidValue,
                format!(
                    "A single value for column '{}' in table '{}' cannot be determined. This can happen when a measure formula refers to a column that contains many values without specifying an aggregation such as min, max, count, or sum to get a single result.",
                    self.data.model.column(c).name,
                    self.data.model.tables[c.table].name
                ),
            )
        })
    }

    /// The `skip`-th (0 = innermost) row context containing column `c`.
    pub fn row_value_nth(&self, c: ColId, env: &Env, skip: usize) -> VResult<Option<Value>> {
        let mut seen = 0;
        let mut cur = env.rows.clone();
        while let Some(f) = cur {
            let v = match &f.row {
                RowRef::Base { table, row } if *table == c.table => Some(self.data.value(c, *row).clone()),
                RowRef::Mat { t, row } => t.cols.iter().position(|tc| tc.lineage == Some(c)).map(|i| t.rows[*row][i].clone()),
                _ => None,
            };
            if let Some(v) = v {
                if seen == skip {
                    return Ok(Some(v));
                }
                seen += 1;
            }
            cur = f.parent.clone();
        }
        Ok(None)
    }

    /// Number of row contexts that contain column `c` (for EARLIEST).
    pub fn row_depth_of(&self, c: ColId, env: &Env) -> usize {
        env.row_frames()
            .iter()
            .filter(|r| match r {
                RowRef::Base { table, .. } => *table == c.table,
                RowRef::Mat { t, .. } => t.cols.iter().any(|tc| tc.lineage == Some(c)),
            })
            .count()
    }

    fn row_value_by_name(&self, name: &str, env: &Env) -> VResult<Value> {
        let mut cur = env.rows.clone();
        while let Some(f) = cur {
            match &f.row {
                RowRef::Base { table, row } => {
                    if let Some(c) = self.data.model.column_id(*table, name) {
                        return Ok(self.data.value(c, *row).clone());
                    }
                }
                RowRef::Mat { t, row } => {
                    if let Some(i) = t.cols.iter().position(|tc| tc.name.eq_ignore_ascii_case(name)) {
                        return Ok(t.rows[*row][i].clone());
                    }
                }
            }
            cur = f.parent.clone();
        }
        Err(EvalError::new(ErrorCode::UnrecognizedIdentifier, format!("Column '{name}' cannot be found or may not be used in this expression.")))
    }

    // ---- CALCULATE ----

    /// Turns every row context into filters (outermost first, so inner rows win on shared columns).
    pub fn context_transition(&self, env: &Env) -> VResult<FilterCtx> {
        let frames = env.row_frames();
        if frames.is_empty() {
            return Ok(env.filter.clone());
        }
        let mut ctx = env.filter.with_shadow();
        let g = self.graph(&ctx);
        for f in frames.iter().rev() {
            let (filters, cols): (Vec<Filter>, HashSet<ColId>) = match f {
                RowRef::Base { table, row } => {
                    let own: Vec<ColId> = self.data.model.columns_of(*table).collect();
                    let group = self.data.dup_group(*table, *row);
                    let rows = RowSet::from_rows(self.data.nrows(*table) + 1, group.iter().copied());
                    (vec![Filter::Rows { table: *table, rows: Rc::new(rows), cols: own.clone() }], own.into_iter().collect())
                }
                RowRef::Mat { t, row } => {
                    let mut fs = Vec::new();
                    let mut cs = HashSet::new();
                    for (i, c) in t.cols.iter().enumerate() {
                        if let Some(l) = c.lineage {
                            if cs.insert(l) {
                                fs.push(Filter::single(l, t.rows[*row][i].key()));
                            }
                        }
                    }
                    (fs, cs)
                }
            };
            ctx = ctx.remove_columns(self.data, &g, &cols);
            for f in filters {
                ctx = ctx.push(f);
            }
        }
        Ok(ctx)
    }

    /// Builds the filter context of CALCULATE / CALCULATETABLE from the filter arguments.
    pub fn calculate_ctx<'a>(&'a self, filters: &[&'a BExpr], env: &Env<'a>) -> VResult<FilterCtx> {
        enum Op {
            Remove(RemoveSpec),
            UseRel(usize),
            Cross(usize, String, bool),
            Apply(Filter, bool),
        }
        enum RemoveSpec {
            All,
            Cols(Vec<ColId>),
            Table(TableId),
            TableExcept(TableId, Vec<ColId>),
            SelectedAll,
            SelectedCols(Vec<ColId>),
            SelectedTable(TableId),
            CrossTable(TableId),
        }
        // 1. evaluate filter arguments in the original context
        let mut ops = Vec::new();
        for &f in filters {
            if f.is_missing() {
                continue;
            }
            let (inner, keep) = match &f.kind {
                BKind::Call { name, args } if name == "KEEPFILTERS" => (&args[0], true),
                // NONVISUAL(filter) is a value filter of SUMMARIZECOLUMNS; the visual totals it exists for
                // are not modelled, so it filters like its argument
                BKind::Call { name, args } if name == "NONVISUAL" => (&args[0], false),
                _ => (f, false),
            };
            match &inner.kind {
                BKind::Call { name, args } if !keep && matches!(name.as_str(), "ALL" | "REMOVEFILTERS") => {
                    if args.is_empty() {
                        ops.push(Op::Remove(RemoveSpec::All));
                    } else if let Some(t) = args[0].table() {
                        ops.push(Op::Remove(RemoveSpec::Table(t)));
                    } else {
                        let cols = args.iter().map(|a| a.col().ok_or_else(|| EvalError::new(ErrorCode::InvalidParameter, format!("{name} needs a table or column references.")))).collect::<VResult<Vec<_>>>()?;
                        ops.push(Op::Remove(RemoveSpec::Cols(cols)));
                    }
                }
                BKind::Call { name, args } if !keep && name == "ALLEXCEPT" => {
                    let t = args[0].table().ok_or_else(|| EvalError::new(ErrorCode::InvalidParameter, "The first argument of ALLEXCEPT must be a table."))?;
                    let cols = args[1..].iter().map(|a| a.col().ok_or_else(|| EvalError::new(ErrorCode::InvalidParameter, "ALLEXCEPT needs column references after the table."))).collect::<VResult<Vec<_>>>()?;
                    ops.push(Op::Remove(RemoveSpec::TableExcept(t, cols)));
                }
                BKind::Call { name, args } if !keep && name == "USERELATIONSHIP" => {
                    let (a, b) = (args[0].col(), args[1].col());
                    let r = self.find_relationship(a, b).ok_or_else(|| EvalError::new(ErrorCode::InvalidParameter, "USERELATIONSHIP needs two columns that are joined by a relationship."))?;
                    ops.push(Op::UseRel(r));
                }
                BKind::Call { name, args } if !keep && name == "CROSSFILTER" => {
                    let (a, b) = (args[0].col(), args[1].col());
                    let r = self.find_relationship(a, b).ok_or_else(|| EvalError::new(ErrorCode::InvalidParameter, "CROSSFILTER needs two columns that are joined by a relationship."))?;
                    let dir = args[2].ident().map(|s| s.to_string()).or_else(|| match &args[2].kind {
                        BKind::Const(Value::Int(1)) => Some("ONEWAY".into()),
                        BKind::Const(Value::Int(2)) => Some("BOTH".into()),
                        BKind::Const(Value::Int(0)) => Some("NONE".into()),
                        _ => None,
                    });
                    let dir = dir.ok_or_else(|| EvalError::new(ErrorCode::InvalidParameter, "CROSSFILTER direction must be NONE, ONEWAY, BOTH, ONEWAY_LEFTFILTERING or ONEWAY_RIGHTFILTERING."))?;
                    let left_is_from = a.map(|c| c.table) == Some(self.data.model.relationships[r].from.table);
                    ops.push(Op::Cross(r, dir, left_is_from));
                }
                BKind::Call { name, args } if !keep && name == "ALLSELECTED" => {
                    if args.is_empty() {
                        ops.push(Op::Remove(RemoveSpec::SelectedAll));
                    } else if let Some(t) = args[0].table() {
                        ops.push(Op::Remove(RemoveSpec::SelectedTable(t)));
                    } else {
                        let cols = args.iter().map(|a| a.col().ok_or_else(|| EvalError::new(ErrorCode::InvalidParameter, "ALLSELECTED needs a table or column references."))).collect::<VResult<Vec<_>>>()?;
                        ops.push(Op::Remove(RemoveSpec::SelectedCols(cols)));
                    }
                }
                BKind::Call { name, args } if !keep && name == "ALLCROSSFILTERED" => {
                    let t = args[0].table().ok_or_else(|| EvalError::new(ErrorCode::InvalidParameter, "ALLCROSSFILTERED needs a table reference."))?;
                    ops.push(Op::Remove(RemoveSpec::CrossTable(t)));
                }
                _ => {
                    let flt = if crate::functions::is_scalar_expr(inner) {
                        self.predicate_filter(inner, env)?
                    } else {
                        let t = self.table(inner, env)?;
                        self.table_filter(&t, &env.filter)?
                    };
                    if let Some(flt) = flt {
                        ops.push(Op::Apply(flt, keep));
                    }
                }
            }
        }
        // 2. context transition
        let mut ctx = self.context_transition(env)?;
        // 3. relationship modifiers
        for op in &ops {
            match op {
                Op::UseRel(r) => {
                    let rel = &self.data.model.relationships[*r];
                    let states = filter::rel_states(self.data, &ctx);
                    // deactivate other active relationships between the same two tables
                    for (i, o) in self.data.model.relationships.iter().enumerate() {
                        let same = (o.from.table == rel.from.table && o.to.table == rel.to.table) || (o.from.table == rel.to.table && o.to.table == rel.from.table);
                        if i != *r && same && states[i].active {
                            ctx = ctx.set_rel(i, RelState { active: false, ..states[i] });
                        }
                    }
                    ctx = ctx.set_rel(*r, RelState { active: true, ..states[*r] });
                }
                Op::Cross(r, dir, left_is_from) => {
                    let st = filter::rel_states(self.data, &ctx)[*r];
                    let new = match dir.as_str() {
                        "NONE" => RelState { active: false, ..st },
                        "ONEWAY" => RelState { to_filters_from: true, from_filters_to: false, ..st },
                        "BOTH" => RelState { to_filters_from: true, from_filters_to: true, ..st },
                        "ONEWAY_LEFTFILTERING" => RelState { to_filters_from: !*left_is_from, from_filters_to: *left_is_from, ..st },
                        "ONEWAY_RIGHTFILTERING" => RelState { to_filters_from: *left_is_from, from_filters_to: !*left_is_from, ..st },
                        other => return Err(EvalError::new(ErrorCode::InvalidParameter, format!("'{other}' is not a valid CROSSFILTER direction."))),
                    };
                    ctx = ctx.set_rel(*r, new);
                }
                _ => {}
            }
        }
        // 4. removals (ALL, REMOVEFILTERS, ALLEXCEPT)
        let g = self.graph(&ctx);
        for op in &ops {
            if let Op::Remove(spec) = op {
                ctx = match spec {
                    RemoveSpec::All => ctx.clear(),
                    RemoveSpec::Cols(cols) => ctx.remove_columns(self.data, &g, &cols.iter().copied().collect()),
                    RemoveSpec::Table(t) => ctx.remove_columns(self.data, &g, &g.expanded_columns(self.data, *t).into_iter().collect()),
                    RemoveSpec::SelectedAll => ctx.restore_selected(self.data, &g, None),
                    RemoveSpec::SelectedCols(cols) => ctx.restore_selected(self.data, &g, Some(&cols.iter().copied().collect())),
                    RemoveSpec::SelectedTable(t) => ctx.restore_selected(self.data, &g, Some(&g.expanded_columns(self.data, *t).into_iter().collect())),
                    RemoveSpec::CrossTable(t) => {
                        // the table and every table that filters it: through one-to-many relationships downwards and
                        // through bidirectional ones upwards (recorded from Power BI: a filter on a table that only
                        // reaches the same fact table, like Customer for Product, stays)
                        let mut seen = HashSet::from([*t]);
                        let mut grew = true;
                        while grew {
                            grew = false;
                            for (i, r) in self.data.model.relationships.iter().enumerate() {
                                let st = g.states[i];
                                if !st.active {
                                    continue;
                                }
                                let (many, one) = (r.from.table, r.to.table);
                                if seen.contains(&many) && st.to_filters_from && !seen.contains(&one) {
                                    seen.insert(one);
                                    grew = true;
                                }
                                if seen.contains(&one) && st.from_filters_to && !seen.contains(&many) {
                                    seen.insert(many);
                                    grew = true;
                                }
                            }
                        }
                        let cols: HashSet<ColId> = seen.iter().flat_map(|t| self.data.model.columns_of(*t).collect::<Vec<_>>()).collect();
                        ctx.remove_columns(self.data, &g, &cols)
                    }
                    RemoveSpec::TableExcept(t, keep) => {
                        let cols: HashSet<ColId> = g.expanded_columns(self.data, *t).into_iter().filter(|c| !keep.contains(c)).collect();
                        ctx.remove_columns(self.data, &g, &cols)
                    }
                };
            }
        }
        // 5. filter arguments: each overrides the existing filters on its columns; together they intersect
        let filters: Vec<(Filter, bool)> = ops.into_iter().filter_map(|op| if let Op::Apply(f, keep) = op { Some((f, keep)) } else { None }).collect();
        Ok(self.apply_filters(ctx, &g, filters))
    }

    /// Applies filter arguments to a context: every filter replaces the existing filters on its columns (unless it
    /// is a KEEPFILTERS one); a filter on the key column of a marked date table replaces all filters on that table.
    pub fn apply_filters(&self, mut ctx: FilterCtx, g: &Graph, filters: Vec<(Filter, bool)>) -> FilterCtx {
        let mut remove = HashSet::new();
        for (f, keep) in &filters {
            if *keep {
                continue;
            }
            remove.extend(f.cols().iter().copied());
            for dc in &self.data.model.date_tables {
                if f.cols().contains(dc) {
                    remove.extend(self.data.model.columns_of(dc.table));
                }
            }
        }
        ctx = ctx.remove_columns(self.data, g, &remove);
        for (f, _) in filters {
            ctx = ctx.push(f);
        }
        ctx
    }

    fn find_relationship(&self, a: Option<ColId>, b: Option<ColId>) -> Option<usize> {
        let (a, b) = (a?, b?);
        self.data.model.relationships.iter().position(|r| (r.from == a && r.to == b) || (r.from == b && r.to == a))
    }

    /// A table used as a filter: rows of a model table filter its expanded table; other tables filter the
    /// columns that have lineage.
    pub fn table_filter(&self, t: &TableVal, ctx: &FilterCtx) -> VResult<Option<Filter>> {
        Ok(match t {
            TableVal::Base { table, rows } => {
                let g = self.graph(ctx);
                Some(Filter::Rows {
                    table: *table,
                    rows: Rc::new(RowSet::from_rows(self.data.nrows(*table) + 1, rows.iter().copied())),
                    cols: g.expanded_columns(self.data, *table),
                })
            }
            TableVal::Mat(m) => {
                let idx: Vec<(usize, ColId)> = m.cols.iter().enumerate().filter_map(|(i, c)| c.lineage.map(|l| (i, l))).collect();
                if idx.is_empty() {
                    return Ok(None);
                }
                let mut cols = Vec::new();
                let mut pos = Vec::new();
                for (i, l) in idx {
                    if !cols.contains(&l) {
                        cols.push(l);
                        pos.push(i);
                    }
                }
                let set: HashSet<Vec<Key>> = m.rows.iter().map(|r| pos.iter().map(|&i| r[i].key()).collect()).collect();
                Some(Filter::Values { cols, set: Rc::new(set) })
            }
        })
    }

    /// `Table[Col] = x` style filter: FILTER(ALL(columns used), predicate), evaluated in the outer context.
    fn predicate_filter<'a>(&'a self, pred: &'a BExpr, env: &Env<'a>) -> VResult<Option<Filter>> {
        let cols = crate::functions::row_level_columns(pred);
        if cols.is_empty() {
            return Err(EvalError::new(ErrorCode::InvalidParameter, "The True/False expression does not specify a column. Each True/False expression used as a table filter expression must refer to exactly one column."));
        }
        let t = cols[0].table;
        if cols.iter().any(|c| c.table != t) {
            return Err(EvalError::new(ErrorCode::InvalidParameter, "The expression contains columns from multiple tables, but only columns from a single table can be used in a True/False expression that is used as a table filter expression."));
        }
        let all = self.distinct_combos(&cols, &self.all_rows(t, true));
        let mat = Rc::new(MatTable { cols: cols.iter().map(|&c| TCol { name: self.data.model.column(c).name.clone(), lineage: Some(c), renamed: false }).collect(), rows: all });
        let mut set = HashSet::new();
        for r in 0..mat.rows.len() {
            let e2 = env.push_row(RowRef::Mat { t: mat.clone(), row: r });
            if self.scalar(pred, &e2)?.to_bool()? {
                set.insert(mat.rows[r].iter().map(|v| v.key()).collect::<Vec<_>>());
            }
        }
        Ok(Some(Filter::Values { cols, set: Rc::new(set) }))
    }

    /// All rows of a table, with the blank row when it exists and `with_blank`.
    pub fn all_rows(&self, t: TableId, with_blank: bool) -> Vec<u32> {
        let n = self.data.nrows(t) as u32;
        let mut v: Vec<u32> = (0..n).collect();
        if with_blank && self.data.has_blank_row(t) {
            v.push(n);
        }
        v
    }

    /// Distinct value combinations of columns (all from one table) over the given rows, in first-seen order.
    pub fn distinct_combos(&self, cols: &[ColId], rows: &[u32]) -> Vec<Vec<Value>> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for &r in rows {
            let vals: Vec<Value> = cols.iter().map(|&c| self.data.value(c, r).clone()).collect();
            if seen.insert(vals.iter().map(|v| v.key()).collect::<Vec<_>>()) {
                out.push(vals);
            }
        }
        out
    }
}

pub fn binary(op: BinOp, a: &Value, b: &Value) -> VResult<Value> {
    use std::cmp::Ordering::*;
    Ok(match op {
        BinOp::Add => value::add(a, b)?,
        BinOp::Sub => value::sub(a, b)?,
        BinOp::Mul => value::mul(a, b)?,
        BinOp::Div => value::div(a, b)?,
        BinOp::Pow => value::pow(a, b)?,
        BinOp::Concat => value::concat(a, b),
        BinOp::And => value::and(a, b)?,
        BinOp::Or => value::or(a, b)?,
        BinOp::StrictEq => Value::Bool(value::strict_eq(a, b)?),
        BinOp::Eq => Value::Bool(value::compare(a, b)? == Equal),
        BinOp::Ne => Value::Bool(value::compare(a, b)? != Equal),
        BinOp::Lt => Value::Bool(value::compare(a, b)? == Less),
        BinOp::Le => Value::Bool(value::compare(a, b)? != Greater),
        BinOp::Gt => Value::Bool(value::compare(a, b)? == Greater),
        BinOp::Ge => Value::Bool(value::compare(a, b)? != Less),
    })
}

/// A loaded model with calculated columns computed, ready to evaluate expressions and queries.
pub struct Engine {
    pub data: ModelData,
    /// Calculated columns that failed (their values are BLANK): (table, column, message).
    pub column_errors: Vec<(String, String, String)>,
}

impl Engine {
    pub fn new(model: Model, source: &dyn DataSource) -> Result<Engine, String> {
        let data = ModelData::load(model, source)?;
        let mut eng = Engine { data, column_errors: vec![] };
        eng.process_calculated_columns();
        Ok(eng)
    }

    /// Like [`Engine::new`], but the stored columns are read the first time a query uses them (see
    /// [`ModelData::load_lazy`]); `source` must stay usable for as long as the engine lives.
    pub fn new_lazy(model: Model, source: std::sync::Arc<dyn DataSource + Send + Sync>) -> Result<Engine, String> {
        let data = ModelData::load_lazy(model, source)?;
        let mut eng = Engine { data, column_errors: vec![] };
        eng.process_calculated_columns();
        Ok(eng)
    }

    /// Like [`Engine::new`], with the identity USERNAME() and USERPRINCIPALNAME() return (set before the
    /// calculated columns are computed, so they can use it).
    pub fn new_as(model: Model, source: &dyn DataSource, identity: &str) -> Result<Engine, String> {
        let mut data = ModelData::load(model, source)?;
        data.identity = identity.to_string();
        let mut eng = Engine { data, column_errors: vec![] };
        eng.process_calculated_columns();
        Ok(eng)
    }

    /// The values of the calculated columns of a table: (name, values) in column order.
    pub fn calculated_columns(&self, table: &str) -> Vec<(String, Vec<Value>)> {
        let Some(t) = self.data.model.table_id(table) else { return vec![] };
        self.data
            .model
            .columns_of(t)
            .filter(|c| self.data.model.column(*c).expression.is_some())
            .map(|c| (self.data.model.column(c).name.clone(), self.data.column_values(c).as_ref().clone()))
            .collect()
    }

    /// Computes calculated columns in dependency order. A column that fails is left BLANK and reported.
    fn process_calculated_columns(&mut self) {
        let calcs: Vec<ColId> = (0..self.data.model.tables.len())
            .flat_map(|t| self.data.model.columns_of(t).collect::<Vec<_>>())
            .filter(|c| self.data.model.column(*c).expression.is_some())
            .collect();
        if calcs.is_empty() {
            return;
        }
        let mut bound: HashMap<ColId, Result<BExpr, EvalError>> = HashMap::new();
        for &c in &calcs {
            let src = self.data.model.column(c).expression.clone().unwrap();
            let scope = QueryScope::default();
            let r = crate::parser::parse_expression(&src).map_err(EvalError::from).and_then(|e| Binder::new(&self.data.model, &scope, 0).bind(&e).map_err(EvalError::from));
            bound.insert(c, r);
        }
        let mut remaining = calcs.clone();
        let order = loop {
            match crate::deps::calc_column_order(&self.data.model, &remaining, &bound) {
                Ok(o) => break o,
                Err((cycle, msg)) => {
                    for c in &cycle {
                        self.column_errors.push((self.data.model.tables[c.table].name.clone(), self.data.model.column(*c).name.clone(), msg.clone()));
                    }
                    remaining.retain(|c| !cycle.contains(c));
                }
            }
        };
        for c in order {
            let expr = match bound.get(&c).unwrap() {
                Ok(e) => e.clone(),
                Err(e) => {
                    self.column_errors.push((self.data.model.tables[c.table].name.clone(), self.data.model.column(c).name.clone(), e.message.clone()));
                    continue;
                }
            };
            let n = self.data.nrows(c.table);
            let result: VResult<Vec<Value>> = {
                let ev = Evaluator::new(&self.data);
                (0..n as u32)
                    .map(|r| {
                        let env = Env::empty().push_row(RowRef::Base { table: c.table, row: r });
                        ev.scalar(&expr, &env)
                    })
                    .collect()
            };
            match result {
                Ok(vals) => self.data.set_column(c, vals),
                Err(e) => self.column_errors.push((self.data.model.tables[c.table].name.clone(), self.data.model.column(c).name.clone(), e.message)),
            }
        }
    }

    pub fn evaluator(&self) -> Evaluator<'_> {
        Evaluator::new(&self.data)
    }

    /// Evaluates a scalar DAX expression in an empty filter context (no row context).
    pub fn eval_scalar(&self, src: &str) -> VResult<Value> {
        let e = crate::parser::parse_expression(src)?;
        let scope = QueryScope::default();
        let b = Binder::new(&self.data.model, &scope, 0).bind(&e)?;
        let ev = self.evaluator();
        ev.scalar(&b, &Env::empty())
    }

    /// Like `eval_scalar`, optionally letting aggregations run as SQL; also returns how many did.
    pub fn eval_scalar_with(&self, src: &str, sql: Option<&dyn SqlExecutor>) -> VResult<(Value, usize)> {
        let e = crate::parser::parse_expression(src)?;
        let scope = QueryScope::default();
        let b = Binder::new(&self.data.model, &scope, 0).bind(&e)?;
        let mut ev = self.evaluator();
        if let Some(s) = sql {
            ev = ev.with_sql(s);
        }
        let v = ev.scalar(&b, &Env::empty())?;
        Ok((v, ev.sql_hits.get()))
    }

    /// Evaluates a measure of the model in an empty filter context.
    pub fn eval_measure(&self, name: &str) -> VResult<Value> {
        let m = self.data.model.measure(name).ok_or_else(|| EvalError::new(ErrorCode::UnrecognizedIdentifier, format!("Measure '{name}' does not exist.")))?;
        let ev = self.evaluator();
        ev.eval_measure(MeasureRef::Model(m), &Env::empty())
    }
}
