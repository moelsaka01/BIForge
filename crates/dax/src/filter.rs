//! Filter context, relationship states and the set of visible rows of a table.
//!
//! Model (from Microsoft's public DAX documentation and the expanded-table explanation in public DAX
//! literature):
//! - A filter is a set of tuples over some columns (`Values`), or a set of rows of one base table
//!   (`Rows`, used for table filters and context transition) over that table's columns.
//! - The *expanded table* of T is T plus every table reachable from T through active many-to-one (and
//!   one-to-one) relationships. A filter applies to T when all its columns belong to T's expanded table;
//!   rows of T are then tested through the relationship path (unmatched keys see the related table's blank
//!   row, whose values are all BLANK).
//! - Cross-filtering against the many-to-one direction (bidirectional relationships, many-to-many) is a
//!   semi-join applied only when the other table is actually filtered, and never with filters that already
//!   reach the requesting table (a filter does not loop back to its origin).
//! - USERELATIONSHIP / CROSSFILTER change relationship states inside a CALCULATE.

use crate::data::ModelData;
use crate::model::{Cardinality, ColId, CrossFilter, TableId};
use crate::value::Key;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// Bit set over the rows of one table plus its blank row (index `nrows`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RowSet {
    bits: Vec<u64>,
    len: usize,
}

impl RowSet {
    pub fn empty(len: usize) -> RowSet {
        RowSet { bits: vec![0; len.div_ceil(64)], len }
    }
    pub fn full(len: usize) -> RowSet {
        let mut s = RowSet { bits: vec![u64::MAX; len.div_ceil(64)], len };
        s.trim();
        s
    }
    fn trim(&mut self) {
        let extra = self.bits.len() * 64 - self.len;
        if extra > 0 {
            if let Some(last) = self.bits.last_mut() {
                *last &= u64::MAX >> extra;
            }
        }
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn get(&self, i: u32) -> bool {
        let i = i as usize;
        i < self.len && self.bits[i / 64] & (1 << (i % 64)) != 0
    }
    pub fn set(&mut self, i: u32, v: bool) {
        let i = i as usize;
        if i >= self.len {
            return;
        }
        if v {
            self.bits[i / 64] |= 1 << (i % 64);
        } else {
            self.bits[i / 64] &= !(1 << (i % 64));
        }
    }
    pub fn and(&mut self, o: &RowSet) {
        for (a, b) in self.bits.iter_mut().zip(&o.bits) {
            *a &= b;
        }
    }
    pub fn count(&self) -> usize {
        self.bits.iter().map(|b| b.count_ones() as usize).sum()
    }
    pub fn iter(&self) -> impl Iterator<Item = u32> + '_ {
        self.bits.iter().enumerate().flat_map(|(w, &bits)| {
            let mut b = bits;
            std::iter::from_fn(move || {
                if b == 0 {
                    return None;
                }
                let t = b.trailing_zeros();
                b &= b - 1;
                Some((w * 64) as u32 + t)
            })
        })
    }
    pub fn from_rows(len: usize, rows: impl IntoIterator<Item = u32>) -> RowSet {
        let mut s = RowSet::empty(len);
        for r in rows {
            s.set(r, true);
        }
        s
    }
}

#[derive(Clone, Debug)]
pub enum Filter {
    /// Allowed tuples (value keys) over `cols`.
    Values { cols: Vec<ColId>, set: Rc<HashSet<Vec<Key>>> },
    /// Allowed rows of base table `table`; the filter is "on" `cols` (the table's own or expanded columns).
    Rows { table: TableId, rows: Rc<RowSet>, cols: Vec<ColId> },
}

impl Filter {
    pub fn cols(&self) -> &[ColId] {
        match self {
            Filter::Values { cols, .. } | Filter::Rows { cols, .. } => cols,
        }
    }
    pub fn single(col: ColId, key: Key) -> Filter {
        Filter::Values { cols: vec![col], set: Rc::new(HashSet::from([vec![key]])) }
    }
}

/// Effective state of one relationship.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct RelState {
    pub active: bool,
    /// The `to` (one) side filters the `from` (many) side.
    pub to_filters_from: bool,
    /// The `from` side filters the `to` side (bidirectional).
    pub from_filters_to: bool,
}

#[derive(Clone, Default, Debug)]
pub struct FilterCtx {
    pub filters: Rc<Vec<Filter>>,
    /// Relationship overrides from USERELATIONSHIP / CROSSFILTER: (relationship index, state).
    pub rels: Rc<Vec<(usize, RelState)>>,
    /// Unique id of this context value, for caching visible rows. 0 = the empty context.
    pub id: u64,
    /// The filters in force before the innermost group-by / context transition began: the "outer" selection
    /// that ALLSELECTED restores.
    pub shadow: Option<Rc<Vec<Filter>>>,
}

