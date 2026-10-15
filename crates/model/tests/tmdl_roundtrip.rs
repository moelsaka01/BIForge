use biforge_model::tmdl::{self, PropValue};
use std::fs;
use std::path::PathBuf;

fn fixture(rel: &str) -> String {
    let p: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests", "fixtures", rel]
        .iter()
        .collect();
    fs::read_to_string(p).unwrap().replace("\r\n", "\n")
}

fn canonical_files() -> Vec<String> {
    let dir: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests", "fixtures", "canonical"]
        .iter()
        .collect();
    let mut v: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    v.sort();
    v
}

#[test]
fn canonical_fixtures_print_byte_identical() {
    let files = canonical_files();
    assert!(files.len() >= 7);
    for f in files {
        let src = fixture(&format!("canonical/{f}"));
        let doc = tmdl::parse(&src).unwrap_or_else(|e| panic!("{f}: {e}"));
        assert_eq!(tmdl::print(&doc), src, "round trip differs for {f}");
    }
}

#[test]
fn printing_is_idempotent_on_all_fixtures() {
    let mut all: Vec<String> = canonical_files()
        .into_iter()
        .map(|f| format!("canonical/{f}"))
        .collect();
    all.push("messy/spaces2.tmdl".into());
    for f in all {
        let doc = tmdl::parse(&fixture(&f)).unwrap();
        let again = tmdl::parse(&tmdl::print(&doc)).unwrap();
        assert_eq!(doc, again, "{f}");
    }
}

#[test]
fn messy_input_normalizes_to_canonical_output() {
    let doc = tmdl::parse(&fixture("messy/spaces2.tmdl")).unwrap();
    assert_eq!(tmdl::print(&doc), fixture("messy/spaces2.expected.tmdl"));
}

#[test]
fn crlf_and_bom_are_accepted() {
    let src = fixture("canonical/sales.tmdl");
    let crlf = format!("\u{feff}{}", src.replace('\n', "\r\n"));
    assert_eq!(tmdl::parse(&crlf).unwrap(), tmdl::parse(&src).unwrap());
}

#[test]
fn sales_structure_is_parsed() {
    let doc = tmdl::parse(&fixture("canonical/sales.tmdl")).unwrap();
    let t = &doc.nodes[0];
    assert_eq!(
        (t.kind.as_str(), t.name.as_deref()),
        ("table", Some("Sales"))
    );
    assert_eq!(t.description, vec!["Sales fact table"]);
    assert_eq!(
        t.text_prop("lineageTag"),
        Some("9a48bea0-e5fb-40fa-9e81-f61288e31a02")
    );

    let amount = &t.children[0];
    assert_eq!(amount.name.as_deref(), Some("Sales Amount"));
    assert_eq!(amount.description, vec!["Total of net amount"]);
    assert_eq!(
        amount.default.as_ref().unwrap().text,
        "SUMX(Sales, Sales[Quantity] * Sales[Net Price])"
    );
    assert_eq!(
        amount.text_prop("displayFolder"),
        Some(" My \"Amazing\" Measures")
    );

    let ly = &t.children[1];
    assert_eq!(
        ly.default.as_ref().unwrap().text,
        "var ly = CALCULATE([Sales Amount], SAMEPERIODLASTYEAR('Calendar'[Date]))\nreturn ly"
    );

    let key = t
        .children
        .iter()
        .find(|c| c.name.as_deref() == Some("Product Key"))
        .unwrap();
    assert!(key.has_flag("isHidden"));

    let part = t.children.iter().find(|c| c.kind == "partition").unwrap();
    assert_eq!(part.default.as_ref().unwrap().text, "m");
    match part.prop("source") {
        Some(PropValue::Expr(e)) => {
            assert!(e.text.starts_with("let\n\tSource = Sql.Database"));
            assert!(e.text.ends_with("in\n\tSales"));
        }
        other => panic!("unexpected source prop: {other:?}"),
    }

    let h = t.children.iter().find(|c| c.kind == "hierarchy").unwrap();
    assert_eq!(h.children[0].text_prop("column"), Some("Category"));
}

