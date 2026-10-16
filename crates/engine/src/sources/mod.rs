//! Row-wise sources (Excel, SQLite, PostgreSQL) are read into typed cells and appended to a DuckDB table.
//! File formats DuckDB reads natively (CSV, JSON, Parquet) are handled in `lib.rs`.
pub mod excel;
pub mod postgres_src;
pub mod sqlserver_src;
pub mod sqlite_src;

use crate::error::Result;
use duckdb::types::{TimeUnit, Value};
use duckdb::Connection;

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Int(i64),
    Float(f64),
    Bool(bool),
    Text(String),
    /// Microseconds since the Unix epoch.
    Timestamp(i64),
}

pub struct RawTable {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

/// Makes names non-empty and unique (case-insensitive): "Column3", "Name.1".
pub fn clean_names(names: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    names
        .into_iter()
        .enumerate()
        .map(|(i, n)| {
            let base = if n.trim().is_empty() { format!("Column{}", i + 1) } else { n.trim().to_string() };
            let mut name = base.clone();
            let mut k = 1;
            while !seen.insert(name.to_lowercase()) {
                name = format!("{base}.{k}");
                k += 1;
            }
            name
        })
        .collect()
}

fn column_type(rows: &[Vec<Cell>], i: usize) -> &'static str {
    let (mut int, mut float, mut boolean, mut ts, mut other) = (false, false, false, false, false);
    for r in rows {
        match &r[i] {
            Cell::Null => {}
            Cell::Int(_) => int = true,
            Cell::Float(_) => float = true,
            Cell::Bool(_) => boolean = true,
            Cell::Timestamp(_) => ts = true,
            Cell::Text(_) => other = true,
        }
    }
    let kinds = [int || float, boolean, ts, other].iter().filter(|b| **b).count();
    if kinds > 1 || other {
        "VARCHAR"
    } else if float {
        "DOUBLE"
    } else if int {
        "BIGINT"
    } else if boolean {
        "BOOLEAN"
    } else if ts {
        "TIMESTAMP"
    } else {
        "VARCHAR"
    }
}

fn to_text(c: &Cell) -> Option<String> {
    Some(match c {
        Cell::Null => return None,
        Cell::Int(i) => i.to_string(),
        Cell::Float(f) => f.to_string(),
        Cell::Bool(b) => b.to_string(),
        Cell::Text(s) => s.clone(),
        Cell::Timestamp(us) => chrono::DateTime::from_timestamp_micros(*us)
            .map(|d| d.naive_utc().to_string())
            .unwrap_or_default(),
    })
}

pub fn q(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// Creates `table` (typed by inference over all rows) and appends the rows.
pub fn load(conn: &Connection, table: &str, raw: &RawTable) -> Result<()> {
    load_as(conn, table, raw, false)
}

/// Like `load`; `temp` creates a temporary table (lives as long as the connection).
pub fn load_as(conn: &Connection, table: &str, raw: &RawTable, temp: bool) -> Result<()> {
    if temp {
        // the appender cannot address the temp catalog, so fill a plain table first and copy it
        let stage = format!("{table}__fill");
        conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", q(&stage)))?;
        load_as(conn, &stage, raw, false)?;
        let r = conn.execute_batch(&format!("CREATE TEMP TABLE {} AS SELECT * FROM {}", q(table), q(&stage)));
        let _ = conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", q(&stage)));
        return Ok(r?);
    }
    let types: Vec<&str> = (0..raw.columns.len()).map(|i| column_type(&raw.rows, i)).collect();
    let defs: Vec<String> = raw.columns.iter().zip(&types).map(|(c, t)| format!("{} {}", q(c), t)).collect();
    conn.execute_batch(&format!("CREATE TABLE {} ({})", q(table), defs.join(", ")))?;
    let mut app = conn.appender(table)?;
    for r in &raw.rows {
        let vals: Vec<Value> = r
            .iter()
            .zip(&types)
            .map(|(c, t)| match (c, *t) {
                (Cell::Null, _) => Value::Null,
                (Cell::Int(i), "BIGINT") => Value::BigInt(*i),
                (Cell::Int(i), "DOUBLE") => Value::Double(*i as f64),
                (Cell::Float(f), "DOUBLE") => Value::Double(*f),
                (Cell::Bool(b), "BOOLEAN") => Value::Boolean(*b),
                (Cell::Timestamp(us), "TIMESTAMP") => Value::Timestamp(TimeUnit::Microsecond, *us),
                (other, _) => to_text(other).map(Value::Text).unwrap_or(Value::Null),
            })
            .collect();
        app.append_row(duckdb::appender_params_from_iter(vals))?;
    }
    app.flush()?;
    Ok(())
}
