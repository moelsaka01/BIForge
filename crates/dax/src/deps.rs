//! Dependency order of calculated columns (references to other calculated columns, directly or through
//! measures). A cycle is reported as a circular dependency.

use crate::bind::{BExpr, BKind, Binder, MeasureRef, QueryScope};
use crate::model::{ColId, Model};
use crate::value::EvalError;
use std::collections::{HashMap, HashSet};

fn collect(model: &Model, e: &BExpr, own_table: usize, out: &mut HashSet<ColId>, seen_measures: &mut HashSet<usize>) {
    e.walk(&mut |x| match &x.kind {
        BKind::Col(c) => {
            out.insert(*c);
        }
        BKind::RowCol(name) => {
            if let Some(c) = model.column_id(own_table, name) {
                out.insert(c);
            }
        }
        BKind::Measure(MeasureRef::Model(m)) => {
            if seen_measures.insert(*m) {
                let me = &model.measures[*m];
                let scope = QueryScope::default();
                if let Ok(p) = crate::parser::parse_expression(&me.expression) {
                    if let Ok(b) = Binder::new(model, &scope, 0).bind(&p) {
                        collect(model, &b, me.table, out, seen_measures);
                    }
                }
            }
        }
        _ => {}
    });
}

/// Topological order of `calcs`. On a cycle, returns the columns involved and a message.
pub fn calc_column_order(model: &Model, calcs: &[ColId], bound: &HashMap<ColId, Result<BExpr, EvalError>>) -> Result<Vec<ColId>, (Vec<ColId>, String)> {
    let is_calc: HashSet<ColId> = calcs.iter().copied().collect();
    let mut deps: HashMap<ColId, Vec<ColId>> = HashMap::new();
    for &c in calcs {
        let mut out = HashSet::new();
        if let Some(Ok(e)) = bound.get(&c) {
            collect(model, e, c.table, &mut out, &mut HashSet::new());
        }
        let mut d: Vec<ColId> = out.into_iter().filter(|x| is_calc.contains(x)).collect();
        d.sort();
        deps.insert(c, d);
    }
    // Kahn-style DFS with colors
    let mut order = Vec::new();
    let mut state: HashMap<ColId, u8> = HashMap::new(); // 1 = visiting, 2 = done
    fn visit(c: ColId, deps: &HashMap<ColId, Vec<ColId>>, state: &mut HashMap<ColId, u8>, order: &mut Vec<ColId>, stack: &mut Vec<ColId>) -> Result<(), Vec<ColId>> {
        match state.get(&c) {
            Some(2) => return Ok(()),
            Some(1) => {
                let i = stack.iter().position(|x| *x == c).unwrap_or(0);
                return Err(stack[i..].to_vec());
            }
            _ => {}
        }
        state.insert(c, 1);
        stack.push(c);
        for &d in &deps[&c] {
            visit(d, deps, state, order, stack)?;
        }
        stack.pop();
        state.insert(c, 2);
        order.push(c);
        Ok(())
    }
    for &c in calcs {
        let mut stack = Vec::new();
        if let Err(cycle) = visit(c, &deps, &mut state, &mut order, &mut stack) {
            let names: Vec<String> = cycle.iter().map(|c| model.column_name(*c)).collect();
            return Err((cycle, format!("A circular dependency was detected: {}.", names.join(", "))));
        }
    }
    Ok(order)
}
