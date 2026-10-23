//! Runs the DAX that the report layer generates (tests/reports/query-cases.json, written by the vitest suite
//! app/src/core/report/queryBuilder.test.ts) on the engine over the fixture data, and compares with the rows that
//! the vitest suite computed from the CSV files. This checks that generated queries are valid DAX and that the
//! engine returns what a direct computation over the data gives.

mod fixture;

use biforge_dax::value::Value;
use biforge_dax::ResultTable;
use serde_json::Value as Json;
use std::cmp::Ordering;
use std::path::PathBuf;

fn golden() -> Json {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/reports/query-cases.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("tests/reports/query-cases.json")).expect("valid JSON")
}

fn same(actual: &Value, expected: &Json) -> bool {
    match expected {
        Json::Null => actual.is_blank(),
        Json::Number(n) => match actual.as_f64() {
            Some(a) => {
                let e = n.as_f64().unwrap();
                (a - e).abs() <= 1e-9 * a.abs().max(e.abs()).max(1.0)
            }
            None => false,
        },
        Json::String(s) => actual.to_text() == *s,
        Json::Bool(b) => matches!(actual, Value::Bool(x) if x == b),
        _ => false,
    }
}

fn cmp_rows(a: &[String], b: &[String]) -> Ordering {
    a.cmp(b)
}

fn compare(actual: &ResultTable, expected: &Json, ordered: bool) -> Result<(), String> {
    let exp: Vec<&Vec<Json>> = expected.as_array().unwrap().iter().map(|r| r.as_array().unwrap()).collect();
    if actual.rows.len() != exp.len() {
        return Err(format!("expected {} rows, got {}: {:?}", exp.len(), actual.rows.len(), actual.rows.iter().map(|r| r.iter().map(|v| v.to_text()).collect::<Vec<_>>()).collect::<Vec<_>>()));
    }
    let width = exp.first().map(|r| r.len()).unwrap_or(0);
    let render = |r: &[Value]| r.iter().take(width).map(|v| v.to_text()).collect::<Vec<_>>();
    let mut act: Vec<&Vec<Value>> = actual.rows.iter().collect();
    let mut exp = exp;
    if !ordered {
        act.sort_by(|a, b| cmp_rows(&render(a), &render(b)));
        let key = |r: &Vec<Json>| r.iter().map(|j| if j.is_null() { String::new() } else if let Some(n) = j.as_f64() { format!("{}", Value::Double(n).to_text()) } else { j.as_str().unwrap_or("").to_string() }).collect::<Vec<_>>();
        exp.sort_by(|a, b| cmp_rows(&key(a), &key(b)));
    }
    for (i, (a, e)) in act.iter().zip(&exp).enumerate() {
        for (j, ej) in e.iter().enumerate() {
            if !same(&a[j], ej) {
                return Err(format!("row {i} column {j}: expected {ej}, got {:?} (row {:?})", a[j].to_text(), render(a)));
            }
        }
    }
    Ok(())
}

#[test]
fn generated_report_queries_match_the_fixture_data() {
    check_all(false);
}

/// The same queries with aggregations (and whole group-bys) compiled to SQL, as the app runs them.
#[test]
fn generated_report_queries_match_the_fixture_data_through_sql() {
    check_all(true);
}

fn check_all(use_sql: bool) {
    let (store, dax) = fixture::setup();
    let sql: Option<&dyn biforge_dax::sql::SqlExecutor> = if use_sql { Some(&store) } else { None };
    let g = golden();
    let cases = g["cases"].as_array().unwrap();
    assert!(cases.len() >= 20, "golden file looks empty");
    let mut failures = Vec::new();
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let q = c["dax"].as_str().unwrap();
        let ordered = c["ordered"].as_bool().unwrap_or(true);
        match dax.query_with(q, sql) {
            Err(e) => failures.push(format!("{id}: query failed: {}\n   {q}", e.message)),
            Ok(tables) => {
                let expected = c["expected"].as_array().unwrap();
                if tables.len() != expected.len() {
                    failures.push(format!("{id}: expected {} result sets, got {}", expected.len(), tables.len()));
                    continue;
                }
                for (k, (t, e)) in tables.iter().zip(expected).enumerate() {
                    if let Err(m) = compare(t, e, ordered) {
                        failures.push(format!("{id} [set {k}]: {m}\n   {q}"));
                    }
                }
            }
        }
    }
    println!("report queries: {}/{} pass", cases.len() - failures.len(), cases.len());
    assert!(failures.is_empty(), "{} generated query case(s) failed:\n{}", failures.len(), failures.join("\n"));
}
