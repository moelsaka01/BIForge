use serde::{Deserialize, Serialize};

/// Where a table's data comes from. Stored (without secrets) in the document so a table can be refreshed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceSpec {
    Csv {
        path: String,
        #[serde(default)]
        delimiter: Option<String>,
        #[serde(default)]
        header: Option<bool>,
    },
    Excel {
        path: String,
        #[serde(default)]
        sheet: Option<String>,
        #[serde(default = "yes")]
        header: bool,
    },
    Json {
        path: String,
    },
    Parquet {
        path: String,
    },
    Sqlite {
        path: String,
        table: String,
    },
    Postgres {
        host: String,
        #[serde(default = "pg_port")]
        port: u16,
        database: String,
        user: String,
        #[serde(default = "pg_schema")]
        schema: String,
        table: String,
        /// Custom SQL (a SELECT) used instead of the table.
        #[serde(default)]
        query: Option<String>,
    },
    /// SQL Server (tiberius). Without `user` Windows integrated authentication is used.
    #[serde(rename = "sqlserver")]
    SqlServer {
        server: String,
        #[serde(default)]
        port: Option<u16>,
        database: String,
        #[serde(default)]
        user: Option<String>,
        #[serde(default = "mssql_schema")]
        schema: String,
        table: String,
        /// Custom SQL (a SELECT) used instead of the table.
        #[serde(default)]
        query: Option<String>,
        /// Accept a server certificate that does not validate (a self-signed one). The connection stays encrypted.
        #[serde(default)]
        trust_certificate: bool,
    },
    /// MySQL and MariaDB.
    #[serde(rename = "mysql")]
    MySql {
        host: String,
        #[serde(default = "mysql_port")]
        port: u16,
        database: String,
        user: String,
        #[serde(default)]
        table: String,
        #[serde(default)]
        query: Option<String>,
    },
    /// Any database with an ODBC driver on this machine. `flavor` (odbc, access, oracle, db2, ...) only changes how names are quoted
    /// and which M connector the partition uses. The connection string never holds the password.
    Odbc {
        #[serde(default = "odbc_flavor")]
        flavor: String,
        connection: String,
        #[serde(default)]
        user: Option<String>,
        #[serde(default)]
        table: Option<String>,
        #[serde(default)]
        query: Option<String>,
    },
    /// XML file; `table` names one of the tables found in it (blank = the first).
    Xml {
        path: String,
        #[serde(default)]
        table: Option<String>,
    },
    /// A web address: an HTML page (tables), JSON, CSV or XML. `format` is auto, html, json, csv or xml. With `user` the request uses Basic authentication.
    Web {
        url: String,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        table: Option<String>,
        #[serde(default)]
        user: Option<String>,
    },
    /// OData v4 feed: `entity` is an entity set of the service.
    #[serde(rename = "odata")]
    OData {
        url: String,
        entity: String,
        #[serde(default)]
        user: Option<String>,
    },
    /// A table found in a PDF file (best effort: text laid out in rows and columns).
    Pdf {
        path: String,
        #[serde(default)]
        table: Option<String>,
    },
    /// Data typed in by the user (Enter data). Values are text; `ty` is text, whole, decimal, logical, date or datetime.
    Inline {
        columns: Vec<InlineColumn>,
        rows: Vec<Vec<Option<String>>>,
    },
    /// Text file with columns at fixed character positions: `widths` are the column widths.
    FixedWidth {
        path: String,
        widths: Vec<usize>,
        #[serde(default = "yes")]
        header: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InlineColumn {
    pub name: String,
    #[serde(rename = "type", default = "inline_text")]
    pub ty: String,
}

fn inline_text() -> String {
    "text".into()
}

fn mysql_port() -> u16 {
    3306
}
fn odbc_flavor() -> String {
    "odbc".into()
}

fn mssql_schema() -> String {
    "dbo".into()
}
fn yes() -> bool {
    true
}
fn pg_port() -> u16 {
    5432
}
fn pg_schema() -> String {
    "public".into()
}

impl SourceSpec {
    /// Key under which the secret for this source is kept in the Windows Credential Manager.
    pub fn credential_key(&self) -> Option<String> {
        match self {
            SourceSpec::Postgres { host, port, database, user, .. } => {
                Some(format!("postgres:{user}@{host}:{port}/{database}"))
            }
            SourceSpec::SqlServer { server, port, database, user: Some(user), .. } => {
                Some(format!("sqlserver:{user}@{server}:{}/{database}", port.unwrap_or(1433)))
            }
            SourceSpec::MySql { host, port, database, user, .. } => Some(format!("mysql:{user}@{host}:{port}/{database}")),
            SourceSpec::Odbc { connection, user: Some(user), .. } if !user.trim().is_empty() => Some(format!("odbc:{user}@{connection}")),
            SourceSpec::Web { url, user: Some(user), .. } | SourceSpec::OData { url, user: Some(user), .. } if !user.trim().is_empty() => Some(format!("web:{user}@{url}")),
            _ => None,
        }
    }
}

/// Data types used by the model (TMDL `dataType` values).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BiType {
    Int64,
    Double,
    Decimal,
    Boolean,
    DateTime,
    String,
    Binary,
}

impl BiType {
    pub fn from_duckdb(t: &str) -> BiType {
        let u = t.to_ascii_uppercase();
        if u.starts_with("DECIMAL") {
            return BiType::Decimal;
        }
        match u.as_str() {
            "TINYINT" | "SMALLINT" | "INTEGER" | "BIGINT" | "HUGEINT" | "UTINYINT" | "USMALLINT" | "UINTEGER"
            | "UBIGINT" | "UHUGEINT" => BiType::Int64,
            "FLOAT" | "DOUBLE" => BiType::Double,
            "BOOLEAN" => BiType::Boolean,
            "DATE" | "TIMESTAMP" | "TIMESTAMP_S" | "TIMESTAMP_MS" | "TIMESTAMP_NS" | "TIMESTAMP WITH TIME ZONE" | "TIME" => {
                BiType::DateTime
            }
            "BLOB" => BiType::Binary,
            _ => BiType::String,
        }
    }
    pub fn tmdl_name(self) -> &'static str {
        match self {
            BiType::Int64 => "int64",
            BiType::Double => "double",
            BiType::Decimal => "decimal",
            BiType::Boolean => "boolean",
            BiType::DateTime => "dateTime",
            BiType::String => "string",
            BiType::Binary => "binary",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub duckdb_type: String,
    pub bi_type: BiType,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub columns: Vec<ColumnInfo>,
    pub row_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    #[serde(default)]
    pub descending: bool,
}

/// Cell values are returned as text (NULL = None); the UI formats by the column's type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowPage {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Option<String>>>,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cardinality {
    OneToMany,
    ManyToOne,
    OneToOne,
    ManyToMany,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipHint {
    pub from_unique: bool,
    pub to_unique: bool,
    pub cardinality: Cardinality,
}
