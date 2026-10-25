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

// A tiny PNG made with the standard library only, so that the test does not need matplotlib.
const PNG_SCRIPT: &str = r#"
import os, struct, zlib
def chunk(t, d):
    c = struct.pack(">I", len(d)) + t + d
    return c + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
rows = b"".join(b"\x00" + bytes([int(v) % 256, 0, 0]) * 2 for v in dataset.iloc[:, 0])
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, len(dataset), 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
open(os.environ["BIFORGE_PLOT"], "wb").write(png)
"#;

#[test]
fn python_visual_gets_the_data_as_dataset_and_returns_the_plot() {
    use biforge_engine::sources::script_src::run_visual_script;
    match run_visual_script("python", PNG_SCRIPT, "a,b\n10,x\n20,y\n30,z\n", None, 200, 100, None) {
        Ok(png) => {
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
            assert!(png.len() > 40);
        }
        Err(e) => {
            let m = e.to_string();
            if m.contains("did not find") || m.contains("pandas package is not installed") {
                println!("SKIPPED python visual: {m}");
                return;
            }
            panic!("{m}");
        }
    }
    // errors are the interpreter's own message; a script that draws nothing says so
    let e = run_visual_script("python", "raise ValueError('asked to fail')", "a\n1\n", None, 100, 100, None).unwrap_err().to_string();
    assert!(e.contains("ValueError") && e.contains("asked to fail"), "{e}");
    let e = run_visual_script("python", "x = 1", "a\n1\n", None, 100, 100, None).unwrap_err().to_string();
    assert!(e.contains("drew nothing"), "{e}");
    assert!(run_visual_script("ruby", "x", "a\n1\n", None, 1, 1, None).is_err());
    assert!(run_visual_script("python", "   ", "a\n1\n", None, 1, 1, None).is_err());
}
