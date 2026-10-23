//! Runs M queries (crate `biforge-m`) on the DuckDB store: the backend that supplies sources, schemas and small reads,
//! and the entry points the app uses (analyze steps, preview a step, load a query into a table).
use crate::error::{EngineError, Result};
use crate::sources::{self, q};
use crate::types::{BiType, ColumnInfo, ColumnProfile, RowPage, TableInfo};
use crate::Engine;
use biforge_m::run::{ColumnOut, StepResult, TableSql};
use biforge_m::{Backend, SourceRequest};
use std::collections::BTreeMap;

pub struct MBackend<'a> {
    engine: &'a Engine,
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A string DuckDB never reads as NULL: Power Query's CSV reader keeps empty fields as empty text.
const NO_NULL: &str = "\u{1}biforge-null\u{1}";

impl<'a> MBackend<'a> {
    pub fn new(engine: &'a Engine) -> Self {
        MBackend { engine }
    }

    fn describe_inner(&self, sql: &str) -> Result<Vec<(String, String)>> {
        let mut st = self.engine.conn.prepare(&format!("DESCRIBE {sql}"))?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn file_stamp(path: &str) -> String {
        std::fs::metadata(path)
            .map(|m| {
                let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
                format!("{}_{}", m.len(), t)
            })
            .unwrap_or_default()
    }

    fn stage(&self, key: &str, make: impl FnOnce() -> Result<sources::RawTable>) -> Result<String> {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut h);
        let name = format!("__biforge_m_{:x}", h.finish());
        let exists: i64 = self.engine.conn.query_row(
            "SELECT count(*) FROM duckdb_tables() WHERE table_name = ? AND temporary",
            [&name],
            |r| r.get(0),
        )?;
        if exists == 0 {
            let raw = make()?;
            sources::load_as(&self.engine.conn, &name, &raw, true)?;
        }
        Ok(format!("SELECT * FROM {}", q(&name)))
    }

    fn csv(&self, path: &str, delimiter: &str, quote: &Option<String>) -> Result<String> {
        if !std::path::Path::new(path).is_file() {
            return Err(EngineError::FileNotFound(path.into()));
        }
        let q_opt = match quote {
            Some(qc) => format!("quote={}", lit(qc)),
            None => "quote=''".to_string(),
        };
        let read = format!(
            "read_csv({}, header=false, all_varchar=true, delim={}, {q_opt}, nullstr={}, sample_size=-1, null_padding=true)",
            lit(path),
            lit(delimiter),
            lit(NO_NULL)
        );
        let desc = self.describe_inner(&format!("SELECT * FROM {read}"))?;
        let cols: Vec<String> = desc.iter().enumerate().map(|(i, (n, _))| format!("{} AS {}", q(n), q(&format!("Column{}", i + 1)))).collect();
        Ok(format!("SELECT {} FROM {read}", cols.join(", ")))
    }

    fn folder(&self, path: &str, recursive: bool) -> Result<String> {
        fn walk(dir: &std::path::Path, recursive: bool, out: &mut Vec<std::path::PathBuf>) -> std::io::Result<()> {
            for e in std::fs::read_dir(dir)? {
                let e = e?;
                let p = e.path();
                if p.is_dir() {
                    if recursive {
                        walk(&p, recursive, out)?;
                    }
                } else {
                    out.push(p);
                }
            }
            Ok(())
        }
        let root = std::path::Path::new(path);
        if !root.is_dir() {
            return Err(EngineError::FileNotFound(path.into()));
        }
        let mut files = Vec::new();
        walk(root, recursive, &mut files)?;
        files.sort_by_key(|p| p.to_string_lossy().to_lowercase());
        let ts = |t: Option<std::time::SystemTime>| -> String {
            match t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()) {
                Some(d) => format!("TIMESTAMP '{}'", chrono::DateTime::from_timestamp(d.as_secs() as i64, 0).map(|x| x.naive_utc().to_string()).unwrap_or_default()),
                None => "CAST(NULL AS TIMESTAMP)".into(),
            }
        };
        let names = "Content, Name, Extension, \"Date accessed\", \"Date modified\", \"Date created\", Attributes, \"Folder Path\"";
        if files.is_empty() {
            return Ok(format!(
                "SELECT CAST(NULL AS VARCHAR) AS Content, CAST(NULL AS VARCHAR) AS Name, CAST(NULL AS VARCHAR) AS Extension, CAST(NULL AS TIMESTAMP) AS \"Date accessed\", CAST(NULL AS TIMESTAMP) AS \"Date modified\", CAST(NULL AS TIMESTAMP) AS \"Date created\", CAST(NULL AS VARCHAR) AS Attributes, CAST(NULL AS VARCHAR) AS \"Folder Path\" WHERE FALSE"
            ));
        }
        let rows: Vec<String> = files
            .iter()
            .map(|p| {
                let md = std::fs::metadata(p).ok();
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                let mut folder = p.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
                if !folder.ends_with(['\\', '/']) {
                    folder.push(std::path::MAIN_SEPARATOR);
                }
                format!(
                    "({}, {}, {}, {}, {}, {}, CAST(NULL AS VARCHAR), {})",
                    lit(&p.to_string_lossy()),
                    lit(&name),
                    lit(&ext),
                    ts(md.as_ref().and_then(|m| m.accessed().ok())),
                    ts(md.as_ref().and_then(|m| m.modified().ok())),
                    ts(md.as_ref().and_then(|m| m.created().ok())),
                    lit(&folder)
                )
            })
            .collect();
        Ok(format!("SELECT * FROM (VALUES {}) AS f({names})", rows.join(", ")))
    }
}

