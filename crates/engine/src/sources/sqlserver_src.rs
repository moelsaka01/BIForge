//! SQL Server connector (tiberius, MIT/Apache-2.0). The table is read into typed cells like the other row-wise
//! sources. Types are normalized on the server: numbers that are not plain ints/floats become float, dates and times
//! become datetime2, everything else is read as text, so every column maps to a supported cell kind.
use super::{clean_names, Cell, RawTable};
use crate::creds::CredentialStore;
use crate::error::{EngineError, Result};
use crate::types::SourceSpec;
use chrono::NaiveDateTime;
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, Row};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

fn err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Source(format!("SQL Server error: {e}"))
}

/// Bracket-quotes an identifier.
pub fn qi(s: &str) -> String {
    format!("[{}]", s.replace(']', "]]"))
}

/// What the SELECT list does with a column of a given SQL Server type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Bool,
    U8,
    I16,
    I32,
    I64,
    F32,
    F64,
    /// decimal, numeric, money: cast to float
    ToFloat,
    /// date, datetime, datetime2, smalldatetime: cast to datetime2(6)
    ToDateTime,
    /// everything else: cast to nvarchar(max)
    ToText,
}

pub fn kind_of(data_type: &str) -> Kind {
    match data_type.to_ascii_lowercase().as_str() {
        "bit" => Kind::Bool,
        "tinyint" => Kind::U8,
        "smallint" => Kind::I16,
        "int" => Kind::I32,
        "bigint" => Kind::I64,
        "real" => Kind::F32,
        "float" => Kind::F64,
        "decimal" | "numeric" | "money" | "smallmoney" => Kind::ToFloat,
        "date" | "datetime" | "datetime2" | "smalldatetime" => Kind::ToDateTime,
        _ => Kind::ToText,
    }
}

/// The SELECT that reads `schema.table` with the columns normalized as described above.
pub fn select_sql(schema: &str, table: &str, columns: &[(String, String)]) -> String {
    select_from(&format!("{}.{}", qi(schema), qi(table)), columns, None)
}

/// A custom query is wrapped as a derived table (so it must be valid there: no ORDER BY without TOP); a trailing semicolon is dropped.
pub fn query_from(query: &str) -> Option<String> {
    let q = query.trim().trim_end_matches(';').trim();
    (!q.is_empty()).then(|| format!("({q}) AS biforge_query"))
}

pub fn select_from(from: &str, columns: &[(String, String)], limit: Option<usize>) -> String {
    let list: Vec<String> = columns
        .iter()
        .map(|(name, ty)| {
            let n = qi(name);
            match kind_of(ty) {
                Kind::ToFloat => format!("CAST({n} AS float) AS {n}"),
                Kind::ToDateTime => format!("CAST({n} AS datetime2(6)) AS {n}"),
                Kind::ToText => format!("CAST({n} AS nvarchar(max)) AS {n}"),
                _ => n,
            }
        })
        .collect();
    let top = limit.map(|n| format!("TOP {n} ")).unwrap_or_default();
    format!("SELECT {top}{} FROM {from}", list.join(", "))
}

fn parts(spec: &SourceSpec) -> Result<(&str, Option<u16>, &str, Option<&str>, &str, &str)> {
    match spec {
        SourceSpec::SqlServer { server, port, database, user, schema, table, .. } => Ok((server, *port, database, user.as_deref(), schema, table)),
        _ => Err(EngineError::Source("not a SQL Server source".into())),
    }
}

