//! Column data for the engine, loaded once from a `DataSource` (DuckDB in the app, memory in tests).
//! Calculated columns are computed by the evaluator after the base columns are loaded.
//!
//! Row indexes are `u32`. Each table has a virtual *blank row* at index `nrows` that exists when a
//! many-to-one relationship has many-side keys with no match on the one side (see `has_blank_row`).

use crate::model::{Cardinality, ColId, Model, TableId};
use crate::value::{Key, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/// Loads base (non-calculated) columns of a table, in the model's column order, column-major.
pub trait DataSource {
    fn load_table(&self, model: &Model, table: TableId) -> Result<Vec<Vec<Value>>, String>;

    /// Number of rows of the table (the default loads it).
    fn row_count(&self, model: &Model, table: TableId) -> Result<usize, String> {
        Ok(self.load_table(model, table)?.first().map(|c| c.len()).unwrap_or(0))
    }

    /// One stored column, by its index among the table's model columns (the default loads the whole table).
    fn load_column(&self, model: &Model, table: TableId, column: usize) -> Result<Vec<Value>, String> {
        let pos = model.tables[table].columns.iter().take(column).filter(|c| c.expression.is_none()).count();
        let mut cols = self.load_table(model, table)?;
        if pos >= cols.len() {
            return Err(format!("Table '{}' has no stored column at position {column}.", model.tables[table].name));
        }
        Ok(cols.swap_remove(pos))
    }
}

/// Row-major test/data source keyed by table name (case-insensitive).
#[derive(Default, Clone)]
pub struct MemorySource {
    tables: HashMap<String, Vec<Vec<Value>>>,
}

impl MemorySource {
    pub fn new() -> MemorySource {
        MemorySource::default()
    }
    /// Rows in base-column order (calculated columns excluded).
    pub fn with_rows(mut self, table: &str, rows: Vec<Vec<Value>>) -> MemorySource {
        self.tables.insert(table.to_lowercase(), rows);
        self
    }
}

impl DataSource for MemorySource {
    fn load_table(&self, model: &Model, table: TableId) -> Result<Vec<Vec<Value>>, String> {
        let t = &model.tables[table];
        let ncols = t.columns.iter().filter(|c| c.expression.is_none()).count();
        let rows = self.tables.get(&t.name.to_lowercase()).cloned().unwrap_or_default();
        let mut cols = vec![Vec::with_capacity(rows.len()); ncols];
        for (i, r) in rows.into_iter().enumerate() {
            if r.len() != ncols {
                return Err(format!("Row {} of table '{}' has {} values; expected {ncols}.", i + 1, t.name, r.len()));
            }
            for (c, v) in r.into_iter().enumerate() {
                cols[c].push(v);
            }
        }
        Ok(cols)
    }
}

pub struct TableData {
    pub nrows: usize,
    /// One slot per model column: filled when the column is first read (a model loaded lazily) or at load time;
    /// calculated columns are filled in after evaluation.
    columns: Vec<OnceLock<Arc<Vec<Value>>>>,
    dup_groups: OnceLock<Vec<Arc<Vec<u32>>>>,
}

/// Lookup indexes for one relationship.
pub struct RelIndex {
    /// For each `from` row: the matching `to` row, or `to` table's blank-row index.
    pub fwd: Vec<u32>,
    /// For each `to` row: one matching `from` row (exact for one-to-one), or the `from` blank-row index.
    pub rev: Vec<u32>,
    pub has_orphans: bool,
    /// One-side key values that appear more than once (a model error for many-to-one).
    pub duplicate_keys: usize,
}

pub struct ModelData {
    pub model: Model,
    pub tables: Vec<TableData>,
    rel_index: Vec<OnceLock<Arc<RelIndex>>>,
    blank_rows: OnceLock<Vec<bool>>,
    /// What USERNAME() and USERPRINCIPALNAME() return (set by the host for row-level security).
    pub identity: String,
    /// Where columns are read from when first used (None: everything was loaded up front).
    source: Option<Arc<dyn DataSource + Send + Sync>>,
    /// The first error a lazy column load hit (its values are BLANK); the query that used it reports it.
    load_error: std::sync::Mutex<Option<String>>,
}

/// The Windows user name, used for USERNAME() when no identity is set (desktop use, no sign-in).
fn default_identity() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default()
}