impl<'a> Backend for MBackend<'a> {
    fn describe(&self, sql: &str) -> std::result::Result<Vec<(String, String)>, String> {
        self.describe_inner(sql).map_err(|e| e.to_string())
    }

    fn rows(&self, sql: &str, limit: usize) -> std::result::Result<Vec<Vec<Option<String>>>, String> {
        let run = || -> Result<Vec<Vec<Option<String>>>> {
            let desc = self.describe_inner(sql)?;
            let sel: Vec<String> = desc.iter().map(|(n, _)| format!("CAST({} AS VARCHAR)", q(n))).collect();
            let n = desc.len();
            let wrapped = format!("SELECT {} FROM ({sql}) AS r LIMIT {limit}", sel.join(", "));
            let mut st = self.engine.conn.prepare(&wrapped)?;
            let rows = st
                .query_map([], |r| (0..n).map(|i| r.get::<_, Option<String>>(i)).collect::<std::result::Result<Vec<_>, _>>())?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        };
        run().map_err(|e| e.to_string())
    }

    fn source_sql(&self, req: &SourceRequest) -> std::result::Result<String, String> {
        let r: Result<String> = (|| match req {
            SourceRequest::Csv { path, delimiter, quote } => self.csv(path, delimiter, quote),
            SourceRequest::Parquet { path } => {
                if !std::path::Path::new(path).is_file() {
                    return Err(EngineError::FileNotFound(path.clone()));
                }
                Ok(format!("SELECT * FROM read_parquet({})", lit(path)))
            }
            SourceRequest::Json { path } => {
                if !std::path::Path::new(path).is_file() {
                    return Err(EngineError::FileNotFound(path.clone()));
                }
                Ok(format!("SELECT * FROM read_json_auto({})", lit(path)))
            }
            SourceRequest::Excel { path, sheet, index: _, header } => {
                let key = format!("xlsx|{path}|{}|{header}|{}", sheet.clone().unwrap_or_default(), Self::file_stamp(path));
                self.stage(&key, || sources::excel::read(path, sheet.as_deref(), *header))
            }
            SourceRequest::Sqlite { path, table } => {
                let key = format!("sqlite|{path}|{table}|{}", Self::file_stamp(path));
                self.stage(&key, || sources::sqlite_src::read(path, table))
            }
            SourceRequest::Folder { path, recursive } => self.folder(path, *recursive),
        })();
        r.map_err(|e| e.to_string())
    }

    fn excel_sheets(&self, path: &str) -> std::result::Result<Vec<String>, String> {
        sources::excel::sheet_names(path).map_err(|e| e.to_string())
    }
}

impl Engine {
    /// Result of each step of `query`: columns, or the error of that step.
    pub fn m_analyze(&self, queries: &BTreeMap<String, String>, query: &str) -> Result<Vec<StepResult>> {
        let be = MBackend::new(self);
        biforge_m::run::analyze_steps(&be, queries, query).map_err(|e| EngineError::Source(e.to_string()))
    }

    /// The SQL of a query result (or of one of its steps).
    pub fn m_table_sql(&self, queries: &BTreeMap<String, String>, query: &str, step: Option<&str>, limit: Option<usize>) -> Result<TableSql> {
        let be = MBackend::new(self);
        biforge_m::run::table_sql(&be, queries, query, step, limit).map_err(|e| EngineError::Source(e.to_string()))
    }

