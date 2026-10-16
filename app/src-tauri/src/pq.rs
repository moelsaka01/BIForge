//! Tauri wrappers for the Power Query editor: M text tools (no data needed) and query evaluation over the project store.
use crate::data::DataService;
use biforge_engine::{RowPage, TableInfo};
use biforge_m::run::StepResult;
use biforge_m::steps::{self, ParsedQuery};
use biforge_m::transforms::{apply_transform, folder_combine_query, Applied, Transform};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MDiagnostic {
    /// UTF-16 offsets into the checked text.
    pub start: usize,
    pub end: usize,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StepEdit {
    Insert { after: Option<String>, name: String, expr: String },
    Delete { name: String },
    DeleteFrom { name: String },
    Rename { old: String, new: String },
    SetExpr { name: String, expr: String },
    Move { name: String, delta: i32 },
    /// Renames uses of another query (the text need not be a `let`).
    RenameRef { old: String, new: String },
}

pub fn check(text: &str) -> Vec<MDiagnostic> {
    match biforge_m::parse(text) {
        Ok(_) => vec![],
        Err(e) => {
            let start = biforge_dax::editor::utf16_offset(text, e.start);
            let mut end = biforge_dax::editor::utf16_offset(text, e.end);
            if end <= start {
                end = start + 1;
            }
            vec![MDiagnostic { start, end, message: e.message }]
        }
    }
}

pub fn edit_step(text: &str, edit: &StepEdit) -> Result<String, String> {
    match edit {
        StepEdit::Insert { after, name, expr } => {
            biforge_m::parse(expr).map_err(|e| e.to_string())?;
            steps::insert_step(text, after.as_deref(), name, expr)
        }
        StepEdit::Delete { name } => steps::delete_step(text, name),
        StepEdit::DeleteFrom { name } => steps::delete_from(text, name),
        StepEdit::Rename { old, new } => steps::rename_step(text, old, new),
        StepEdit::SetExpr { name, expr } => steps::set_step_expr(text, name, expr),
        StepEdit::Move { name, delta } => steps::move_step(text, name, *delta),
        StepEdit::RenameRef { old, new } => Ok(steps::rename_references(text, old, new)),
    }
}

pub fn dependencies(queries: &BTreeMap<String, String>) -> BTreeMap<String, Vec<String>> {
    queries.keys().map(|k| (k.clone(), biforge_m::run::dependencies(queries, k))).collect()
}

impl DataService {
    pub fn m_analyze(&self, queries: &BTreeMap<String, String>, query: &str) -> Result<Vec<StepResult>, String> {
        self.with_store(|e| e.m_analyze(queries, query).map_err(|e| e.to_string()))
    }
    pub fn m_preview(&self, queries: &BTreeMap<String, String>, query: &str, step: Option<&str>, limit: usize) -> Result<RowPage, String> {
        self.with_store(|e| e.m_preview(queries, query, step, limit.min(5000)).map_err(|e| e.to_string()))
    }
    pub fn m_load(&self, queries: &BTreeMap<String, String>, query: &str, table: &str) -> Result<TableInfo, String> {
        self.with_store(|e| e.m_load(queries, query, table).map_err(|e| e.to_string()))
    }
    pub fn m_query_kinds(&self, queries: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
        self.with_store(|e| Ok(queries.keys().map(|k| (k.clone(), e.m_query_kind(queries, k))).collect()))
    }
}

#[tauri::command]
pub fn m_parse_query(text: String) -> Result<ParsedQuery, String> {
    steps::parse_query(&text)
}
#[tauri::command]
pub fn m_check(text: String) -> Vec<MDiagnostic> {
    check(&text)
}
#[tauri::command]
pub fn m_apply_transform(text: String, after: Option<String>, transform: Transform) -> Result<Applied, String> {
    apply_transform(&text, after.as_deref(), &transform)
}
#[tauri::command]
pub fn m_edit_step(text: String, edit: StepEdit) -> Result<String, String> {
    edit_step(&text, &edit)
}
#[tauri::command]
pub fn m_dependencies(queries: BTreeMap<String, String>) -> BTreeMap<String, Vec<String>> {
    dependencies(&queries)
}
#[tauri::command]
pub fn m_folder_query(folder: String, extension: String, delimiter: String) -> String {
    folder_combine_query(&folder, &extension, &delimiter)
}
#[tauri::command]
pub fn m_analyze(state: tauri::State<DataService>, queries: BTreeMap<String, String>, query: String) -> Result<Vec<StepResult>, String> {
    state.m_analyze(&queries, &query)
}
#[tauri::command]
pub fn m_preview(
    state: tauri::State<DataService>,
    queries: BTreeMap<String, String>,
    query: String,
    step: Option<String>,
    limit: usize,
) -> Result<RowPage, String> {
    state.m_preview(&queries, &query, step.as_deref(), limit)
}
#[tauri::command]
pub fn m_load(state: tauri::State<DataService>, queries: BTreeMap<String, String>, query: String, table: String) -> Result<TableInfo, String> {
    state.m_load(&queries, &query, &table)
}
#[tauri::command]
pub fn m_query_kinds(state: tauri::State<DataService>, queries: BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    state.m_query_kinds(&queries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use biforge_engine::MemoryCredentialStore;
    use std::sync::Arc;

    fn qs(items: &[(&str, &str)]) -> BTreeMap<String, String> {
        items.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn text_tools_need_no_data_store() {
        assert!(check("let a = 1 in a").is_empty());
        let d = check("let a = \"é😀 in a");
        assert_eq!(d.len(), 1);
        assert!(d[0].message.contains("not closed"));
        assert_eq!(d[0].start, 8); // UTF-16 offset: the emoji counts as two units
        let text = "let\n    Source = 1,\n    B = Source + 1\nin\n    B";
        let out = edit_step(text, &StepEdit::Insert { after: Some("Source".into()), name: "Mid".into(), expr: "Source * 2".into() }).unwrap();
        assert!(out.contains("B = Mid + 1"), "{out}");
        assert!(edit_step(text, &StepEdit::Insert { after: None, name: "X".into(), expr: "(".into() }).is_err());
        assert_eq!(steps::parse_query(&edit_step(text, &StepEdit::DeleteFrom { name: "B".into() }).unwrap()).unwrap().output, "Source");
        let deps = dependencies(&qs(&[("A", "let S = 1 in S"), ("B", "let S = A + 1 in S"), ("C", "let S = B + A in S")]));
        assert_eq!(deps["A"], Vec::<String>::new());
        assert_eq!(deps["B"], ["A"]);
        assert_eq!(deps["C"], ["B", "A"]);
        let json = serde_json::json!({"kind": "filterRows", "conditions": [{"column": "a", "op": "eq", "value": 1, "valueType": "number"}]});
        let t: Transform = serde_json::from_value(json).unwrap();
        let a = apply_transform("let Source = 1 in Source", None, &t).unwrap();
        assert_eq!(a.added, ["Filtered Rows"]);
    }

    #[test]
    fn queries_run_over_the_open_project_store() {
        let d = tempfile::tempdir().unwrap();
        let svc = DataService::new(Arc::new(MemoryCredentialStore::default()));
        let q = qs(&[("T", "let S = #table({\"x\"}, {{1},{2},{3}}), F = Table.SelectRows(S, each [x] > 1) in F")]);
        assert!(svc.m_analyze(&q, "T").unwrap_err().contains("No project is open"));
        svc.open_store(&d.path().to_string_lossy()).unwrap();
        let steps = svc.m_analyze(&q, "T").unwrap();
        assert_eq!(steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["S", "F"]);
        let page = svc.m_preview(&q, "T", Some("S"), 100).unwrap();
        assert_eq!(page.total, 3);
        let page = svc.m_preview(&q, "T", None, 100).unwrap();
        assert_eq!(page.rows.len(), 2);
        let info = svc.m_load(&q, "T", "Result").unwrap();
        assert_eq!(info.row_count, 2);
        assert_eq!(svc.table_info("Result").unwrap().unwrap().row_count, 2);
        assert_eq!(svc.m_query_kinds(&q).unwrap()["T"], "table");
        let bad = qs(&[("T", "let S = Table.SelectColumns(#table({\"x\"}, {{1}}), {\"nope\"}) in S")]);
        assert!(svc.m_load(&bad, "T", "Result").unwrap_err().contains("'nope'"));
        assert_eq!(svc.table_info("Result").unwrap().unwrap().row_count, 2);
    }
}
