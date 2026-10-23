//! Connects the DuckDB store to the DAX engine: loads model tables as DAX values and runs the SQL the DAX
//! engine compiles for aggregations.

use crate::sources::q;
use crate::types::BiType;
use crate::Engine;
use biforge_dax::model::{DataType, Model, TableId};
use biforge_dax::sql::SqlExecutor;
use biforge_dax::value::{micros_to_serial, Value, CURRENCY_SCALE};
use duckdb::types::ValueRef;

/// The DAX data type used for a column imported with this type.
pub fn dax_type(t: BiType) -> DataType {
    match t {
        BiType::Int64 => DataType::Int64,
        BiType::Double => DataType::Double,
        BiType::Decimal => DataType::Decimal,
        BiType::Boolean => DataType::Boolean,
        BiType::DateTime => DataType::DateTime,
        BiType::String => DataType::String,
        BiType::Binary => DataType::Binary,
    }
}

fn to_value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Blank,
        ValueRef::Boolean(b) => Value::Bool(b),
        ValueRef::TinyInt(x) => Value::Int(x as i64),
        ValueRef::SmallInt(x) => Value::Int(x as i64),
        ValueRef::Int(x) => Value::Int(x as i64),
        ValueRef::BigInt(x) => Value::Int(x),
        ValueRef::HugeInt(x) => i64::try_from(x).map(Value::Int).unwrap_or(Value::Double(x as f64)),
        ValueRef::UHugeInt(x) => i64::try_from(x).map(Value::Int).unwrap_or(Value::Double(x as f64)),
        ValueRef::UTinyInt(x) => Value::Int(x as i64),
        ValueRef::USmallInt(x) => Value::Int(x as i64),
        ValueRef::UInt(x) => Value::Int(x as i64),
        ValueRef::UBigInt(x) => i64::try_from(x).map(Value::Int).unwrap_or(Value::Double(x as f64)),
        ValueRef::Float(x) => Value::Double(x as f64),
        ValueRef::Double(x) => Value::Double(x),
        ValueRef::Decimal(d) => {
            let f: f64 = d.to_string().parse().unwrap_or(f64::NAN);
            Value::Currency((f * CURRENCY_SCALE as f64).round() as i64)
        }
        ValueRef::Timestamp(unit, x) => Value::DateTime(micros_to_serial(unit.to_micros(x))),
        ValueRef::Date32(days) => Value::DateTime(days as f64 + 25569.0),
        ValueRef::Time64(unit, x) => Value::DateTime(unit.to_micros(x) as f64 / 86_400_000_000.0),
        ValueRef::Text(t) => Value::str(&String::from_utf8_lossy(t)),
        ValueRef::Blob(_) | ValueRef::Geometry(_) => Value::Blank,
        other => Value::str(&format!("{other:?}")),
    }
}

/// The stored name of a table (case-insensitive match) and its column names, or None when the store has no such table.
fn stored_table(conn: &duckdb::Connection, name: &str) -> Result<Option<(String, Vec<String>)>, String> {
    let found: Option<String> = conn
        .query_row("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND lower(table_name) = lower(?) LIMIT 1", [name], |r| r.get(0))
        .ok();
    let Some(stored) = found else { return Ok(None) };
    let mut st = conn.prepare(&format!("DESCRIBE {}", q(&stored))).map_err(|e| e.to_string())?;
    let cols = st.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(Some((stored, cols)))
}