thread_local! {
    static NEXT_CTX_ID: std::cell::Cell<u64> = const { std::cell::Cell::new(1) };
}

fn next_id() -> u64 {
    NEXT_CTX_ID.with(|c| {
        let v = c.get();
        c.set(v + 1);
        v
    })
}

impl FilterCtx {
    pub fn empty() -> FilterCtx {
        FilterCtx::default()
    }

    fn touched(mut self) -> FilterCtx {
        self.id = next_id();
        self
    }

    /// Removes the given columns from every filter (a filter on several columns keeps its other columns,
    /// projected). Filters left with no columns disappear.
    pub fn remove_columns(&self, data: &ModelData, graph: &Graph, remove: &HashSet<ColId>) -> FilterCtx {
        if remove.is_empty() {
            return self.clone();
        }
        let mut out = Vec::with_capacity(self.filters.len());
        for f in self.filters.iter() {
            if !f.cols().iter().any(|c| remove.contains(c)) {
                out.push(f.clone());
                continue;
            }
            let keep: Vec<ColId> = f.cols().iter().copied().filter(|c| !remove.contains(c)).collect();
            if keep.is_empty() {
                continue;
            }
            match f {
                Filter::Values { cols, set } => {
                    let idx: Vec<usize> = keep.iter().map(|k| cols.iter().position(|c| c == k).unwrap()).collect();
                    let projected: HashSet<Vec<Key>> = set.iter().map(|t| idx.iter().map(|&i| t[i].clone()).collect()).collect();
                    out.push(Filter::Values { cols: keep, set: Rc::new(projected) });
                }
                Filter::Rows { table, rows, cols: _ } => {
                    let own_removed = remove.iter().any(|c| c.table == *table);
                    if !own_removed {
                        // the remaining columns still determine the same rows of `table`
                        out.push(Filter::Rows { table: *table, rows: rows.clone(), cols: keep });
                    } else {
                        let mut tuples = HashSet::new();
                        for r in rows.iter() {
                            tuples.insert(keep.iter().map(|c| graph.value_through(data, *table, r, *c).key()).collect::<Vec<_>>());
                        }
                        out.push(Filter::Values { cols: keep, set: Rc::new(tuples) });
                    }
                }
            }
        }
        FilterCtx { filters: Rc::new(out), rels: self.rels.clone(), id: 0, shadow: self.shadow.clone() }.touched()
    }

    pub fn clear(&self) -> FilterCtx {
        FilterCtx { filters: Rc::new(vec![]), rels: self.rels.clone(), id: 0, shadow: self.shadow.clone() }.touched()
    }

    pub fn push(&self, f: Filter) -> FilterCtx {
        let mut v = (*self.filters).clone();
        v.push(f);
        FilterCtx { filters: Rc::new(v), rels: self.rels.clone(), id: 0, shadow: self.shadow.clone() }.touched()
    }

    pub fn set_rel(&self, rel: usize, st: RelState) -> FilterCtx {
        let mut v: Vec<(usize, RelState)> = self.rels.iter().filter(|(r, _)| *r != rel).cloned().collect();
        v.push((rel, st));
        FilterCtx { filters: self.filters.clone(), rels: Rc::new(v), id: 0, shadow: self.shadow.clone() }.touched()
    }

    /// Marks the current filters as the outer selection (only the outermost call counts).
    pub fn with_shadow(&self) -> FilterCtx {
        if self.shadow.is_some() {
            return self.clone();
        }
        FilterCtx { filters: self.filters.clone(), rels: self.rels.clone(), id: self.id, shadow: Some(self.filters.clone()) }
    }

    /// ALLSELECTED: for the given columns (None = all), replaces the current filters with the outer selection.
    pub fn restore_selected(&self, data: &ModelData, graph: &Graph, cols: Option<&HashSet<ColId>>) -> FilterCtx {
        let Some(shadow) = &self.shadow else { return self.clone() };
        let shadow_ctx = FilterCtx { filters: shadow.clone(), rels: self.rels.clone(), id: 0, shadow: None };
        match cols {
            None => FilterCtx { filters: shadow.clone(), rels: self.rels.clone(), id: 0, shadow: self.shadow.clone() }.touched(),
            Some(cols) => {
                let mut ctx = self.remove_columns(data, graph, cols);
                for f in shadow.iter() {
                    if !f.cols().iter().any(|c| cols.contains(c)) {
                        continue;
                    }
                    let drop: HashSet<ColId> = f.cols().iter().copied().filter(|c| !cols.contains(c)).collect();
                    let single = FilterCtx { filters: Rc::new(vec![f.clone()]), ..shadow_ctx.clone() }.remove_columns(data, graph, &drop);
                    for g in single.filters.iter() {
                        ctx = ctx.push(g.clone());
                    }
                }
                ctx
            }
        }
    }

