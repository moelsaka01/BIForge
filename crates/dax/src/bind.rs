//! Resolves a parsed expression against the model: columns, measures, tables, variables and function
//! names. Unqualified `[Name]` that is not a measure is resolved at run time against the row contexts
//! (it may be a column added by ADDCOLUMNS / SELECTCOLUMNS).

use crate::ast::{BinOp, Expr, ExprKind, UnOp};
use crate::catalog::Catalog;
use crate::diag::{Diagnostic, ErrorCode, Span};
use crate::model::{ColId, Model, TableId};
use crate::value::{parse_datetime_literal, Value};
use std::collections::HashMap;

/// Reference to a measure: one of the model's, or one defined in a query (`DEFINE MEASURE`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MeasureRef {
    Model(usize),
    Query(usize),
}

#[derive(Debug, Clone)]
pub struct BExpr {
    pub kind: BKind,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub enum BKind {
    Const(Value),
    Col(ColId),
    /// `[Name]` (or `Table[Name]` for a query table) looked up in the row contexts by name.
    RowCol(String),
    Measure(MeasureRef),
    Var(usize),
    Table(TableId),
    /// A query-defined table (`DEFINE TABLE`), by index.
    QueryTable(usize),
    Call { name: String, args: Vec<BExpr> },
    Unary(UnOp, Box<BExpr>),
    Binary(BinOp, Box<BExpr>, Box<BExpr>),
    In(Box<BExpr>, Box<BExpr>),
    Tuple(Vec<BExpr>),
    TableCtor(Vec<Vec<BExpr>>),
    Let(Vec<(usize, BExpr)>, Box<BExpr>),
    Sort(bool),
    Missing,
    /// Keyword-like argument such as DAY, MONTH, BOTH, NONE, SKIP, DENSE, INTEGER.
    Ident(String),
}

/// Bare names accepted as keyword arguments.
const ENUM_WORDS: &[&str] = &[
    "DAY", "WEEK", "MONTH", "QUARTER", "YEAR", "HOUR", "MINUTE", "SECOND", "BOTH", "NONE", "ONEWAY", "ONEWAY_LEFTFILTERING", "ONEWAY_RIGHTFILTERING", "SKIP", "DENSE",
    "INTEGER", "DOUBLE", "STRING", "BOOLEAN", "CURRENCY", "DATETIME", "REL", "ABS", "FIRST", "LAST", "KEEP", "PARTITIONS", "LOW", "HIGH", "DEFAULT",
];

/// A function defined in a query (`DEFINE FUNCTION`): calls are bound by putting the body in place with the arguments bound to its parameters.
#[derive(Clone)]
pub struct FuncDef {
    pub params: Vec<String>,
    /// Parameters declared `EXPR`: the argument is evaluated wherever the body uses the parameter.
    pub lazy: Vec<bool>,
    pub body: Expr,
}

/// Names a query adds on top of the model.
#[derive(Default, Clone)]
pub struct QueryScope {
    /// DEFINE FUNCTION names (lower case).
    pub functions: HashMap<String, FuncDef>,
    /// DEFINE MEASURE names (lower case) -> index.
    pub measures: HashMap<String, usize>,
    /// DEFINE TABLE names (lower case) -> index.
    pub tables: HashMap<String, usize>,
    /// DEFINE VAR names visible to every EVALUATE (lower case) -> slot.
    pub vars: Vec<(String, usize)>,
}

pub struct Binder<'a> {
    pub model: &'a Model,
    pub catalog: &'a Catalog,
    pub query: &'a QueryScope,
    scopes: Vec<(String, usize)>,
    /// Parameters of the function being bound that are evaluated where they are used (lower case name, bound argument).
    lazy_params: Vec<(String, BExpr)>,
    /// The query functions being bound (a function cannot call itself).
    fn_stack: Vec<String>,
    next_slot: usize,
}

pub type BResult<T> = Result<T, Diagnostic>;

