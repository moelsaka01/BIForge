//! The M standard library, case by case. Every case in tests/m/stdlib/*.json is an M expression with the value Power Query gives
//! (written from the function's documented behavior). "cell" cases run the expression per row in a table column (the SQL path
//! of scalar functions); "value" cases evaluate it as a plain value (lists and records) and compare "{a,b}" / "[k=v]" text.
//! A guard checks that every function the engine reports as supported has a case here, except the ones listed in
//! covered-before-sprint.txt (they were accepted before this harness existed and are tested in the other m_*.rs files).
use biforge_engine::Engine;
use biforge_m::stdlib::supported_functions;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[derive(serde::Deserialize)]
struct Case {
    /// the function the case is about (the guard looks for this name)
    #[serde(rename = "fn")]
    func: String,
    m: String,
    expect: String,
    #[serde(default)]
    mode: Option<String>,
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/m/stdlib")
}

fn cases() -> Vec<(String, Case)> {
    let mut out = Vec::new();
    let mut files: Vec<_> = std::fs::read_dir(dir()).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    for f in files {
        let list: Vec<Case> = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        out.extend(list.into_iter().map(|c| (name.clone(), c)));
    }
    out
}

fn plain(s: &str) -> String {
    match s.strip_suffix(".0") {
        Some(h) if !h.is_empty() && h.trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) => h.to_string(),
        _ => s.to_string(),
    }
}

fn run(e: &Engine, c: &Case) -> Result<String, String> {
    let mut qs = BTreeMap::new();
    if c.mode.as_deref() == Some("value") {
        qs.insert("Q".to_string(), format!("let V = {} in V", c.m));
        let v = e.m_value(&qs, "Q", None).map_err(|x| x.to_string())?;
        Ok(match v.kind.as_str() {
            "list" => format!("{{{}}}", v.items.join(",")),
            "record" => format!("[{}]", v.items.join(",")),
            _ => v.text,
        })
    } else {
        qs.insert("Q".to_string(), format!("let T = Table.AddColumn(#table({{\"a\"}}, {{{{1}}}}), \"v\", each {}) in T", c.m));
        let page = e.m_preview(&qs, "Q", None, 10).map_err(|x| x.to_string())?;
        let cell = page.rows.first().and_then(|r| r.get(1)).cloned().flatten();
        Ok(cell.map(|s| plain(&s)).unwrap_or_else(|| "null".to_string()))
    }
}

#[test]
fn every_case_gives_the_documented_value() {
    let e = Engine::in_memory().unwrap();
    let mut bad = Vec::new();
    let all = cases();
    assert!(!all.is_empty());
    for (file, c) in &all {
        match run(&e, c) {
            Ok(got) if got == c.expect => {}
            Ok(got) => bad.push(format!("{file}: {} gave {got:?}, expected {:?}", c.m, c.expect)),
            Err(err) => bad.push(format!("{file}: {} failed: {err}", c.m)),
        }
    }
    assert!(bad.is_empty(), "{} of {} cases differ:\n{}", bad.len(), all.len(), bad.join("\n"));
}

#[test]
fn every_supported_function_has_a_case() {
    let before: BTreeSet<String> = std::fs::read_to_string(dir().join("covered-before-sprint.txt")).unwrap().lines().map(String::from).collect();
    let have: BTreeSet<String> = cases().into_iter().map(|(_, c)| c.func).collect();
    let missing: Vec<&str> = supported_functions().into_iter().filter(|f| !before.contains(*f) && !have.contains(*f)).collect();
    assert!(missing.is_empty(), "supported functions without a case in tests/m/stdlib: {missing:?}");
    // a case names a function that exists
    let supported: BTreeSet<&str> = supported_functions().into_iter().collect();
    let unknown: Vec<&String> = have.iter().filter(|f| !supported.contains(f.as_str())).collect();
    assert!(unknown.is_empty(), "cases for functions that are not supported: {unknown:?}");
}
