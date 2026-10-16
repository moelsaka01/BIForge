//! Values of the evaluator. Scalars computed from table columns are *symbolic*: they carry the SQL that computes them.
use crate::ast::{Expr, Param, TypeExpr};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Debug, Clone, PartialEq)]
pub struct MError {
    /// Power Query style reason ("Expression.Error", "DataSource.Error") or "NotSupported" for BIForge limits.
    pub reason: String,
    pub message: String,
}

impl MError {
    pub fn expr(m: impl Into<String>) -> MError {
        MError { reason: "Expression.Error".into(), message: m.into() }
    }
    pub fn source(m: impl Into<String>) -> MError {
        MError { reason: "DataSource.Error".into(), message: m.into() }
    }
    pub fn unsupported(m: impl Into<String>) -> MError {
        MError { reason: "NotSupported".into(), message: m.into() }
    }
}

impl std::fmt::Display for MError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.reason, self.message)
    }
}

pub type MResult<T> = Result<T, MError>;

pub fn qi(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
pub fn ql(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub const ORD: &str = "__ord";
/// Type tag of a column that holds a not yet expanded nested table.
pub const NESTED_TY: &str = "NESTED";

#[derive(Debug, Clone, PartialEq)]
pub struct Col {
    pub name: String,
    /// DuckDB type name.
    pub ty: String,
}

#[derive(Clone)]
pub struct Nested {
    pub name: String,
    pub right: Rel,
    pub left_keys: Vec<String>,
    pub right_keys: Vec<String>,
    pub kind: i32,
}

/// A table: a chain of CTEs ending at `name`, every CTE carrying the hidden ordering column `__ord`.
#[derive(Clone)]
pub struct Rel {
    pub ctes: Rc<Vec<(String, String)>>,
    pub name: String,
    /// Visible columns (without `__ord`; a pending nested-join column has `ty == NESTED_TY`).
    pub cols: Vec<Col>,
    pub nested: Vec<Nested>,
}

impl Rel {
    pub fn plain_cols(&self) -> impl Iterator<Item = &Col> {
        self.cols.iter().filter(|c| c.ty != NESTED_TY)
    }
    pub fn col_names(&self) -> Vec<String> {
        self.cols.iter().map(|c| c.name.clone()).collect()
    }
    pub fn col(&self, name: &str) -> Option<&Col> {
        self.cols.iter().find(|c| c.name == name)
    }
    pub fn prefix(&self) -> String {
        if self.ctes.is_empty() {
            return String::new();
        }
        let parts: Vec<String> = self.ctes.iter().map(|(n, s)| format!("{} AS ({})", qi(n), s)).collect();
        format!("WITH {} ", parts.join(", "))
    }
    /// Complete statement for the table's rows in order.
    pub fn to_sql(&self, limit: Option<usize>) -> String {
        let cols: Vec<String> = self.plain_cols().map(|c| qi(&c.name)).collect();
        let list = if cols.is_empty() { "1 AS \"__none\"".to_string() } else { cols.join(", ") };
        let lim = limit.map(|n| format!(" LIMIT {n}")).unwrap_or_default();
        format!("{}SELECT {} FROM {} ORDER BY {}{}", self.prefix(), list, qi(&self.name), qi(ORD), lim)
    }
    /// Statement that returns nothing but the schema (visible columns and the ordering column).
    pub fn describe_sql(prefix_ctes: &[(String, String)], name: &str) -> String {
        let parts: Vec<String> = prefix_ctes.iter().map(|(n, s)| format!("{} AS ({})", qi(n), s)).collect();
        format!("WITH {} SELECT * FROM {} LIMIT 0", parts.join(", "), qi(name))
    }
}

#[derive(Clone)]
pub struct RowCtx {
    pub cols: Vec<String>,
    /// true inside a Table.Group aggregate: `[c]` is a column *list*.
    pub group: bool,
}

pub struct Closure {
    pub params: Vec<Param>,
    pub body: Rc<Expr>,
    pub scope: Rc<Scope>,
}

#[derive(Clone)]
pub enum BinSrc {
    File(String),
}

#[derive(Clone)]
pub enum NavSrc {
    Excel { path: String, header: bool },
}

#[derive(Clone)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Text(String),
    List(Vec<Value>),
    Record(Vec<(String, Value)>),
    Table(Rel),
    Func(Rc<Closure>),
    /// A library function by name (`Text.Upper`).
    Builtin(String),
    /// A library function applied to some arguments but not called (`Splitter.SplitTextByDelimiter(",")`).
    Native(String, Vec<Value>),
    Type(TypeExpr),
    /// A scalar computed in SQL.
    Sql(String),
    /// A column seen as a list inside a group aggregate.
    ColList { sql: String, distinct: bool },
    Row(Rc<RowCtx>),
    Binary(BinSrc),
    Nav(Rc<NavSrc>),
    /// `Json.Document(File.Contents(path))`
    Json(String),
}

impl Value {
    pub fn is_symbolic(&self) -> bool {
        matches!(self, Value::Sql(_) | Value::ColList { .. } | Value::Row(_))
    }
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "logical",
            Value::Num(_) => "number",
            Value::Text(_) => "text",
            Value::List(_) => "list",
            Value::Record(_) => "record",
            Value::Table(_) => "table",
            Value::Func(_) | Value::Builtin(_) | Value::Native(..) => "function",
            Value::Type(_) => "type",
            Value::Sql(_) => "an expression over table columns",
            Value::ColList { .. } => "a column list",
            Value::Row(_) => "a table row",
            Value::Binary(_) => "binary",
            Value::Nav(_) => "table",
            Value::Json(_) => "a JSON document",
        }
    }
}

#[derive(Clone)]
pub enum Slot {
    Done(Value),
    Lazy(Rc<Expr>),
    LazyText(Rc<String>),
    Busy,
    Failed(MError),
}

pub struct Scope {
    pub vars: RefCell<HashMap<String, Slot>>,
    pub parent: Option<Rc<Scope>>,
}

impl Scope {
    pub fn new(parent: Option<Rc<Scope>>) -> Rc<Scope> {
        Rc::new(Scope { vars: RefCell::new(HashMap::new()), parent })
    }
    pub fn set(&self, name: &str, v: Value) {
        self.vars.borrow_mut().insert(name.to_string(), Slot::Done(v));
    }
}

pub fn fmt_num(x: f64) -> String {
    if x.is_nan() {
        "CAST('NaN' AS DOUBLE)".into()
    } else if x.is_infinite() {
        if x > 0.0 { "CAST('Infinity' AS DOUBLE)".into() } else { "CAST('-Infinity' AS DOUBLE)".into() }
    } else if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        format!("CAST({} AS DOUBLE)", x)
    }
}
