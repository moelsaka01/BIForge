//! The M evaluator over DuckDB: every transform is checked against values computed by hand from small tables.
//! Cell values are compared as text (what the preview grid shows).
mod fixture;

use biforge_engine::{Engine, MemoryCredentialStore, SourceSpec};
use std::collections::BTreeMap;

fn engine() -> Engine {
    Engine::in_memory().unwrap()
}

/// DuckDB prints a DOUBLE 30 as "30.0"; the app formats numbers by type, so the tests compare the plain number.
fn plain(s: &str) -> String {
    match s.strip_suffix(".0") {
        Some(h) if !h.is_empty() && h.trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) => h.to_string(),
        _ => s.to_string(),
    }
}

fn queries(items: &[(&str, &str)]) -> BTreeMap<String, String> {
    items.iter().map(|(n, t)| (n.to_string(), t.to_string())).collect()
}

/// Rows of query "Q" (cells as text, NULL as "~") and its column names.
fn run_with(e: &Engine, items: &[(&str, &str)]) -> (Vec<String>, Vec<Vec<String>>) {
    let qs = queries(items);
    let page = e.m_preview(&qs, "Q", None, 10_000).unwrap_or_else(|err| panic!("{err}\n{}", items.last().unwrap().1));
    let cols = page.columns.iter().map(|c| c.name.clone()).collect();
    let rows = page.rows.into_iter().map(|r| r.into_iter().map(|c| c.map(|s| plain(&s)).unwrap_or_else(|| "~".into())).collect()).collect();
    (cols, rows)
}

fn run(m: &str) -> (Vec<String>, Vec<Vec<String>>) {
    run_with(&engine(), &[("Q", m)])
}

fn fails(m: &str) -> String {
    let e = engine();
    let qs = queries(&[("Q", m)]);
    match e.m_preview(&qs, "Q", None, 100) {
        Ok(p) => panic!("expected an error, got {:?}", p.rows),
        Err(err) => err.to_string(),
    }
}

fn t(rows: &[&[&str]]) -> Vec<Vec<String>> {
    rows.iter().map(|r| r.iter().map(|c| c.to_string()).collect()).collect()
}

const PEOPLE: &str = r#"#table({"Name","Age","City"}, {{"Ann",30,"Rome"},{"Bob",25,"Paris"},{"Cy",null,"Rome"},{"Di",41,"Oslo"},{"Eve",25,"Paris"}})"#;

fn people(steps: &str, last: &str) -> String {
    format!("let\n  Source = {PEOPLE},\n{steps}\nin\n  {last}")
}

#[test]
fn table_literal_and_basic_selection() {
    let (c, r) = run(&format!("let Source = {PEOPLE} in Source"));
    assert_eq!(c, ["Name", "Age", "City"]);
    assert_eq!(r, t(&[&["Ann", "30", "Rome"], &["Bob", "25", "Paris"], &["Cy", "~", "Rome"], &["Di", "41", "Oslo"], &["Eve", "25", "Paris"]]));
}

#[test]
fn select_remove_reorder_rename_duplicate_columns() {
    let (c, r) = run(&people("  S = Table.SelectColumns(Source, {\"City\", \"Name\"})", "S"));
    assert_eq!(c, ["City", "Name"]);
    assert_eq!(r[0], ["Rome", "Ann"]);
    let (c, _) = run(&people("  S = Table.RemoveColumns(Source, {\"Age\"})", "S"));
    assert_eq!(c, ["Name", "City"]);
    let (c, _) = run(&people("  S = Table.ReorderColumns(Source, {\"City\", \"Name\"})", "S"));
    assert_eq!(c, ["City", "Age", "Name"]);
    let (c, r) = run(&people("  S = Table.RenameColumns(Source, {{\"Age\", \"Years\"}})", "S"));
    assert_eq!(c, ["Name", "Years", "City"]);
    assert_eq!(r[1], ["Bob", "25", "Paris"]);
    let (c, r) = run(&people("  S = Table.DuplicateColumn(Source, \"Name\", \"Name2\")", "S"));
    assert_eq!(c, ["Name", "Age", "City", "Name2"]);
    assert_eq!(r[0][3], "Ann");
    assert!(fails(&people("  S = Table.SelectColumns(Source, {\"Nope\"})", "S")).contains("The column 'Nope' of the table wasn't found."));
    let (c, _) = run(&people("  S = Table.RemoveColumns(Source, {\"Nope\"}, MissingField.Ignore)", "S"));
    assert_eq!(c, ["Name", "Age", "City"]);
    assert!(fails(&people("  S = Table.RenameColumns(Source, {{\"Age\", \"Name\"}})", "S")).contains("used by more than one column"));
}

