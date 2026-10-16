//! Syntax tree of the M language (the subset described in research/m-parser-license.md).

#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TypeExpr {
    /// `text`, `number`, `any`, `table`, `Int64.Type`, ...
    Named(String),
    Nullable(Box<TypeExpr>),
    List(Box<TypeExpr>),
    Record { fields: Vec<(String, Option<TypeExpr>)>, open: bool },
    Table { fields: Vec<(String, Option<TypeExpr>)> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
    Concat,
    Meta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp {
    Not,
    Neg,
    Pos,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Param {
    pub name: String,
    pub optional: bool,
    pub ty: Option<TypeExpr>,
}

/// One binding of a `let` expression, with the source ranges needed to edit the text.
#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    /// The name without `#"` quoting.
    pub name: String,
    /// The name as written (`#"Changed Type"`).
    pub raw_name: String,
    pub name_span: Span,
    pub expr_span: Span,
    pub expr: Expr,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Null,
    Bool(bool),
    /// Value and the literal as written.
    Number(f64, String),
    Text(String),
    Ident(String),
    /// `_`
    Underscore,
    /// `[Name]` on the implicit `_`
    ImplicitField(String, bool),
    Record(Vec<(String, Expr)>),
    List(Vec<Expr>),
    Let { bindings: Vec<Binding>, body: Box<Expr>, body_span: Span },
    If(Box<Expr>, Box<Expr>, Box<Expr>),
    Each(Box<Expr>),
    Func { params: Vec<Param>, ret: Option<TypeExpr>, body: Box<Expr> },
    Binary(BinOp, Box<Expr>, Box<Expr>),
    Unary(UnOp, Box<Expr>),
    Invoke(Box<Expr>, Vec<Expr>),
    /// `e[Name]` / `e[Name]?`
    Field(Box<Expr>, String, bool),
    /// `e[[a],[b]]`
    Project(Box<Expr>, Vec<String>, bool),
    /// `e{i}` / `e{[k=v]}` / `e{i}?`
    Item(Box<Expr>, Box<Expr>, bool),
    Type(TypeExpr),
    Is(Box<Expr>, TypeExpr),
    As(Box<Expr>, TypeExpr),
    Try(Box<Expr>, Option<Box<Expr>>),
    Error(Box<Expr>),
}
