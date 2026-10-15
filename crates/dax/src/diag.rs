//! Diagnostics. Syntax error kinds follow the taxonomy in research/dax-parser.md section 3.

use serde::Serialize;
use std::fmt;

/// Byte range in the source text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Span {
        Span { start, end }
    }
    pub fn to(self, other: Span) -> Span {
        Span { start: self.start.min(other.start), end: self.end.max(other.end) }
    }
}

/// The 16 syntax error kinds the reference parser distinguishes, plus semantic kinds of our own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    // ---- syntax (research/dax-parser.md) ----
    /// A formula of the form `Name = expression` has no name or no `=`.
    CantSeparateNameAndExpression,
    /// Something that is not a function is called with parentheses (e.g. `'Sales'(1)`).
    FunctionCallOnNonFunction,
    /// Any other grammar violation (unexpected token, missing parenthesis, ...).
    GrammaticalError,
    /// A number literal that stops half way (e.g. `1e`).
    IncompleteNumber,
    InvalidOrderByParameter,
    InvalidPartitionByParameter,
    InvalidMatchByParameter,
    /// A malformed identifier (e.g. an unterminated `[` or an empty `[]`).
    InvalidIdentifier,
    /// A character that cannot start any token.
    InvalidNameCharacter,
    /// A parenthesized list `(a, b)` outside a table constructor or the left side of `IN`.
    InvalidTupleLocation,
    /// An argument of the wrong kind (e.g. a scalar where a column reference is required).
    InvalidParameter,
    MissingParameters,
    TooManyParameters,
    /// The right side of `IN` is not a table.
    InRightArgumentNotTable,
    /// A name that is not a known function, table, column, measure or variable.
    UnrecognizedIdentifier,
    /// A variable named like a keyword or function.
    VariableNameReserved,
    // ---- semantic / evaluation ----
    /// Wrong value type for an operation (e.g. comparing text with a number).
    TypeMismatch,
    /// Circular dependency between measures or calculated columns.
    CircularDependency,
    /// A value was expected to be a single value but a table had several rows (or similar).
    InvalidValue,
    /// The function exists in the catalog but is not implemented by BIForge yet.
    NotImplemented,
    /// Any other evaluation error.
    Evaluation,
}

impl ErrorCode {
    pub fn is_syntax(self) -> bool {
        !matches!(
            self,
            ErrorCode::TypeMismatch | ErrorCode::CircularDependency | ErrorCode::InvalidValue | ErrorCode::NotImplemented | ErrorCode::Evaluation
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagnostic {
    pub code: ErrorCode,
    pub message: String,
    pub span: Span,
}

impl Diagnostic {
    pub fn new(code: ErrorCode, message: impl Into<String>, span: Span) -> Diagnostic {
        Diagnostic { code, message: message.into(), span }
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Diagnostic {}

/// 1-based line and column (in characters) of a byte offset; used by editors.
pub fn line_col(src: &str, offset: usize) -> (usize, usize) {
    let mut line = 1;
    let mut col = 1;
    for (i, ch) in src.char_indices() {
        if i >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}
