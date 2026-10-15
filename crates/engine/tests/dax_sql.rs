//! DAX over the DuckDB store: the fixture CSVs (tests/dax/fixtures) are imported, the DAX engine loads them
//! through the bridge, and every measure is evaluated under many filter contexts twice: once by the
//! engine alone and once with aggregations compiled to DuckDB SQL. The answers must match, and SQL must
//! actually be used where the semantics allow it.

use biforge_dax::model::Model;
use biforge_dax::{CrossFilter, Value};
use biforge_engine::dax_bridge::dax_type;
use biforge_engine::{Engine, MemoryCredentialStore, SourceSpec};
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/dax/fixtures")
}

const TABLES: &[&str] = &["Date", "Customer", "Product", "Promotion", "Sales", "Budget"];

fn setup() -> (Engine, biforge_dax::Engine) {
    let store = Engine::in_memory().unwrap();
    let creds = MemoryCredentialStore::default();
    let mut model = Model::new();
    for t in TABLES {
        let path = fixtures().join(format!("{t}.csv")).to_string_lossy().into_owned();
        let info = store.import(t, &SourceSpec::Csv { path, delimiter: None, header: None }, &creds).unwrap();
        let cols: Vec<(String, biforge_dax::DataType)> = info.columns.iter().map(|c| (c.name.clone(), dax_type(c.bi_type))).collect();
        let refs: Vec<(&str, biforge_dax::DataType)> = cols.iter().map(|(n, t)| (n.as_str(), *t)).collect();
        model.add_table(t, &refs).unwrap();
    }
    // the relationships of the fixture report (tests/dax/fixtures/README.md)
    model.add_relationship(("Sales", "OrderDate"), ("Date", "Date"), CrossFilter::Single, true).unwrap();
    model.add_relationship(("Sales", "ShipDate"), ("Date", "Date"), CrossFilter::Single, false).unwrap();
    model.add_relationship(("Sales", "CustomerKey"), ("Customer", "CustomerKey"), CrossFilter::Single, true).unwrap();
    model.add_relationship(("Sales", "ProductKey"), ("Product", "ProductKey"), CrossFilter::Single, true).unwrap();
    model.add_relationship(("Sales", "PromotionKey"), ("Promotion", "PromotionKey"), CrossFilter::Both, true).unwrap();
    let dax = biforge_dax::Engine::new(model, &store).unwrap();
    (store, dax)
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Double(x), Value::Double(y)) => (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0),
        _ => a == b,
    }
}

#[test]
fn loads_fixture_data_with_types_and_blanks() {
    let (_, dax) = setup();
    let ev = |s: &str| dax.eval_scalar(s).unwrap_or_else(|e| panic!("{s}: {}", e.message));
    assert_eq!(ev("COUNTROWS(Sales)"), Value::Int(241));
    assert_eq!(ev("COUNTROWS('Date')"), Value::Int(731));
    // SalesKey 90 has a blank Quantity, 50 and 51 have no ship date
    assert_eq!(ev("COUNTBLANK(Sales[Quantity])"), Value::Int(1));
    assert_eq!(ev("COUNTBLANK(Sales[ShipDate])"), Value::Int(2));
    // customer 99 and the blank product key give Customer and Product a blank row
    assert_eq!(ev("COUNTROWS(VALUES(Customer))"), Value::Int(11));
    assert_eq!(ev("COUNTROWS(VALUES(Product))"), Value::Int(10));
    assert_eq!(ev("COUNTROWS(VALUES(Promotion))"), Value::Int(4));
    assert_eq!(ev("MIN('Date'[Date])"), Value::DateTime(biforge_dax::value::date_serial(2023, 1, 1).unwrap()));
    assert_eq!(ev("CALCULATE(COUNTROWS(Sales), Sales[SalesKey] = 77, Sales[Quantity] = -2)"), Value::Int(1));
}