/// Reads stored columns of a model table in model order (only model column `only` when given). A model table with no
/// data in the store loads empty. Rows come in insertion order (DuckDB keeps it for a plain scan).
fn read_columns(conn: &duckdb::Connection, model: &Model, table: TableId, only: Option<usize>) -> Result<Vec<Vec<Value>>, String> {
    let t = &model.tables[table];
    let base: Vec<&str> = t
        .columns
        .iter()
        .enumerate()
        .filter(|(i, c)| c.expression.is_none() && only.is_none_or(|o| o == *i))
        .map(|(_, c)| c.name.as_str())
        .collect();
    let Some((stored, have)) = stored_table(conn, &t.name)? else { return Ok(vec![Vec::new(); base.len()]) };
    let mut select = Vec::with_capacity(base.len());
    for c in &base {
        let found = have.iter().find(|x| x.eq_ignore_ascii_case(c)).ok_or_else(|| format!("Column '{}'[{c}] has no data in the store; refresh the table.", t.name))?;
        select.push(q(found));
    }
    let rows_hint: i64 = conn.query_row(&format!("SELECT count(*) FROM {}", q(&stored)), [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let sql = format!("SELECT {} FROM {}", if select.is_empty() { "1".into() } else { select.join(", ") }, q(&stored));
    let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = st.query([]).map_err(|e| e.to_string())?;
    let mut cols = vec![Vec::with_capacity(rows_hint as usize); base.len()];
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        for (i, col) in cols.iter_mut().enumerate() {
            col.push(to_value(r.get_ref(i).map_err(|e| e.to_string())?));
        }
    }
    Ok(cols)
}

fn stored_row_count(conn: &duckdb::Connection, model: &Model, table: TableId) -> Result<usize, String> {
    let Some((stored, _)) = stored_table(conn, &model.tables[table].name)? else { return Ok(0) };
    let n: i64 = conn.query_row(&format!("SELECT count(*) FROM {}", q(&stored)), [], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(n as usize)
}

impl biforge_dax::DataSource for Engine {
    fn load_table(&self, model: &Model, table: TableId) -> Result<Vec<Vec<Value>>, String> {
        read_columns(self.conn(), model, table, None)
    }
    fn row_count(&self, model: &Model, table: TableId) -> Result<usize, String> {
        stored_row_count(self.conn(), model, table)
    }
    fn load_column(&self, model: &Model, table: TableId, column: usize) -> Result<Vec<Value>, String> {
        Ok(read_columns(self.conn(), model, table, Some(column))?.pop().unwrap_or_default())
    }
}

/// Reads columns for a DAX engine that outlives the call that made it: it owns its own connection to the same
/// database, so the DAX engine can read a column the first time a query uses it (see `ModelData::load_lazy`).
pub struct StoreLoader {
    conn: std::sync::Mutex<duckdb::Connection>,
}

impl StoreLoader {
    pub fn new(store: &Engine) -> Result<StoreLoader, String> {
        Ok(StoreLoader { conn: std::sync::Mutex::new(store.conn().try_clone().map_err(|e| e.to_string())?) })
    }
    fn with<T>(&self, f: impl FnOnce(&duckdb::Connection) -> Result<T, String>) -> Result<T, String> {
        let g = self.conn.lock().map_err(|_| "The data store is unavailable.".to_string())?;
        f(&g)
    }
}

impl biforge_dax::DataSource for StoreLoader {
    fn load_table(&self, model: &Model, table: TableId) -> Result<Vec<Vec<Value>>, String> {
        self.with(|c| read_columns(c, model, table, None))
    }
    fn row_count(&self, model: &Model, table: TableId) -> Result<usize, String> {
        self.with(|c| stored_row_count(c, model, table))
    }
    fn load_column(&self, model: &Model, table: TableId, column: usize) -> Result<Vec<Value>, String> {
        Ok(self.with(|c| read_columns(c, model, table, Some(column)))?.pop().unwrap_or_default())
    }
}

impl SqlExecutor for Engine {
    fn query_scalar(&self, sql: &str) -> Result<Value, String> {
        let mut st = self.conn().prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = st.query([]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(to_value(r.get_ref(0).map_err(|e| e.to_string())?)),
            None => Ok(Value::Blank),
        }
    }

    fn query_rows(&self, sql: &str) -> Result<Vec<Vec<Value>>, String> {
        let mut st = self.conn().prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = st.query([]).map_err(|e| e.to_string())?;
        let n = rows.as_ref().map(|s| s.column_count()).unwrap_or(0);
        let mut out = Vec::new();
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            out.push((0..n).map(|i| r.get_ref(i).map(to_value)).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?);
        }
        Ok(out)
    }
}

/// The DuckDB type that holds all of `values` (a calculated column or table has no declared type).
pub fn infer_sql_type(values: &[Value]) -> &'static str {
    let mut kind: Option<&'static str> = None;
    for v in values {
        let k = match v {
            Value::Blank => continue,
            Value::Bool(_) => "BOOLEAN",
            Value::Int(_) => "BIGINT",
            Value::Double(_) | Value::Currency(_) => "DOUBLE",
            Value::DateTime(_) => "TIMESTAMP",
            Value::Str(_) => "VARCHAR",
        };
        kind = match (kind, k) {
            (None, k) => Some(k),
            (Some(a), b) if a == b => Some(a),
            (Some("BIGINT"), "DOUBLE") | (Some("DOUBLE"), "BIGINT") => Some("DOUBLE"),
            _ => Some("VARCHAR"),
        };
    }
    kind.unwrap_or("VARCHAR")
}

