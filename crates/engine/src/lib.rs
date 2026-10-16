//! DuckDB-backed data store and importers. The UI never computes data itself; it asks this crate.
pub mod creds;
pub mod dax_bridge;
pub mod m_bridge;
pub mod error;
pub mod sources;
pub mod types;

pub use creds::{CredentialStore, MemoryCredentialStore, SystemCredentialStore};
pub use error::{EngineError, Result};
pub use types::*;

use duckdb::Connection;
use sources::q;
use std::path::Path;

const STAGE: &str = "__biforge_stage";

pub struct Engine {
    conn: Connection,
    /// Identifies this store (a new project gets a new id), so cached DAX engines are never reused across stores.
    id: u64,
    /// Bumped by every change of the stored data made through this type (import, refresh, drop).
    version: std::sync::atomic::AtomicU64,
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn check_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.contains(['\r', '\n', '\t']) || name.starts_with("__biforge") {
        return Err(EngineError::InvalidName(format!("\"{name}\" is not a valid table name.")));
    }
    Ok(())
}

fn require_file(path: &str) -> Result<()> {
    if Path::new(path).is_file() {
        Ok(())
    } else {
        Err(EngineError::FileNotFound(path.into()))
    }
}

impl Engine {
    fn with_conn(conn: Connection) -> Engine {
        Engine { conn, id: NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed), version: std::sync::atomic::AtomicU64::new(0) }
    }

    /// (store id, data version): changes whenever cached results derived from the data would be stale.
    pub fn data_stamp(&self) -> (u64, u64) {
        (self.id, self.version.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// Call after changing the data through `connection()` directly.
    pub fn data_changed(&self) {
        self.version.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn in_memory() -> Result<Engine> {
        Ok(Engine::with_conn(Connection::open_in_memory()?))
    }

    /// Opens (or creates) the project's data file.
    pub fn open(path: &Path) -> Result<Engine> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Ok(Engine::with_conn(Connection::open(path)?))
    }

    /// The underlying connection (for the DAX bridge).
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn has_table(&self, name: &str) -> Result<bool> {
        let n: i64 = self.conn.query_row(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'main' AND lower(table_name) = lower(?)",
            [name],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn table_names(&self) -> Result<Vec<String>> {
        let mut st = self.conn.prepare(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name NOT LIKE '__biforge%' ORDER BY 1",
        )?;
        let v = st.query_map([], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(v)
    }

    pub fn table_info(&self, name: &str) -> Result<TableInfo> {
        if !self.has_table(name)? {
            return Err(EngineError::NoSuchTable(name.into()));
        }
        let mut st = self.conn.prepare(&format!("DESCRIBE {}", q(name)))?;
        let columns = st
            .query_map([], |r| {
                let name: String = r.get(0)?;
                let t: String = r.get(1)?;
                Ok(ColumnInfo { name, bi_type: BiType::from_duckdb(&t), duckdb_type: t })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let row_count: i64 = self.conn.query_row(&format!("SELECT count(*) FROM {}", q(name)), [], |r| r.get(0))?;
        Ok(TableInfo { name: name.into(), columns, row_count: row_count as u64 })
    }

    pub fn drop_table(&self, name: &str) -> Result<()> {
        self.conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", q(name)))?;
        self.data_changed();
        Ok(())
    }

    /// Stores the result of a SELECT as table `name`; like `import`, a failing query leaves existing data intact.
    pub fn import_select(&self, name: &str, select_sql: &str) -> Result<TableInfo> {
        check_name(name)?;
        self.conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", q(STAGE)))?;
        if let Err(e) = self.conn.execute_batch(&format!("CREATE TABLE {} AS {select_sql}", q(STAGE))) {
            let _ = self.conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", q(STAGE)));
            return Err(e.into());
        }
        self.swap_stage(name)
    }

    /// Imports `spec` into table `name`. Used for both first import and refresh: the new data is built in a
    /// staging table and swapped in only on success, so a failed import/refresh leaves existing data intact.
    pub fn import(&self, name: &str, spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<TableInfo> {
        check_name(name)?;
        self.conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", q(STAGE)))?;
        if let Err(e) = self.build_stage(spec, creds) {
            let _ = self.conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", q(STAGE)));
            return Err(e);
        }
        self.swap_stage(name)
    }

    fn swap_stage(&self, name: &str) -> Result<TableInfo> {
        let swap = format!(
            "BEGIN; DROP TABLE IF EXISTS {t}; ALTER TABLE {s} RENAME TO {t}; COMMIT;",
            t = q(name),
            s = q(STAGE)
        );
        if let Err(e) = self.conn.execute_batch(&swap) {
            let _ = self.conn.execute_batch("ROLLBACK");
            let _ = self.conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", q(STAGE)));
            return Err(e.into());
        }
        self.data_changed();
        self.table_info(name)
    }

    fn build_stage(&self, spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<()> {
        let src_err = |what: &str, e: duckdb::Error| EngineError::Source(format!("Could not read {what}: {e}"));
        match spec {
            SourceSpec::Csv { path, delimiter, header } => {
                require_file(path)?;
                let mut opts = String::from("sample_size=-1");
                if let Some(d) = delimiter {
                    opts += &format!(", delim={}", lit(d));
                }
                if let Some(h) = header {
                    opts += &format!(", header={h}");
                }
                self.conn
                    .execute_batch(&format!("CREATE TABLE {} AS SELECT * FROM read_csv({}, {opts})", q(STAGE), lit(path)))
                    .map_err(|e| src_err(&format!("CSV file \"{path}\""), e))?;
                self.empty_text_fields_to_empty_string()
            }
            SourceSpec::Json { path } => {
                require_file(path)?;
                self.conn
                    .execute_batch(&format!("CREATE TABLE {} AS SELECT * FROM read_json_auto({})", q(STAGE), lit(path)))
                    .map_err(|e| src_err(&format!("JSON file \"{path}\""), e))
            }
            SourceSpec::Parquet { path } => {
                require_file(path)?;
                self.conn
                    .execute_batch(&format!("CREATE TABLE {} AS SELECT * FROM read_parquet({})", q(STAGE), lit(path)))
                    .map_err(|e| src_err(&format!("Parquet file \"{path}\""), e))
            }
            SourceSpec::Excel { path, sheet, header } => {
                let raw = sources::excel::read(path, sheet.as_deref(), *header)?;
                sources::load(&self.conn, STAGE, &raw)
            }
            SourceSpec::Sqlite { path, table } => {
                let raw = sources::sqlite_src::read(path, table)?;
                sources::load(&self.conn, STAGE, &raw)
            }
            SourceSpec::Postgres { .. } => {
                let raw = sources::postgres_src::read(spec, creds)?;
                sources::load(&self.conn, STAGE, &raw)
            }
            SourceSpec::SqlServer { .. } => {
                let raw = sources::sqlserver_src::read(spec, creds)?;
                sources::load(&self.conn, STAGE, &raw)
            }
        }
    }

    /// Power Query's CSV reader gives "" (not null) for an empty field of a text column, while numbers, dates and
    /// booleans become null. DuckDB reads every empty field as NULL, so text columns of the stage are fixed up.
    fn empty_text_fields_to_empty_string(&self) -> Result<()> {
        let mut st = self.conn.prepare(&format!("DESCRIBE {}", q(STAGE)))?;
        let text_cols = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|(_, t)| BiType::from_duckdb(t) == BiType::String)
            .map(|(n, _)| n)
            .collect::<Vec<_>>();
        for c in text_cols {
            self.conn.execute_batch(&format!("UPDATE {s} SET {c} = '' WHERE {c} IS NULL", s = q(STAGE), c = q(&c)))?;
        }
        Ok(())
    }

    fn require_column(&self, info: &TableInfo, column: &str) -> Result<()> {
        if info.columns.iter().any(|c| c.name == column) {
            Ok(())
        } else {
            Err(EngineError::NoSuchColumn { table: info.name.clone(), column: column.into() })
        }
    }

    /// One page of rows, optionally sorted. Stable: ties are broken by physical row order.
    pub fn fetch_page(&self, name: &str, offset: u64, limit: u64, sort: Option<&SortSpec>) -> Result<RowPage> {
        let info = self.table_info(name)?;
        let order = match sort {
            Some(s) => {
                self.require_column(&info, &s.column)?;
                format!(
                    "ORDER BY {} {} NULLS LAST, rowid",
                    q(&s.column),
                    if s.descending { "DESC" } else { "ASC" }
                )
            }
            None => "ORDER BY rowid".to_string(),
        };
        let select: Vec<String> = info.columns.iter().map(|c| format!("CAST({} AS VARCHAR)", q(&c.name))).collect();
        let sql = format!("SELECT {} FROM {} {order} LIMIT {limit} OFFSET {offset}", select.join(", "), q(name));
        let n = info.columns.len();
        let mut st = self.conn.prepare(&sql)?;
        let rows = st
            .query_map([], |r| (0..n).map(|i| r.get::<_, Option<String>>(i)).collect::<std::result::Result<Vec<_>, _>>())?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(RowPage { total: info.row_count, columns: info.columns, rows })
    }

    /// (rows, non-null count, distinct non-null count)
    pub fn column_stats(&self, table: &str, column: &str) -> Result<(u64, u64, u64)> {
        let info = self.table_info(table)?;
        self.require_column(&info, column)?;
        let c = q(column);
        let (rows, nonnull, distinct): (i64, i64, i64) = self.conn.query_row(
            &format!("SELECT count(*), count({c}), count(DISTINCT {c}) FROM {}", q(table)),
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        Ok((rows as u64, nonnull as u64, distinct as u64))
    }

    /// A column can be the "one" side of a relationship when its values (blank counted as a value) are unique.
    fn is_unique(&self, table: &str, column: &str) -> Result<bool> {
        let (rows, nonnull, distinct) = self.column_stats(table, column)?;
        let nulls = rows - nonnull;
        Ok(nulls <= 1 && distinct + nulls == rows)
    }

    /// Suggests cardinality for a relationship drawn from `from` to `to` by looking at the data.
    pub fn suggest_relationship(&self, from: (&str, &str), to: (&str, &str)) -> Result<RelationshipHint> {
        let from_unique = self.is_unique(from.0, from.1)?;
        let to_unique = self.is_unique(to.0, to.1)?;
        let cardinality = match (from_unique, to_unique) {
            (true, true) => Cardinality::OneToOne,
            (true, false) => Cardinality::OneToMany,
            (false, true) => Cardinality::ManyToOne,
            (false, false) => Cardinality::ManyToMany,
        };
        Ok(RelationshipHint { from_unique, to_unique, cardinality })
    }
}

/// Lists sheet names of an Excel workbook (for the import dialog).
pub fn excel_sheets(path: &str) -> Result<Vec<String>> {
    sources::excel::sheet_names(path)
}

/// Lists tables/views of a SQLite file (for the import dialog).
pub fn sqlite_tables(path: &str) -> Result<Vec<String>> {
    sources::sqlite_src::list_tables(path)
}

/// Lists tables of a PostgreSQL schema (for the import dialog).
pub fn postgres_tables(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Vec<String>> {
    sources::postgres_src::list_tables(spec, creds)
}

/// Lists tables of a SQL Server schema (for the import dialog).
pub fn sqlserver_tables(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Vec<String>> {
    sources::sqlserver_src::list_tables(spec, creds)
}

impl Engine {
    /// Raw connection for advanced callers and tests (e.g. exporting fixtures).
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}
