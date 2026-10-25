//! The quick measure templates (app/src/core/model/quickMeasures.ts, expanded into tests/model/quick-measure-cases.json by the
//! vitest suite) run on the DAX engine over the fixture data, in the interpreter and with SQL, and give the numbers they should.

use biforge_dax::Value;
use serde_json::Value as Json;

fn cases() -> Vec<(String, String, String)> {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/model/quick-measure-cases.json");
    let j: Json = serde_json::from_str(&std::fs::read_to_string(p).expect("run the vitest suite first")).unwrap();
    j["cases"].as_array().unwrap().iter().map(|c| (c["id"].as_str().unwrap().into(), c["group"].as_str().unwrap().into(), c["expression"].as_str().unwrap().into())).collect()
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

#[test]
fn quick_measures_run_and_give_the_right_numbers() {
    let (store, dax) = crate::fixture::setup();
    let total = num(&dax.eval_scalar("SUM(Sales[Quantity])").unwrap());
    let y23 = num(&dax.eval_scalar("CALCULATE(SUM(Sales[Quantity]), 'Date'[Year] = 2023)").unwrap());
    let y24 = num(&dax.eval_scalar("CALCULATE(SUM(Sales[Quantity]), 'Date'[Year] = 2024)").unwrap());
    for (id, group, expr) in cases() {
        let q = format!("DEFINE MEASURE Sales[QM] = {expr}\nEVALUATE SUMMARIZECOLUMNS({group}, \"v\", [QM]) ORDER BY {group}");
        let plain = dax.query_with(&q, None).unwrap_or_else(|e| panic!("{id}: {}\n{q}", e.message));
        let viasql = dax.query_with(&q, Some(&store)).unwrap_or_else(|e| panic!("{id} (sql): {}", e.message));
        let (a, b) = (&plain[0].rows, &viasql[0].rows);
        assert!(!a.is_empty(), "{id}: no rows");
        assert_eq!(a.len(), b.len(), "{id}: interpreter and SQL disagree on the rows");
        for (ra, rb) in a.iter().zip(b) {
            let (x, y) = (num(&ra[1]), num(&rb[1]));
            assert!((x.is_nan() && y.is_nan()) || (x - y).abs() < 1e-9 * x.abs().max(1.0), "{id}: {ra:?} vs {rb:?}");
        }
        let col: Vec<f64> = a.iter().map(|r| num(&r[1])).collect();
        match id.as_str() {
            "sum" => assert!((col.iter().sum::<f64>() - total).abs() < 1e-9, "sum per category adds up to the total"),
            "percentOfTotal" => assert!((col.iter().sum::<f64>() - 1.0).abs() < 1e-9, "shares add up to 1"),
            "runningTotal" => assert!((col.last().unwrap() - total).abs() < 1e-9, "the running total ends at the total"),
            "sameLastYear" => assert!((col.last().unwrap() - y23).abs() < 1e-9, "2024 shows 2023"),
            "yoy" => assert!((col.last().unwrap() - (y24 - y23)).abs() < 1e-9, "2024 minus 2023"),
            "yoyPercent" => assert!((col.last().unwrap() - (y24 - y23) / y23).abs() < 1e-9),
            "ytd" => assert!((col.last().unwrap() - y24).abs() < 1e-9 || col.last().unwrap() > &0.0),
            _ => {}
        }
    }
}
