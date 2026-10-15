//! Tauri wrappers around `biforge-engine`. `DataService` holds the logic so it can be tested without a window.

use biforge_engine::{
    CredentialStore, Engine, EngineError, RelationshipHint, RowPage, SortSpec, SourceSpec, SystemCredentialStore, TableInfo,
};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct DataService {
    engine: Mutex<Option<Engine>>,
    creds: Arc<dyn CredentialStore>,
}

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

impl DataService {
    pub fn new(creds: Arc<dyn CredentialStore>) -> Self {
        Self { engine: Mutex::new(None), creds }
    }

    pub fn system() -> Self {
        Self::new(Arc::new(SystemCredentialStore))
    }

    fn with<T>(&self, f: impl FnOnce(&Engine) -> Result<T, EngineError>) -> Result<T, String> {
        let g = self.engine.lock().map_err(|_| "The data store is unavailable.".to_string())?;
        let e = g.as_ref().ok_or("No project is open, so there is no data store.")?;
        f(e).map_err(msg)
    }

    /// Opens `<root>/.biforge/data.duckdb` and returns the tables it holds. The folder gets a `.gitignore` so data is never committed.
    pub fn open_store(&self, root: &str) -> Result<Vec<String>, String> {
        let dir = Path::new(root).join(".biforge");
        std::fs::create_dir_all(&dir).map_err(msg)?;
        let ignore = dir.join(".gitignore");
        if !ignore.exists() {
            std::fs::write(&ignore, "*\n").map_err(msg)?;
        }
        let mut slot = self.engine.lock().map_err(|_| "The data store is unavailable.".to_string())?;
        // Release the previous store first: DuckDB allows one connection owner per file, so re-opening the same project must not conflict with ourselves.
        *slot = None;
        let engine = Engine::open(&dir.join("data.duckdb")).map_err(msg)?;
        let names = engine.table_names().map_err(msg)?;
        *slot = Some(engine);
        Ok(names)
    }

    pub fn import(&self, table: &str, spec: &SourceSpec) -> Result<TableInfo, String> {
        let creds = self.creds.clone();
        self.with(|e| e.import(table, spec, creds.as_ref()))
    }
    pub fn table_info(&self, table: &str) -> Result<Option<TableInfo>, String> {
        self.with(|e| if e.has_table(table)? { e.table_info(table).map(Some) } else { Ok(None) })
    }
    pub fn drop_table(&self, table: &str) -> Result<(), String> {
        self.with(|e| e.drop_table(table))
    }
    pub fn fetch_page(&self, table: &str, offset: u64, limit: u64, sort: Option<SortSpec>) -> Result<RowPage, String> {
        self.with(|e| e.fetch_page(table, offset, limit.min(5000), sort.as_ref()))
    }
    pub fn suggest(&self, from: (String, String), to: (String, String)) -> Result<RelationshipHint, String> {
        self.with(|e| e.suggest_relationship((&from.0, &from.1), (&to.0, &to.1)))
    }
    pub fn set_credential(&self, spec: &SourceSpec, secret: &str) -> Result<(), String> {
        let key = spec.credential_key().ok_or("This source type does not use a stored credential.")?;
        self.creds.set(&key, secret).map_err(msg)
    }
    pub fn postgres_tables(&self, spec: &SourceSpec) -> Result<Vec<String>, String> {
        biforge_engine::postgres_tables(spec, self.creds.as_ref()).map_err(msg)
    }
}

#[tauri::command]
pub fn engine_open_store(state: tauri::State<DataService>, root: String) -> Result<Vec<String>, String> {
    state.open_store(&root)
}
#[tauri::command]
pub fn engine_import(state: tauri::State<DataService>, table: String, spec: SourceSpec) -> Result<TableInfo, String> {
    state.import(&table, &spec)
}
#[tauri::command]
pub fn engine_table_info(state: tauri::State<DataService>, table: String) -> Result<Option<TableInfo>, String> {
    state.table_info(&table)
}
#[tauri::command]
pub fn engine_drop_table(state: tauri::State<DataService>, table: String) -> Result<(), String> {
    state.drop_table(&table)
}
#[tauri::command]
pub fn engine_fetch_page(
    state: tauri::State<DataService>,
    table: String,
    offset: u64,
    limit: u64,
    sort: Option<SortSpec>,
) -> Result<RowPage, String> {
    state.fetch_page(&table, offset, limit, sort)
}
#[tauri::command]
pub fn engine_suggest_relationship(
    state: tauri::State<DataService>,
    from: (String, String),
    to: (String, String),
) -> Result<RelationshipHint, String> {
    state.suggest(from, to)
}
#[tauri::command]
pub fn engine_excel_sheets(path: String) -> Result<Vec<String>, String> {
    biforge_engine::excel_sheets(&path).map_err(msg)
}
#[tauri::command]
pub fn engine_sqlite_tables(path: String) -> Result<Vec<String>, String> {
    biforge_engine::sqlite_tables(&path).map_err(msg)
}
#[tauri::command]
pub fn engine_postgres_tables(state: tauri::State<DataService>, spec: SourceSpec) -> Result<Vec<String>, String> {
    state.postgres_tables(&spec)
}
#[tauri::command]
pub fn engine_set_credential(state: tauri::State<DataService>, spec: SourceSpec, secret: String) -> Result<(), String> {
    state.set_credential(&spec, &secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    use biforge_engine::MemoryCredentialStore;

    #[test]
    fn service_opens_store_imports_pages_and_reports_readable_errors() {
        let d = tempfile::tempdir().unwrap();
        let svc = DataService::new(Arc::new(MemoryCredentialStore::default()));
        assert!(svc.import("T", &SourceSpec::Json { path: "x".into() }).unwrap_err().contains("No project is open"));

        let root = d.path().to_string_lossy().into_owned();
        assert!(svc.open_store(&root).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(d.path().join(".biforge/.gitignore")).unwrap(), "*\n");

        let csv = d.path().join("a.csv");
        std::fs::write(&csv, "k,v\n2,b\n1,a\n").unwrap();
        let spec = SourceSpec::Csv { path: csv.to_string_lossy().into_owned(), delimiter: None, header: None };
        let info = svc.import("T", &spec).unwrap();
        assert_eq!(info.row_count, 2);
        let page = svc.fetch_page("T", 0, 10, Some(SortSpec { column: "k".into(), descending: false })).unwrap();
        assert_eq!(page.rows[0][0].as_deref(), Some("1"));
        assert!(svc.table_info("Nope").unwrap().is_none());
        assert!(svc.fetch_page("Nope", 0, 1, None).unwrap_err().contains("Nope"));
        let hint = svc.suggest(("T".into(), "k".into()), ("T".into(), "k".into())).unwrap();
        assert!(hint.from_unique && hint.to_unique);
        assert!(svc.set_credential(&spec, "x").is_err());

        // re-opening the same project in the same app works and finds the data again
        assert_eq!(svc.open_store(&root).unwrap(), vec!["T"]);

        // a second process/service cannot open a store that is in use; the error is readable and the first keeps working
        let other = DataService::new(Arc::new(MemoryCredentialStore::default()));
        let err = other.open_store(&root).unwrap_err();
        assert!(err.contains("used by another process"), "{err}");
        assert!(svc.table_info("T").unwrap().is_some());

        svc.drop_table("T").unwrap();
        assert!(svc.table_info("T").unwrap().is_none());
    }
}