    pub fn is_filtered_column(&self, c: ColId) -> bool {
        self.filters.iter().any(|f| f.cols().contains(&c))
    }
}

/// Relationship states for a context: the model's defaults with the context's overrides applied.
pub fn rel_states(data: &ModelData, ctx: &FilterCtx) -> Vec<RelState> {
    let mut v: Vec<RelState> = data
        .model
        .relationships
        .iter()
        .map(|r| RelState {
            active: r.active,
            to_filters_from: true,
            from_filters_to: r.cross_filter == CrossFilter::Both,
        })
        .collect();
    for (i, st) in ctx.rels.iter() {
        v[*i] = *st;
    }
    v
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hop {
    pub rel: usize,
    /// true: from (many) -> to (one); false: to -> from (one-to-one only).
    pub forward: bool,
}

/// Expansion paths for one relationship configuration.
pub struct Graph {
    pub states: Vec<RelState>,
    /// For each table: reachable table -> path of hops (the table itself maps to an empty path).
    paths: Vec<HashMap<TableId, Vec<Hop>>>,
}

impl Graph {
    pub fn new(data: &ModelData, states: Vec<RelState>) -> Graph {
        let m = &data.model;
        let n = m.tables.len();
        let mut paths = Vec::with_capacity(n);
        for t in 0..n {
            let mut seen: HashMap<TableId, Vec<Hop>> = HashMap::from([(t, vec![])]);
            let mut queue = vec![t];
            while let Some(cur) = queue.pop() {
                let base = seen[&cur].clone();
                for (i, r) in m.relationships.iter().enumerate() {
                    if !states[i].active || r.cardinality == Cardinality::ManyToMany {
                        continue;
                    }
                    let next = if r.from.table == cur {
                        Some((r.to.table, true))
                    } else if r.to.table == cur && r.cardinality == Cardinality::OneToOne {
                        Some((r.from.table, false))
                    } else {
                        None
                    };
                    if let Some((nt, fwd)) = next {
                        if let std::collections::hash_map::Entry::Vacant(e) = seen.entry(nt) {
                            let mut p = base.clone();
                            p.push(Hop { rel: i, forward: fwd });
                            e.insert(p);
                            queue.push(nt);
                        }
                    }
                }
            }
            paths.push(seen);
        }
        Graph { states, paths }
    }

    pub fn path(&self, from: TableId, to: TableId) -> Option<&Vec<Hop>> {
        self.paths[from].get(&to)
    }

    pub fn reaches(&self, from: TableId, to: TableId) -> bool {
        self.paths[from].contains_key(&to)
    }

    /// Tables in the expanded table of `t` (including `t`).
    pub fn expanded(&self, t: TableId) -> impl Iterator<Item = TableId> + '_ {
        self.paths[t].keys().copied()
    }

    /// All columns of the expanded table of `t`.
    pub fn expanded_columns(&self, data: &ModelData, t: TableId) -> Vec<ColId> {
        let mut tables: Vec<TableId> = self.expanded(t).collect();
        tables.sort();
        tables.into_iter().flat_map(|u| data.model.columns_of(u).collect::<Vec<_>>()).collect()
    }

    /// Row of `target` reached from row `row` of `from` (the target's blank row when unmatched).
    pub fn follow(&self, data: &ModelData, from: TableId, row: u32, target: TableId) -> Option<u32> {
        let path = self.path(from, target)?;
        let mut r = row;
        let mut cur = from;
        for h in path {
            let rel = &data.model.relationships[h.rel];
            let idx = data.rel(h.rel);
            if h.forward {
                r = if (r as usize) < data.nrows(cur) { idx.fwd[r as usize] } else { data.nrows(rel.to.table) as u32 };
                cur = rel.to.table;
            } else {
                r = if (r as usize) < data.nrows(cur) { idx.rev[r as usize] } else { data.nrows(rel.from.table) as u32 };
                cur = rel.from.table;
            }
        }
        Some(r)
    }

    pub fn value_through<'d>(&self, data: &'d ModelData, from: TableId, row: u32, c: ColId) -> &'d crate::value::Value {
        static BLANK: crate::value::Value = crate::value::Value::Blank;
        match self.follow(data, from, row, c.table) {
            Some(r) => data.value(c, r),
            None => &BLANK,
        }
    }

    pub fn applies(&self, f: &Filter, t: TableId) -> bool {
        match f {
            Filter::Rows { table, cols, .. } => {
                self.reaches(t, *table) && cols.iter().all(|c| self.reaches(t, c.table))
            }
            Filter::Values { cols, .. } => cols.iter().all(|c| self.reaches(t, c.table)),
        }
    }
}

