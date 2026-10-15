use thiserror::Error;

/// Errors surfaced to the UI as readable messages. Nothing here panics on user input.
#[derive(Debug, Error)]
pub enum EngineError {
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Table \"{0}\" does not exist in the data store.")]
    NoSuchTable(String),
    #[error("Column \"{column}\" does not exist in table \"{table}\".")]
    NoSuchColumn { table: String, column: String },
    #[error("Invalid name: {0}")]
    InvalidName(String),
    #[error("{0}")]
    Source(String),
    #[error("Credential store error: {0}")]
    Credential(String),
    #[error("Data store error: {0}")]
    Db(#[from] duckdb::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, EngineError>;
