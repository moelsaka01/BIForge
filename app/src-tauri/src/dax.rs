//! Tauri wrappers around the DAX engine. `DaxService` holds the logic so it can be tested without a window.
//!
//! The UI sends the project's TMDL documents (the document store is the single source of truth, including
//! unsaved edits); the model is built from them for every call and the data comes from the project's DuckDB store.

use crate::data::DataService;
use biforge_dax::editor::{check_expression, function_catalog, result_dto, EditorDiagnostic, FunctionDto, ResultDto};
use biforge_dax::Model;
use biforge_model::tmdl::Document;
use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutcome {
    /// One result per EVALUATE statement.
    pub results: Vec<ResultDto>,
    pub elapsed_ms: u64,
}

fn model_of(documents: &[Document]) -> Result<Model, String> {
    Model::from_tmdl(documents.iter()).map_err(|e| e.to_string())
}

pub struct DaxService<'a> {
    pub data: &'a DataService,
}

impl DaxService<'_> {
    pub fn catalog(&self) -> Vec<FunctionDto> {
        function_catalog()
    }

    /// Diagnostics for a measure expression against the project's model.
    pub fn check(&self, documents: &[Document], expression: &str) -> Result<Vec<EditorDiagnostic>, String> {
        let model = model_of(documents)?;
        Ok(check_expression(&model, expression))
    }

    /// Runs a DAX query (`DEFINE ... EVALUATE ...`) over the project's model and data.
    pub fn query(&self, documents: &[Document], query: &str) -> Result<QueryOutcome, String> {
        let model = model_of(documents)?;
        self.data.with_store(|store| {
            let started = Instant::now();
            let engine = biforge_dax::Engine::new(model, store)?;
            let tables = engine.query_with(query, Some(store)).map_err(|e| e.message)?;
            Ok(QueryOutcome { results: tables.iter().map(result_dto).collect(), elapsed_ms: started.elapsed().as_millis() as u64 })
        })
    }
}

#[tauri::command]
pub fn dax_catalog(state: tauri::State<DataService>) -> Vec<FunctionDto> {
    DaxService { data: &state }.catalog()
}

#[tauri::command]
pub fn dax_check(state: tauri::State<DataService>, documents: Vec<Document>, expression: String) -> Result<Vec<EditorDiagnostic>, String> {
    DaxService { data: &state }.check(&documents, &expression)
}

#[tauri::command]
pub fn dax_query(state: tauri::State<DataService>, documents: Vec<Document>, query: String) -> Result<QueryOutcome, String> {
    DaxService { data: &state }.query(&documents, &query)
}

#[cfg(test)]
mod tests {
    use super::*;
    use biforge_engine::{MemoryCredentialStore, SourceSpec};
    use std::sync::Arc;

    const MODEL: &str = "table Sales\n\tcolumn Region\n\t\tdataType: string\n\tcolumn Qty\n\t\tdataType: int64\n\tmeasure Total = SUM(Sales[Qty])\n";

    fn setup() -> (tempfile::TempDir, DataService, Vec<Document>) {
        let d = tempfile::tempdir().unwrap();
        let svc = DataService::new(Arc::new(MemoryCredentialStore::default()));
        svc.open_store(&d.path().to_string_lossy()).unwrap();
        let csv = d.path().join("s.csv");
        std::fs::write(&csv, "Region,Qty\nEast,2\nWest,3\nEast,5\n").unwrap();
        svc.import("Sales", &SourceSpec::Csv { path: csv.to_string_lossy().into_owned(), delimiter: None, header: None }).unwrap();
        let docs = vec![biforge_model::tmdl::parse(MODEL).unwrap()];
        (d, svc, docs)
    }

    #[test]
    fn evaluates_measures_and_queries_over_the_project_store() {
        let (_d, svc, docs) = setup();
        let dax = DaxService { data: &svc };
        let out = dax.query(&docs, "EVALUATE ROW(\"v\", [Total])").unwrap();
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].columns, vec!["[v]"]);
        assert_eq!(out.results[0].rows[0][0].v, "10");
        assert_eq!(out.results[0].rows[0][0].t, "int");

        // an unsaved measure is evaluated through DEFINE; grouped results
        let q = "DEFINE MEASURE Sales[Double] = [Total] * 2 EVALUATE SUMMARIZECOLUMNS(Sales[Region], \"v\", [Double]) ORDER BY Sales[Region]";
        let out = dax.query(&docs, q).unwrap();
        let rows: Vec<(String, String)> = out.results[0].rows.iter().map(|r| (r[0].v.clone(), r[1].v.clone())).collect();
        assert_eq!(rows, vec![("East".into(), "14".into()), ("West".into(), "6".into())]);
    }

    #[test]
    fn errors_are_readable() {
        let (_d, svc, docs) = setup();
        let dax = DaxService { data: &svc };
        let e = dax.query(&docs, "EVALUATE ROW(\"v\", SUM(Sales[Nope]))").unwrap_err();
        assert!(e.contains("Nope"), "{e}");
        let e = dax.query(&docs, "EVALUATE ROW(\"v\", XIRR(Sales, Sales[Qty], Sales[Qty]))").unwrap_err();
        assert!(e.contains("XIRR") && e.contains("not implemented"), "{e}");
        // no project open
        let none = DataService::new(Arc::new(MemoryCredentialStore::default()));
        assert!(DaxService { data: &none }.query(&docs, "EVALUATE ROW(\"v\", 1)").unwrap_err().contains("No project is open"));
    }

    #[test]
    fn checks_do_not_need_a_data_store() {
        let none = DataService::new(Arc::new(MemoryCredentialStore::default()));
        let docs = vec![biforge_model::tmdl::parse(MODEL).unwrap()];
        let dax = DaxService { data: &none };
        assert!(dax.check(&docs, "SUM(Sales[Qty]) + [Total]").unwrap().is_empty());
        let d = dax.check(&docs, "SUM(Sales[Qty") .unwrap();
        assert_eq!(d.len(), 1);
        let d = dax.check(&docs, "SUM(Sales[Nope])").unwrap();
        assert_eq!(d[0].severity, "error");
        assert!(dax.catalog().iter().any(|f| f.name == "CALCULATE" && f.implemented));
    }
}