/// Builds the connection configuration. With a user name the password comes from the credential store only; without
/// one, Windows integrated authentication is used. The server certificate is trusted only when it validates.
pub fn config(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Config> {
    let (server, port, database, user, _, _) = parts(spec)?;
    let mut cfg = Config::new();
    cfg.host(server);
    if let Some(p) = port {
        cfg.port(p);
    }
    cfg.database(database);
    cfg.encryption(EncryptionLevel::Required);
    if matches!(spec, SourceSpec::SqlServer { trust_certificate: true, .. }) {
        cfg.trust_cert();
    }
    match user {
        Some(u) => {
            let pw = match spec.credential_key() {
                Some(k) => creds.get(&k)?.unwrap_or_default(),
                None => String::new(),
            };
            cfg.authentication(AuthMethod::sql_server(u, pw));
        }
        #[cfg(windows)]
        None => cfg.authentication(AuthMethod::Integrated),
        #[cfg(not(windows))]
        None => return Err(EngineError::Source("SQL Server error: Windows authentication is only available on Windows; enter a user and password".into())),
    }
    Ok(cfg)
}

async fn connect(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Client<Compat<TcpStream>>> {
    let cfg = config(spec, creds)?;
    let tcp = tokio::time::timeout(std::time::Duration::from_secs(10), TcpStream::connect(cfg.get_addr()))
        .await
        .map_err(|_| EngineError::Source("SQL Server error: the connection timed out after 10 seconds".into()))?
        .map_err(err)?;
    tcp.set_nodelay(true).map_err(err)?;
    Client::connect(cfg, tcp.compat_write()).await.map_err(err)
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(err)
}

pub fn list_tables(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Vec<String>> {
    let (_, _, _, _, schema, _) = parts(spec)?;
    runtime()?.block_on(async {
        let mut c = connect(spec, creds).await?;
        let rows = c
            .query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @P1 ORDER BY TABLE_NAME", &[&schema])
            .await
            .map_err(err)?
            .into_first_result()
            .await
            .map_err(err)?;
        Ok(rows.iter().filter_map(|r| r.get::<&str, _>(0).map(String::from)).collect())
    })
}

struct Row2 {
    name: String,
    ty: String,
}

fn cell(r: &Row, i: usize, k: Kind) -> Cell {
    match k {
        Kind::Bool => r.get::<bool, _>(i).map_or(Cell::Null, Cell::Bool),
        Kind::U8 => r.get::<u8, _>(i).map_or(Cell::Null, |v| Cell::Int(v as i64)),
        Kind::I16 => r.get::<i16, _>(i).map_or(Cell::Null, |v| Cell::Int(v as i64)),
        Kind::I32 => r.get::<i32, _>(i).map_or(Cell::Null, |v| Cell::Int(v as i64)),
        Kind::I64 => r.get::<i64, _>(i).map_or(Cell::Null, Cell::Int),
        Kind::F32 => r.get::<f32, _>(i).map_or(Cell::Null, |v| Cell::Float(v as f64)),
        Kind::F64 | Kind::ToFloat => r.get::<f64, _>(i).map_or(Cell::Null, Cell::Float),
        Kind::ToDateTime => r.get::<NaiveDateTime, _>(i).map_or(Cell::Null, |d| Cell::Timestamp(d.and_utc().timestamp_micros())),
        Kind::ToText => r.get::<&str, _>(i).map_or(Cell::Null, |s| Cell::Text(s.to_string())),
    }
}

pub fn read(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<RawTable> {
    read_n(spec, creds, None)
}

pub fn read_n(spec: &SourceSpec, creds: &dyn CredentialStore, limit: Option<usize>) -> Result<RawTable> {
    let (_, _, _, _, schema, table) = parts(spec)?;
    let custom = match spec {
        SourceSpec::SqlServer { query: Some(q), .. } => query_from(q).map(|f| (f, q.trim().trim_end_matches(';').trim().to_string())),
        _ => None,
    };
    runtime()?.block_on(async {
        let mut c = connect(spec, creds).await?;
        let cols = if let Some((_, q)) = &custom {
            // column names and types of the query, as the server sees them
            c.query("EXEC sp_describe_first_result_set @tsql = @P1", &[q])
                .await
                .map_err(err)?
                .into_first_result()
                .await
                .map_err(err)?
                .iter()
                .map(|r| {
                    let ty = r.get::<&str, _>("system_type_name").unwrap_or_default();
                    (r.get::<&str, _>("name").unwrap_or_default().to_string(), ty.split('(').next().unwrap_or_default().trim().to_string())
                })
                .map(|(n, t)| Row2 { name: n, ty: t })
                .collect::<Vec<_>>()
        } else {
            c.query(
                "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @P1 AND TABLE_NAME = @P2 ORDER BY ORDINAL_POSITION",
                &[&schema, &table],
            )
            .await
            .map_err(err)?
            .into_first_result()
            .await
            .map_err(err)?
            .iter()
            .map(|r| Row2 { name: r.get::<&str, _>(0).unwrap_or_default().to_string(), ty: r.get::<&str, _>(1).unwrap_or_default().to_string() })
            .collect::<Vec<_>>()
        };
        let columns: Vec<(String, String)> = cols.into_iter().map(|r| (r.name, r.ty)).collect();
        if columns.is_empty() {
            return Err(EngineError::Source(format!("SQL Server error: table \"{schema}.{table}\" does not exist or has no readable columns")));
        }
        let from = custom.as_ref().map(|(f, _)| f.clone()).unwrap_or_else(|| format!("{}.{}", qi(schema), qi(table)));
        let rows = c.query(select_from(&from, &columns, limit), &[]).await.map_err(err)?.into_first_result().await.map_err(err)?;
        let kinds: Vec<Kind> = columns.iter().map(|(_, t)| kind_of(t)).collect();
        let names = clean_names(columns.iter().map(|(n, _)| n.clone()).collect());
        let out = rows.iter().map(|r| kinds.iter().enumerate().map(|(i, k)| cell(r, i, *k)).collect()).collect();
        Ok(RawTable { columns: names, rows: out })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creds::MemoryCredentialStore;

    fn spec(user: Option<&str>) -> SourceSpec {
        SourceSpec::SqlServer { server: "127.0.0.1".into(), port: Some(1), database: "db".into(), user: user.map(String::from), schema: "dbo".into(), table: "t".into(), query: None, trust_certificate: false }
    }

    #[test]
    fn identifiers_are_bracket_quoted() {
        assert_eq!(qi("a]b"), "[a]]b]");
    }

    #[test]
    fn column_types_map_to_cell_kinds_and_casts() {
        assert_eq!(kind_of("INT"), Kind::I32);
        assert_eq!(kind_of("decimal"), Kind::ToFloat);
        assert_eq!(kind_of("datetime2"), Kind::ToDateTime);
        assert_eq!(kind_of("uniqueidentifier"), Kind::ToText);
        let sql = select_sql(
            "dbo",
            "People",
            &[("Id".into(), "int".into()), ("Score".into(), "numeric".into()), ("Born".into(), "date".into()), ("Guid".into(), "uniqueidentifier".into())],
        );
        assert_eq!(
            sql,
            "SELECT [Id], CAST([Score] AS float) AS [Score], CAST([Born] AS datetime2(6)) AS [Born], CAST([Guid] AS nvarchar(max)) AS [Guid] FROM [dbo].[People]"
        );
    }

    #[test]
    fn credentials_come_only_from_the_store_and_windows_auth_needs_no_user() {
        let creds = MemoryCredentialStore::default();
        let s = spec(Some("sa"));
        creds.set(&s.credential_key().unwrap(), "secret").unwrap();
        assert!(config(&s, &creds).is_ok());
        assert!(!format!("{s:?}").contains("secret"));
        assert!(config(&spec(None), &creds).is_ok());
        assert_eq!(spec(None).credential_key(), None);
        assert_eq!(s.credential_key().as_deref(), Some("sqlserver:sa@127.0.0.1:1/db"));
    }

    #[test]
    fn an_unreachable_server_gives_a_readable_error() {
        let e = read(&spec(Some("sa")), &MemoryCredentialStore::default()).err().expect("must fail").to_string();
        assert!(e.starts_with("SQL Server error"), "{e}");
    }
}
