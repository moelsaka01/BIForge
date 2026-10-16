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
    },
    /// SQL Server (tiberius). Without `user` Windows integrated authentication is used.
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
    },
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