impl<'a> Binder<'a> {
    pub fn new(model: &'a Model, query: &'a QueryScope, first_slot: usize) -> Binder<'a> {
        Binder { model, catalog: Catalog::builtin(), query, scopes: query.vars.clone(), lazy_params: Vec::new(), fn_stack: Vec::new(), next_slot: first_slot }
    }

    pub fn next_slot(&self) -> usize {
        self.next_slot
    }

    pub fn alloc_slot(&mut self) -> usize {
        self.next_slot += 1;
        self.next_slot - 1
    }

    fn lookup_var(&self, name: &str) -> Option<usize> {
        let n = name.to_lowercase();
        self.scopes.iter().rev().find(|(v, _)| *v == n).map(|(_, s)| *s)
    }

    pub fn bind(&mut self, e: &Expr) -> BResult<BExpr> {
        let span = e.span;
        let b = |kind| Ok(BExpr { kind, span });
        match &e.kind {
            ExprKind::Int(i) => b(BKind::Const(Value::Int(*i))),
            ExprKind::Number(f) => b(BKind::Const(Value::Double(*f))),
            ExprKind::Str(s) => b(BKind::Const(Value::str(s))),
            ExprKind::Bool(v) => b(BKind::Const(Value::Bool(*v))),
            ExprKind::DateTime(s) => match parse_datetime_literal(s) {
                Some(d) => b(BKind::Const(Value::DateTime(d))),
                None => Err(Diagnostic::new(ErrorCode::GrammaticalError, format!("'{s}' is not a valid date-time literal (use YYYY-MM-DD or YYYY-MM-DDThh:mm:ss)."), span)),
            },
            ExprKind::ColumnRef { table, column } => {
                if let Some(t) = self.model.table_id(table) {
                    if let Some(c) = self.model.column_id(t, column) {
                        return b(BKind::Col(c));
                    }
                    if let Some(m) = self.measure(column) {
                        return b(BKind::Measure(m));
                    }
                    return Err(Diagnostic::new(
                        ErrorCode::UnrecognizedIdentifier,
                        format!("Column '{column}' in table '{}' cannot be found or may not be used in this expression.", self.model.tables[t].name),
                        span,
                    ));
                }
                if self.query.tables.contains_key(&table.to_lowercase()) || self.lookup_var(table).is_some() {
                    return b(BKind::RowCol(column.clone()));
                }
                Err(Diagnostic::new(ErrorCode::UnrecognizedIdentifier, format!("Cannot find table '{table}'."), span))
            }
            ExprKind::BracketRef(name) => match self.measure(name) {
                Some(m) => b(BKind::Measure(m)),
                None => b(BKind::RowCol(name.clone())),
            },
            ExprKind::Name(name) => {
                if let Some((_, x)) = self.lazy_params.iter().rev().find(|(n, _)| *n == name.to_lowercase()) {
                    return Ok(x.clone());
                }
                if let Some(s) = self.lookup_var(name) {
                    return b(BKind::Var(s));
                }
                if let Some(&qt) = self.query.tables.get(&name.to_lowercase()) {
                    return b(BKind::QueryTable(qt));
                }
                if let Some(t) = self.model.table_id(name) {
                    return b(BKind::Table(t));
                }
                if ENUM_WORDS.iter().any(|w| w.eq_ignore_ascii_case(name)) {
                    return b(BKind::Ident(name.to_ascii_uppercase()));
                }
                Err(Diagnostic::new(ErrorCode::UnrecognizedIdentifier, format!("Failed to resolve name '{name}'. It is not a valid table, variable, or function name."), span))
            }
            ExprKind::TableRef(name) => {
                if let Some(&qt) = self.query.tables.get(&name.to_lowercase()) {
                    return b(BKind::QueryTable(qt));
                }
                match self.model.table_id(name) {
                    Some(t) => b(BKind::Table(t)),
                    None => Err(Diagnostic::new(ErrorCode::UnrecognizedIdentifier, format!("Cannot find table '{name}'."), span)),
                }
            }
            ExprKind::Call { name, name_span, args } if self.query.functions.contains_key(&name.to_lowercase()) => {
                let key = name.to_lowercase();
                let f = self.query.functions[&key].clone();
                if self.fn_stack.contains(&key) {
                    return Err(Diagnostic::new(ErrorCode::InvalidParameter, format!("The function '{name}' calls itself; a recursive function is not supported."), *name_span));
                }
                if args.len() < f.params.len() {
                    return Err(Diagnostic::new(ErrorCode::MissingParameters, format!("Too few arguments were passed to the {name} function. It takes {} argument(s).", f.params.len()), span));
                }
                if args.len() > f.params.len() {
                    return Err(Diagnostic::new(ErrorCode::TooManyParameters, format!("Too many arguments were passed to the {name} function. It takes {} argument(s).", f.params.len()), span));
                }
                // the arguments are bound where the call is; the body sees its parameters and the query's variables, not the caller's
                let bound = args.iter().map(|a| self.bind(a)).collect::<BResult<Vec<_>>>()?;
                let saved_scopes = std::mem::replace(&mut self.scopes, self.query.vars.clone());
                let saved_lazy = std::mem::take(&mut self.lazy_params);
                self.fn_stack.push(key);
                let mut lets = Vec::new();
                for ((p, lazy), arg) in f.params.iter().zip(&f.lazy).zip(bound) {
                    if *lazy {
                        self.lazy_params.push((p.to_lowercase(), arg));
                    } else {
                        let slot = self.alloc_slot();
                        self.scopes.push((p.to_lowercase(), slot));
                        lets.push((slot, arg));
                    }
                }
                let body = self.bind(&f.body);
                self.fn_stack.pop();
                self.scopes = saved_scopes;
                self.lazy_params = saved_lazy;
                b(BKind::Let(lets, Box::new(body?)))
            }
            ExprKind::Call { name, name_span, args } => {
                let up = name.to_ascii_uppercase();
                let Some(info) = self.catalog.get(&up) else {
                    return Err(Diagnostic::new(ErrorCode::UnrecognizedIdentifier, format!("Failed to resolve name '{name}'. It is not a valid table, variable, or function name."), *name_span));
                };
                if args.len() < info.min_args {
                    return Err(Diagnostic::new(ErrorCode::MissingParameters, format!("Too few arguments were passed to the {up} function. The minimum argument count for the function is {}.", info.min_args), span));
                }
                if info.max_args.is_some_and(|m| args.len() > m) {
                    return Err(Diagnostic::new(ErrorCode::TooManyParameters, format!("Too many arguments were passed to the {up} function. The maximum argument count for the function is {}.", info.max_args.unwrap()), span));
                }
                if !crate::functions::is_implemented(&up) {
                    return Err(Diagnostic::new(ErrorCode::NotImplemented, format!("The function {up} is not implemented in BIForge yet."), *name_span));
                }
                let args = args.iter().map(|a| self.bind(a)).collect::<BResult<Vec<_>>>()?;
                crate::functions::check_args(&up, &args, span)?;
                b(BKind::Call { name: up, args })
            }
            ExprKind::Missing => b(BKind::Missing),
            ExprKind::Unary { op, expr } => {
                let x = self.bind(expr)?;
                b(BKind::Unary(*op, Box::new(x)))
            }
            ExprKind::Binary { op, left, right } => {
                let l = self.bind(left)?;
                let r = self.bind(right)?;
                b(BKind::Binary(*op, Box::new(l), Box::new(r)))
            }
            ExprKind::In { left, right } => {
                let l = self.bind(left)?;
                let r = self.bind(right)?;
                b(BKind::In(Box::new(l), Box::new(r)))
            }
            ExprKind::Tuple(items) => {
                let items = items.iter().map(|a| self.bind(a)).collect::<BResult<Vec<_>>>()?;
                b(BKind::Tuple(items))
            }
            ExprKind::TableConstructor(rows) => {
                let rows = rows.iter().map(|r| r.iter().map(|a| self.bind(a)).collect::<BResult<Vec<_>>>()).collect::<BResult<Vec<_>>>()?;
                b(BKind::TableCtor(rows))
            }
            ExprKind::VarBlock { vars, body } => {
                let depth = self.scopes.len();
                let mut out = Vec::new();
                for v in vars {
                    let x = self.bind(&v.expr)?;
                    let slot = self.alloc_slot();
                    self.scopes.push((v.name.to_lowercase(), slot));
                    out.push((slot, x));
                }
                let body = self.bind(body);
                self.scopes.truncate(depth);
                b(BKind::Let(out, Box::new(body?)))
            }
            ExprKind::SortOrder(d) => b(BKind::Sort(*d)),
        }
    }

    fn measure(&self, name: &str) -> Option<MeasureRef> {
        if let Some(&q) = self.query.measures.get(&name.to_lowercase()) {
            return Some(MeasureRef::Query(q));
        }
        self.model.measure(name).map(MeasureRef::Model)
    }

    /// Pushes a query-level variable (DEFINE VAR) for later expressions.
    pub fn push_var(&mut self, name: &str, slot: usize) {
        self.scopes.push((name.to_lowercase(), slot));
    }
}

