//! Table values produced by table expressions.

use crate::data::ModelData;
use crate::model::{ColId, TableId};
use crate::value::Value;
use std::rc::Rc;

#[derive(Clone, Debug, PartialEq)]
pub struct TCol {
    pub name: String,
    /// The model column this column comes from (keeps filtering power), if any.
    pub lineage: Option<ColId>,
    /// Named explicitly (SELECTCOLUMNS): the header is `[Name]` even when the column keeps its lineage.
    pub renamed: bool,
}

#[derive(Debug, Default)]
pub struct MatTable {
    pub cols: Vec<TCol>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Clone, Debug)]
pub enum TableVal {
    /// Rows of a model table with all its columns (row indexes may include the blank row).
    Base { table: TableId, rows: Rc<Vec<u32>> },
    Mat(Rc<MatTable>),
}

impl TableVal {
    pub fn mat(cols: Vec<TCol>, rows: Vec<Vec<Value>>) -> TableVal {
        TableVal::Mat(Rc::new(MatTable { cols, rows }))
    }

    pub fn nrows(&self) -> usize {
        match self {
            TableVal::Base { rows, .. } => rows.len(),
            TableVal::Mat(m) => m.rows.len(),
        }
    }

    pub fn cols(&self, data: &ModelData) -> Vec<TCol> {
        match self {
            TableVal::Base { table, .. } => data
                .model
                .columns_of(*table)
                .map(|c| TCol { name: data.model.column(c).name.clone(), lineage: Some(c), renamed: false })
                .collect(),
            TableVal::Mat(m) => m.cols.clone(),
        }
    }

    pub fn ncols(&self, data: &ModelData) -> usize {
        match self {
            TableVal::Base { table, .. } => data.model.tables[*table].columns.len(),
            TableVal::Mat(m) => m.cols.len(),
        }
    }

    pub fn value(&self, data: &ModelData, row: usize, col: usize) -> Value {
        match self {
            TableVal::Base { table, rows } => data.value(ColId { table: *table, col }, rows[row]).clone(),
            TableVal::Mat(m) => m.rows[row][col].clone(),
        }
    }

    pub fn row(&self, data: &ModelData, row: usize) -> Vec<Value> {
        (0..self.ncols(data)).map(|c| self.value(data, row, c)).collect()
    }

    pub fn to_mat(&self, data: &ModelData) -> Rc<MatTable> {
        match self {
            TableVal::Mat(m) => m.clone(),
            TableVal::Base { .. } => Rc::new(MatTable { cols: self.cols(data), rows: (0..self.nrows()).map(|r| self.row(data, r)).collect() }),
        }
    }
}

/// Header shown for a result column: `Table[Column]` for model columns, `[Name]` otherwise.
pub fn header(data: &ModelData, c: &TCol) -> String {
    match c.lineage {
        Some(id) if !c.renamed && data.model.column(id).name.eq_ignore_ascii_case(&c.name) => data.model.column_name(id),
        _ => format!("[{}]", c.name),
    }
}
