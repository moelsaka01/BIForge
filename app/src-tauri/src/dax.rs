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

/// Hash of the model text: the loaded engine is reused while it stays the same.
fn model_key(documents: &[Document]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for d in documents {
        biforge_model::tmdl::print(d).hash(&mut h);
    }
    h.finish()
}

/// "View as": the engine only sees what these roles allow, for this user name (USERNAME() returns it).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewAs {
    pub roles: Vec<String>,
    #[serde(default)]
    pub identity: String,
}

/// The roles of the model: `role` objects with one `tablePermission` per table.
pub fn roles_of(documents: &[Document]) -> Vec<biforge_dax::security::Role> {
    documents
        .iter()
        .flat_map(|d| d.nodes.iter())
        .filter(|n| n.kind == "role")
        .map(|n| biforge_dax::security::Role {
            name: n.name.clone().unwrap_or_default(),
            filters: n
                .children
                .iter()
                .filter(|c| c.kind == "tablePermission")
                .map(|c| biforge_dax::security::TableFilter { table: c.name.clone().unwrap_or_default(), expression: c.default.as_ref().map(|e| e.text.clone()).unwrap_or_default() })
                .collect(),
        })
        .collect()
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

    /// Evaluates the DAX table expression of a calculated table and stores its rows as table `name`.
    pub fn calc_table(&self, documents: &[Document], name: &str, expression: &str) -> Result<biforge_engine::TableInfo, String> {
        self.data.with_store(|store| {
            let engine = self.data.dax_cache.get(model_key(documents), store, || model_of(documents))?;
            let tables = engine.query_with(&format!("EVALUATE {expression}"), Some(store)).map_err(|e| e.message)?;
            let t = tables.first().ok_or("The expression returned no table.")?;
            if t.columns.is_empty() {
                return Err("The expression returned a table without columns.".into());
            }
            store.store_calculated_table(name, &t.columns, &t.rows).map_err(|e| e.to_string())
        })
    }

    /// Computes the calculated columns of `table` and stores their values in the table; returns the column names.
    pub fn calc_columns(&self, documents: &[Document], table: &str) -> Result<Vec<String>, String> {
        self.data.with_store(|store| {
            let engine = self.data.dax_cache.get(model_key(documents), store, || model_of(documents))?;
            if let Some((t, c, msg)) = engine.column_errors.iter().find(|(t, _, _)| t.eq_ignore_ascii_case(table)) {
                return Err(format!("The calculated column {t}[{c}] failed: {msg}"));
            }
            let mut names = Vec::new();
            for (name, values) in engine.calculated_columns(table) {
                store.store_calculated_column(table, &name, &values).map_err(|e| e.to_string())?;
                names.push(name);
            }
            Ok(names)
        })
    }

    /// Runs a DAX query (`DEFINE ... EVALUATE ...`) over the project's model and data.
    pub fn query(&self, documents: &[Document], query: &str) -> Result<QueryOutcome, String> {
        self.query_as(documents, query, None)
    }

    /// Like `query`; with `view_as` the data is pruned by the roles first (row-level security as a member of them would see it).
    pub fn query_as(&self, documents: &[Document], query: &str, view_as: Option<&ViewAs>) -> Result<QueryOutcome, String> {
        self.data.with_store(|store| {
            let started = Instant::now();
            let engine = match view_as.filter(|v| !v.roles.is_empty()) {
                None => self.data.dax_cache.get(model_key(documents), store, || model_of(documents))?,
                Some(v) => {
                    let all = roles_of(documents);
                    let chosen: Vec<&biforge_dax::security::Role> = v.roles.iter().map(|n| all.iter().find(|r| r.name.eq_ignore_ascii_case(n)).ok_or_else(|| format!("The role \"{n}\" does not exist."))).collect::<Result<_, _>>()?;
                    let key = {
                        use std::hash::{Hash, Hasher};
                        let mut h = std::collections::hash_map::DefaultHasher::new();
                        (model_key(documents), "view-as", &v.roles, &v.identity).hash(&mut h);
                        h.finish()
                    };
                    self.data.dax_cache.get_built(key, store, || biforge_dax::Engine::new_secured(model_of(documents)?, store, &chosen, &v.identity))?
                }
            };
            // a pruned engine must not push aggregations to the store: SQL would read the rows the roles hide
            let secured = view_as.is_some_and(|v| !v.roles.is_empty());
            let tables = engine.query_with(query, if secured { None } else { Some(store) }).map_err(|e| e.message)?;
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
pub fn dax_query(state: tauri::State<DataService>, documents: Vec<Document>, query: String, view_as: Option<ViewAs>) -> Result<QueryOutcome, String> {
    DaxService { data: &state }.query_as(&documents, &query, view_as.as_ref())
}

#[tauri::command]
pub fn dax_calc_table(state: tauri::State<DataService>, documents: Vec<Document>, name: String, expression: String) -> Result<biforge_engine::TableInfo, String> {
    DaxService { data: &state }.calc_table(&documents, &name, &expression)
}

#[tauri::command]
pub fn dax_calc_columns(state: tauri::State<DataService>, documents: Vec<Document>, table: String) -> Result<Vec<String>, String> {
    DaxService { data: &state }.calc_columns(&documents, &table)
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
    fn calculated_tables_and_columns_are_stored_so_the_views_and_visuals_can_read_them() {
        let (_d, svc, docs) = setup();
        let dax = DaxService { data: &svc };
        // a calculated table from a DAX table expression
        let info = dax.calc_table(&docs, "Regions", "SUMMARIZE(Sales, Sales[Region], \"Total\", SUM(Sales[Qty]))").unwrap();
        assert_eq!(info.row_count, 2);
        assert_eq!(info.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Region", "Total"]);
        let page = svc.fetch_page("Regions", 0, 10, None).unwrap();
        let mut rows: Vec<Vec<Option<String>>> = page.rows;
        rows.sort();
        assert_eq!(rows, vec![vec![Some("East".to_string()), Some("7".to_string())], vec![Some("West".to_string()), Some("3".to_string())]]);
        // the table is part of the model afterwards and can be queried like any other
        let with_table = format!("{MODEL}\ntable Regions\n\tcolumn Region\n\t\tdataType: string\n\tcolumn Total\n\t\tdataType: int64\n");
        let docs2 = vec![biforge_model::tmdl::parse(&with_table).unwrap()];
        let out = dax.query(&docs2, "EVALUATE ROW(\"n\", COUNTROWS(Regions), \"s\", SUM(Regions[Total]))").unwrap();
        assert_eq!((out.results[0].rows[0][0].v.as_str(), out.results[0].rows[0][1].v.as_str()), ("2", "10"));
        // recalculating replaces the table
        let info = dax.calc_table(&docs2, "Regions", "FILTER(SUMMARIZE(Sales, Sales[Region], \"Total\", SUM(Sales[Qty])), [Total] > 5)").unwrap();
        assert_eq!(info.row_count, 1);
        // a calculated column is computed by the engine and written into the table
        let with_col = format!("{MODEL}\ttable Sales2\n").replace("\ttable Sales2\n", "");
        let with_col = with_col.replace("\tmeasure Total", "\tcolumn Double = Sales[Qty] * 2\n\t\tdataType: int64\n\tmeasure Total");
        let docs3 = vec![biforge_model::tmdl::parse(&with_col).unwrap()];
        assert_eq!(dax.calc_columns(&docs3, "Sales").unwrap(), ["Double"]);
        let page = svc.fetch_page("Sales", 0, 10, None).unwrap();
        let idx = page.columns.iter().position(|c| c.name == "Double").unwrap();
        assert_eq!(page.rows.iter().map(|r| r[idx].clone().unwrap()).collect::<Vec<_>>(), ["4", "6", "10"]);
        // the model still reads the stored column as calculated (not as imported data)
        assert_eq!(dax.query(&docs3, "EVALUATE ROW(\"v\", SUM(Sales[Double]))").unwrap().results[0].rows[0][0].v, "20");
        // a calculated column that fails is reported
        let bad = with_col.replace("Sales[Qty] * 2", "Sales[Nope] * 2");
        let docs4 = vec![biforge_model::tmdl::parse(&bad).unwrap()];
        assert!(dax.calc_columns(&docs4, "Sales").unwrap_err().contains("Double"));
    }


    #[test]
    fn a_what_if_parameter_is_a_generated_series_and_a_measure_that_reads_the_selection() {
        let (_d, svc, docs) = setup();
        let dax = DaxService { data: &svc };
        let info = dax.calc_table(&docs, "Discount", "SELECTCOLUMNS(GENERATESERIES(0, 50, 5), \"Discount\", [Value])").unwrap();
        assert_eq!((info.row_count, info.columns[0].name.as_str()), (11, "Discount"));
        let model = format!("{MODEL}\ntable Discount\n\tcolumn Discount\n\t\tdataType: int64\n\tmeasure 'Discount Value' = SELECTEDVALUE('Discount'[Discount], 10)\n");
        let docs2 = vec![biforge_model::tmdl::parse(&model).unwrap()];
        let q = |s: &str| dax.query(&docs2, s).unwrap().results[0].rows[0][0].v.clone();
        assert_eq!(q("EVALUATE ROW(\"v\", [Discount Value])"), "10", "nothing selected: the default");
        assert_eq!(q("EVALUATE CALCULATETABLE(ROW(\"v\", [Discount Value]), 'Discount'[Discount] = 25)"), "25");
    }


    #[test]
    fn view_as_a_role_prunes_the_data_for_the_queries_of_the_report() {
        let (_d, svc, docs) = setup();
        let dax = DaxService { data: &svc };
        let model = format!("{MODEL}\nrole EastOnly\n\tmodelPermission: read\n\ttablePermission Sales = Sales[Region] = \"East\"\n\nrole Me\n\ttablePermission Sales = Sales[Region] = USERNAME()\n");
        let docs2 = vec![biforge_model::tmdl::parse(&model).unwrap()];
        assert_eq!(roles_of(&docs2).len(), 2);
        let total = |v: Option<ViewAs>| dax.query_as(&docs2, "EVALUATE ROW(\"v\", [Total])", v.as_ref()).map(|o| o.results[0].rows[0][0].v.clone());
        assert_eq!(total(None).unwrap(), "10");
        assert_eq!(total(Some(ViewAs { roles: vec!["EastOnly".into()], identity: String::new() })).unwrap(), "7");
        assert_eq!(total(Some(ViewAs { roles: vec!["Me".into()], identity: "West".into() })).unwrap(), "3");
        assert!(total(Some(ViewAs { roles: vec!["Nope".into()], identity: String::new() })).unwrap_err().contains("does not exist"));
        // after viewing as a role, the unrestricted engine is back
        assert_eq!(total(None).unwrap(), "10");
    }


    #[test]
    fn the_automatic_date_table_covers_whole_years_with_the_hierarchy_columns() {
        let d = tempfile::tempdir().unwrap();
        let svc = DataService::new(Arc::new(MemoryCredentialStore::default()));
        svc.open_store(&d.path().to_string_lossy()).unwrap();
        let csv = d.path().join("o.csv");
        std::fs::write(&csv, "Id,Day\n1,2023-03-15\n2,2024-11-02\n").unwrap();
        svc.import("Orders", &SourceSpec::Csv { path: csv.to_string_lossy().into_owned(), delimiter: None, header: None }).unwrap();
        let model = "table Orders\n\tcolumn Id\n\t\tdataType: int64\n\tcolumn Day\n\t\tdataType: dateTime\n";
        let docs = vec![biforge_model::tmdl::parse(model).unwrap()];
        let dax = DaxService { data: &svc };
        let info = dax.calc_table(&docs, "LocalDateTable_Orders_Day", "ADDCOLUMNS(CALENDAR(DATE(YEAR(MIN('Orders'[Day])), 1, 1), DATE(YEAR(MAX('Orders'[Day])), 12, 31)), \"Year\", YEAR([Date]), \"MonthNo\", MONTH([Date]), \"Month\", FORMAT([Date], \"MMMM\"), \"QuarterNo\", QUARTER([Date]), \"Quarter\", \"Qtr \" & QUARTER([Date]), \"Day\", DAY([Date]))").unwrap();
        assert_eq!(info.row_count, 731, "2023 and 2024");
        assert_eq!(info.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Date", "Year", "MonthNo", "Month", "QuarterNo", "Quarter", "Day"]);
        let page = svc.fetch_page("LocalDateTable_Orders_Day", 74, 1, None).unwrap();
        assert_eq!(page.rows[0].iter().map(|c| c.clone().unwrap_or_default()).collect::<Vec<_>>()[1..], ["2023", "3", "March", "1", "Qtr 1", "16"]);
    }

    #[test]
    fn repeated_queries_reuse_the_loaded_engine_until_the_model_or_the_data_change() {
        let (d, svc, docs) = setup();
        let dax = DaxService { data: &svc };
        let q = "EVALUATE ROW(\"v\", [Total])";
        assert_eq!(dax.query(&docs, q).unwrap().results[0].rows[0][0].v, "10");
        dax.query(&docs, "EVALUATE ROW(\"v\", [Total] + 1)").unwrap();
        assert_eq!(svc.dax_cache.loads(), 1, "the second query reloaded the model");
        // a changed model loads again
        let docs2 = vec![biforge_model::tmdl::parse(&MODEL.replace("measure Total = SUM(Sales[Qty])", "measure Total = SUM(Sales[Qty]) * 2")).unwrap()];
        assert_eq!(dax.query(&docs2, q).unwrap().results[0].rows[0][0].v, "20");
        assert_eq!(svc.dax_cache.loads(), 2);
        // refreshed data loads again and the answer changes
        std::fs::write(d.path().join("s.csv"), "Region,Qty
East,100
").unwrap();
        svc.import("Sales", &SourceSpec::Csv { path: d.path().join("s.csv").to_string_lossy().into_owned(), delimiter: None, header: None }).unwrap();
        assert_eq!(dax.query(&docs2, q).unwrap().results[0].rows[0][0].v, "200");
        assert_eq!(svc.dax_cache.loads(), 3);
        // a different store never reuses another store's engine
        let other = tempfile::tempdir().unwrap();
        svc.open_store(&other.path().to_string_lossy()).unwrap();
        assert!(dax.query(&docs2, q).is_err() || svc.dax_cache.loads() == 4);
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