#[test]
fn filter_rows_with_each_conditions() {
    let (_, r) = run(&people("  S = Table.SelectRows(Source, each [Age] > 25)", "S"));
    assert_eq!(r, t(&[&["Ann", "30", "Rome"], &["Di", "41", "Oslo"]]));
    // null never passes a comparison
    let (_, r) = run(&people("  S = Table.SelectRows(Source, each [Age] <> 25)", "S"));
    assert_eq!(r.iter().map(|x| x[0].as_str()).collect::<Vec<_>>(), ["Ann", "Cy", "Di"]); // <> is null-safe: Cy (null) differs from 25
    let (_, r) = run(&people("  S = Table.SelectRows(Source, each [City] = \"Rome\" and [Age] <> null)", "S"));
    assert_eq!(r, t(&[&["Ann", "30", "Rome"]]));
    let (_, r) = run(&people("  S = Table.SelectRows(Source, each [Age] = null or Text.StartsWith([Name], \"D\"))", "S"));
    assert_eq!(r.iter().map(|x| x[0].as_str()).collect::<Vec<_>>(), ["Cy", "Di"]);
    let (_, r) = run(&people("  S = Table.SelectRows(Source, each List.Contains({\"Oslo\", \"Paris\"}, [City]))", "S"));
    assert_eq!(r.len(), 3);
    let (_, r) = run(&people("  S = Table.SelectRows(Source, (row) => row[Age] >= 30)", "S"));
    assert_eq!(r.len(), 2);
    let (_, r) = run(&people("  S = Table.SelectRows(Source, each not Text.Contains([Name], \"e\"))", "S"));
    assert_eq!(r.len(), 4); // only Eve contains a lowercase e
}

#[test]
fn sort_is_stable_and_puts_null_lowest() {
    let (_, r) = run(&people("  S = Table.Sort(Source, {{\"Age\", Order.Ascending}})", "S"));
    assert_eq!(r.iter().map(|x| x[0].as_str()).collect::<Vec<_>>(), ["Cy", "Bob", "Eve", "Ann", "Di"]);
    let (_, r) = run(&people("  S = Table.Sort(Source, {{\"Age\", Order.Descending}, {\"Name\", Order.Descending}})", "S"));
    assert_eq!(r.iter().map(|x| x[0].as_str()).collect::<Vec<_>>(), ["Di", "Ann", "Eve", "Bob", "Cy"]);
    let (_, r) = run(&people("  S = Table.Sort(Source, \"City\")", "S"));
    assert_eq!(r.iter().map(|x| x[0].as_str()).collect::<Vec<_>>(), ["Di", "Bob", "Eve", "Ann", "Cy"]);
}

#[test]
fn keep_and_remove_rows_by_position() {
    let q = |f: &str| run(&people(&format!("  S = {f}"), "S")).1.iter().map(|x| x[0].clone()).collect::<Vec<_>>();
    assert_eq!(q("Table.FirstN(Source, 2)"), ["Ann", "Bob"]);
    assert_eq!(q("Table.LastN(Source, 2)"), ["Di", "Eve"]);
    assert_eq!(q("Table.Skip(Source, 3)"), ["Di", "Eve"]);
    assert_eq!(q("Table.RemoveFirstN(Source, 4)"), ["Eve"]);
    assert_eq!(q("Table.RemoveLastN(Source, 3)"), ["Ann", "Bob"]);
    assert_eq!(q("Table.Range(Source, 1, 2)"), ["Bob", "Cy"]);
    assert_eq!(q("Table.RemoveRows(Source, 1, 2)"), ["Ann", "Di", "Eve"]);
    assert_eq!(q("Table.FirstN(Source, 0)"), Vec::<String>::new());
}

#[test]
fn distinct_keeps_the_first_row_of_each_group() {
    let (_, r) = run(&people("  S = Table.Distinct(Source, {\"City\"})", "S"));
    assert_eq!(r.iter().map(|x| x[0].as_str()).collect::<Vec<_>>(), ["Ann", "Bob", "Di"]);
    let (_, r) = run(&people("  S = Table.Distinct(Table.SelectColumns(Source, {\"City\"}))", "S"));
    assert_eq!(r.len(), 3);
}