    pub fn m_query_kind(&self, queries: &BTreeMap<String, String>, query: &str) -> String {
        biforge_m::run::query_kind(&MBackend::new(self), queries, query)
    }

    /// First rows of a step for the preview grid.
    pub fn m_preview(&self, queries: &BTreeMap<String, String>, query: &str, step: Option<&str>, limit: usize) -> Result<RowPage> {
        let t = self.m_table_sql(queries, query, step, Some(limit))?;
        let n = t.columns.len();
        let sel: Vec<String> = t.columns.iter().map(|c| format!("CAST({} AS VARCHAR)", q(&c.name))).collect();
        let sql = if sel.is_empty() { "SELECT 0 WHERE FALSE".to_string() } else { format!("SELECT {} FROM ({}) AS p", sel.join(", "), t.sql) };
        let mut st = self.conn.prepare(&sql)?;
        let rows = st
            .query_map([], |r| (0..n).map(|i| r.get::<_, Option<String>>(i)).collect::<std::result::Result<Vec<_>, _>>())?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let total = if rows.len() < limit {
            rows.len() as u64
        } else {
            let full = self.m_table_sql(queries, query, step, None)?;
            self.conn.query_row(&format!("SELECT count(*) FROM ({}) AS c", full.sql), [], |r| r.get::<_, i64>(0))? as u64
        };
        let columns = t.columns.iter().map(col_info).collect();
        Ok(RowPage { columns, rows, total })
    }

    /// Statistics of every column of a step, over its first `limit` rows (all rows when `limit` is None): Power Query's
    /// column quality, distribution and profile.
    pub fn m_profile(&self, queries: &BTreeMap<String, String>, query: &str, step: Option<&str>, limit: Option<usize>) -> Result<Vec<ColumnProfile>> {
        let t = self.m_table_sql(queries, query, step, limit)?;
        let mut out = Vec::new();
        for c in &t.columns {
            let col = q(&c.name);
            let bi = BiType::from_duckdb(&c.duckdb_type);
            let text = bi == BiType::String;
            let numeric = matches!(bi, BiType::Int64 | BiType::Double | BiType::Decimal);
            let src = format!("(SELECT {col} AS v FROM ({}) AS p) AS s", t.sql);
            let empty_expr = if text { "count(*) FILTER (WHERE v IS NULL OR CAST(v AS VARCHAR) = '')" } else { "count(*) FILTER (WHERE v IS NULL)" };
            let stats = if numeric { "avg(CAST(v AS DOUBLE)), stddev_samp(CAST(v AS DOUBLE))" } else { "CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE)" };
            let sql = format!(
                "SELECT count(*), {empty_expr}, count(DISTINCT v), CAST(min(v) AS VARCHAR), CAST(max(v) AS VARCHAR), {stats} FROM {src}"
            );
            let (rows, empty, distinct, min, max, average, std_dev) = self.conn.query_row(&sql, [], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<f64>>(5)?, r.get::<_, Option<f64>>(6)?))
            })?;
            let unique = self.conn.query_row(&format!("SELECT count(*) FROM (SELECT v FROM {src} WHERE v IS NOT NULL GROUP BY v HAVING count(*) = 1)"), [], |r| r.get::<_, i64>(0))?;
            let mut st = self.conn.prepare(&format!("SELECT CAST(v AS VARCHAR), count(*) AS c FROM {src} GROUP BY v ORDER BY c DESC, v LIMIT 20"))?;
            let top = st.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)? as u64)))?.collect::<std::result::Result<Vec<_>, _>>()?;
            out.push(ColumnProfile {
                name: c.name.clone(),
                duckdb_type: c.duckdb_type.clone(),
                rows: rows as u64,
                valid: (rows - empty) as u64,
                empty: empty as u64,
                error: 0,
                distinct: distinct as u64,
                unique: unique as u64,
                min,
                max,
                average,
                std_dev,
                top,
                rows_limited: limit.is_some_and(|l| rows as usize >= l),
            });
        }
        Ok(out)
    }

    /// Runs the query and stores its result as table `name` (replacing the old data only when the query succeeds).
    pub fn m_load(&self, queries: &BTreeMap<String, String>, query: &str, name: &str) -> Result<TableInfo> {
        let t = self.m_table_sql(queries, query, None, None)?;
        self.import_select(name, &t.sql)
    }
}

fn col_info(c: &ColumnOut) -> ColumnInfo {
    ColumnInfo { name: c.name.clone(), duckdb_type: c.duckdb_type.clone(), bi_type: BiType::from_duckdb(&c.duckdb_type) }
}
