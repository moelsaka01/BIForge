use super::{clean_names, Cell, RawTable};
use crate::creds::CredentialStore;
use crate::error::{EngineError, Result};
use crate::types::SourceSpec;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use postgres::types::Type;
use postgres::{Client, Config, NoTls};

fn err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Source(format!("PostgreSQL error: {e}"))
}

fn qi(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Connects without TLS (documented limitation). The password comes from the credential store only.
pub fn connect(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Client> {
    let SourceSpec::Postgres { host, port, database, user, .. } = spec else {
        return Err(EngineError::Source("not a PostgreSQL source".into()));
    };
    let mut cfg = Config::new();
    cfg.host(host).port(*port).dbname(database).user(user).connect_timeout(std::time::Duration::from_secs(10));
    if let Some(key) = spec.credential_key() {
        if let Some(pw) = creds.get(&key)? {
            cfg.password(pw);
        }
    }
    cfg.connect(NoTls).map_err(err)
}

pub fn list_tables(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Vec<String>> {
    let SourceSpec::Postgres { schema, .. } = spec else {
        return Err(EngineError::Source("not a PostgreSQL source".into()));
    };
    let mut c = connect(spec, creds)?;
    let rows = c
        .query("SELECT table_name::text FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1", &[schema])
        .map_err(err)?;
    Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
}

pub fn read(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<RawTable> {
    let SourceSpec::Postgres { schema, table, .. } = spec else {
        return Err(EngineError::Source("not a PostgreSQL source".into()));
    };
    let mut c = connect(spec, creds)?;
    let from = format!("{}.{}", qi(schema), qi(table));
    let probe = c.prepare(&format!("SELECT * FROM {from}")).map_err(err)?;
    // Numeric and exotic types are cast server-side so every column maps to a supported cell kind.
    let select: Vec<String> = probe
        .columns()
        .iter()
        .map(|col| {
            let n = qi(col.name());
            let t = col.type_();
            if [
                Type::BOOL,
                Type::INT2,
                Type::INT4,
                Type::INT8,
                Type::FLOAT4,
                Type::FLOAT8,
                Type::TEXT,
                Type::VARCHAR,
                Type::BPCHAR,
                Type::DATE,
                Type::TIMESTAMP,
                Type::TIMESTAMPTZ,
            ]
            .contains(t)
            {
                n
            } else if *t == Type::NUMERIC {
                format!("{n}::float8 AS {n}")
            } else {
                format!("{n}::text AS {n}")
            }
        })
        .collect();
    let names = clean_names(probe.columns().iter().map(|c| c.name().to_string()).collect());
    let rows = c.query(&format!("SELECT {} FROM {from}", select.join(", ")), &[]).map_err(err)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let mut row = Vec::with_capacity(names.len());
        for (i, col) in r.columns().iter().enumerate() {
            let t = col.type_();
            row.push(if *t == Type::BOOL {
                r.get::<_, Option<bool>>(i).map_or(Cell::Null, Cell::Bool)
            } else if *t == Type::INT2 {
                r.get::<_, Option<i16>>(i).map_or(Cell::Null, |v| Cell::Int(v as i64))
            } else if *t == Type::INT4 {
                r.get::<_, Option<i32>>(i).map_or(Cell::Null, |v| Cell::Int(v as i64))
            } else if *t == Type::INT8 {
                r.get::<_, Option<i64>>(i).map_or(Cell::Null, Cell::Int)
            } else if *t == Type::FLOAT4 {
                r.get::<_, Option<f32>>(i).map_or(Cell::Null, |v| Cell::Float(v as f64))
            } else if *t == Type::FLOAT8 {
                r.get::<_, Option<f64>>(i).map_or(Cell::Null, Cell::Float)
            } else if *t == Type::DATE {
                r.get::<_, Option<NaiveDate>>(i)
                    .map_or(Cell::Null, |d| Cell::Timestamp(d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_micros()))
            } else if *t == Type::TIMESTAMP {
                r.get::<_, Option<NaiveDateTime>>(i).map_or(Cell::Null, |d| Cell::Timestamp(d.and_utc().timestamp_micros()))
            } else if *t == Type::TIMESTAMPTZ {
                r.get::<_, Option<DateTime<Utc>>>(i).map_or(Cell::Null, |d| Cell::Timestamp(d.timestamp_micros()))
            } else {
                r.get::<_, Option<String>>(i).map_or(Cell::Null, Cell::Text)
            });
        }
        out.push(row);
    }
    Ok(RawTable { columns: names, rows: out })
}
