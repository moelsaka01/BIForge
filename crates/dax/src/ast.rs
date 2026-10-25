//! Syntax tree produced by the parser. Names are unresolved here; `bind` resolves them against a model.

use crate::diag::Span;

#[derive(Debug, Clone, PartialEq)]
pub struct Expr {
    pub kind: ExprKind,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp {
    Neg,
    Plus,
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
    Concat,
    Eq,
    StrictEq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

impl BinOp {
    pub fn symbol(self) -> &'static str {
        match self {
            BinOp::Add => "+",
            BinOp::Sub => "-",
            BinOp::Mul => "*",
            BinOp::Div => "/",
            BinOp::Pow => "^",
            BinOp::Concat => "&",
            BinOp::Eq => "=",
            BinOp::StrictEq => "==",
            BinOp::Ne => "<>",
            BinOp::Lt => "<",
            BinOp::Le => "<=",
            BinOp::Gt => ">",
            BinOp::Ge => ">=",
            BinOp::And => "&&",
            BinOp::Or => "||",
        }
    }
    pub fn is_comparison(self) -> bool {
        matches!(self, BinOp::Eq | BinOp::StrictEq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExprKind {
    /// Integer literal (no decimal point or exponent).
    Int(i64),
    Number(f64),
    Str(String),
    Bool(bool),
    /// `dt"..."` literal, text as written.
    DateTime(String),
    /// `Table[Name]` or `'Table'[Name]`: a column, or a measure written with its table.
    ColumnRef { table: String, column: String },
    /// `[Name]`: a measure, or a column of the table in the current row context.
    BracketRef(String),
    /// A bare plain identifier that is not a function call: a variable or a table.
    Name(String),
    /// `'Quoted name'` without brackets: always a table.
    TableRef(String),
    Call { name: String, name_span: Span, args: Vec<Expr> },
    /// An argument left empty, as in `F(a, , c)`.
    Missing,
    Unary { op: UnOp, expr: Box<Expr> },
    Binary { op: BinOp, left: Box<Expr>, right: Box<Expr> },
    /// `left IN right`; `left` may be a tuple.
    In { left: Box<Expr>, right: Box<Expr> },
    /// `(a, b)`; only valid inside table constructors and on the left of `IN`.
    Tuple(Vec<Expr>),
    /// `{ ... }`: each row is a list of values (a single value means a one-column row).
    TableConstructor(Vec<Vec<Expr>>),
    /// `VAR a = ... VAR b = ... RETURN body`
    VarBlock { vars: Vec<VarDef>, body: Box<Expr> },
    /// `ASC` / `DESC` used as an argument (TOPN, ORDERBY, RANKX ...).
    SortOrder(bool),
}

#[derive(Debug, Clone, PartialEq)]
pub struct VarDef {
    pub name: String,
    pub span: Span,
    pub expr: Expr,
}

/// `DEFINE` section items.
#[derive(Debug, Clone, PartialEq)]
pub enum Define {
    Measure { table: String, name: String, expr: Expr, span: Span },
    Column { table: String, name: String, expr: Expr, span: Span },
    Table { name: String, expr: Expr, span: Span },
    Var(VarDef),
    /// `lazy[i]`: parameter `i` is declared `EXPR` (evaluated where the body uses it) instead of `VAL` (evaluated once at the call).
    Function { name: String, params: Vec<String>, lazy: Vec<bool>, body: Expr, span: Span },
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderKey {
    pub expr: Expr,
    pub descending: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Evaluate {
    pub expr: Expr,
    pub order_by: Vec<OrderKey>,
    pub start_at: Vec<Expr>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Query {
    pub defines: Vec<Define>,
    pub evaluates: Vec<Evaluate>,
}

impl Expr {
    pub fn new(kind: ExprKind, span: Span) -> Expr {
        Expr { kind, span }
    }

    /// Visits this node and all sub-expressions (pre-order).
    pub fn walk<'a>(&'a self, f: &mut dyn FnMut(&'a Expr)) {
        f(self);
        match &self.kind {
            ExprKind::Call { args, .. } => args.iter().for_each(|a| a.walk(f)),
            ExprKind::Unary { expr, .. } => expr.walk(f),
            ExprKind::Binary { left, right, .. } | ExprKind::In { left, right } => {
                left.walk(f);
                right.walk(f);
            }
            ExprKind::Tuple(items) => items.iter().for_each(|a| a.walk(f)),
            ExprKind::TableConstructor(rows) => rows.iter().flatten().for_each(|a| a.walk(f)),
            ExprKind::VarBlock { vars, body } => {
                vars.iter().for_each(|v| v.expr.walk(f));
                body.walk(f);
            }
            _ => {}
        }
    }
}
