use super::{clean_names, Cell, RawTable};
use crate::error::{EngineError, Result};
use calamine::{open_workbook_auto, Data, Reader};

fn err<E: std::fmt::Display>(path: &str, e: E) -> EngineError {
    EngineError::Source(format!("Could not read Excel file \"{path}\": {e}"))
}

pub fn sheet_names(path: &str) -> Result<Vec<String>> {
    if !std::path::Path::new(path).exists() {
        return Err(EngineError::FileNotFound(path.into()));
    }
    let wb = open_workbook_auto(path).map_err(|e| err(path, e))?;
    Ok(wb.sheet_names())
}

fn cell(d: &Data) -> Cell {
    match d {
        Data::Empty => Cell::Null,
        Data::Int(i) => Cell::Int(*i),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 9e15 {
                Cell::Int(*f as i64)
            } else {
                Cell::Float(*f)
            }
        }
        Data::Bool(b) => Cell::Bool(*b),
        Data::String(s) => Cell::Text(s.clone()),
        Data::DateTime(dt) => match dt.as_datetime() {
            Some(n) => Cell::Timestamp(n.and_utc().timestamp_micros()),
            None => Cell::Float(dt.as_f64()),
        },
        Data::DateTimeIso(s) | Data::DurationIso(s) => Cell::Text(s.clone()),
        Data::Error(e) => Cell::Text(format!("#{e:?}")),
    }
}

fn cell_text(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        other => other.to_string(),
    }
}

pub fn read(path: &str, sheet: Option<&str>, header: bool) -> Result<RawTable> {
    if !std::path::Path::new(path).exists() {
        return Err(EngineError::FileNotFound(path.into()));
    }
    let mut wb = open_workbook_auto(path).map_err(|e| err(path, e))?;
    let name = match sheet {
        Some(s) => s.to_string(),
        None => wb.sheet_names().first().cloned().ok_or_else(|| err(path, "workbook has no sheets"))?,
    };
    let range = wb
        .worksheet_range(&name)
        .map_err(|e| EngineError::Source(format!("Could not read sheet \"{name}\" of \"{path}\": {e}")))?;
    let width = range.width();
    let mut rows = range.rows();
    let columns = if header {
        match rows.next() {
            Some(h) => h.iter().map(cell_text).collect(),
            None => vec![],
        }
    } else {
        (1..=width).map(|i| format!("Column{i}")).collect()
    };
    let columns = clean_names(columns);
    if columns.is_empty() {
        return Err(EngineError::Source(format!("Sheet \"{name}\" of \"{path}\" is empty.")));
    }
    let mut out = Vec::new();
    for r in rows {
        let mut row: Vec<Cell> = r.iter().map(cell).collect();
        row.resize(columns.len(), Cell::Null);
        out.push(row);
    }
    Ok(RawTable { columns, rows: out })
}