#[test]
fn fence_keeps_trailing_whitespace_and_blank_lines() {
    let doc = tmdl::parse(&fixture("canonical/fence.tmdl")).unwrap();
    let m = &doc.nodes[0].children[0];
    let e = m.default.as_ref().unwrap();
    assert!(e.verbatim);
    assert_eq!(e.text, "VAR a = 1   \n\nRETURN a");
}

#[test]
fn model_refs_are_kept_in_order() {
    let doc = tmdl::parse(&fixture("canonical/model.tmdl")).unwrap();
    let refs: Vec<_> = doc
        .nodes
        .iter()
        .skip(1)
        .map(|n| (n.kind.clone(), n.name.clone().unwrap()))
        .collect();
    assert_eq!(
        refs,
        vec![
            ("ref table".to_string(), "Calendar".to_string()),
            ("ref table".to_string(), "Sales".to_string()),
            ("ref table".to_string(), "Product".to_string()),
            ("ref culture".to_string(), "en-US".to_string()),
        ]
    );
}

#[test]
fn names_with_special_characters_are_quoted_and_escaped() {
    let src = "table 'It''s a.name'\n\n\tcolumn 'a=b'\n\t\tdataType: string\n";
    let doc = tmdl::parse(src).unwrap();
    assert_eq!(doc.nodes[0].name.as_deref(), Some("It's a.name"));
    assert_eq!(doc.nodes[0].children[0].name.as_deref(), Some("a=b"));
    assert_eq!(tmdl::print(&doc), src);
}

#[test]
fn value_that_looks_quoted_round_trips() {
    let src = "measure M = 1\n\tformatString: \"\"\"$\"\"#,##0\"\n";
    let doc = tmdl::parse(src).unwrap();
    assert_eq!(doc.nodes[0].text_prop("formatString"), Some("\"$\"#,##0"));
    assert_eq!(tmdl::print(&doc), src);
    // unquoted literal with a leading quote only
    let doc2 = tmdl::parse("measure M = 1\n\tformatString: \"$\"#,##0\n").unwrap();
    assert_eq!(doc2.nodes[0].text_prop("formatString"), Some("\"$\"#,##0"));
}

fn parse_err(src: &str) -> (usize, String) {
    let e = tmdl::parse(src).unwrap_err();
    (e.line, e.message)
}

#[test]
fn error_unterminated_fence() {
    let (line, msg) = parse_err("table T\n\tmeasure M = ```\n\t\t\tx\n");
    assert_eq!(line, 2);
    assert!(msg.contains("unterminated"));
}

#[test]
fn error_unterminated_quoted_name() {
    let (line, msg) = parse_err("table 'Oops\n");
    assert_eq!(line, 1);
    assert!(msg.contains("unterminated"));
}

#[test]
fn error_unexpected_indentation_skips_a_level() {
    let (line, _) = parse_err("table T\n\t\tcolumn C\n");
    assert_eq!(line, 2);
}

#[test]
fn error_description_must_touch_object() {
    let (line, msg) = parse_err("/// doc\n\ntable T\n");
    assert_eq!(line, 1);
    assert!(msg.contains("description"));
}

#[test]
fn error_property_at_top_level() {
    let (line, _) = parse_err("isHidden\n");
    assert_eq!(line, 1);
}

#[test]
fn error_text_after_name() {
    let (line, msg) = parse_err("table T extra\n");
    assert_eq!(line, 1);
    assert!(msg.contains("unexpected text"));
}

#[test]
fn empty_and_blank_documents_are_empty() {
    assert!(tmdl::parse("").unwrap().nodes.is_empty());
    assert!(tmdl::parse("\n\n").unwrap().nodes.is_empty());
    assert_eq!(tmdl::print(&tmdl::Document::default()), "");
}
