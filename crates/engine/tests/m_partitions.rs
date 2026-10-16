//! The M text that the app writes into TMDL partitions (tests/m/*.m, produced by app/src/core/model/partitionM.ts and
//! checked by a vitest contract test) is run by BIForge's M engine and must give exactly what the engine's own CSV import gives.
mod fixture;

use biforge_engine::{BiType, Engine, MemoryCredentialStore, SourceSpec};
use std::collections::BTreeMap;

fn plain(s: &str) -> String {
    match s.strip_suffix(".0") {
        Some(h) if !h.is_empty() && h.trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) => h.to_string(),
        _ => s.to_string(),
    }
}

#[test]
fn generated_partition_m_reproduces_the_csv_import() {
    let e = Engine::in_memory().unwrap();
    let creds = MemoryCredentialStore::default();
    let dir = fixture::fixtures();
    let mdir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/m");
    for table in ["Sales", "Customer", "Date"] {
        let path = dir.join(format!("{table}.csv")).to_string_lossy().into_owned();
        let info = e.import(table, &SourceSpec::Csv { path, delimiter: None, header: None }, &creds).unwrap();
        let m = std::fs::read_to_string(mdir.join(format!("partition_{table}.m"))).unwrap().replace("{{FIXTURES}}", &dir.to_string_lossy().replace('\\', "/"));
        let qs: BTreeMap<String, String> = [("Q".to_string(), m)].into_iter().collect();
        let page = e.m_preview(&qs, "Q", None, 10_000).unwrap_or_else(|err| panic!("{table}: {err}"));
        let got_cols: Vec<(String, BiType)> = page.columns.iter().map(|c| (c.name.clone(), c.bi_type)).collect();
        let want_cols: Vec<(String, BiType)> = info.columns.iter().map(|c| (c.name.clone(), c.bi_type)).collect();
        assert_eq!(got_cols, want_cols, "{table}: columns and types");
        assert_eq!(page.total, info.row_count, "{table}: row count");
        let want = e.fetch_page(table, 0, 10_000, None).unwrap();
        for (i, (g, w)) in page.rows.iter().zip(&want.rows).enumerate() {
            let g: Vec<Option<String>> = g.iter().map(|c| c.as_deref().map(plain)).collect();
            let w: Vec<Option<String>> = w.iter().map(|c| c.as_deref().map(plain)).collect();
            assert_eq!(g, w, "{table}: row {i}");
        }
    }
}