#[test]
fn add_columns_custom_conditional_index() {
    let (c, r) = run(&people("  S = Table.AddColumn(Source, \"Next\", each [Age] + 1)", "S"));
    assert_eq!(c.last().unwrap(), "Next");
    assert_eq!(r.iter().map(|x| x[3].as_str()).collect::<Vec<_>>(), ["31", "26", "~", "42", "26"]);
    let (_, r) = run(&people(
        "  S = Table.AddColumn(Source, \"Group\", each if [Age] = null then \"unknown\" else if [Age] < 30 then \"young\" else \"adult\", type text)",
        "S",
    ));
    assert_eq!(r.iter().map(|x| x[3].as_str()).collect::<Vec<_>>(), ["adult", "young", "unknown", "adult", "young"]);
    let (_, r) = run(&people("  S = Table.AddColumn(Source, \"Label\", each [Name] & \" (\" & [City] & \")\")", "S"));
    assert_eq!(r[0][3], "Ann (Rome)");
    let (_, r) = run(&people("  S = Table.AddIndexColumn(Source, \"Index\", 1, 10)", "S"));
    assert_eq!(r.iter().map(|x| x[3].as_str()).collect::<Vec<_>>(), ["1", "11", "21", "31", "41"]);
    let (_, r) = run(&people("  S = Table.AddColumn(Source, \"Half\", each [Age] / 4)", "S"));
    assert_eq!(r[0][3], "7.5");
    assert!(fails(&people("  S = Table.AddColumn(Source, \"Name\", each 1)", "S")).contains("already exists"));
    let (_, r) = run(&people("  S = Table.AddColumn(Source, \"U\", each Text.Upper([Name]) & Text.From(Text.Length([City])))", "S"));
    assert_eq!(r[0][3], "ANN4");
}

#[test]
fn change_types_follow_power_query_conversions() {
    let m = "let Source = #table({\"A\",\"B\",\"C\",\"D\",\"E\"}, {{\"1\",\"1,234.5\",\"2024-03-05\",\"true\",\"7.6\"},{\"2\",\"\",\"3/7/2023\",\"false\",null}}),\n T = Table.TransformColumnTypes(Source, {{\"A\", Int64.Type}, {\"B\", type number}, {\"C\", type date}, {\"D\", type logical}, {\"E\", Int64.Type}}) in T";
    let (_, r) = run(m);
    // empty text becomes null in a number column; 7.6 rounds to 8
    assert_eq!(r, t(&[&["1", "1234.5", "2024-03-05", "true", "8"], &["2", "~", "2023-03-07", "false", "~"]]));
    let m2 = "let Source = #table({\"N\",\"D\"}, {{1.5, #date(2024,1,2)},{2, #date(2024,12,31)}}),\n T = Table.TransformColumnTypes(Source, {{\"N\", type text}, {\"D\", type text}}) in T";
    let (_, r) = run(m2);
    assert_eq!(r, t(&[&["1.5", "1/2/2024"], &["2", "12/31/2024"]]));
    assert!(fails("let Source = #table({\"A\"}, {{\"x\"}}), T = Table.TransformColumnTypes(Source, {{\"A\", Int64.Type}}) in T").len() > 5);
    assert!(fails("let Source = #table({\"A\"}, {{\"1\"}}), T = Table.TransformColumnTypes(Source, {{\"B\", Int64.Type}}) in T").contains("'B'"));
}

#[test]
fn replace_values_whole_cell_or_substring() {
    let (_, r) = run(&people("  S = Table.ReplaceValue(Source, \"Rome\", \"Roma\", Replacer.ReplaceValue, {\"City\"})", "S"));
    assert_eq!(r.iter().map(|x| x[2].as_str()).collect::<Vec<_>>(), ["Roma", "Paris", "Roma", "Oslo", "Paris"]);
    // whole-cell replacement leaves a partial match alone
    let (_, r) = run(&people("  S = Table.ReplaceValue(Source, \"om\", \"XX\", Replacer.ReplaceValue, {\"City\"})", "S"));
    assert_eq!(r[0][2], "Rome");
    let (_, r) = run(&people("  S = Table.ReplaceValue(Source, \"om\", \"XX\", Replacer.ReplaceText, {\"City\"})", "S"));
    assert_eq!(r[0][2], "RXXe");
    let (_, r) = run(&people("  S = Table.ReplaceValue(Source, null, 0, Replacer.ReplaceValue, {\"Age\"})", "S"));
    assert_eq!(r[2][1], "0");
}