fn to_duck(v: &Value, ty: &str) -> duckdb::types::Value {
    use duckdb::types::{TimeUnit, Value as D};
    match (v, ty) {
        (Value::Blank, _) => D::Null,
        (_, "VARCHAR") => D::Text(v.to_text()),
        (Value::Bool(b), _) => D::Boolean(*b),
        (Value::Int(i), "DOUBLE") => D::Double(*i as f64),
        (Value::Int(i), _) => D::BigInt(*i),
        (Value::Double(f), _) => D::Double(*f),
        (Value::Currency(c), _) => D::Double(*c as f64 / CURRENCY_SCALE as f64),
        (Value::DateTime(serial), _) => D::Timestamp(TimeUnit::Microsecond, ((serial - 25569.0) * 86_400_000_000.0).round() as i64),
        (Value::Str(s), _) => D::Text(s.to_string()),
    }
}

impl Engine {
    /// Stores the rows of a DAX table expression as table `name` (a calculated table), replacing it. The column names
    /// are the names without `Table[...]`; types are inferred from the values.
    pub fn store_calculated_table(&self, name: &str, headers: &[String], rows: &[Vec<Value>]) -> crate::Result<crate::TableInfo> {
        let names: Vec<String> = headers
            .iter()
            .map(|h| match (h.find('['), h.rfind(']')) {
                (Some(a), Some(b)) if b > a => h[a + 1..b].to_string(),
                _ => h.clone(),
            })
            .collect();
        let types: Vec<&'static str> = (0..names.len()).map(|c| infer_sql_type(&rows.iter().map(|r| r[c].clone()).collect::<Vec<_>>())).collect();
        let stage = format!("__biforge_stage_{name}");
        self.conn().execute_batch(&format!("DROP TABLE IF EXISTS {}", q(&stage)))?;
        let cols: Vec<String> = names.iter().zip(&types).map(|(n, t)| format!("{} {t}", q(n))).collect();
        self.conn().execute_batch(&format!("CREATE TABLE {} ({})", q(&stage), cols.join(", ")))?;
        {
            let mut app = self.conn().appender(&stage)?;
            for r in rows {
                let vals: Vec<duckdb::types::Value> = r.iter().zip(&types).map(|(v, t)| to_duck(v, t)).collect();
                app.append_row(duckdb::appender_params_from_iter(vals))?;
            }
            app.flush()?;
        }
        self.conn().execute_batch(&format!("DROP TABLE IF EXISTS {0}; ALTER TABLE {1} RENAME TO {0}", q(name), q(&stage)))?;
        self.data_changed();
        self.table_info(name)
    }

