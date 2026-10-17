//! MySQL and MariaDB connector (mysql crate, MIT/Apache-2.0). Results come in the text protocol and are converted by the
//! column type the server reports. The connection is not encrypted yet (documented in the import dialog).
use super::{clean_names, Cell, RawTable};
use crate::creds::CredentialStore;
use crate::error::{EngineError, Result};
use crate::types::SourceSpec;
use mysql::consts::ColumnType as T;
use mysql::prelude::Queryable;
use mysql::{Conn, OptsBuilder, Value};

fn err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Source(format!("MySQL error: {e}"))
}

/// Backtick quoting.
pub fn qi(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

fn connect(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Conn> {
    let SourceSpec::MySql { host, port, database, user, .. } = spec else {
        return Err(EngineError::Source("not a MySQL source".into()));
    };
    let pw = spec.credential_key().and_then(|k| creds.get(&k).ok().flatten());
    let opts = OptsBuilder::new()
        .ip_or_hostname(Some(host.clone()))
        .tcp_port(*port)
        .db_name(Some(database.clone()))
        .user(Some(user.clone()))
        .pass(pw)
        .tcp_connect_timeout(Some(std::time::Duration::from_secs(10)))
        .prefer_socket(false);
    Conn::new(opts).map_err(err)
}

pub fn list_tables(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Vec<String>> {
    let SourceSpec::MySql { database, .. } = spec else {
        return Err(EngineError::Source("not a MySQL source".into()));
    };
    let mut c = connect(spec, creds)?;
    c.exec("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1", (database,)).map_err(err)
}

pub fn select_for(spec: &SourceSpec, limit: Option<usize>) -> Result<String> {
    let SourceSpec::MySql { table, query, .. } = spec else {
        return Err(EngineError::Source("not a MySQL source".into()));
    };
    let cap = limit.map(|n| format!(" LIMIT {n}")).unwrap_or_default();
    match query.as_deref().map(|q| q.trim().trim_end_matches(';').trim()).filter(|q| !q.is_empty()) {
        Some(q) => Ok(if limit.is_some() { format!("SELECT * FROM ({q}) AS biforge_query{cap}") } else { q.to_string() }),
        None if table.trim().is_empty() => Err(EngineError::Source("Choose a table or enter a query.".into())),
        None => Ok(format!("SELECT * FROM {}{cap}", qi(table))),
    }
}

#[derive(Clone, Copy)]
enum K {
    Int,
    Float,
    Time,
    Text,
}

fn kind(t: T) -> K {
    match t {
        T::MYSQL_TYPE_TINY | T::MYSQL_TYPE_SHORT | T::MYSQL_TYPE_LONG | T::MYSQL_TYPE_INT24 | T::MYSQL_TYPE_LONGLONG | T::MYSQL_TYPE_YEAR => K::Int,
        T::MYSQL_TYPE_FLOAT | T::MYSQL_TYPE_DOUBLE | T::MYSQL_TYPE_DECIMAL | T::MYSQL_TYPE_NEWDECIMAL => K::Float,
        T::MYSQL_TYPE_DATE | T::MYSQL_TYPE_DATETIME | T::MYSQL_TYPE_TIMESTAMP | T::MYSQL_TYPE_DATETIME2 | T::MYSQL_TYPE_TIMESTAMP2 | T::MYSQL_TYPE_NEWDATE => K::Time,
        _ => K::Text,
    }
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, mo, d, h, mi, s, us) => Some(format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")),
        Value::Time(neg, days, h, m, s, us) => Some(format!("{}{:02}:{m:02}:{s:02}.{us:06}", if *neg { "-" } else { "" }, *days as u32 * 24 + *h as u32)),
    }
}

fn cell(k: K, v: &Value) -> Cell {
    let Some(s) = text(v) else { return Cell::Null };
    match k {
        K::Int => s.parse().map(Cell::Int).unwrap_or_else(|_| s.parse().map(Cell::Float).unwrap_or(Cell::Text(s))),
        K::Float => s.parse().map(Cell::Float).unwrap_or(Cell::Text(s)),
        K::Time => {
            // zero dates ("0000-00-00") are not valid dates: they become null, as in Power Query
            for f in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d"] {
                if let Ok(d) = chrono::NaiveDateTime::parse_from_str(&s, f) {
                    return Cell::Timestamp(d.and_utc().timestamp_micros());
                }
                if let Ok(d) = chrono::NaiveDate::parse_from_str(&s, f) {
                    return Cell::Timestamp(d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_micros());
                }
            }
            if s.starts_with("0000") { Cell::Null } else { Cell::Text(s) }
        }
        K::Text => Cell::Text(s),
    }
}

pub fn read_n(spec: &SourceSpec, creds: &dyn CredentialStore, limit: Option<usize>) -> Result<RawTable> {
    let sql = select_for(spec, limit)?;
    let mut c = connect(spec, creds)?;
    let mut res = c.query_iter(sql).map_err(err)?;
    let cols = res.columns();
    let names: Vec<String> = cols.as_ref().iter().map(|c| c.name_str().to_string()).collect();
    let kinds: Vec<K> = cols.as_ref().iter().map(|c| kind(c.column_type())).collect();
    let mut rows = Vec::new();
    for r in res.by_ref() {
        let r = r.map_err(err)?;
        rows.push(r.unwrap().iter().zip(&kinds).map(|(v, k)| cell(*k, v)).collect());
    }
    Ok(RawTable { columns: clean_names(names), rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statements_quote_names_and_wrap_queries() {
        let s = |table: &str, query: Option<&str>| SourceSpec::MySql { host: "h".into(), port: 3306, database: "d".into(), user: "u".into(), table: table.into(), query: query.map(String::from) };
        assert_eq!(select_for(&s("a`b", None), None).unwrap(), "SELECT * FROM `a``b`");
        assert_eq!(select_for(&s("t", None), Some(5)).unwrap(), "SELECT * FROM `t` LIMIT 5");
        assert_eq!(select_for(&s("", Some("SELECT 1 AS x;")), None).unwrap(), "SELECT 1 AS x");
        assert_eq!(select_for(&s("", Some("SELECT 1 AS x")), Some(3)).unwrap(), "SELECT * FROM (SELECT 1 AS x) AS biforge_query LIMIT 3");
        assert!(select_for(&s("", None), None).is_err());
    }

    #[test]
    fn values_are_converted_by_the_column_type() {
        assert_eq!(cell(K::Int, &Value::Bytes(b"42".to_vec())), Cell::Int(42));
        assert_eq!(cell(K::Float, &Value::Bytes(b"1.50".to_vec())), Cell::Float(1.5));
        assert_eq!(cell(K::Time, &Value::Bytes(b"0000-00-00".to_vec())), Cell::Null);
        assert!(matches!(cell(K::Time, &Value::Bytes(b"2024-01-02 03:04:05".to_vec())), Cell::Timestamp(_)));
        assert!(matches!(cell(K::Time, &Value::Bytes(b"2024-01-02".to_vec())), Cell::Timestamp(_)));
        assert_eq!(cell(K::Text, &Value::NULL), Cell::Null);
    }
}