#[test]
fn split_column_by_delimiter_positions_and_lengths() {
    let src = "#table({\"Full\",\"Code\"}, {{\"a-b-c\",\"ABCDEF\"},{\"x-y\",\"AB\"},{null,\"\"}})";
    let m = |step: &str| format!("let Source = {src}, S = {step} in S");
    let (c, r) = run(&m("Table.SplitColumn(Source, \"Full\", Splitter.SplitTextByDelimiter(\"-\", QuoteStyle.Csv), {\"F.1\", \"F.2\", \"F.3\"})"));
    assert_eq!(c, ["F.1", "F.2", "F.3", "Code"]);
    assert_eq!(r, t(&[&["a", "b", "c", "ABCDEF"], &["x", "y", "~", "AB"], &["~", "~", "~", ""]]));
    let (c, r) = run(&m("Table.SplitColumn(Source, \"Code\", Splitter.SplitTextByPositions({0, 2, 4}), {\"P1\", \"P2\", \"P3\"})"));
    assert_eq!(c, ["Full", "P1", "P2", "P3"]);
    assert_eq!(r[0], ["a-b-c", "AB", "CD", "EF"]);
    assert_eq!(r[1], ["x-y", "AB", "~", "~"]);
    let (_, r) = run(&m("Table.SplitColumn(Source, \"Code\", Splitter.SplitTextByRepeatedLengths(3), {\"A\", \"B\"})"));
    assert_eq!(r[0], ["a-b-c", "ABC", "DEF"]);
    let (_, r) = run(&m("Table.SplitColumn(Source, \"Full\", Splitter.SplitTextByAnyDelimiter({\"-\", \"b\"}), {\"A\", \"B\", \"C\", \"D\"})"));
    assert_eq!(r[0], ["a", "", "", "c", "ABCDEF"]);
}

#[test]
fn group_by_with_aggregates() {
    let m = people(
        "  G = Table.Group(Source, {\"City\"}, {{\"People\", each Table.RowCount(_), Int64.Type}, {\"Total\", each List.Sum([Age]), type nullable number}, {\"Oldest\", each List.Max([Age]), type nullable number}, {\"Avg\", each List.Average([Age]), type nullable number}, {\"Distinct\", each List.Count(List.Distinct([Age])), Int64.Type}})",
        "G",
    );
    let (c, r) = run(&m);
    assert_eq!(c, ["City", "People", "Total", "Oldest", "Avg", "Distinct"]);
    // groups appear in order of first appearance
    assert_eq!(r, t(&[&["Rome", "2", "30", "30", "30", "1"], &["Paris", "2", "50", "25", "25", "1"], &["Oslo", "1", "41", "41", "41", "1"]]));
    let (_, r) = run(&people("  G = Table.Group(Source, {}, {{\"N\", each Table.RowCount(_), Int64.Type}})", "G"));
    assert_eq!(r, t(&[&["5"]]));
    let (_, r) = run(&people("  G = Table.Group(Source, {\"City\", \"Age\"}, {{\"N\", each List.Count([Name]), Int64.Type}})", "G"));
    assert_eq!(r.len(), 4);
    assert!(fails(&people("  G = Table.Group(Source, {\"City\"}, {{\"T\", each _}})", "G")).contains("Nested tables"));
}

#[test]
fn fill_down_and_up() {
    let src = "#table({\"K\",\"V\"}, {{1,\"a\"},{2,null},{3,null},{4,\"b\"},{5,null}})";
    let (_, r) = run(&format!("let Source = {src}, S = Table.FillDown(Source, {{\"V\"}}) in S"));
    assert_eq!(r.iter().map(|x| x[1].as_str()).collect::<Vec<_>>(), ["a", "a", "a", "b", "b"]);
    let (_, r) = run(&format!("let Source = {src}, S = Table.FillUp(Source, {{\"V\"}}) in S"));
    assert_eq!(r.iter().map(|x| x[1].as_str()).collect::<Vec<_>>(), ["a", "b", "b", "b", "~"]);
}

#[test]
fn pivot_and_unpivot() {
    let sales = "#table({\"Region\",\"Year\",\"Amount\"}, {{\"N\",\"2023\",10},{\"N\",\"2024\",20},{\"S\",\"2023\",5},{\"N\",\"2023\",1}})";
    let (c, r) = run(&format!(
        "let Source = {sales}, P = Table.Pivot(Source, List.Distinct(Source[Year]), \"Year\", \"Amount\", List.Sum) in P"
    ));
    assert_eq!(c, ["Region", "2023", "2024"]);
    assert_eq!(r, t(&[&["N", "11", "20"], &["S", "5", "~"]]));
    let wide = "#table({\"Id\",\"Q1\",\"Q2\",\"Q3\"}, {{\"a\",1,2,null},{\"b\",null,5,6}})";
    let (c, r) = run(&format!("let Source = {wide}, U = Table.UnpivotOtherColumns(Source, {{\"Id\"}}, \"Quarter\", \"Value\") in U"));
    assert_eq!(c, ["Id", "Quarter", "Value"]);
    assert_eq!(r, t(&[&["a", "Q1", "1"], &["a", "Q2", "2"], &["b", "Q2", "5"], &["b", "Q3", "6"]]));
    let (_, r) = run(&format!("let Source = {wide}, U = Table.Unpivot(Source, {{\"Q2\", \"Q3\"}}, \"A\", \"V\") in U"));
    assert_eq!(r.len(), 3);
    assert_eq!(c.len(), 3);
}