/// Visible rows of `t` under `ctx`; the flag tells whether any filter or cross-filter applied.
pub fn visible(data: &ModelData, graph: &Graph, ctx: &FilterCtx, t: TableId) -> (RowSet, bool) {
    visible_rec(data, graph, ctx, t, &mut vec![])
}

fn row_count_with_blank(data: &ModelData, t: TableId) -> (usize, bool) {
    (data.nrows(t) + 1, data.has_blank_row(t))
}

fn visible_rec(data: &ModelData, graph: &Graph, ctx: &FilterCtx, t: TableId, visiting: &mut Vec<TableId>) -> (RowSet, bool) {
    let (len, blank) = row_count_with_blank(data, t);
    let mut rows = RowSet::full(len);
    if !blank {
        rows.set((len - 1) as u32, false);
    }
    let mut filtered = false;
    for f in ctx.filters.iter() {
        if !graph.applies(f, t) || visiting.iter().any(|&v| graph.applies(f, v)) {
            continue;
        }
        filtered = true;
        apply_filter(data, graph, f, t, &mut rows);
    }
    // cross-filters that expansion does not cover
    visiting.push(t);
    for (i, r) in data.model.relationships.iter().enumerate() {
        let st = graph.states[i];
        if !st.active {
            continue;
        }
        let (other, other_filters_t) = if r.to.table == t {
            (r.from.table, st.from_filters_to)
        } else if r.from.table == t {
            (r.to.table, st.to_filters_from)
        } else {
            continue;
        };
        if !other_filters_t || visiting.contains(&other) {
            continue;
        }
        let (orows, ofilt) = visible_rec(data, graph, ctx, other, visiting);
        if !ofilt {
            continue;
        }
        filtered = true;
        semi_join(data, i, t, other, &orows, &mut rows);
    }
    visiting.pop();
    (rows, filtered)
}

fn apply_filter(data: &ModelData, graph: &Graph, f: &Filter, t: TableId, rows: &mut RowSet) {
    let candidates: Vec<u32> = rows.iter().collect();
    match f {
        Filter::Rows { table, rows: allowed, .. } => {
            for r in candidates {
                let target = if *table == t { Some(r) } else { graph.follow(data, t, r, *table) };
                if !target.is_some_and(|x| allowed.get(x)) {
                    rows.set(r, false);
                }
            }
        }
        Filter::Values { cols, set } => {
            let mut key = Vec::with_capacity(cols.len());
            for r in candidates {
                key.clear();
                for c in cols {
                    key.push(graph.value_through(data, t, r, *c).key());
                }
                if !set.contains(&key) {
                    rows.set(r, false);
                }
            }
        }
    }
}

/// Restricts `t` to rows related to the visible rows of `other` through relationship `rel`.
fn semi_join(data: &ModelData, rel: usize, t: TableId, other: TableId, orows: &RowSet, rows: &mut RowSet) {
    let r = &data.model.relationships[rel];
    if r.cardinality == Cardinality::ManyToMany {
        let (tcol, ocol) = if r.from.table == t { (r.from, r.to) } else { (r.to, r.from) };
        let keys: HashSet<Key> = orows.iter().map(|o| data.value(ocol, o).key()).collect();
        for x in rows.iter().collect::<Vec<_>>() {
            if !keys.contains(&data.value(tcol, x).key()) {
                rows.set(x, false);
            }
        }
        return;
    }
    let idx = data.rel(rel);
    if r.to.table == t {
        // t is the one side: keep rows referenced by visible many-side rows (blank row: by unmatched ones)
        let mut keep = RowSet::empty(rows.len());
        for o in orows.iter() {
            if (o as usize) < data.nrows(other) {
                keep.set(idx.fwd[o as usize], true);
            }
        }
        rows.and(&keep);
    } else {
        // t is the many side: keep rows whose one-side row is visible
        let blank = data.nrows(other) as u32;
        for x in rows.iter().collect::<Vec<_>>() {
            let o = if (x as usize) < data.nrows(t) { idx.fwd[x as usize] } else { blank };
            if !orows.get(o) {
                rows.set(x, false);
            }
        }
    }
}
