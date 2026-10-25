//! Row-level security: roles with one DAX filter per table, applied for one user.
//!
//! Semantics (from Microsoft's public documentation of roles, written in our own words):
//! * a role holds, per table, a boolean DAX expression; a row is visible when the expression is TRUE
//!   (BLANK, FALSE and errors hide it: the rule fails closed);
//! * several roles of one user are added: a table's visible rows are the union over the roles, and a role with no
//!   filter on a table shows all of its rows;
//! * a filter on a table also removes the rows of tables on the many side of an active relationship whose key no
//!   longer has a visible row on the one side (the filter flows along relationships to the tables it can filter);
//!   rows without any match count as the "blank member" and are hidden as well;
//! * a relationship that applies the security filter in both directions (and filters in both directions) also hides
//!   the one-side rows that no visible many-side row refers to;
//! * USERNAME() and USERPRINCIPALNAME() return the identity the host assigned to the user.
//!
//! The protection is data pruning: the engine the user queries is built from the visible rows only, so no
//! DAX expression (ALL, REMOVEFILTERS, ...) can reach a hidden row.

use crate::data::{DataSource, ModelData};
use crate::bind::{Binder, QueryScope};
use crate::eval::{Engine, Env, Evaluator, RowRef};
use crate::filter::RowSet;
use crate::model::{Cardinality, CrossFilter, Model, TableId};
use crate::value::{Key, Value};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFilter {
    pub table: String,
    /// Boolean DAX expression evaluated once per row of the table.
    pub expression: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub name: String,
    pub filters: Vec<TableFilter>,
}

/// Returns only the rows of the tables in `keep`.
struct SubsetSource<'a> {
    inner: &'a dyn DataSource,
    keep: HashMap<TableId, RowSet>,
}

impl DataSource for SubsetSource<'_> {
    fn load_table(&self, model: &Model, table: TableId) -> Result<Vec<Vec<Value>>, String> {
        let mut cols = self.inner.load_table(model, table)?;
        if let Some(mask) = self.keep.get(&table) {
            for c in &mut cols {
                let old = std::mem::take(c);
                *c = old.into_iter().enumerate().filter(|(i, _)| mask.get(*i as u32)).map(|(_, v)| v).collect();
            }
        }
        Ok(cols)
    }
}

/// The rows each table keeps for these roles (tables absent from the result keep every row).
fn visible_rows(base: &Engine, roles: &[&Role]) -> Result<HashMap<TableId, RowSet>, String> {
    let data: &ModelData = &base.data;
    let model = &data.model;
    // every table that some role filters
    let mut filtered: HashSet<TableId> = HashSet::new();
    for r in roles {
        for f in &r.filters {
            let t = model.table_id(&f.table).ok_or_else(|| format!("Role '{}' filters the table '{}', which the model does not have.", r.name, f.table))?;
            filtered.insert(t);
        }
    }
    let ev = Evaluator::new(data);
    let mut masks: HashMap<TableId, RowSet> = HashMap::new();
    for &t in &filtered {
        let n = data.nrows(t);
        let mut union = RowSet::empty(n + 1);
        for r in roles {
            let own: Vec<&TableFilter> = r.filters.iter().filter(|f| model.table_id(&f.table) == Some(t)).collect();
            if own.is_empty() {
                // a role without a filter on this table shows all of it
                union = RowSet::full(n + 1);
                break;
            }
            let mut bound = Vec::new();
            for f in own {
                let e = crate::parser::parse_expression(&f.expression).map_err(|e| format!("Role '{}', table '{}': {}", r.name, f.table, crate::value::EvalError::from(e).message))?;
                let scope = QueryScope::default();
                bound.push(Binder::new(model, &scope, 0).bind(&e).map_err(|e| format!("Role '{}', table '{}': {}", r.name, f.table, crate::value::EvalError::from(e).message))?);
            }
            for row in 0..n as u32 {
                let env = Env::empty().push_row(RowRef::Base { table: t, row });
                let mut ok = true;
                for b in &bound {
                    // an expression that fails hides nothing silently: the whole request fails
                    let v = ev.scalar(b, &env).map_err(|e| format!("Role '{}', table '{}', row {}: {}", r.name, model.tables[t].name, row + 1, e.message))?;
                    if !v.to_bool().unwrap_or(false) {
                        ok = false;
                        break;
                    }
                }
                if ok {
                    union.set(row, true);
                }
            }
        }
        masks.insert(t, union);
    }
    // the filter flows to the many side of active relationships, and from there on
    for _ in 0..model.tables.len() + 1 {
        let mut changed = false;
        for rel in &model.relationships {
            if !rel.active || rel.cardinality == Cardinality::ManyToMany {
                continue;
            }
            for (from, to) in [(rel.from, rel.to), (rel.to, rel.from)] {
                let uphill_allowed = rel.security_both && rel.cross_filter == CrossFilter::Both;
                if from == to || (rel.cardinality == Cardinality::ManyToOne && from == rel.to && !uphill_allowed) {
                    continue; // a one-to-many relationship only filters downhill, unless it applies the security filter in both directions
                }
                let Some(to_mask) = masks.get(&to.table) else { continue };
                let allowed: HashSet<Key> = to_mask.iter().filter(|r| (*r as usize) < data.nrows(to.table)).map(|r| data.value(to, r).key()).collect();
                let n = data.nrows(from.table);
                let mask = masks.entry(from.table).or_insert_with(|| RowSet::full(n + 1));
                for row in 0..n as u32 {
                    if mask.get(row) && !allowed.contains(&data.value(from, row).key()) {
                        mask.set(row, false);
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
    Ok(masks)
}

impl Engine {
    /// An engine whose USERNAME() is `identity` and that only sees the rows `roles` allow.
    /// `roles` empty means "no restriction" (the caller decides who is restricted).
    pub fn new_secured(model: Model, source: &dyn DataSource, roles: &[&Role], identity: &str) -> Result<Engine, String> {
        let base = Engine::new_as(model.clone(), source, identity)?;
        if roles.is_empty() {
            return Ok(base);
        }
        let keep = visible_rows(&base, roles)?;
        drop(base);
        Engine::new_as(model, &SubsetSource { inner: source, keep }, identity)
    }
}