#[test]
fn append_and_merge() {
    let a = "#table({\"K\",\"X\"}, {{1,\"a\"},{2,\"b\"}})";
    let b = "#table({\"K\",\"Y\"}, {{2,\"B\"},{3,\"C\"},{2,\"BB\"}})";
    let e = engine();
    let (c, r) = run_with(&e, &[("A", &format!("let S = {a} in S")), ("B", &format!("let S = {b} in S")), ("Q", "let S = Table.Combine({A, B}) in S")]);
    assert_eq!(c, ["K", "X", "Y"]);
    assert_eq!(r, t(&[&["1", "a", "~"], &["2", "b", "~"], &["2", "~", "B"], &["3", "~", "C"], &["2", "~", "BB"]]));
    let merge = |kind: &str| {
        run_with(
            &e,
            &[
                ("A", &format!("let S = {a} in S")),
                ("B", &format!("let S = {b} in S")),
                ("Q", &format!("let N = Table.NestedJoin(A, {{\"K\"}}, B, {{\"K\"}}, \"Bs\", {kind}), E = Table.ExpandTableColumn(N, \"Bs\", {{\"Y\"}}, {{\"Y\"}}) in E")),
            ],
        )
    };
    assert_eq!(merge("JoinKind.LeftOuter").1, t(&[&["1", "a", "~"], &["2", "b", "B"], &["2", "b", "BB"]]));
    assert_eq!(merge("JoinKind.Inner").1, t(&[&["2", "b", "B"], &["2", "b", "BB"]]));
    let full = merge("JoinKind.FullOuter").1;
    assert_eq!(full.len(), 4);
    assert!(full.contains(&vec!["3".to_string(), "~".to_string(), "C".to_string()]), "{full:?}");
    assert_eq!(merge("JoinKind.LeftAnti").1, t(&[&["1", "a", "~"]]));
    let (c, r) = run_with(
        &e,
        &[
            ("A", &format!("let S = {a} in S")),
            ("B", "let S = #table({\"K2\",\"Y\"}, {{2,\"B\"}}) in S"),
            ("Q", "let J = Table.Join(A, {\"K\"}, B, {\"K2\"}, JoinKind.Inner) in J"),
        ],
    );
    assert_eq!(c, ["K", "X", "K2", "Y"]);
    assert_eq!(r, t(&[&["2", "b", "2", "B"]]));
    // null keys match each other in a merge, as in Power Query
    let (_, r) = run_with(
        &e,
        &[
            ("A", "let S = #table({\"K\"}, {{null},{1}}) in S"),
            ("B", "let S = #table({\"K\",\"V\"}, {{null,\"z\"}}) in S"),
            ("Q", "let N = Table.NestedJoin(A, {\"K\"}, B, {\"K\"}, \"B\", JoinKind.LeftOuter), E = Table.ExpandTableColumn(N, \"B\", {\"V\"}) in E"),
        ],
    );
    assert_eq!(r, t(&[&["~", "z"], &["1", "~"]]));
}

#[test]
fn promote_and_demote_headers() {
    let src = "#table({\"Column1\",\"Column2\",\"Column3\"}, {{\"id\",\"name\",\"\"},{\"1\",\"x\",\"y\"},{\"2\",\"z\",\"w\"}})";
    let (c, r) = run(&format!("let Source = {src}, P = Table.PromoteHeaders(Source, [PromoteAllScalars=true]) in P"));
    assert_eq!(c, ["id", "name", "Column3"]);
    assert_eq!(r, t(&[&["1", "x", "y"], &["2", "z", "w"]]));
    let dup = "#table({\"Column1\",\"Column2\"}, {{\"a\",\"a\"},{\"1\",\"2\"}})";
    let (c, _) = run(&format!("let Source = {dup}, P = Table.PromoteHeaders(Source) in P"));
    assert_eq!(c, ["a", "a.1"]);
    let (c, r) = run(&format!("let Source = {src}, D = Table.DemoteHeaders(Table.PromoteHeaders(Source)) in D"));
    assert_eq!(c, ["Column1", "Column2", "Column3"]);
    assert_eq!(r[0], ["id", "name", "Column3"]);
    assert_eq!(r.len(), 3);
}

