//! Tauri wrappers around `biforge-engine`. `DataService` holds the logic so it can be tested without a window.

use biforge_engine::{
    CredentialStore, Engine, EngineError, RelationshipHint, RowPage, SortSpec, SourceSpec, SystemCredentialStore, TableInfo,
};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct DataService {
    engine: Mutex<Option<Engine>>,
    creds: Arc<dyn CredentialStore>,
    /// The loaded DAX engine of the last query, reused while the model and the data are unchanged.
    pub dax_cache: biforge_engine::dax_bridge::DaxCache,
}

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

impl DataService {
    pub fn new(creds: Arc<dyn CredentialStore>) -> Self {
        Self { engine: Mutex::new(None), creds, dax_cache: Default::default() }
    }

    pub fn system() -> Self {
        Self::new(Arc::new(SystemCredentialStore))
    }

    fn with<T>(&self, f: impl FnOnce(&Engine) -> Result<T, EngineError>) -> Result<T, String> {
        let g = self.engine.lock().map_err(|_| "The data store is unavailable.".to_string())?;
        let e = g.as_ref().ok_or("No project is open, so there is no data store.")?;
        f(e).map_err(msg)
    }

    /// Runs `f` with the open store; the error type is the DAX layer's plain text.
    pub fn with_store<T>(&self, f: impl FnOnce(&Engine) -> Result<T, String>) -> Result<T, String> {
        let g = self.engine.lock().map_err(|_| "The data store is unavailable.".to_string())?;
        let e = g.as_ref().ok_or("No project is open, so there is no data store.")?;
        f(e)
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
        self.dax_cache.clear(); // the cached DAX engine holds its own connection to the file
        *slot = None;
        let engine = Engine::open(&dir.join("data.duckdb")).map_err(msg)?;
        let names = engine.table_names().map_err(msg)?;
        *slot = Some(engine);
        Ok(names)
    }

