//! Generic ODBC connector (odbc-api, MIT). It serves every database that has an ODBC driver on the machine: Access,
//! Oracle, Db2, Teradata, SAP HANA, Sybase, Redshift, Snowflake, BigQuery, Databricks, Excel and text drivers, and so on.
//! Rows are fetched as text and converted by the type the driver reports for the column.
use super::{clean_names, Cell, RawTable};
use crate::creds::CredentialStore;
use crate::error::{EngineError, Result};
use crate::types::SourceSpec;
use odbc_api::{buffers::TextRowSet, ConnectionOptions, Cursor, DataType, Environment, ResultSetMetadata};

fn err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Source(format!("ODBC error: {e}"))
}

/// A connection string must not carry the secret: the password is added from the credential store.
pub fn check_connection(conn: &str) -> Result<()> {
    let low = conn.to_ascii_lowercase().replace(' ', "");
    if low.contains("pwd=") || low.contains("password=") {
        return Err(EngineError::Source("Do not put the password in the connection string: enter it in the Password field, it is kept in Windows Credential Manager.".into()));
    }
    if conn.trim().is_empty() {
        return Err(EngineError::Source("The ODBC connection string is empty.".into()));
    }
    Ok(())
}

type Parts<'a> = (&'a str, &'a str, Option<&'a str>, Option<&'a str>, Option<&'a str>);

fn parts(spec: &SourceSpec) -> Result<Parts<'_>> {
    match spec {
        SourceSpec::Odbc { flavor, connection, user, table, query } => Ok((flavor, connection, user.as_deref(), table.as_deref(), query.as_deref())),
        _ => Err(EngineError::Source("not an ODBC source".into())),
    }
}

/// The connection string as sent to the driver (user name and password appended when a user is set).
pub fn full_connection(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<String> {
    let (_, conn, user, _, _) = parts(spec)?;
    check_connection(conn)?;
    let mut s = conn.trim().trim_end_matches(';').to_string();
    if let Some(u) = user.filter(|u| !u.trim().is_empty()) {
        let pw = spec.credential_key().and_then(|k| creds.get(&k).ok().flatten()).unwrap_or_default();
        s += &format!(";UID={};PWD={}", brace(u), brace(&pw));
    }
    Ok(s)
}

fn brace(v: &str) -> String {
    if v.chars().any(|c| ";{}= ".contains(c)) {
        format!("{{{}}}", v.replace('}', "}}"))
    } else {
        v.to_string()
    }
}

/// Identifier quoting: Access uses [brackets], the others standard double quotes. "schema.table" is quoted per part.
pub fn quote_table(flavor: &str, table: &str) -> String {
    let q = |p: &str| if flavor == "access" { format!("[{}]", p.replace(']', "]]")) } else { format!("\"{}\"", p.replace('"', "\"\"")) };
    if flavor == "access" {
        q(table)
    } else {
        table.split('.').map(q).collect::<Vec<_>>().join(".")
    }
}

pub fn select_for(spec: &SourceSpec) -> Result<String> {
    let (flavor, _, _, table, query) = parts(spec)?;
    if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
        return Ok(q.to_string());
    }
    let t = table.filter(|t| !t.trim().is_empty()).ok_or_else(|| EngineError::Source("Choose a table or enter a query.".into()))?;
    Ok(format!("SELECT * FROM {}", quote_table(flavor, t)))
}

#[derive(Clone, Copy)]
enum K {
    Int,
    Float,
    Bool,
    Time,
    Text,
}

fn kind(t: &DataType) -> K {
    match t {
        DataType::TinyInt | DataType::SmallInt | DataType::Integer | DataType::BigInt => K::Int,
        DataType::Numeric { scale: 0, precision } | DataType::Decimal { scale: 0, precision } if *precision <= 18 => K::Int,
        DataType::Real | DataType::Float { .. } | DataType::Double | DataType::Numeric { .. } | DataType::Decimal { .. } => K::Float,
        DataType::Bit => K::Bool,
        DataType::Date | DataType::Timestamp { .. } => K::Time,
        _ => K::Text,
    }
}

fn cell(k: K, b: Option<&[u8]>) -> Cell {
    let Some(b) = b else { return Cell::Null };
    let s = String::from_utf8_lossy(b);
    let t = s.trim();
    match k {
        K::Int => t.parse().map(Cell::Int).unwrap_or_else(|_| Cell::Text(s.to_string())),
        K::Float => t.replace(',', ".").parse().map(Cell::Float).unwrap_or_else(|_| Cell::Text(s.to_string())),
        K::Bool => Cell::Bool(matches!(t, "1" | "true" | "TRUE" | "True" | "-1")),
        K::Time => {
            for f in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
                if let Ok(d) = chrono::NaiveDateTime::parse_from_str(t, f) {
                    return Cell::Timestamp(d.and_utc().timestamp_micros());
                }
            }
            chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d")
                .map(|d| Cell::Timestamp(d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_micros()))
                .unwrap_or_else(|_| Cell::Text(s.to_string()))
        }
        K::Text => Cell::Text(s.to_string()),
    }
}