#[test]
fn step_references_functions_and_errors() {
    // steps may reference later steps and unused steps may fail without hurting the result
    let m = "let\n  B = Table.SelectRows(A, each [x] > 1),\n  A = #table({\"x\"}, {{1},{2},{3}}),\n  Broken = Table.SelectColumns(A, {\"nope\"})\nin\n  B";
    let (_, r) = run(m);
    assert_eq!(r, t(&[&["2"], &["3"]]));
    assert!(fails("let A = A in A").contains("cycle"));
    assert!(fails("let A = 1 in A").contains("not a table"));
    let e = engine();
    let qs = queries(&[("Q", m)]);
    let steps = e.m_analyze(&qs, "Q").unwrap();
    assert_eq!(steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["B", "A", "Broken"]);
    assert!(steps[0].error.is_none() && steps[0].columns[0].name == "x");
    assert!(steps[2].error.as_ref().unwrap().message.contains("'nope'"));
    // user-defined functions and try/otherwise run in the evaluator itself
    let (_, r) = run("let F = (n as number) => n * 2, T = #table({\"x\"}, {{F(21)}, {try error \"boom\" otherwise 7}}) in T");
    assert_eq!(r, t(&[&["42"], &["7"]]));
}

#[test]
fn unsupported_things_say_so() {
    assert!(fails("let S = Web.Contents(\"http://x\") in S").contains("not supported"));
    assert!(fails(&people("  S = Table.Profile(Source)", "S")).contains("not supported"));
    assert!(fails(&people("  S = Table.RemoveRowsWithErrors(Source)", "S")).contains("not supported"));
    assert!(fails(&people("  S = Table.Group(Source, {\"City\"}, {{\"N\", each Table.RowCount(_)}}, GroupKind.Local)", "S")).contains("GroupKind.Local"));
}

fn csv_query(path: &str, extra: &str) -> String {
    format!("let\n  Source = Csv.Document(File.Contents({path:?}), [Delimiter=\",\", Encoding=65001, QuoteStyle=QuoteStyle.Csv]),\n  #\"Promoted Headers\" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]){extra}\nin\n  {}", if extra.is_empty() { "#\"Promoted Headers\"" } else { "#\"Changed Type\"" })
}

#[test]
fn csv_files_read_like_power_query_empty_text_stays_text() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("t.csv");
    std::fs::write(&p, "Id,Name,Score,When\n1,\"Smith, J\",2.5,2024-01-02\n2,,,\n3,\"Say \"\"hi\"\"\",7,2024-02-03\n").unwrap();
    let path = p.to_string_lossy().replace('\\', "/");
    let (c, r) = run(&csv_query(&path, ""));
    assert_eq!(c, ["Id", "Name", "Score", "When"]);
    assert_eq!(r, t(&[&["1", "Smith, J", "2.5", "2024-01-02"], &["2", "", "", ""], &["3", "Say \"hi\"", "7", "2024-02-03"]]));
    let typed = ",\n  #\"Changed Type\" = Table.TransformColumnTypes(#\"Promoted Headers\", {{\"Id\", Int64.Type}, {\"Name\", type text}, {\"Score\", type number}, {\"When\", type date}})";
    let (_, r) = run(&csv_query(&path, typed));
    // after typing, the empty text field is still "" while number and date become null
    assert_eq!(r, t(&[&["1", "Smith, J", "2.5", "2024-01-02"], &["2", "", "~", "~"], &["3", "Say \"hi\"", "7", "2024-02-03"]]));
    assert!(fails(&csv_query("C:/definitely/missing.csv", "")).to_lowercase().contains("not found"));
}

#[test]
fn folder_files_combine_csv_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.csv"), "k,v\n1,x\n2,y\n").unwrap();
    std::fs::write(dir.path().join("b.csv"), "k,v\n3,z\n").unwrap();
    std::fs::write(dir.path().join("note.txt"), "ignore me").unwrap();
    let folder = dir.path().to_string_lossy().replace('\\', "/");
    let m = format!(
        "let\n  Source = Folder.Files({folder:?}),\n  Csvs = Table.SelectRows(Source, each [Extension] = \".csv\"),\n  Tables = List.Transform(Csvs[Content], each Table.PromoteHeaders(Csv.Document(_, [Delimiter=\",\"]))),\n  Combined = Table.Combine(Tables)\nin\n  Combined"
    );
    let (c, r) = run(&m);
    assert_eq!(c, ["k", "v"]);
    assert_eq!(r, t(&[&["1", "x"], &["2", "y"], &["3", "z"]]));
    let (c, r) = run(&format!("let Source = Folder.Files({folder:?}), S = Table.SelectColumns(Source, {{\"Name\", \"Extension\"}}) in S"));
    assert_eq!(c, ["Name", "Extension"]);
    assert_eq!(r.len(), 3);
    assert_eq!(r[0], ["a.csv", ".csv"]);
}