    /// Copies the data store of project `src_root` into `dst_root` (Save as) and keeps the copy open. The store is
    /// closed while the file is copied so that DuckDB has flushed it; if the copy fails the original is reopened.
    pub fn copy_store(&self, src_root: &str, dst_root: &str) -> Result<Vec<String>, String> {
        {
            let mut slot = self.engine.lock().map_err(|_| "The data store is unavailable.".to_string())?;
            self.dax_cache.clear();
            *slot = None;
        }
        let from = Path::new(src_root).join(".biforge").join("data.duckdb");
        let copy = (|| -> Result<(), String> {
            if !from.exists() {
                return Ok(());
            }
            let dir = Path::new(dst_root).join(".biforge");
            std::fs::create_dir_all(&dir).map_err(msg)?;
            std::fs::copy(&from, dir.join("data.duckdb")).map_err(msg)?;
            Ok(())
        })();
        match copy {
            Ok(()) => self.open_store(dst_root),
            Err(e) => {
                let _ = self.open_store(src_root);
                Err(format!("The data could not be copied: {e}"))
            }
        }
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
    pub fn rename_table(&self, old: &str, new: &str) -> Result<(), String> {
        self.with(|e| e.rename_table(old, new))
    }
    pub fn rename_column(&self, table: &str, old: &str, new: &str) -> Result<(), String> {
        self.with(|e| e.rename_column(table, old, new))
    }
    pub fn fetch_page(&self, table: &str, offset: u64, limit: u64, sorts: Vec<SortSpec>) -> Result<RowPage, String> {
        self.with(|e| e.fetch_page_sorted(table, offset, limit.min(5000), &sorts))
    }
    pub fn suggest(&self, from: (String, String), to: (String, String)) -> Result<RelationshipHint, String> {
        self.with(|e| e.suggest_relationship((&from.0, &from.1), (&to.0, &to.1)))
    }
    pub fn set_credential(&self, spec: &SourceSpec, secret: &str) -> Result<(), String> {
        let key = spec.credential_key().ok_or("This source type does not use a stored credential.")?;
        self.creds.set(&key, secret).map_err(msg)
    }
    /// Keeps the value of a secret request header of a Web source in the credential store.
    pub fn set_header_secret(&self, spec: &SourceSpec, name: &str, value: &str) -> Result<(), String> {
        let key = spec.header_credential_key(name).ok_or("Only Web sources have request headers.")?;
        self.creds.set(&key, value).map_err(msg)
    }
    pub fn sqlserver_tables(&self, spec: &SourceSpec) -> Result<Vec<String>, String> {
        biforge_engine::sqlserver_tables(spec, self.creds.as_ref()).map_err(msg)
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
pub fn engine_copy_store(state: tauri::State<DataService>, src_root: String, dst_root: String) -> Result<Vec<String>, String> {
    state.copy_store(&src_root, &dst_root)
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
pub fn engine_rename_table(state: tauri::State<DataService>, old: String, new: String) -> Result<(), String> {
    state.rename_table(&old, &new)
}
#[tauri::command]
pub fn engine_rename_column(state: tauri::State<DataService>, table: String, old: String, new: String) -> Result<(), String> {
    state.rename_column(&table, &old, &new)
}
#[tauri::command]
pub fn engine_fetch_page(
    state: tauri::State<DataService>,
    table: String,
    offset: u64,
    limit: u64,
    sort: Option<SortSpec>,
    sorts: Option<Vec<SortSpec>>,
) -> Result<RowPage, String> {
    // `sorts` orders by several columns; `sort` (one column) is what older callers send
    state.fetch_page(&table, offset, limit, sorts.unwrap_or_else(|| sort.into_iter().collect()))
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
pub fn engine_sqlserver_tables(state: tauri::State<DataService>, spec: SourceSpec) -> Result<Vec<String>, String> {
    state.sqlserver_tables(&spec)
}
#[tauri::command]
pub fn engine_source_choices(state: tauri::State<DataService>, spec: SourceSpec) -> Result<Vec<String>, String> {
    biforge_engine::source_choices(&spec, state.creds.as_ref()).map_err(msg)
}
#[tauri::command]
pub fn engine_source_preview(state: tauri::State<DataService>, spec: SourceSpec, limit: usize) -> Result<RowPage, String> {
    biforge_engine::source_preview(&spec, state.creds.as_ref(), limit.clamp(1, 1000)).map_err(msg)
}
#[tauri::command]
pub fn engine_odbc_drivers() -> Result<Vec<String>, String> {
    biforge_engine::odbc_drivers().map_err(msg)
}
#[tauri::command]
pub fn engine_credential_exists(state: tauri::State<DataService>, spec: SourceSpec) -> Result<bool, String> {
    match spec.credential_key() {
        Some(k) => Ok(state.creds.get(&k).map_err(msg)?.is_some()),
        None => Ok(false),
    }
}
#[tauri::command]
pub fn engine_clear_credential(state: tauri::State<DataService>, spec: SourceSpec) -> Result<(), String> {
    match spec.credential_key() {
        Some(k) => state.creds.delete(&k).map_err(msg),
        None => Ok(()),
    }
}
#[tauri::command]
pub fn engine_set_header_secret(state: tauri::State<DataService>, spec: SourceSpec, name: String, value: String) -> Result<(), String> {
    state.set_header_secret(&spec, &name, &value)
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
        let page = svc.fetch_page("T", 0, 10, vec![SortSpec { column: "k".into(), descending: false }]).unwrap();
        assert_eq!(page.rows[0][0].as_deref(), Some("1"));
        assert!(svc.table_info("Nope").unwrap().is_none());
        assert!(svc.fetch_page("Nope", 0, 1, vec![]).unwrap_err().contains("Nope"));
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

    #[test]
    fn copy_store_copies_the_data_keeps_the_copy_open_and_leaves_the_original_intact() {
        let d = tempfile::tempdir().unwrap();
        let (a, b) = (d.path().join("a"), d.path().join("b"));
        let svc = DataService::new(Arc::new(MemoryCredentialStore::default()));
        svc.open_store(&a.to_string_lossy()).unwrap();
        let csv = d.path().join("t.csv");
        std::fs::write(&csv, "k
1
2
3
").unwrap();
        svc.import("T", &SourceSpec::Csv { path: csv.to_string_lossy().into_owned(), delimiter: None, header: None }).unwrap();

        let names = svc.copy_store(&a.to_string_lossy(), &b.to_string_lossy()).unwrap();
        assert_eq!(names, vec!["T"]);
        assert_eq!(svc.table_info("T").unwrap().unwrap().row_count, 3);
        assert!(b.join(".biforge/data.duckdb").exists() && a.join(".biforge/data.duckdb").exists());
        // the copy is what is open now: dropping the table there leaves the original's data alone
        svc.drop_table("T").unwrap();
        assert_eq!(svc.open_store(&a.to_string_lossy()).unwrap(), vec!["T"]);

        // a project without a data store copies to an empty store
        let empty = d.path().join("empty");
        assert!(svc.copy_store(&empty.to_string_lossy(), &d.path().join("c").to_string_lossy()).unwrap().is_empty());
    }
}
