//! Every ribbon transform writes M that the evaluator runs: apply it to a query, run the result, compare with hand-computed rows.
use biforge_engine::Engine;
use biforge_m::steps::parse_query;
use biforge_m::transforms::{apply_transform, folder_combine_query, Transform};
use std::collections::BTreeMap;

const BASE: &str = "let\n    Source = #table({\"Id\",\"Name\",\"Qty\",\"Day\"}, {{\"1\",\"  ann \",\"10\",\"2024-01-05\"},{\"2\",\"BOB\",\"\",\"2024-02-10\"},{\"3\",\"cy\",\"7.5\",\"2024-02-11\"},{\"3\",\"cy\",\"7.5\",\"2024-02-11\"}})\nin\n    Source";

fn tr(json: &str) -> Transform {
    serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"))
}

fn plain(s: &str) -> String {
    match s.strip_suffix(".0") {
        Some(h) if !h.is_empty() && h.trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) => h.to_string(),
        _ => s.to_string(),
    }
}

fn run_text(e: &Engine, text: &str, extra: &[(&str, &str)]) -> (Vec<String>, Vec<Vec<String>>) {
    let mut qs: BTreeMap<String, String> = extra.iter().map(|(n, t)| (n.to_string(), t.to_string())).collect();
    qs.insert("Q".into(), text.to_string());
    let page = e.m_preview(&qs, "Q", None, 1000).unwrap_or_else(|err| panic!("{err}\n{text}"));
    (
        page.columns.iter().map(|c| c.name.clone()).collect(),
        page.rows.into_iter().map(|r| r.into_iter().map(|c| c.map(|s| plain(&s)).unwrap_or_else(|| "~".into())).collect()).collect(),
    )
}

/// Applies the transforms one after the other (each to the end of the query) and runs the result.
fn chain(base: &str, transforms: &[&str], extra: &[(&str, &str)]) -> (Vec<String>, Vec<Vec<String>>, String) {
    let e = Engine::in_memory().unwrap();
    let mut text = base.to_string();
    for t in transforms {
        text = apply_transform(&text, None, &tr(t)).unwrap().text;
    }
    let (c, r) = run_text(&e, &text, extra);
    (c, r, text)
}

fn rows(r: &[Vec<String>]) -> Vec<String> {
    r.iter().map(|x| x.join("|")).collect()
}

const TYPED: &str = r#"{"kind":"changeType","changes":[{"column":"Id","type":"int64"},{"column":"Qty","type":"number"},{"column":"Day","type":"date"}]}"#;

