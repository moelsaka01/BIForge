//! Phase 9 transforms: single-value results (Count Rows, Statistics), Keep Duplicates, cell errors with Keep / Remove /
//! Replace Errors, and Detect Data Type. Every expected value is computed by hand.
use biforge_engine::Engine;
use biforge_m::transforms::{apply_transform, Transform};
use std::collections::BTreeMap;

fn tr(json: &str) -> Transform {
    serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"))
}

fn plain(s: &str) -> String {
    match s.strip_suffix(".0") {
        Some(h) if !h.is_empty() && h.trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) => h.to_string(),
        _ => s.to_string(),
    }
}

fn qs(text: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("Q".to_string(), text.to_string())])
}

fn build(base: &str, transforms: &[&str]) -> String {
    let mut text = base.to_string();
    for t in transforms {
        text = apply_transform(&text, None, &tr(t)).unwrap_or_else(|e| panic!("{t}: {e}")).text;
    }
    text
}

fn rows(e: &Engine, text: &str) -> Vec<String> {
    let page = e.m_preview(&qs(text), "Q", None, 1000).unwrap_or_else(|err| panic!("{err}\n{text}"));
    page.rows.into_iter().map(|r| r.into_iter().map(|c| c.map(|s| plain(&s)).unwrap_or_else(|| "~".into())).collect::<Vec<_>>().join("|")).collect()
}

const PEOPLE: &str = "let\n    Source = #table({\"Name\",\"Age\",\"City\"}, {{\"Ann\",30,\"Rome\"},{\"Bob\",25,\"Paris\"},{\"Cy\",null,\"Rome\"},{\"Di\",41,\"Oslo\"},{\"Eve\",25,\"Paris\"}})\nin\n    Source";

/// Name, Qty as text: "10", "x" (not a number), "7.5", "" (empty), "oops" (not a number)
const MESSY: &str = "let\n    Source = #table({\"Name\",\"Qty\"}, {{\"a\",\"10\"},{\"b\",\"x\"},{\"c\",\"7.5\"},{\"d\",\"\"},{\"e\",\"oops\"}})\nin\n    Source";

