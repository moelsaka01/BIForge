//! tests/dax conformance runner. Every case file in tests/dax/cases/*.json holds DAX queries with the expected
//! result (recorded from the reference engine on the fixture model, or written by hand from public
//! documentation). Each query runs on the BIForge engine over the fixture data and is compared.
//!
//! Outcomes: pass, FAIL (the test fails), skip (the engine reports "not implemented": never counted as a
//! pass), pending (no expected result recorded yet). The summary line gives the pass rate over recorded
//! cases. Set BIFORGE_DAX_VERBOSE=1 to list every case.
//!
//! Case file format: see tests/dax/README.md.

mod fixture;

use biforge_dax::diag::ErrorCode;
use biforge_dax::value::{parse_datetime_literal, Value};
use biforge_dax::ResultTable;
use serde_json::Value as Json;
use std::cmp::Ordering;
use std::path::PathBuf;

#[derive(Debug, PartialEq)]
enum Outcome {
    Pass,
    Fail(String),
    Skip(String),
    /// No expected result yet; carries the engine error text when our engine fails on the query.
    Pending(Option<String>),
}

fn cases_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/dax/cases")
}

/// Converts a JSON cell to a value; `ty` is the column type recorded next to the rows.
fn cell(j: &Json, ty: &str) -> Result<Value, String> {
    Ok(match j {
        Json::Null => Value::Blank,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => match ty {
            "currency" => Value::Currency((n.as_f64().unwrap() * 10_000.0).round() as i64),
            "datetime" => Value::DateTime(n.as_f64().unwrap()),
            _ => match n.as_i64() {
                Some(i) if ty != "real" => Value::Int(i),
                _ => Value::Double(n.as_f64().unwrap()),
            },
        },
        Json::String(s) => {
            if ty == "real" && matches!(s.as_str(), "NaN" | "Infinity" | "-Infinity") {
                Value::Double(match s.as_str() {
                    "NaN" => f64::NAN,
                    "Infinity" => f64::INFINITY,
                    _ => f64::NEG_INFINITY,
                })
            } else if ty == "datetime" {
                Value::DateTime(parse_datetime_literal(s).ok_or_else(|| format!("bad datetime '{s}'"))?)
            } else {
                Value::str(s)
            }
        }
        other => return Err(format!("unsupported cell {other}")),
    })
}

fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Blank, Value::Blank) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Blank, _) | (_, Value::Blank) | (Value::Str(_), _) | (_, Value::Str(_)) | (Value::Bool(_), _) | (_, Value::Bool(_)) => false,
        (x, y) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            x == y || (x.is_nan() && y.is_nan()) || (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0)
        }
    }
}

fn type_of(v: &Value) -> &'static str {
    match v {
        Value::Blank => "blank",
        Value::Bool(_) => "bool",
        Value::Int(_) => "int",
        Value::Double(_) => "real",
        Value::Currency(_) => "currency",
        Value::Str(_) => "text",
        Value::DateTime(_) => "datetime",
    }
}

fn row_cmp(a: &[Value], b: &[Value]) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        let o = biforge_dax::value::sort_cmp(x, y);
        if o != Ordering::Equal {
            return o;
        }
    }
    Ordering::Equal
}

fn show(row: &[Value]) -> String {
    row.iter().map(|v| if v.is_blank() { "(blank)".to_string() } else { format!("{}:{}", type_of(v), v.to_text()) }).collect::<Vec<_>>().join(" | ")
}

