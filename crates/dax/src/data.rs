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
    /// One entry per model column (calculated columns filled in after evaluation).
    pub columns: Vec<Arc<Vec<Value>>>,
    dup_groups: OnceLock<Vec<Arc<Vec<u32>>>>,
}

impl TableData {
    pub fn value(&self, col: usize, row: u32) -> &Value {
        static BLANK: Value = Value::Blank;
        if row as usize >= self.nrows {
            &BLANK
        } else {
            &self.columns[col][row as usize]
        }
    }

    /// Rows with identical values in every column, per row (context transition filters by value, so
    /// duplicate rows are selected together).
    pub fn dup_group(&self, row: u32) -> Arc<Vec<u32>> {
        let groups = self.dup_groups.get_or_init(|| {
            let mut by_key: HashMap<Vec<Key>, Arc<Vec<u32>>> = HashMap::new();
            let mut members: HashMap<Vec<Key>, Vec<u32>> = HashMap::new();
            let key = |r: usize| self.columns.iter().map(|c| c[r].key()).collect::<Vec<_>>();
            for r in 0..self.nrows {
                members.entry(key(r)).or_default().push(r as u32);
            }
            let mut out = vec![Arc::new(Vec::new()); self.nrows];
            for (k, rows) in members {
                let a = Arc::new(rows);
                for &r in a.iter() {
                    out[r as usize] = a.clone();
                }
                by_key.insert(k, a);
            }
            out
        });
        if row as usize >= self.nrows {
            Arc::new(vec![row])
        } else {
            groups[row as usize].clone()
        }
    }
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
                    columns.push(Arc::new(vec![Value::Blank; nrows]));
                } else {
                    let mut v = base.next().ok_or_else(|| format!("Table '{}' is missing data for column '{}'.", def.name, c.name))?;
                    if v.len() != nrows {
                        return Err(format!("Column '{}'[{}] has {} values; expected {nrows}.", def.name, c.name, v.len()));
                    }
                    unify_text_case(&mut v);
                    columns.push(Arc::new(v));
                }
            }
            tables.push(TableData { nrows, columns, dup_groups: OnceLock::new() });
        }
        let rel_index = (0..model.relationships.len()).map(|_| OnceLock::new()).collect();
        Ok(ModelData { model, tables, rel_index, blank_rows: OnceLock::new() })
    }

    /// Replaces a calculated column's values (used while processing calculated columns).
    pub fn set_column(&mut self, c: ColId, values: Vec<Value>) {
        let mut values = values;
        unify_text_case(&mut values);
        self.tables[c.table].columns[c.col] = Arc::new(values);
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
        self.tables[c.table].value(c.col, row)
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
