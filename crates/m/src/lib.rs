//! M (Power Query formula language): parser, evaluator that folds table steps to DuckDB SQL, Applied Steps model.
pub mod ast;
pub mod backend;
pub mod eval;
pub mod fold;
pub mod lexer;
pub mod parser;
pub mod run;
pub mod stdlib;
pub mod stdlib_batch;
pub mod stdlib_date;
pub mod stdlib_ext;
pub mod stdlib_list;
pub mod stdlib_misc;
pub mod stdlib_more;
pub mod stdlib_native;
pub mod stdlib_rec;
pub mod steps;
pub mod transforms;
pub mod value;

pub use backend::{Backend, SourceRequest};
pub use lexer::ParseError;
pub use parser::parse;
pub use value::{Col, MError};