#[test]
fn excel_workbook_navigation() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("w.xlsx");
    {
        let mut wb = rust_xlsxwriter::Workbook::new();
        let s1 = wb.add_worksheet();
        s1.set_name("Data").unwrap();
        s1.write(0, 0, "Item").unwrap();
        s1.write(0, 1, "Qty").unwrap();
        s1.write(1, 0, "pen").unwrap();
        s1.write(1, 1, 3).unwrap();
        s1.write(2, 0, "ink").unwrap();
        s1.write(2, 1, 4).unwrap();
        let s2 = wb.add_worksheet();
        s2.set_name("Other").unwrap();
        s2.write(0, 0, "A").unwrap();
        s2.write(1, 0, 1).unwrap();
        wb.save(&p).unwrap();
    }
    let path = p.to_string_lossy().replace('\\', "/");
    let m = format!("let Source = Excel.Workbook(File.Contents({path:?}), true, true), D = Source{{[Item=\"Data\",Kind=\"Sheet\"]}}[Data] in D");
    let (c, r) = run(&m);
    assert_eq!(c, ["Item", "Qty"]);
    assert_eq!(r, t(&[&["pen", "3"], &["ink", "4"]]));
    let m = format!("let Source = Excel.Workbook(File.Contents({path:?}), true, true), D = Source{{1}}[Data] in D");
    assert_eq!(run(&m).0, ["A"]);
    let m = format!("let Source = Excel.Workbook(File.Contents({path:?}), true, true), D = Source{{[Item=\"Nope\",Kind=\"Sheet\"]}}[Data] in D");
    assert!(fails(&m).contains("didn't match"));
}

#[test]
fn loading_a_query_replaces_the_table_only_on_success() {
    let e = engine();
    let qs = queries(&[("Q", "let S = #table({\"x\"}, {{1},{2}}) in S")]);
    let info = e.m_load(&qs, "Q", "Result").unwrap();
    assert_eq!(info.row_count, 2);
    let bad = queries(&[("Q", "let S = Table.SelectColumns(#table({\"x\"}, {{1}}), {\"y\"}) in S")]);
    assert!(e.m_load(&bad, "Q", "Result").is_err());
    assert_eq!(e.table_info("Result").unwrap().row_count, 2);
}

#[test]
fn m_over_imported_fixture_tables_by_query_name() {
    let _ = (SourceSpec::Json { path: String::new() }, MemoryCredentialStore::default());
    let (store, _) = fixture::setup();
    // an M query can start from a table that is already in the store only through a source, so use the CSV directly
    let sales = fixture::fixtures().join("Sales.csv").to_string_lossy().replace('\\', "/");
    let m = format!(
        "let\n  Source = Csv.Document(File.Contents({sales:?}), [Delimiter=\",\"]),\n  H = Table.PromoteHeaders(Source),\n  T = Table.TransformColumnTypes(H, {{{{\"Quantity\", Int64.Type}}, {{\"Channel\", type text}}}}),\n  G = Table.Group(T, {{\"Channel\"}}, {{{{\"Qty\", each List.Sum([Quantity]), type nullable number}}, {{\"Rows\", each Table.RowCount(_), Int64.Type}}}})\nin\n  G"
    );
    let (_, r) = run_with(&store, &[("Q", &m)]);
    let rows_total: i64 = r.iter().map(|x| x[2].parse::<i64>().unwrap()).sum();
    assert_eq!(rows_total, 241);
    // compare with the same aggregation done directly in DuckDB over the engine's own import
    let direct: Vec<(String, i64)> = {
        let mut st = store.connection().prepare("SELECT Channel, sum(Quantity) FROM Sales GROUP BY Channel ORDER BY Channel").unwrap();
        st.query_map([], |x| Ok((x.get::<_, String>(0)?, x.get::<_, i64>(1)?))).unwrap().map(|x| x.unwrap()).collect()
    };
    let mut got: Vec<(String, i64)> = r.iter().map(|x| (x[0].clone(), x[1].parse().unwrap())).collect();
    got.sort();
    assert_eq!(got, direct);
}