impl ModelData {
    /// Loads base columns. Calculated columns are left blank; `crate::eval::Engine::new` computes them.
    pub fn load(model: Model, source: &dyn DataSource) -> Result<ModelData, String> {
        let mut tables = Vec::with_capacity(model.tables.len());
        for (t, def) in model.tables.iter().enumerate() {
            let base = source.load_table(&model, t)?;
            let nrows = base.first().map(|c| c.len()).unwrap_or(0);
            let mut base = base.into_iter();
            let mut columns = Vec::with_capacity(def.columns.len());
            for c in &def.columns {
                if c.expression.is_some() {
                    columns.push(OnceLock::from(Arc::new(vec![Value::Blank; nrows])));
                } else {
                    let mut v = base.next().ok_or_else(|| format!("Table '{}' is missing data for column '{}'.", def.name, c.name))?;
                    if v.len() != nrows {
                        return Err(format!("Column '{}'[{}] has {} values; expected {nrows}.", def.name, c.name, v.len()));
                    }
                    unify_text_case(&mut v);
                    columns.push(OnceLock::from(Arc::new(v)));
                }
            }
            tables.push(TableData { nrows, columns, dup_groups: OnceLock::new() });
        }
        let rel_index = (0..model.relationships.len()).map(|_| OnceLock::new()).collect();
        Ok(ModelData { model, tables, rel_index, blank_rows: OnceLock::new(), identity: default_identity(), source: None, load_error: std::sync::Mutex::new(None) })
    }

    /// Like `load`, but a column is read from `source` the first time it is used: a query that touches 4 of the 10
    /// columns of a 10 million row table reads those 4. Only the row counts are read here.
    pub fn load_lazy(model: Model, source: Arc<dyn DataSource + Send + Sync>) -> Result<ModelData, String> {
        let mut tables = Vec::with_capacity(model.tables.len());
        for (t, def) in model.tables.iter().enumerate() {
            let nrows = source.row_count(&model, t)?;
            let columns = def.columns.iter().map(|c| if c.expression.is_some() { OnceLock::from(Arc::new(vec![Value::Blank; nrows])) } else { OnceLock::new() }).collect();
            tables.push(TableData { nrows, columns, dup_groups: OnceLock::new() });
        }
        let rel_index = (0..model.relationships.len()).map(|_| OnceLock::new()).collect();
        Ok(ModelData { model, tables, rel_index, blank_rows: OnceLock::new(), identity: default_identity(), source: Some(source), load_error: std::sync::Mutex::new(None) })
    }

    /// A copy of the loaded data over `model`, which is this model with calculated columns added at the end of tables (the new columns are
    /// BLANK until they are computed). The values already loaded are shared, not copied.
    pub fn with_model(&self, model: Model) -> ModelData {
        let tables = self
            .tables
            .iter()
            .enumerate()
            .map(|(t, td)| {
                let mut columns: Vec<OnceLock<Arc<Vec<Value>>>> = td.columns.iter().map(|s| s.get().map(|a| OnceLock::from(a.clone())).unwrap_or_default()).collect();
                for _ in td.columns.len()..model.tables[t].columns.len() {
                    columns.push(OnceLock::from(Arc::new(vec![Value::Blank; td.nrows])));
                }
                TableData { nrows: td.nrows, columns, dup_groups: OnceLock::new() }
            })
            .collect();
        let rel_index = (0..model.relationships.len()).map(|_| OnceLock::new()).collect();
        ModelData { model, tables, rel_index, blank_rows: OnceLock::new(), identity: self.identity.clone(), source: self.source.clone(), load_error: std::sync::Mutex::new(None) }
    }

    /// The values of a column (read from the source on first use).
    pub fn column_values(&self, c: ColId) -> &Arc<Vec<Value>> {
        let t = &self.tables[c.table];
        t.columns[c.col].get_or_init(|| {
            let loaded = match &self.source {
                Some(s) => s.load_column(&self.model, c.table, c.col),
                None => Err("The column was not loaded.".to_string()),
            };
            match loaded {
                Ok(mut v) if v.len() == t.nrows => {
                    unify_text_case(&mut v);
                    Arc::new(v)
                }
                other => {
                    let msg = match other {
                        Ok(v) => format!("Column {} has {} values; expected {}.", self.model.column_name(c), v.len(), t.nrows),
                        Err(e) => e,
                    };
                    if let Ok(mut g) = self.load_error.lock() {
                        g.get_or_insert(msg);
                    }
                    Arc::new(vec![Value::Blank; t.nrows])
                }
            }
        })
    }

    /// Takes the first error a lazy column load hit, if any.
    pub fn take_load_error(&self) -> Option<String> {
        self.load_error.lock().ok().and_then(|mut g| g.take())
    }

