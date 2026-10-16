use biforge_m::steps::*;
use biforge_m::transforms::*;

const Q: &str = "let\n    Source = #table({\"a\", \"b\"}, {{1, 2}}),\n    #\"Filtered Rows\" = Table.SelectRows(Source, each [a] > 0),\n    #\"Removed Columns\" = Table.RemoveColumns(#\"Filtered Rows\", {\"b\"})\nin\n    #\"Removed Columns\"";

#[test]
fn parses_steps_with_names_and_functions() {
    let q = parse_query(Q).unwrap();
    assert_eq!(q.steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Source", "Filtered Rows", "Removed Columns"]);
    assert_eq!(q.steps[1].raw_name, "#\"Filtered Rows\"");
    assert_eq!(q.steps[1].function.as_deref(), Some("Table.SelectRows"));
    assert_eq!(q.steps[1].expr, "Table.SelectRows(Source, each [a] > 0)");
    assert_eq!(q.output, "#\"Removed Columns\"");
    assert!(parse_query("1 + 1").is_err());
    assert!(parse_query("let a = in a").is_err());
}

#[test]
fn raw_names_quote_only_when_needed() {
    assert_eq!(raw_name("Source"), "Source");
    assert_eq!(raw_name("Changed Type"), "#\"Changed Type\"");
    assert_eq!(raw_name("a\"b"), "#\"a\"\"b\"");
    assert_eq!(raw_name("let"), "#\"let\"");
    assert_eq!(raw_name("1abc"), "#\"1abc\"");
    assert_eq!(unique_step_name(Q, "Filtered Rows"), "Filtered Rows1");
    assert_eq!(unique_step_name(Q, "Sorted Rows"), "Sorted Rows");
}

#[test]
fn insert_in_the_middle_rewires_later_steps() {
    let out = insert_step(Q, Some("Source"), "Promoted", "Table.PromoteHeaders(Source)").unwrap();
    let q = parse_query(&out).unwrap();
    assert_eq!(q.steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Source", "Promoted", "Filtered Rows", "Removed Columns"]);
    assert!(q.steps[2].expr.contains("Table.SelectRows(Promoted,"), "{}", q.steps[2].expr);
    assert_eq!(q.output, "#\"Removed Columns\"");
    // inserting at the end changes the output
    let out = insert_step(Q, None, "Sorted", "Table.Sort(#\"Removed Columns\", {\"a\"})").unwrap();
    assert_eq!(parse_query(&out).unwrap().output, "Sorted");
    assert!(insert_step(Q, Some("Source"), "Filtered Rows", "1").is_err());
    assert!(insert_step(Q, Some("Nope"), "X", "1").is_err());
}

#[test]
fn delete_hands_dependents_to_the_input_step() {
    let out = delete_step(Q, "Filtered Rows").unwrap();
    let q = parse_query(&out).unwrap();
    assert_eq!(q.steps.len(), 2);
    assert!(q.steps[1].expr.contains("Table.RemoveColumns(Source,"), "{}", q.steps[1].expr);
    let out = delete_step(Q, "Removed Columns").unwrap();
    assert_eq!(parse_query(&out).unwrap().output, "#\"Filtered Rows\"");
    assert!(delete_step(Q, "Source").unwrap_err().contains("cannot be deleted"));
    assert!(delete_step("let A = 1 in A", "A").is_err());
}

#[test]
fn rename_updates_every_reference() {
    let out = rename_step(Q, "Filtered Rows", "Big Rows").unwrap();
    let q = parse_query(&out).unwrap();
    assert_eq!(q.steps[1].name, "Big Rows");
    assert!(q.steps[2].expr.contains("#\"Big Rows\""));
    assert!(rename_step(Q, "Source", "Filtered Rows").is_err());
    assert!(rename_step(Q, "Nope", "X").is_err());
    let out = rename_step(Q, "Removed Columns", "Final").unwrap();
    assert_eq!(parse_query(&out).unwrap().output, "Final");
}

#[test]
fn move_edit_and_dependencies() {
    let out = move_step(Q, "Removed Columns", -1);
    assert!(out.is_err(), "Removed Columns uses Filtered Rows, it cannot move above it");
    let base = "let\n    A = 1,\n    B = 2,\n    C = A + B\nin\n    C";
    let out = move_step(base, "B", -1).unwrap();
    assert_eq!(parse_query(&out).unwrap().steps.iter().map(|s| s.name.clone()).collect::<Vec<_>>(), ["B", "A", "C"]);
    assert!(move_step(base, "A", -1).is_err());
    let out = set_step_expr(Q, "Filtered Rows", "Table.SelectRows(Source, each [a] > 5)").unwrap();
    assert!(parse_query(&out).unwrap().steps[1].expr.contains("> 5"));
    assert!(set_step_expr(Q, "Filtered Rows", "Table.SelectRows(").is_err());
    assert_eq!(step_dependencies(Q, "Removed Columns").unwrap(), ["Source", "Filtered Rows"]);
    assert_eq!(step_dependencies(Q, "Source").unwrap(), Vec::<String>::new());
}

fn tr(json: &str) -> Transform {
    serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"))
}

fn expr_of(t: &str) -> String {
    let a = apply_transform(Q, Some("Source"), &tr(t)).unwrap();
    let q = parse_query(&a.text).unwrap();
    q.steps.iter().find(|s| s.name == a.added[0]).unwrap().expr.clone()
}

#[test]
fn transforms_write_the_m_that_power_query_writes() {
    assert_eq!(expr_of(r#"{"kind":"promoteHeaders"}"#), "Table.PromoteHeaders(Source, [PromoteAllScalars=true])");
    assert_eq!(
        expr_of(r#"{"kind":"changeType","changes":[{"column":"a","type":"int64"},{"column":"b","type":"date"}]}"#),
        "Table.TransformColumnTypes(Source, {{\"a\", Int64.Type}, {\"b\", type date}})"
    );
    assert_eq!(expr_of(r#"{"kind":"removeColumns","columns":["b"]}"#), "Table.RemoveColumns(Source, {\"b\"})");
    assert_eq!(
        expr_of(r#"{"kind":"filterRows","conditions":[{"column":"a","op":"gt","value":"5","valueType":"number"},{"column":"b","op":"contains","value":"x\"y"}],"combine":"or"}"#),
        "Table.SelectRows(Source, each [a] > 5 or Text.Contains([b], \"x\"\"y\"))"
    );
    assert_eq!(
        expr_of(r#"{"kind":"filterRows","conditions":[{"column":"When","op":"ge","value":"2024-03-05","valueType":"date"}]}"#),
        "Table.SelectRows(Source, each [When] >= #date(2024, 3, 5))"
    );
    assert_eq!(expr_of(r#"{"kind":"sort","keys":[{"column":"a","descending":true},{"column":"b"}]}"#), "Table.Sort(Source, {{\"a\", Order.Descending}, {\"b\", Order.Ascending}})");
    assert_eq!(
        expr_of(r#"{"kind":"groupBy","keys":["a"],"aggregates":[{"name":"Total","op":"sum","column":"b"},{"name":"N","op":"countRows"}]}"#),
        "Table.Group(Source, {\"a\"}, {{\"Total\", each List.Sum([b]), type nullable number}, {\"N\", each Table.RowCount(_), Int64.Type}})"
    );
    assert_eq!(
        expr_of(r#"{"kind":"splitColumn","column":"a","by":"delimiter","delimiter":",","count":2}"#),
        "Table.SplitColumn(Source, \"a\", Splitter.SplitTextByDelimiter(\",\", QuoteStyle.Csv), {\"a.1\", \"a.2\"})"
    );
    assert_eq!(
        expr_of(r#"{"kind":"addConditionalColumn","name":"Size","clauses":[{"condition":{"column":"a","op":"lt","value":"10","valueType":"number"},"result":"small"}],"elseValue":"big"}"#),
        "Table.AddColumn(Source, \"Size\", each if [a] < 10 then \"small\" else \"big\")"
    );
    assert_eq!(expr_of(r#"{"kind":"addCustomColumn","name":"Sum","formula":"[a] + [b]","valueType":"number"}"#), "Table.AddColumn(Source, \"Sum\", each [a] + [b], type number)");
    assert_eq!(expr_of(r#"{"kind":"replaceValues","columns":["b"],"find":"x","replace":"y","mode":"text"}"#), "Table.ReplaceValue(Source, \"x\", \"y\", Replacer.ReplaceText, {\"b\"})");
    assert_eq!(expr_of(r#"{"kind":"append","queries":["Other Sales"]}"#), "Table.Combine({Source, #\"Other Sales\"})");
    assert_eq!(expr_of(r#"{"kind":"filterRows","conditions":[{"column":"Sales Amount","op":"isNull"}]}"#), "Table.SelectRows(Source, each [Sales Amount] = null)");
    assert_eq!(expr_of(r#"{"kind":"filterRows","conditions":[{"column":"a]b","op":"isNotNull"}]}"#), "Table.SelectRows(Source, each [#\"a]b\"] <> null)");
}

#[test]
fn multi_step_transforms_chain_their_steps() {
    let a = apply_transform(
        Q,
        Some("Removed Columns"),
        &tr(r#"{"kind":"merge","right":"Customers","leftKeys":["a"],"rightKeys":["id"],"joinKind":"leftOuter","newColumn":"Customers","expand":[{"name":"city","newName":"City"}]}"#),
    )
    .unwrap();
    assert_eq!(a.added, ["Merged Queries", "Expanded Customers"]);
    let q = parse_query(&a.text).unwrap();
    assert!(q.steps[3].expr.starts_with("Table.NestedJoin(#\"Removed Columns\", {\"a\"}, Customers, {\"id\"}, \"Customers\", JoinKind.LeftOuter)"));
    assert!(q.steps[4].expr.starts_with("Table.ExpandTableColumn(#\"Merged Queries\", \"Customers\""));
    assert_eq!(q.output, "#\"Expanded Customers\"");
    let p = apply_transform(Q, None, &tr(r#"{"kind":"pivot","attribute":"b","value":"a","attributeIsText":false,"aggregate":"sum"}"#)).unwrap();
    assert_eq!(p.added, ["Changed Type", "Pivoted Column"]);
    let q = parse_query(&p.text).unwrap();
    assert!(q.steps[4].expr.contains("List.Distinct(#\"Changed Type\"[b])"), "{}", q.steps[4].expr);
    // names stay unique when the same transform is applied twice
    let again = apply_transform(&p.text, None, &tr(r#"{"kind":"promoteHeaders"}"#)).unwrap();
    let again2 = apply_transform(&again.text, None, &tr(r#"{"kind":"promoteHeaders"}"#)).unwrap();
    assert_eq!(again2.added, ["Promoted Headers1"]);
}

#[test]
fn bad_input_is_reported() {
    assert!(apply_transform(Q, None, &tr(r#"{"kind":"changeType","changes":[{"column":"a","type":"weird"}]}"#)).is_err());
    assert!(apply_transform(Q, None, &tr(r#"{"kind":"filterRows","conditions":[]}"#)).is_err());
    assert!(apply_transform(Q, None, &tr(r#"{"kind":"filterRows","conditions":[{"column":"a","op":"gt","value":"abc","valueType":"number"}]}"#)).is_err());
    assert!(apply_transform(Q, None, &tr(r#"{"kind":"filterRows","conditions":[{"column":"a","op":"eq","value":"2024-1","valueType":"date"}]}"#)).is_err());
    assert!(apply_transform("1+1", None, &tr(r#"{"kind":"promoteHeaders"}"#)).is_err());
    assert!(apply_transform(Q, Some("Nope"), &tr(r#"{"kind":"promoteHeaders"}"#)).is_err());
    let q = folder_combine_query("C:/data", "csv", ",");
    assert!(biforge_m::parse(&q).is_ok());
    assert!(q.contains("\".csv\""));
}