#[test]
fn desktop_check_cases_give_what_the_readme_says() {
    // the queries of tests/m/README.md (to be compared with Power BI Desktop by hand)
    let cases: &[(&str, &[&str], &[&[&str]])] = &[
        ("let S = #table({\"a\"}, {{1},{null},{3}}), F = Table.SelectRows(S, each [a] > 1) in F", &["a"], &[&["3"]]),
        ("let S = #table({\"a\"}, {{1},{null}}), F = Table.SelectRows(S, each [a] <> 1) in F", &["a"], &[&["~"]]),
        ("let S = #table({\"a\"}, {{\"7.6\"},{\"-7.5\"},{\"\"}}), T = Table.TransformColumnTypes(S, {{\"a\", Int64.Type}}) in T", &["a"], &[&["8"], &["-8"], &["~"]]),
        ("let S = #table({\"a\"}, {{\"1,234.5\"}}), T = Table.TransformColumnTypes(S, {{\"a\", type number}}, \"en-US\") in T", &["a"], &[&["1234.5"]]),
        ("let S = #table({\"a\"}, {{0.5},{1.5},{2.5},{3.5}}), T = Table.TransformColumns(S, {{\"a\", each Number.Round(_), type number}}) in T", &["a"], &[&["0"], &["2"], &["2"], &["4"]]),
        ("let S = #table({\"a\"}, {{\"B\"},{\"a\"},{null},{\"A\"}}), T = Table.Sort(S, {{\"a\", Order.Ascending}}) in T", &["a"], &[&["~"], &["A"], &["B"], &["a"]]),
        ("let S = #table({\"k\",\"v\"}, {{\"x\",1},{\"y\",null}}), T = Table.Group(S, {\"k\"}, {{\"s\", each List.Sum([v]), type nullable number}, {\"n\", each List.Count([v]), Int64.Type}}) in T", &["k", "s", "n"], &[&["x", "1", "1"], &["y", "~", "1"]]),
        ("let S = #table({\"r\",\"y\",\"v\"}, {{\"n\",\"2023\",1},{\"s\",\"2024\",2}}), P = Table.Pivot(S, {\"2023\",\"2024\"}, \"y\", \"v\", List.Count) in P", &["r", "2023", "2024"], &[&["n", "1", "~"], &["s", "~", "1"]]),
        ("let S = #table({\"id\",\"a\",\"b\"}, {{\"x\",1,null}}), U = Table.UnpivotOtherColumns(S, {\"id\"}, \"k\", \"v\") in U", &["id", "k", "v"], &[&["x", "a", "1"]]),
        ("let A = #table({\"k\"}, {{null},{1}}), B = #table({\"k\",\"v\"}, {{null,\"z\"}}), N = Table.NestedJoin(A, {\"k\"}, B, {\"k\"}, \"b\", JoinKind.LeftOuter), E = Table.ExpandTableColumn(N, \"b\", {\"v\"}) in E", &["k", "v"], &[&["~", "z"], &["1", "~"]]),
        ("let S = #table({\"a\"}, {{\"x\"}}), D = Table.DuplicateColumn(S, \"a\", \"b\") in D", &["a", "b"], &[&["x", "x"]]),
        ("let S = #table({\"d\"}, {{#date(2024,1,2)}}), T = Table.TransformColumnTypes(S, {{\"d\", type text}}) in T", &["d"], &[&["1/2/2024"]]),
        ("let S = #table({\"a\"}, {{\" x \"},{\"x\"}}), T = Table.TransformColumns(S, {{\"a\", Text.Trim, type text}}) in T", &["a"], &[&["x"], &["x"]]),
    ];
    for (q, cols, rows) in cases {
        let (c, r) = run(q);
        assert_eq!(c, *cols, "{q}");
        assert_eq!(r, t(rows), "{q}");
    }
    // Table.Join of two tables that both have a column "k" is refused
    assert!(fails("let A = #table({\"k\"}, {{1}}), B = #table({\"k\",\"v\"}, {{1,\"z\"}}), J = Table.Join(A, {\"k\"}, B, {\"k\"}, JoinKind.LeftOuter) in J").contains("both tables"));
}

#[test]
fn column_profile_counts_valid_empty_distinct_unique_and_the_top_values() {
    let e = engine();
    let m = r#"let S = #table({"n","s"}, {{1,"a"},{2,"a"},{2,"b"},{null,""},{4,null}}) in S"#;
    let qs = queries(&[("Q", m)]);
    let p = e.m_profile(&qs, "Q", None, None).unwrap();
    assert_eq!(p.len(), 2);
    let n = &p[0];
    assert_eq!((n.rows, n.valid, n.empty, n.error, n.distinct, n.unique), (5, 4, 1, 0, 3, 2));
    assert_eq!((n.min.as_deref(), n.max.as_deref()), (Some("1"), Some("4")));
    assert!((n.average.unwrap() - 2.25).abs() < 1e-9);
    assert!((n.std_dev.unwrap() - 1.2583057392117916).abs() < 1e-9);
    assert_eq!(n.top[0], (Some("2".to_string()), 2));
    let s = &p[1];
    // text: empty text counts as empty, like null
    assert_eq!((s.rows, s.valid, s.empty, s.distinct, s.unique), (5, 3, 2, 3, 2)); // unique: "b" and ""
    assert_eq!(s.average, None);
    assert_eq!(s.top[0], (Some("a".to_string()), 2));
    // a limit reads only the first rows
    let l = e.m_profile(&qs, "Q", None, Some(2)).unwrap();
    assert_eq!((l[0].rows, l[0].rows_limited), (2, true));
}
