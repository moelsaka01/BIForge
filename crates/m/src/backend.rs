//! What the evaluator needs from the host: schema discovery, small reads, and the SQL of each data source.
//! The engine crate implements this over its DuckDB connection; tests use the same implementation.

#[derive(Debug, Clone, PartialEq)]
pub enum SourceRequest {
    /// `Csv.Document`: every field is read as text (typing is a later step, as in Power Query).
    Csv { path: String, delimiter: String, quote: Option<String> },
    /// One sheet of a workbook (by name or by position); `header` = the first row holds column names.
    Excel { path: String, sheet: Option<String>, index: usize, header: bool },
    Parquet { path: String },
    /// `Table.FromRecords(Json.Document(...))`
    Json { path: String },
    /// `Folder.Files` / `Folder.Contents`: one row per file with Power Query's column names.
    Folder { path: String, recursive: bool },
    /// SQLite table through `Odbc.Query` (the only ODBC form supported).
    Sqlite { path: String, table: String },
}

pub trait Backend {
    /// Column names and DuckDB type names of a complete SELECT statement.
    fn describe(&self, sql: &str) -> Result<Vec<(String, String)>, String>;
    /// At most `limit` rows of a complete SELECT, every cell as text (None = NULL).
    fn rows(&self, sql: &str, limit: usize) -> Result<Vec<Vec<Option<String>>>, String>;
    /// A SELECT statement (without the ordering column) that yields the source's data.
    fn source_sql(&self, req: &SourceRequest) -> Result<String, String>;
    fn excel_sheets(&self, path: &str) -> Result<Vec<String>, String>;
}