#[test]
fn change_type_then_filters_of_every_operator() {
    let f = |cond: &str| {
        let t = format!(r#"{{"kind":"filterRows","conditions":[{cond}]}}"#);
        let (_, r, _) = chain(BASE, &[TYPED, &t], &[]);
        rows(&r).iter().map(|x| x.split('|').next().unwrap().to_string()).collect::<Vec<_>>()
    };
    assert_eq!(f(r#"{"column":"Qty","op":"gt","value":"8","valueType":"number"}"#), ["1"]);
    assert_eq!(f(r#"{"column":"Qty","op":"isNull"}"#), ["2"]);
    assert_eq!(f(r#"{"column":"Qty","op":"isNotNull"}"#), ["1", "3", "3"]);
    assert_eq!(f(r#"{"column":"Day","op":"ge","value":"2024-02-10","valueType":"date"}"#), ["2", "3", "3"]);
    assert_eq!(f(r#"{"column":"Name","op":"contains","value":"b"}"#), Vec::<String>::new()); // BOB is upper case: case-sensitive
    assert_eq!(f(r#"{"column":"Name","op":"startsWith","value":"cy"}"#), ["3", "3"]);
    assert_eq!(f(r#"{"column":"Name","op":"endsWith","value":"B"}"#), ["2"]);
    assert_eq!(f(r#"{"column":"Name","op":"notContains","value":"y"}"#), ["1", "2"]);
    assert_eq!(f(r#"{"column":"Id","op":"eq","value":"3","valueType":"number"}"#), ["3", "3"]);
    assert_eq!(f(r#"{"column":"Id","op":"ne","value":"3","valueType":"number"}"#), ["1", "2"]);
    assert_eq!(f(r#"{"column":"Id","op":"lt","value":"3","valueType":"number"},{"column":"Qty","op":"isNotNull"}"#), ["1"]);
    let (_, r, _) = chain(
        BASE,
        &[TYPED, r#"{"kind":"filterRows","combine":"or","conditions":[{"column":"Id","op":"eq","value":"1","valueType":"number"},{"column":"Id","op":"eq","value":"2","valueType":"number"}]}"#],
        &[],
    );
    assert_eq!(r.len(), 2);
}

#[test]
fn row_and_column_shaping_transforms() {
    let (c, r, _) = chain(BASE, &[TYPED, r#"{"kind":"removeDuplicates","columns":["Id","Name"]}"#, r#"{"kind":"sort","keys":[{"column":"Id","descending":true}]}"#], &[]);
    assert_eq!(c, ["Id", "Name", "Qty", "Day"]);
    assert_eq!(rows(&r), ["3|cy|7.5|2024-02-11", "2|BOB|~|2024-02-10", "1|  ann |10|2024-01-05"]);
    let (_, r, _) = chain(BASE, &[r#"{"kind":"keepTopRows","count":2}"#, r#"{"kind":"removeTopRows","count":1}"#], &[]);
    assert_eq!(r.len(), 1);
    let (_, r, _) = chain(BASE, &[r#"{"kind":"keepBottomRows","count":3}"#, r#"{"kind":"removeBottomRows","count":1}"#, r#"{"kind":"keepRange","offset":1,"count":5}"#], &[]);
    assert_eq!(r.len(), 1);
    let (c, _, _) = chain(
        BASE,
        &[
            r#"{"kind":"removeColumns","columns":["Day"]}"#,
            r#"{"kind":"reorderColumns","columns":["Qty","Id","Name"]}"#,
            r#"{"kind":"renameColumns","pairs":[["Qty","Quantity"]]}"#,
            r#"{"kind":"duplicateColumn","column":"Id","newName":"Id copy"}"#,
        ],
        &[],
    );
    assert_eq!(c, ["Quantity", "Id", "Name", "Id copy"]);
    let (c, _, _) = chain(BASE, &[r#"{"kind":"keepColumns","columns":["Name","Id"]}"#], &[]);
    assert_eq!(c, ["Name", "Id"]);
    let (_, r, _) = chain(BASE, &[TYPED, r#"{"kind":"removeBlankRows","textColumns":["Name"],"otherColumns":["Qty"]}"#], &[]);
    assert_eq!(r.len(), 4);
    let blank = "let Source = #table({\"A\",\"B\"}, {{\"\",null},{\"x\",null},{null,2},{\"\",\"\"}}) in Source";
    let (_, r, _) = chain(blank, &[r#"{"kind":"removeBlankRows","textColumns":["A"],"otherColumns":[]}"#, r#"{"kind":"promoteHeaders"}"#], &[]);
    // rows where every listed column is empty are removed; then the first remaining row becomes the header
    assert_eq!(r.len(), 0);
}

#[test]
fn text_replace_and_split_transforms() {
    let (_, r, _) = chain(BASE, &[r#"{"kind":"transformText","columns":["Name"],"op":"trim"}"#, r#"{"kind":"transformText","columns":["Name"],"op":"upper"}"#], &[]);
    assert_eq!(r.iter().map(|x| x[1].as_str()).collect::<Vec<_>>(), ["ANN", "BOB", "CY", "CY"]);
    let (_, r, _) = chain(BASE, &[r#"{"kind":"transformText","columns":["Name"],"op":"lower"}"#], &[]);
    assert_eq!(r[1][1], "bob");
    let (_, r, _) = chain(BASE, &[r#"{"kind":"replaceValues","columns":["Name"],"find":"cy","replace":"Cyrus","mode":"value"}"#], &[]);
    assert_eq!(r[2][1], "Cyrus");
    let (_, r, _) = chain(BASE, &[TYPED, r#"{"kind":"replaceValues","columns":["Qty"],"find":null,"replace":"0","replaceType":"number","mode":"value","valueType":"number"}"#], &[]);
    assert_eq!(r[1][2], "0");
    let (c, r, _) = chain(BASE, &[r#"{"kind":"splitColumn","column":"Day","by":"delimiter","delimiter":"-","count":3,"names":["Y","M","D"]}"#], &[]);
    assert_eq!(c, ["Id", "Name", "Qty", "Y", "M", "D"]);
    assert_eq!(r[0][3..], ["2024", "01", "05"]);
    let (c, r, _) = chain(BASE, &[r#"{"kind":"splitColumn","column":"Day","by":"positions","positions":[0,4],"count":2}"#], &[]);
    assert_eq!(c.last().unwrap(), "Day.2");
    assert_eq!(r[0][3..], ["2024", "-01-05"]);
}

#[test]
fn added_columns() {
    let (c, r, _) = chain(BASE, &[TYPED, r#"{"kind":"addCustomColumn","name":"Double","formula":"[Qty] * 2","valueType":"number"}"#], &[]);
    assert_eq!(c.last().unwrap(), "Double");
    assert_eq!(r.iter().map(|x| x[4].as_str()).collect::<Vec<_>>(), ["20", "~", "15", "15"]);
    let (_, r, _) = chain(
        BASE,
        &[
            TYPED,
            r#"{"kind":"addConditionalColumn","name":"Size","clauses":[{"condition":{"column":"Qty","op":"ge","value":"10","valueType":"number"},"result":"big"},{"condition":{"column":"Qty","op":"isNotNull"},"result":"small"}],"elseValue":"none"}"#,
        ],
        &[],
    );
    assert_eq!(r.iter().map(|x| x[4].as_str()).collect::<Vec<_>>(), ["big", "none", "small", "small"]);
    let (_, r, _) = chain(BASE, &[r#"{"kind":"addIndexColumn","name":"N","start":1,"step":1}"#], &[]);
    assert_eq!(r.iter().map(|x| x[4].as_str()).collect::<Vec<_>>(), ["1", "2", "3", "4"]);
    let (_, r, _) = chain(
        BASE,
        &[TYPED, r#"{"kind":"addCustomColumn","name":"Year","formula":"Date.Year([Day])"}"#, r#"{"kind":"addCustomColumn","name":"Label","formula":"Text.From([Id]) & \"-\" & Text.Upper(Text.Start([Name], 3))"}"#],
        &[],
    );
    assert_eq!(r[1][4], "2024");
    assert_eq!(r[1][5], "2-BOB");
}

#[test]
fn fill_group_pivot_unpivot_round() {
    let sparse = "let Source = #table({\"K\",\"V\"}, {{\"a\",\"1\"},{null,\"2\"},{\"b\",\"3\"},{null,\"4\"}}) in Source";
    let (_, r, _) = chain(sparse, &[r#"{"kind":"fillDown","columns":["K"]}"#, r#"{"kind":"changeType","changes":[{"column":"V","type":"int64"}]}"#, r#"{"kind":"groupBy","keys":["K"],"aggregates":[{"name":"Total","op":"sum","column":"V"},{"name":"Rows","op":"countRows"},{"name":"Top","op":"max","column":"V"}]}"#], &[]);
    assert_eq!(rows(&r), ["a|3|2|2", "b|7|2|4"]);
    let (_, r, _) = chain(sparse, &[r#"{"kind":"fillUp","columns":["K"]}"#], &[]);
    assert_eq!(r.iter().map(|x| x[0].as_str()).collect::<Vec<_>>(), ["a", "b", "b", "~"]);
    let long = "let Source = #table({\"Region\",\"Year\",\"Amount\"}, {{\"N\",2023,10},{\"N\",2024,20},{\"S\",2023,5}}) in Source";
    let (c, r, _) = chain(long, &[r#"{"kind":"pivot","attribute":"Year","value":"Amount","attributeIsText":false,"aggregate":"sum"}"#], &[]);
    assert_eq!(c, ["Region", "2023", "2024"]);
    assert_eq!(rows(&r), ["N|10|20", "S|5|~"]);
    let wide = "let Source = #table({\"Id\",\"A\",\"B\"}, {{\"x\",1,2},{\"y\",3,null}}) in Source";
    let (_, r, _) = chain(wide, &[r#"{"kind":"unpivotOther","columns":["Id"]}"#], &[]);
    assert_eq!(rows(&r), ["x|A|1", "x|B|2", "y|A|3"]);
    let (c, r, _) = chain(wide, &[r#"{"kind":"unpivot","columns":["A","B"]}"#], &[]);
    assert_eq!(c, ["Id", "Attribute", "Value"]);
    assert_eq!(r.len(), 3);
    let nums = "let Source = #table({\"P\"}, {{2.345},{10.5}}) in Source";
    let (_, r, _) = chain(nums, &[r#"{"kind":"round","columns":["P"],"digits":1}"#], &[]);
    assert_eq!(rows(&r), ["2.3", "10.5"]);
}

#[test]
fn merge_append_and_headers() {
    let cust = "let Source = #table({\"id\",\"city\"}, {{1,\"Rome\"},{3,\"Oslo\"}}) in Source";
    let (c, r, text) = chain(
        BASE,
        &[TYPED, r#"{"kind":"merge","right":"Customers","leftKeys":["Id"],"rightKeys":["id"],"joinKind":"leftOuter","newColumn":"C","expand":[{"name":"city","newName":"City"}]}"#],
        &[("Customers", cust)],
    );
    assert_eq!(c, ["Id", "Name", "Qty", "Day", "City"]);
    assert_eq!(r.iter().map(|x| x[4].as_str()).collect::<Vec<_>>(), ["Rome", "~", "Oslo", "Oslo"]);
    assert!(parse_query(&text).unwrap().steps.iter().any(|s| s.name == "Merged Queries"));
    let (_, r, _) = chain(BASE, &[r#"{"kind":"append","queries":["Customers"]}"#], &[("Customers", cust)]);
    assert_eq!(r.len(), 6);
    let (c, r, _) = chain(BASE, &[r#"{"kind":"demoteHeaders"}"#, r#"{"kind":"promoteHeaders"}"#], &[]);
    assert_eq!(c, ["Id", "Name", "Qty", "Day"]);
    assert_eq!(r.len(), 4);
}

#[test]
fn folder_combine_template_runs() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.csv"), "k,v\n1,x\n").unwrap();
    std::fs::write(dir.path().join("b.csv"), "k,v\n2,y\n").unwrap();
    let q = folder_combine_query(&dir.path().to_string_lossy().replace('\\', "/"), "csv", ",");
    let e = Engine::in_memory().unwrap();
    let (c, r) = run_text(&e, &q, &[]);
    assert_eq!(c, ["k", "v"]);
    assert_eq!(rows(&r), ["1|x", "2|y"]);
}
