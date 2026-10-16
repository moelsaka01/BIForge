//! What the editor UI needs from the engine: diagnostics with editor offsets, the function catalog with an
//! "implemented" flag, and query results in a display-ready form.

use crate::bind::{Binder, QueryScope};
use crate::catalog::Catalog;
use crate::diag::{Diagnostic, ErrorCode};
use crate::functions;
use crate::model::Model;
use crate::parser::{diagnose, parse_expression};
use crate::query::ResultTable;
use crate::value::Value;
use serde::Serialize;

/// UTF-16 offset (what Monaco and JavaScript strings use) of a byte offset in `src`.
pub fn utf16_offset(src: &str, byte: usize) -> usize {
    let byte = byte.min(src.len());
    src.char_indices().take_while(|(i, _)| *i < byte).map(|(_, c)| c.len_utf16()).sum()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDiagnostic {
    /// "error" or "warning" (a function that exists in DAX but is not implemented by BIForge yet).
    pub severity: &'static str,
    pub code: ErrorCode,
    pub message: String,
    /// UTF-16 offsets into the checked text.
    pub start: usize,
    pub end: usize,
}

fn convert(src: &str, d: Diagnostic) -> EditorDiagnostic {
    let start = utf16_offset(src, d.span.start);
    let mut end = utf16_offset(src, d.span.end);
    if end <= start {
        end = start + 1;
    }
    EditorDiagnostic { severity: if d.code == ErrorCode::NotImplemented { "warning" } else { "error" }, code: d.code, message: d.message, start, end }
}

/// Syntax, function names and argument counts, then names against the model (tables, columns, measures, variables).
pub fn check_expression(model: &Model, src: &str) -> Vec<EditorDiagnostic> {
    if src.trim().is_empty() {
        return vec![];
    }
    let syntax = diagnose(src, Catalog::builtin());
    if !syntax.is_empty() {
        return syntax.into_iter().map(|d| convert(src, d)).collect();
    }
    // `diagnose` succeeded, so the expression parses
    let parsed = match parse_expression(src) {
        Ok(e) => e,
        Err(d) => return vec![convert(src, d)],
    };
    let scope = QueryScope::default();
    match Binder::new(model, &scope, 0).bind(&parsed) {
        Ok(_) => vec![],
        Err(d) => vec![convert(src, d)],
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDto {
    pub name: String,
    pub category: String,
    pub signature: String,
    pub returns_table: bool,
    pub description: String,
    pub implemented: bool,
    pub min_args: usize,
    pub max_args: Option<usize>,
}

pub fn function_catalog() -> Vec<FunctionDto> {
    let mut v: Vec<FunctionDto> = Catalog::builtin()
        .all()
        .iter()
        .map(|f| FunctionDto {
            name: f.name.clone(),
            category: f.category.clone(),
            signature: f.signature.clone(),
            returns_table: f.returns_table,
            description: f.description.clone(),
            implemented: functions::is_implemented(&f.name.to_ascii_uppercase()),
            min_args: f.min_args,
            max_args: f.max_args,
        })
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cell {
    /// blank | int | real | currency | text | bool | datetime
    pub t: &'static str,
    pub v: String,
}

pub fn cell(v: &Value) -> Cell {
    match v {
        Value::Blank => Cell { t: "blank", v: String::new() },
        Value::Bool(_) => Cell { t: "bool", v: v.to_text() },
        Value::Int(_) => Cell { t: "int", v: v.to_text() },
        Value::Double(_) => Cell { t: "real", v: v.to_text() },
        Value::Currency(_) => Cell { t: "currency", v: v.to_text() },
        Value::Str(_) => Cell { t: "text", v: v.to_text() },
        Value::DateTime(_) => Cell { t: "datetime", v: v.to_text() },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultDto {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
    pub total_rows: usize,
    pub truncated: bool,
}

pub const MAX_RESULT_ROWS: usize = 10_000;

pub fn result_dto(t: &ResultTable) -> ResultDto {
    ResultDto {
        columns: t.columns.clone(),
        rows: t.rows.iter().take(MAX_RESULT_ROWS).map(|r| r.iter().map(cell).collect()).collect(),
        total_rows: t.rows.len(),
        truncated: t.rows.len() > MAX_RESULT_ROWS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DataType;

    fn model() -> Model {
        let mut m = Model::new();
        m.add_table("Sales", &[("Qty", DataType::Int64), ("Name", DataType::String)]).unwrap();
        m.add_measure("Sales", "Total", "SUM(Sales[Qty])").unwrap();
        m
    }

    #[test]
    fn utf16_offsets_count_code_units() {
        assert_eq!(utf16_offset("aé😀b", 0), 0);
        assert_eq!(utf16_offset("aé😀b", 1), 1);
        assert_eq!(utf16_offset("aé😀b", 3), 2);
        assert_eq!(utf16_offset("aé😀b", 7), 4);
        assert_eq!(utf16_offset("ab", 99), 2);
    }

    #[test]
    fn clean_expressions_have_no_diagnostics() {
        let m = model();
        assert!(check_expression(&m, "SUM(Sales[Qty]) + [Total]").is_empty());
        assert!(check_expression(&m, "VAR x = 1 RETURN x + 1").is_empty());
        assert!(check_expression(&m, "   ").is_empty());
    }

    #[test]
    fn syntax_and_name_errors_carry_positions() {
        let m = model();
        let d = check_expression(&m, "SUM(Sales[Qty]");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].severity, "error");
        let d = check_expression(&m, "SUM(Sales[Nope])");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].code, ErrorCode::UnrecognizedIdentifier);
        assert!(d[0].end > d[0].start);
        let d = check_expression(&m, "FOO(1)");
        assert_eq!(d[0].code, ErrorCode::UnrecognizedIdentifier);
        assert_eq!(&"FOO(1)"[d[0].start..d[0].end], "FOO");
        let d = check_expression(&m, "SUM()");
        assert_eq!(d[0].code, ErrorCode::MissingParameters);
        // positions are UTF-16 offsets
        let d = check_expression(&m, "\"é😀\" + FOO(1)");
        assert_eq!(d[0].start, 8);
    }

    #[test]
    fn unimplemented_functions_are_warnings() {
        let m = model();
        let d = check_expression(&m, "XIRR(Sales, Sales[Qty], Sales[Qty])");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].severity, "warning");
        assert_eq!(d[0].code, ErrorCode::NotImplemented);
    }

    #[test]
    fn catalog_marks_implemented_functions() {
        let c = function_catalog();
        assert!(c.len() > 300);
        let get = |n: &str| c.iter().find(|f| f.name == n).unwrap();
        assert!(get("CALCULATE").implemented);
        assert!(get("TOTALYTD").implemented);
        assert!(!get("XIRR").implemented);
        assert!(get("SUM").returns_table == false);
        assert!(get("FILTER").returns_table);
    }

    #[test]
    fn cells_keep_their_type() {
        assert_eq!(cell(&Value::Int(5)), Cell { t: "int", v: "5".into() });
        assert_eq!(cell(&Value::Blank).t, "blank");
        assert_eq!(cell(&Value::Double(0.5)).v, "0.5");
        assert_eq!(cell(&Value::Bool(true)).v, "TRUE");
        let r = ResultTable { columns: vec!["[A]".into()], rows: (0..MAX_RESULT_ROWS + 5).map(|i| vec![Value::Int(i as i64)]).collect() };
        let dto = result_dto(&r);
        assert!(dto.truncated);
        assert_eq!(dto.rows.len(), MAX_RESULT_ROWS);
        assert_eq!(dto.total_rows, MAX_RESULT_ROWS + 5);
    }
}