    /// Writes the computed values of a calculated column into the table (so the Table view shows them). Replaces the column if it exists.
    pub fn store_calculated_column(&self, table: &str, column: &str, values: &[Value]) -> crate::Result<()> {
        let ty = infer_sql_type(values);
        let c = self.conn();
        c.execute_batch(&format!("ALTER TABLE {} DROP COLUMN IF EXISTS {}; ALTER TABLE {0} ADD COLUMN {1} {ty}", q(table), q(column)))?;
        c.execute_batch("DROP TABLE IF EXISTS __biforge_calc")?;
        c.execute_batch(&format!("CREATE TEMP TABLE __biforge_calc (i BIGINT, v {ty})"))?;
        {
            let mut app = c.appender("__biforge_calc")?;
            for (i, v) in values.iter().enumerate() {
                app.append_row(duckdb::appender_params_from_iter(vec![duckdb::types::Value::BigInt(i as i64), to_duck(v, ty)]))?;
            }
            app.flush()?;
        }
        c.execute_batch(&format!("UPDATE {} SET {} = __biforge_calc.v FROM __biforge_calc WHERE {0}.rowid = __biforge_calc.i; DROP TABLE __biforge_calc", q(table), q(column)))?;
        self.data_changed();
        Ok(())
    }
}

/// Keeps the last loaded DAX engine (the model's tables read from the store) so that a report page with many
/// visuals, or repeated interactions, does not reload every table for every query. The engine is reused while the
/// model text and the stored data are unchanged.
#[derive(Default)]
pub struct DaxCache {
    slot: std::sync::Mutex<Option<CacheSlot>>,
    loads: std::sync::atomic::AtomicU64,
}

struct CacheSlot {
    model_key: u64,
    stamp: (u64, u64),
    engine: std::sync::Arc<biforge_dax::Engine>,
}

impl DaxCache {
    /// The loaded engine for `model_key` (a hash of the model text) over `store`; `build` makes the model on a miss.
    pub fn get(&self, model_key: u64, store: &Engine, build: impl FnOnce() -> Result<Model, String>) -> Result<std::sync::Arc<biforge_dax::Engine>, String> {
        let stamp = store.data_stamp();
        let mut slot = self.slot.lock().map_err(|_| "The DAX cache is unavailable.".to_string())?;
        if let Some(s) = slot.as_ref() {
            if s.model_key == model_key && s.stamp == stamp {
                return Ok(s.engine.clone());
            }
        }
        let loader: std::sync::Arc<dyn biforge_dax::DataSource + Send + Sync> = std::sync::Arc::new(StoreLoader::new(store)?);
        let engine = std::sync::Arc::new(biforge_dax::Engine::new_lazy(build()?, loader)?);
        self.loads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *slot = Some(CacheSlot { model_key, stamp, engine: engine.clone() });
        Ok(engine)
    }

    /// Like [`DaxCache::get`], for an engine that `build` makes itself (for example one that only sees the rows of some
    /// roles); `key` must include whatever `build` depends on besides the data.
    pub fn get_built(&self, key: u64, store: &Engine, build: impl FnOnce() -> Result<biforge_dax::Engine, String>) -> Result<std::sync::Arc<biforge_dax::Engine>, String> {
        let stamp = store.data_stamp();
        let mut slot = self.slot.lock().map_err(|_| "The DAX cache is unavailable.".to_string())?;
        if let Some(s) = slot.as_ref() {
            if s.model_key == key && s.stamp == stamp {
                return Ok(s.engine.clone());
            }
        }
        let engine = std::sync::Arc::new(build()?);
        self.loads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *slot = Some(CacheSlot { model_key: key, stamp, engine: engine.clone() });
        Ok(engine)
    }

    /// How many times an engine was loaded (cache misses).
    pub fn loads(&self) -> u64 {
        self.loads.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn clear(&self) {
        if let Ok(mut s) = self.slot.lock() {
            *s = None;
        }
    }
}