#[test]
fn sql_compiled_aggregations_match_the_engine() {
    let (store, dax) = setup();
    let measures = [
        "SUM(Sales[Quantity])",
        "SUM(Sales[UnitPrice])",
        "AVERAGE(Sales[UnitPrice])",
        "MIN(Sales[OrderDate])",
        "MAX(Sales[Quantity])",
        "MIN(Sales[Discount])",
        "COUNT(Sales[Discount])",
        "COUNTROWS(Sales)",
        "COUNTROWS(Product)",
        "COUNTROWS(Promotion)",
        "SUM(Budget[BudgetAmount])",
        "COUNTROWS(Customer)",
    ];
    let contexts = [
        "",
        "Product[Category] = \"Bikes\"",
        "Product[Color] = \"red\"",
        "Customer[Country] IN {\"France\", \"Germany\"}",
        "'Date'[Year] = 2024",
        "'Date'[Year] = 2023, Product[Category] = \"Accessories\"",
        "Product[Color] = BLANK()",
        "Customer[Segment] = BLANK()",
        "Sales[Channel] = \"online\"",
        "Promotion[Promotion] = \"Spring Sale\"",
        "'Date'[Year] = 2024, USERELATIONSHIP(Sales[ShipDate], 'Date'[Date])",
        "'Date'[IsWeekend] = TRUE()",
        "'Date'[Date] >= dt\"2024-06-01\"",
        "Sales[Discount] = BLANK()",
        "Budget[Year] = 2024",
        // not compilable (row-set filter / cross-filter): the engine answers, results must still match
        "FILTER(Product, Product[ListPrice] > 100)",
        "Sales[Quantity] > 3",
        "ALL(Product), Product[Category] <> \"Bikes\"",
        "CROSSFILTER(Sales[ProductKey], Product[ProductKey], BOTH), Sales[Quantity] > 4",
    ];
    let mut hits = 0;
    let mut checked = 0;
    for c in contexts {
        for m in measures {
            let expr = if c.is_empty() { m.to_string() } else { format!("CALCULATE({m}, {c})") };
            let (plain, h0) = dax.eval_scalar_with(&expr, None).unwrap_or_else(|e| panic!("{expr}: {}", e.message));
            let (viasql, h1) = dax.eval_scalar_with(&expr, Some(&store)).unwrap_or_else(|e| panic!("{expr} (sql): {}", e.message));
            assert_eq!(h0, 0);
            assert!(same(&plain, &viasql), "{expr}: engine {plain:?} vs SQL {viasql:?}");
            hits += h1;
            checked += 1;
        }
    }
    assert_eq!(checked, measures.len() * contexts.len());
    // most simple contexts compile; make sure SQL really ran
    assert!(hits > 120, "only {hits} aggregations ran as SQL");
    // specific expectations about when SQL is (not) used
    let used = |e: &str| dax.eval_scalar_with(e, Some(&store)).unwrap().1;
    assert_eq!(used("CALCULATE(SUM(Sales[Quantity]), Product[Category] = \"Bikes\")"), 1);
    assert_eq!(used("CALCULATE(SUM(Sales[Quantity]), FILTER(Product, Product[ListPrice] > 100))"), 0);
    assert_eq!(used("CALCULATE(COUNTROWS(Promotion), Sales[Quantity] > 3)"), 0, "bidirectional cross-filter must not compile");
    assert_eq!(used("SUMX(Sales, Sales[Quantity])"), 0);
}

#[test]
fn compiled_sql_is_readable_and_case_insensitive() {
    let (store, dax) = setup();
    // case-insensitive text match through a relationship: "red" finds "Red"
    let (a, h) = dax.eval_scalar_with("CALCULATE(COUNTROWS(Sales), Product[Color] = \"RED\")", Some(&store)).unwrap();
    let (b, _) = dax.eval_scalar_with("CALCULATE(COUNTROWS(Sales), Product[Color] = \"Red\")", None).unwrap();
    assert_eq!(h, 1);
    assert_eq!(a, b);
    assert!(matches!(a, Value::Int(n) if n > 0));
}
