//! Analysis Services against a running Power BI Desktop (its local tabular instance), when there is one: the port is
//! read from the newest msmdsrv.port.txt of Desktop's workspace folders, or from BIFORGE_TEST_AS (host:port). Prints
//! SKIPPED and passes when no instance is found (CI has none). Read-only: only schema queries and EVALUATE are sent.
#![cfg(windows)]

use biforge_engine::{source_choices, source_preview, Engine, MemoryCredentialStore, SourceSpec};

fn server() -> Option<String> {
    if let Ok(s) = std::env::var("BIFORGE_TEST_AS") {
        return Some(s);
    }
    let mut roots = vec![];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(std::path::Path::new(&local).join("Microsoft/Power BI Desktop/AnalysisServicesWorkspaces"));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        roots.push(std::path::Path::new(&home).join("Microsoft/Power BI Desktop Store App/AnalysisServicesWorkspaces"));
    }
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for root in roots {
        for dir in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            let f = dir.path().join("Data/msmdsrv.port.txt");
            if let Ok(m) = std::fs::metadata(&f).and_then(|m| m.modified()) {
                if best.as_ref().map_or(true, |(t, _)| m > *t) {
                    best = Some((m, f));
                }
            }
        }
    }
    let bytes = std::fs::read(best?.1).ok()?;
    // the file is UTF-16LE without a trailing newline
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    let port = String::from_utf16_lossy(&units).trim_matches(|c: char| c == '\u{feff}' || c.is_whitespace()).to_string();
    port.parse::<u16>().ok().map(|p| format!("localhost:{p}"))
}

#[test]
fn reads_the_model_of_the_open_power_bi_desktop_instance() {
    let Some(server) = server() else {
        println!("SKIPPED: no Power BI Desktop Analysis Services instance found");
        return;
    };
    let c = MemoryCredentialStore::default();
    let e = Engine::in_memory().unwrap();
    // the catalog (database) name of a Desktop model is a GUID: ask the instance
    let probe = SourceSpec::OleDb { connection: format!("Provider=MSOLAP;Data Source={server}"), user: None, table: None, query: Some("SELECT [CATALOG_NAME] FROM $SYSTEM.DBSCHEMA_CATALOGS".into()) };
    let cat = match source_preview(&probe, &c, 10) {
        Ok(t) => t.rows[0][0].clone().unwrap_or_default(),
        Err(m) => {
            println!("SKIPPED: the instance does not answer ({m})");
            return;
        }
    };
    let spec = |table: Option<&str>, query: Option<&str>| SourceSpec::AnalysisServices { server: server.clone(), database: cat.trim_matches('"').into(), user: None, table: table.map(Into::into), query: query.map(Into::into) };
    let tables = source_choices(&spec(None, None), &c).unwrap();
    println!("tables of the open model: {tables:?}");
    assert!(!tables.is_empty() && tables.iter().all(|t| !t.starts_with('$')), "the model has tables, without the internal $ ones");
    let info = e.import("T", &spec(Some(&tables[0]), None), &c).unwrap();
    println!("{} has {} rows, {} columns", tables[0], info.row_count, info.columns.len());
    assert!(!info.columns.is_empty());
    let q = e.import("Q", &spec(None, Some("EVALUATE ROW(\"x\", 1 + 1)")), &c).unwrap();
    assert_eq!(q.row_count, 1);
}