#[test]
fn count_rows_and_statistics_are_single_values() {
    let e = Engine::in_memory().unwrap();
    let value = |t: &str| {
        let text = build(PEOPLE, &[t]);
        let v = e.m_value(&qs(&text), "Q", None).unwrap_or_else(|err| panic!("{t}: {err}\n{text}"));
        (v.kind, plain(&v.text))
    };
    assert_eq!(value(r#"{"kind":"countRows"}"#), ("number".to_string(), "5".to_string()));
    let stat = |op: &str| value(&format!(r#"{{"kind":"columnStatistic","column":"Age","op":"{op}"}}"#)).1;
    assert_eq!(stat("sum"), "121");
    assert_eq!(stat("min"), "25");
    assert_eq!(stat("max"), "41");
    assert_eq!(stat("median"), "27.5");
    assert_eq!(stat("average"), "30.25");
    assert_eq!(stat("count"), "5");
    // 30, 25, null, 41: null is a value
    assert_eq!(stat("countDistinct"), "4");
    // sample standard deviation of 30, 25, 41, 25 = sqrt(170.75 / 3)
    let sd: f64 = stat("standardDeviation").parse().unwrap();
    assert!((sd - (170.75f64 / 3.0).sqrt()).abs() < 1e-9, "{sd}");
    // the preview of such a step is not a table: the kind says so
    let text = build(PEOPLE, &[r#"{"kind":"countRows"}"#]);
    let steps = e.m_analyze(&qs(&text), "Q").unwrap();
    assert_eq!(steps.last().unwrap().kind, "number");
    assert!(e.m_preview(&qs(&text), "Q", None, 10).is_err());
    assert_eq!(e.m_query_kind(&qs(&text), "Q"), "number");
}

#[test]
fn statistics_across_the_columns_of_a_row() {
    let e = Engine::in_memory().unwrap();
    let base = "let\n    Source = #table({\"A\",\"B\",\"C\"}, {{1,2,3},{4,null,6},{null,null,null}})\nin\n    Source";
    let run = |op: &str| rows(&e, &build(base, &[&format!(r#"{{"kind":"rowStatistic","columns":["A","B","C"],"op":"{op}","newName":"S"}}"#)]));
    assert_eq!(run("sum"), ["1|2|3|6", "4|~|6|10", "~|~|~|~"]);
    assert_eq!(run("max"), ["1|2|3|3", "4|~|6|6", "~|~|~|~"]);
    assert_eq!(run("min"), ["1|2|3|1", "4|~|6|4", "~|~|~|~"]);
    assert_eq!(run("average"), ["1|2|3|2", "4|~|6|5", "~|~|~|~"]);
    assert_eq!(run("median"), ["1|2|3|2", "4|~|6|5", "~|~|~|~"]);
    // List.Count counts every item, null included
    assert_eq!(run("count"), ["1|2|3|3", "4|~|6|3", "~|~|~|3"]);
}

#[test]
fn keep_duplicates_keeps_every_row_of_a_repeated_key_in_order() {
    let e = Engine::in_memory().unwrap();
    let by = |cols: &str| rows(&e, &build(PEOPLE, &[&format!(r#"{{"kind":"keepDuplicates","columns":[{cols}]}}"#)]));
    assert_eq!(by(r#""City""#), ["Ann|30|Rome", "Bob|25|Paris", "Cy|~|Rome", "Eve|25|Paris"]);
    assert_eq!(by(r#""Age""#), ["Bob|25|Paris", "Eve|25|Paris"]);
    // both columns must repeat together
    assert_eq!(by(r#""Age","City""#), ["Bob|25|Paris", "Eve|25|Paris"]);
    assert_eq!(by(r#""Name""#), Vec::<String>::new());
}

#[test]
fn failed_conversions_are_error_cells_not_failed_steps() {
    let e = Engine::in_memory().unwrap();
    let typed = build(MESSY, &[r#"{"kind":"changeType","changes":[{"column":"Qty","type":"number"}]}"#]);
    // the step runs; the cells that could not be converted are errors (shown as such, the text is None)
    let page = e.m_preview(&qs(&typed), "Q", None, 100).unwrap();
    assert_eq!(page.rows.iter().map(|r| r[1].clone()).collect::<Vec<_>>(), [Some("10.0".into()), None, Some("7.5".into()), None, None]);
    assert_eq!(page.error_cells, [(1, 1), (4, 1)], "rows b and e failed; the empty text d is a null, not an error");
    // the profile counts them
    let p = e.m_profile(&qs(&typed), "Q", None, None).unwrap();
    let qty = p.iter().find(|c| c.name == "Qty").unwrap();
    assert_eq!((qty.rows, qty.error, qty.empty, qty.valid), (5, 2, 1, 2));
    // remove / keep / replace
    let removed = build(&typed, &[r#"{"kind":"removeErrors","columns":[]}"#]);
    assert_eq!(rows(&e, &removed), ["a|10", "c|7.5", "d|~"]);
    let kept = build(&typed, &[r#"{"kind":"keepErrors","columns":["Qty"]}"#]);
    assert_eq!(rows(&e, &kept), ["b|~", "e|~"]);
    let replaced = build(&typed, &[r#"{"kind":"replaceErrors","columns":["Qty"],"value":-1,"valueType":"number"}"#]);
    assert_eq!(rows(&e, &replaced), ["a|10", "b|-1", "c|7.5", "d|~", "e|-1"]);
    let nulled = build(&typed, &[r#"{"kind":"replaceErrors","columns":["Qty"],"value":null}"#]);
    assert_eq!(rows(&e, &nulled), ["a|10", "b|~", "c|7.5", "d|~", "e|~"]);
    // after the errors are handled the cells are ordinary: no error is left
    assert!(e.m_preview(&qs(&replaced), "Q", None, 100).unwrap().error_cells.is_empty());
    // removing the errors of a column that has none changes nothing; keeping them gives no rows
    let clean = build(PEOPLE, &[r#"{"kind":"removeErrors","columns":["Age"]}"#]);
    assert_eq!(rows(&e, &clean).len(), 5);
    assert!(rows(&e, &build(PEOPLE, &[r#"{"kind":"keepErrors","columns":[]}"#])).is_empty());
}

#[test]
fn error_cells_survive_steps_that_keep_the_rows_and_the_column() {
    let e = Engine::in_memory().unwrap();
    // sort, filter, rename another column, reorder, add a column, remove another column: the errors stay
    let steps = [
        r#"{"kind":"changeType","changes":[{"column":"Qty","type":"number"}]}"#,
        r#"{"kind":"sort","keys":[{"column":"Name","descending":true}]}"#,
        r#"{"kind":"filterRows","conditions":[{"column":"Name","op":"ne","value":"a","valueType":"text"}]}"#,
        r#"{"kind":"renameColumns","pairs":[["Qty","Amount"]]}"#,
        r#"{"kind":"addIndexColumn","name":"I","start":0,"step":1}"#,
        r#"{"kind":"reorderColumns","columns":["I","Amount","Name"]}"#,
    ];
    let text = build(MESSY, &steps);
    let page = e.m_preview(&qs(&text), "Q", None, 100).unwrap();
    assert_eq!(page.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["I", "Amount", "Name"]);
    // rows after sort desc and the filter: e, d, c, b
    assert_eq!(page.error_cells, [(0, 1), (3, 1)]);
    let removed = build(&text, &[r#"{"kind":"removeErrors","columns":["Amount"]}"#]);
    assert_eq!(rows(&e, &removed), ["1|~|d", "2|7.5|c"]);
    // a step that rebuilds the rows (Group By) drops the flags: the errors are plain nulls from there on
    let grouped = build(&text, &[r#"{"kind":"groupBy","keys":["Name"],"aggregates":[{"name":"N","op":"countRows"}]}"#]);
    assert!(e.m_preview(&qs(&grouped), "Q", None, 100).unwrap().error_cells.is_empty());
}

#[test]
fn detect_data_type_picks_the_type_every_value_converts_to() {
    let e = Engine::in_memory().unwrap();
    let base = "let\n    Source = #table({\"Ints\",\"Nums\",\"Bools\",\"Dates\",\"Stamps\",\"Mixed\",\"Empty\",\"Words\"}, {\
        {\"1\",\"1.5\",\"true\",\"2024-01-05\",\"2024-01-05 10:30:00\",\"1\",\"\",\"ann\"},\
        {\"-20\",\"2\",\"FALSE\",\"2024-02-10\",\"2024-02-10 08:00:00\",\"x\",\"\",\"bob\"},\
        {\"3\",\"1e3\",\"true\",\"\",\"2024-03-01 00:00:01\",\"2\",\"\",\"cy\"}})\nin\n    Source";
    let cols: Vec<String> = ["Ints", "Nums", "Bools", "Dates", "Stamps", "Mixed", "Empty", "Words"].iter().map(|s| s.to_string()).collect();
    let found = e.m_detect_types(&qs(base), "Q", None, &cols).unwrap();
    let by: BTreeMap<_, _> = found.into_iter().collect();
    assert_eq!(by["Ints"], "int64");
    assert_eq!(by["Nums"], "number");
    assert_eq!(by["Bools"], "logical");
    assert_eq!(by["Dates"], "date");
    assert_eq!(by["Stamps"], "datetime");
    assert_eq!(by["Mixed"], "text");
    assert_eq!(by["Empty"], "text");
    assert_eq!(by["Words"], "text");
    // columns that are not text keep their type
    let typed = e.m_detect_types(&qs(PEOPLE), "Q", None, &["Age".to_string()]).unwrap();
    assert_eq!(typed, [("Age".to_string(), "text".to_string())]);
}

#[test]
fn parse_json_reads_fields_of_json_text_in_a_column() {
    let e = Engine::in_memory().unwrap();
    let base = r#"let
    Source = #table({"Id","Doc"}, {{1,"{""name"":""Ann"",""age"":30,""address"":{""city"":""Rome""},""tags"":[""a"",""b""]}"},{2,"{""name"":""Bob""}"},{3,null}})
in
    Source"#;
    let text = build(base, &[r#"{"kind":"parseJson","column":"Doc","fields":["name","address.city","age"]}"#]);
    let page = e.m_preview(&qs(&text), "Q", None, 100).unwrap();
    assert_eq!(page.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Id", "Doc", "Doc.name", "Doc.address.city", "Doc.age"]);
    let r = rows(&e, &text);
    assert_eq!(r[0].split('|').skip(2).collect::<Vec<_>>(), ["Ann", "Rome", "30"]);
    assert_eq!(r[1].split('|').skip(2).collect::<Vec<_>>(), ["Bob", "~", "~"], "a missing field is null");
    assert_eq!(r[2].split('|').skip(2).collect::<Vec<_>>(), ["~", "~", "~"], "null text parses to nulls");
    // list items by index through M the user can write too
    let custom = build(base, &[r#"{"kind":"addCustomColumn","name":"T","formula":"Json.Document([Doc])[tags]{1}"}"#]);
    assert_eq!(rows(&e, &custom)[0].split('|').last().unwrap(), "b");
    assert!(apply_transform(base, None, &tr(r#"{"kind":"parseJson","column":"Doc","fields":[]}"#)).is_err());
}