    /// Rows with identical values in every column, per row (context transition filters by value, so
    /// duplicate rows are selected together).
    pub fn dup_group(&self, table: TableId, row: u32) -> Arc<Vec<u32>> {
        let t = &self.tables[table];
        let groups = t.dup_groups.get_or_init(|| {
            let cols: Vec<&Arc<Vec<Value>>> = (0..t.columns.len()).map(|col| self.column_values(ColId { table, col })).collect();
            let mut members: HashMap<Vec<Key>, Vec<u32>> = HashMap::new();
            for r in 0..t.nrows {
                members.entry(cols.iter().map(|c| c[r].key()).collect::<Vec<_>>()).or_default().push(r as u32);
            }
            let mut out = vec![Arc::new(Vec::new()); t.nrows];
            for (_, rows) in members {
                let a = Arc::new(rows);
                for &r in a.iter() {
                    out[r as usize] = a.clone();
                }
            }
            out
        });
        if row as usize >= t.nrows {
            Arc::new(vec![row])
        } else {
            groups[row as usize].clone()
        }
    }

    /// Replaces a calculated column's values (used while processing calculated columns).
    pub fn set_column(&mut self, c: ColId, values: Vec<Value>) {
        let mut values = values;
        unify_text_case(&mut values);
        self.tables[c.table].columns[c.col] = OnceLock::from(Arc::new(values));
        self.tables[c.table].dup_groups = OnceLock::new();
        for i in &mut self.rel_index {
            *i = OnceLock::new();
        }
        self.blank_rows = OnceLock::new();
    }

    pub fn nrows(&self, t: TableId) -> usize {
        self.tables[t].nrows
    }

    pub fn value(&self, c: ColId, row: u32) -> &Value {
        static BLANK: Value = Value::Blank;
        if row as usize >= self.tables[c.table].nrows {
            &BLANK
        } else {
            &self.column_values(c)[row as usize]
        }
    }

    pub fn rel(&self, r: usize) -> Arc<RelIndex> {
        self.rel_index[r]
            .get_or_init(|| {
                let rel = &self.model.relationships[r];
                let (ft, tt) = (rel.from.table, rel.to.table);
                let to_blank = self.nrows(tt) as u32;
                let from_blank = self.nrows(ft) as u32;
                let mut key_to_row: HashMap<Key, u32> = HashMap::new();
                let mut duplicate_keys = 0;
                for row in 0..self.nrows(tt) {
                    let v = self.value(rel.to, row as u32);
                    if v.is_blank() {
                        continue;
                    }
                    if key_to_row.insert(v.key(), row as u32).is_some() && rel.cardinality != Cardinality::ManyToMany {
                        duplicate_keys += 1;
                    }
                }
                let mut has_orphans = false;
                let mut rev = vec![from_blank; self.nrows(tt)];
                let fwd = (0..self.nrows(ft))
                    .map(|row| {
                        let v = self.value(rel.from, row as u32);
                        match key_to_row.get(&v.key()).filter(|_| !v.is_blank()) {
                            Some(&to) => {
                                if rev[to as usize] == from_blank {
                                    rev[to as usize] = row as u32;
                                }
                                to
                            }
                            None => {
                                has_orphans = true;
                                to_blank
                            }
                        }
                    })
                    .collect();
                Arc::new(RelIndex { fwd, rev, has_orphans, duplicate_keys })
            })
            .clone()
    }

    /// True when the table gets a virtual blank row: a many-to-one relationship into it, active or not, has
    /// many-side values with no match (including BLANK keys). Recorded from Power BI: an inactive relationship
    /// with orphans also adds the blank row (VALUES(Date) has one more row than the table).
    pub fn has_blank_row(&self, t: TableId) -> bool {
        self.blank_rows.get_or_init(|| {
            let mut v = vec![false; self.model.tables.len()];
            for (i, r) in self.model.relationships.iter().enumerate() {
                if r.cardinality == Cardinality::ManyToOne && self.rel(i).has_orphans {
                    v[r.to.table] = true;
                }
            }
            v
        })[t]
    }
}

/// The storage engine keeps one spelling per text value ignoring case: the first one seen.
fn unify_text_case(v: &mut [Value]) {
    let mut first: HashMap<String, Arc<str>> = HashMap::new();
    for x in v.iter_mut() {
        if let Value::Str(s) = x {
            let k = s.to_lowercase();
            match first.get(&k) {
                Some(f) if **f != **s => *x = Value::Str(f.clone()),
                Some(_) => {}
                None => {
                    first.insert(k, s.clone());
                }
            }
        }
    }
}