fn run(spec: &SourceSpec, creds: &dyn CredentialStore, sql: &str, limit: Option<usize>) -> Result<RawTable> {
    let conn_str = full_connection(spec, creds)?;
    let env = Environment::new().map_err(err)?;
    let conn = env.connect_with_connection_string(&conn_str, ConnectionOptions::default()).map_err(err)?;
    let Some(mut cursor) = conn.execute(sql, (), None).map_err(err)? else {
        return Err(EngineError::Source("ODBC error: the statement returned no result set".into()));
    };
    let n = cursor.num_result_cols().map_err(err)? as u16;
    let mut names = Vec::new();
    let mut kinds = Vec::new();
    for i in 1..=n {
        names.push(cursor.col_name(i).map_err(err)?);
        kinds.push(kind(&cursor.col_data_type(i).map_err(err)?));
    }
    let mut rows = Vec::new();
    let buffer = TextRowSet::for_cursor(2000, &mut cursor, Some(1 << 20)).map_err(err)?;
    let mut block = cursor.bind_buffer(buffer).map_err(err)?;
    'outer: while let Some(batch) = block.fetch().map_err(err)? {
        for r in 0..batch.num_rows() {
            rows.push((0..n as usize).map(|c| cell(kinds[c], batch.at(c, r))).collect());
            if limit.is_some_and(|l| rows.len() >= l) {
                break 'outer;
            }
        }
    }
    Ok(RawTable { columns: clean_names(names), rows })
}

pub fn read(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<RawTable> {
    run(spec, creds, &select_for(spec)?, None)
}

pub fn preview(spec: &SourceSpec, creds: &dyn CredentialStore, limit: usize) -> Result<RawTable> {
    run(spec, creds, &select_for(spec)?, Some(limit))
}

/// Installed driver names (the 64-bit driver manager of this process lists the drivers this process can use).
pub fn drivers() -> Result<Vec<String>> {
    let env = Environment::new().map_err(err)?;
    let mut d: Vec<String> = env.drivers().map_err(err)?.into_iter().map(|d| d.description).collect();
    d.sort();
    d.dedup();
    Ok(d)
}

/// Tables and views the driver reports (system tables are left out).
pub fn list_tables(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Vec<String>> {
    let conn_str = full_connection(spec, creds)?;
    let env = Environment::new().map_err(err)?;
    let conn = env.connect_with_connection_string(&conn_str, ConnectionOptions::default()).map_err(err)?;
    let mut out = Vec::new();
    for row in conn.tables("", "", "", "TABLE,VIEW").map_err(err)? {
        let row = row.map_err(err)?;
        let name = row.table.as_str().map_err(err)?.unwrap_or_default().to_string();
        let schema = row.schema.as_str().map_err(err)?.unwrap_or_default().to_string();
        if name.is_empty() {
            continue;
        }
        out.push(if schema.is_empty() { name } else { format!("{schema}.{name}") });
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creds::MemoryCredentialStore;

    fn spec(user: Option<&str>, conn: &str, table: Option<&str>, flavor: &str) -> SourceSpec {
        SourceSpec::Odbc { flavor: flavor.into(), connection: conn.into(), user: user.map(String::from), table: table.map(String::from), query: None }
    }

    #[test]
    fn passwords_never_live_in_the_connection_string_and_come_from_the_store() {
        assert!(check_connection("DSN=x;PWD=secret").is_err());
        assert!(check_connection("Driver={X};Password = s").is_err());
        let creds = MemoryCredentialStore::default();
        let s = spec(Some("scott"), "Driver={Oracle};Dbq=//h:1521/orcl;", Some("EMP"), "oracle");
        creds.set(&s.credential_key().unwrap(), "t;i{ger").unwrap();
        assert_eq!(full_connection(&s, &creds).unwrap(), "Driver={Oracle};Dbq=//h:1521/orcl;UID=scott;PWD={t;i{ger}");
        assert_eq!(full_connection(&spec(None, "DSN=x", None, "odbc"), &creds).unwrap(), "DSN=x");
    }

    #[test]
    fn tables_are_quoted_for_the_flavor_and_a_query_replaces_the_table() {
        assert_eq!(quote_table("access", "My Table"), "[My Table]");
        assert_eq!(quote_table("oracle", "HR.EMP\"X"), "\"HR\".\"EMP\"\"X\"");
        assert_eq!(select_for(&spec(None, "DSN=x", Some("t"), "odbc")).unwrap(), "SELECT * FROM \"t\"");
        let q = SourceSpec::Odbc { flavor: "odbc".into(), connection: "DSN=x".into(), user: None, table: None, query: Some("SELECT 1 AS a".into()) };
        assert_eq!(select_for(&q).unwrap(), "SELECT 1 AS a");
        assert!(select_for(&spec(None, "DSN=x", None, "odbc")).is_err());
    }
}