/// Compares an actual result with the expected block of a case.
fn compare(actual: &ResultTable, expected: &Json, ordered: bool) -> Outcome {
    let cols: Vec<String> = expected["columns"].as_array().map(|a| a.iter().map(|c| c.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
    let types: Vec<String> = expected["types"].as_array().map(|a| a.iter().map(|c| c.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
    let ty = |i: usize| types.get(i).map(|s| s.as_str()).unwrap_or("");
    if actual.columns.len() != cols.len() || actual.columns.iter().zip(&cols).any(|(a, b)| !a.eq_ignore_ascii_case(b)) {
        return Outcome::Fail(format!("columns: expected {cols:?}, got {:?}", actual.columns));
    }
    let mut want: Vec<Vec<Value>> = Vec::new();
    for r in expected["rows"].as_array().cloned().unwrap_or_default() {
        let r = r.as_array().cloned().unwrap_or_default();
        let mut out = Vec::new();
        for (i, c) in r.iter().enumerate() {
            match cell(c, ty(i)) {
                Ok(v) => out.push(v),
                Err(e) => return Outcome::Fail(format!("case file: {e}")),
            }
        }
        want.push(out);
    }
    let mut got = actual.rows.clone();
    if want.len() != got.len() {
        return Outcome::Fail(format!("row count: expected {}, got {}", want.len(), got.len()));
    }
    if !ordered {
        want.sort_by(|a, b| row_cmp(a, b));
        got.sort_by(|a, b| row_cmp(a, b));
    }
    for (n, (w, g)) in want.iter().zip(&got).enumerate() {
        if w.len() != g.len() || w.iter().zip(g).any(|(x, y)| !same_value(x, y)) {
            return Outcome::Fail(format!("row {n}: expected [{}], got [{}]", show(w), show(g)));
        }
        // the type of a non-blank cell must match the recorded column type (Integer vs Real vs Currency)
        for (i, y) in g.iter().enumerate() {
            let t = ty(i);
            if !t.is_empty() && !y.is_blank() && t != "mixed" && t != type_of(y) && !(t == "real" && type_of(y) == "int") {
                return Outcome::Fail(format!("row {n}, column {}: expected type {t}, got {}", cols[i], type_of(y)));
            }
        }
    }
    Outcome::Pass
}

fn run_case(dax: &biforge_dax::Engine, case: &Json) -> Outcome {
    let expected = &case["expected"];
    let query = case["query"].as_str().unwrap_or("");
    if expected.is_null() {
        return Outcome::Pending(dax.query(query).err().map(|e| e.message));
    }
    let ordered = case["ordered"].as_bool().unwrap_or_else(|| query.to_ascii_uppercase().contains("ORDER BY"));
    let result = dax.query(query);
    if expected.get("error").is_some() {
        return match result {
            Err(e) if e.code == ErrorCode::NotImplemented => Outcome::Skip(e.message),
            Err(_) => Outcome::Pass,
            Ok(_) => Outcome::Fail("expected an error, the query succeeded".into()),
        };
    }
    match result {
        Err(e) if e.code == ErrorCode::NotImplemented => Outcome::Skip(e.message),
        Err(e) => Outcome::Fail(format!("error: {}", e.message)),
        Ok(tables) => match tables.first() {
            Some(t) => compare(t, expected, ordered),
            None => Outcome::Fail("the query has no EVALUATE".into()),
        },
    }
}

#[test]
fn comparison_rules() {
    let t = ResultTable { columns: vec!["[A]".into(), "[B]".into()], rows: vec![vec![Value::Int(2), Value::str("x")], vec![Value::Int(1), Value::Blank]] };
    let exp = |rows: &str| serde_json::from_str::<Json>(&format!(r#"{{"columns":["[A]","[B]"],"types":["int","text"],"rows":{rows}}}"#)).unwrap();
    assert_eq!(compare(&t, &exp(r#"[[1,null],[2,"x"]]"#), false), Outcome::Pass);
    assert!(matches!(compare(&t, &exp(r#"[[1,null],[2,"x"]]"#), true), Outcome::Fail(_)));
    assert!(matches!(compare(&t, &exp(r#"[[1,null],[2,"y"]]"#), false), Outcome::Fail(_)));
    assert!(matches!(compare(&t, &exp(r#"[[1,null]]"#), false), Outcome::Fail(_)));
    // text is compared exactly (case matters in a result even though filters ignore case)
    assert!(matches!(compare(&t, &exp(r#"[[1,null],[2,"X"]]"#), false), Outcome::Fail(_)));
    // a real column accepts an integer-valued number but an int column does not accept a real
    let r = ResultTable { columns: vec!["[A]".into()], rows: vec![vec![Value::Double(2.0)]] };
    let e2 = serde_json::from_str::<Json>(r#"{"columns":["[A]"],"types":["int"],"rows":[[2]]}"#).unwrap();
    assert!(matches!(compare(&r, &e2, false), Outcome::Fail(_)));
    let e3 = serde_json::from_str::<Json>(r#"{"columns":["[A]"],"types":["real"],"rows":[[2]]}"#).unwrap();
    assert_eq!(compare(&r, &e3, false), Outcome::Pass);
    let d = ResultTable { columns: vec!["[D]".into()], rows: vec![vec![Value::DateTime(biforge_dax::value::date_serial(2024, 2, 29).unwrap())]] };
    let e4 = serde_json::from_str::<Json>(r#"{"columns":["[D]"],"types":["datetime"],"rows":[["2024-02-29T00:00:00"]]}"#).unwrap();
    assert_eq!(compare(&d, &e4, false), Outcome::Pass);
}

#[test]
fn conformance_cases() {
    let (_store, dax) = fixture::setup();
    let mut files: Vec<PathBuf> = std::fs::read_dir(cases_dir()).map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect()).unwrap_or_default();
    files.sort();
    let verbose = std::env::var("BIFORGE_DAX_VERBOSE").is_ok();
    let (mut pass, mut skip, mut pending) = (0usize, 0usize, 0usize);
    let mut failures = Vec::new();
    let mut skipped_names = Vec::new();
    let mut pending_err: Vec<String> = Vec::new();
    for f in &files {
        let doc: Json = serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        for case in doc["cases"].as_array().cloned().unwrap_or_default() {
            let id = case["id"].as_str().unwrap_or("?").to_string();
            let out = run_case(&dax, &case);
            if verbose {
                println!("{id}: {out:?}");
            }
            match out {
                Outcome::Pass => pass += 1,
                Outcome::Skip(m) => {
                    skip += 1;
                    skipped_names.push(format!("{id}: {m}"));
                }
                Outcome::Pending(e) => {
                    pending += 1;
                    if let Some(m) = e {
                        pending_err.push(format!("{id}: {m}"));
                    }
                }
                Outcome::Fail(m) => failures.push(format!("{id}: {m}")),
            }
        }
    }
    let recorded = pass + skip + failures.len();
    println!("conformance: {pass}/{recorded} pass, {} fail, {skip} skipped (not implemented), {pending} pending (no expected result recorded)", failures.len());
    println!("pending cases on which BIForge reports an error: {}", pending_err.len());
    if verbose {
        for s in &pending_err {
            println!("  pending-error {s}");
        }
    }
    for s in skipped_names.iter().take(20) {
        println!("  skipped {s}");
    }
    if let Ok(path) = std::env::var("BIFORGE_DAX_REPORT") {
        let _ = std::fs::write(path, format!("{pass} {recorded} {} {skip} {pending}\n", failures.len()));
    }
    assert!(failures.is_empty(), "{} conformance case(s) failed:\n{}", failures.len(), failures.join("\n"));
}
