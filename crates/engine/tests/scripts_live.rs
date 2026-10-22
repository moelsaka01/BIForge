//! The Python and R wrappers with the real interpreters. Each test prints SKIPPED and passes when the interpreter is
//! not installed (CI has none of pandas); on a PC with Python (pandas) and R they run for real.

use biforge_engine::{Engine, MemoryCredentialStore, SourceSpec};

fn script(lang: &str, code: &str, table: Option<&str>) -> SourceSpec {
    SourceSpec::Script { language: lang.into(), code: code.into(), table: table.map(Into::into), home: None }
}

fn run(lang: &str, code: &str) -> Option<Result<biforge_engine::TableInfo, String>> {
    let spec = script(lang, code, None);
    let e = Engine::in_memory().unwrap();
    match e.import("T", &spec, &MemoryCredentialStore::default()) {
        Ok(i) => Some(Ok(i)),
        Err(x) => {
            let m = x.to_string();
            if m.contains("not found") || m.contains("Could not find") || m.contains("install") && m.contains("Options") {
                println!("SKIPPED {lang}: {m}");
                None
            } else {
                Some(Err(m))
            }
        }
    }
}

#[test]
fn python_makes_a_table_from_a_pandas_data_frame_and_reports_errors() {
    let Some(r) = run("python", "import pandas\ndf = pandas.DataFrame({'a': [1, 2, 3], 'name': ['x', 'y', None]})") else { return };
    let info = r.expect("the script ran");
    assert_eq!(info.row_count, 3);
    assert_eq!(info.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["a", "name"]);
    let Some(Err(m)) = run("python", "raise ValueError('asked to fail')") else { panic!("must fail") };
    assert!(m.contains("ValueError") && m.contains("asked to fail"), "{m}");
    let Some(Err(m)) = run("python", "x = 1") else { panic!("must fail") };
    assert!(m.contains("no pandas DataFrame"), "{m}");
}

#[test]
fn r_makes_a_table_from_a_data_frame_and_reports_errors() {
    let Some(r) = run("r", "df <- data.frame(a = 1:3, name = c('x', 'y', NA))") else { return };
    let info = r.expect("the script ran");
    assert_eq!(info.row_count, 3);
    assert_eq!(info.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["a", "name"]);
    let Some(Err(m)) = run("r", "stop('asked to fail')") else { panic!("must fail") };
    assert!(m.contains("asked to fail"), "{m}");
}
