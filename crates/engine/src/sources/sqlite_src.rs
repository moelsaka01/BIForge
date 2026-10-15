use super::{clean_names, Cell, RawTable};
use crate::error::{EngineError, Result};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

fn err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Source(format!("SQLite error: {e}"))
}

fn open(path: &str) -> Result<Connection> {
    if !std::path::Path::new(path).exists() {
        return Err(EngineError::FileNotFound(path.into()));
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)
}

pub fn list_tables(path: &str) -> Result<Vec<String>> {
    let c = open(path)?;
    let mut st = c
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(err)?;
    let v = st
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(v)
}

pub fn read(path: &str, table: &str) -> Result<RawTable> {
    let c = open(path)?;
    let sql = format!("SELECT * FROM \"{}\"", table.replace('"', "\"\""));
    let mut st = c.prepare(&sql).map_err(err)?;
    let columns = clean_names(st.column_names().iter().map(|s| s.to_string()).collect());
    let n = columns.len();
    let mut rows = Vec::new();
    let mut q = st.query([]).map_err(err)?;
    while let Some(r) = q.next().map_err(err)? {
        let mut row = Vec::with_capacity(n);
        for i in 0..n {
            row.push(match r.get_ref(i).map_err(err)? {
                ValueRef::Null => Cell::Null,
                ValueRef::Integer(i) => Cell::Int(i),
                ValueRef::Real(f) => Cell::Float(f),
                ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(b) => Cell::Text(format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())),
            });
        }
        rows.push(row);
    }
    Ok(RawTable { columns, rows })
}