impl BExpr {
    pub fn col(&self) -> Option<ColId> {
        match self.kind {
            BKind::Col(c) => Some(c),
            _ => None,
        }
    }
    pub fn table(&self) -> Option<TableId> {
        match self.kind {
            BKind::Table(t) => Some(t),
            _ => None,
        }
    }
    pub fn is_missing(&self) -> bool {
        matches!(self.kind, BKind::Missing)
    }
    pub fn ident(&self) -> Option<&str> {
        match &self.kind {
            BKind::Ident(s) => Some(s),
            _ => None,
        }
    }
    pub fn call_name(&self) -> Option<&str> {
        match &self.kind {
            BKind::Call { name, .. } => Some(name),
            _ => None,
        }
    }

    /// Visits sub-expressions.
    pub fn walk<'s>(&'s self, f: &mut dyn FnMut(&'s BExpr)) {
        f(self);
        match &self.kind {
            BKind::Call { args, .. } | BKind::Tuple(args) => args.iter().for_each(|a| a.walk(f)),
            BKind::Unary(_, x) => x.walk(f),
            BKind::Binary(_, l, r) | BKind::In(l, r) => {
                l.walk(f);
                r.walk(f);
            }
            BKind::TableCtor(rows) => rows.iter().flatten().for_each(|a| a.walk(f)),
            BKind::Let(vars, body) => {
                vars.iter().for_each(|(_, v)| v.walk(f));
                body.walk(f);
            }
            _ => {}
        }
    }
}
