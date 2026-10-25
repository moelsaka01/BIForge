//! DAX over the DuckDB store: the fixture CSVs (tests/dax/fixtures) are imported, the DAX engine loads them
//! through the bridge, and every measure is evaluated under many filter contexts twice: once by the
//! engine alone and once with aggregations compiled to DuckDB SQL. The answers must match, and SQL must
//! actually be used where the semantics allow it.

use biforge_dax::Value;
mod fixture;
use fixture::setup;

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
        // row expressions of the iterators compile too (BLANK acts as 0 in + and -, BLANK * x is BLANK)
        "SUMX(Sales, Sales[Quantity] * Sales[UnitPrice] * (1 - Sales[Discount]))",
        "SUMX(Sales, Sales[Quantity] + Sales[Discount])",
        "SUMX(Sales, Sales[Discount] - Sales[Quantity])",
        "SUMX(Sales, RELATED(Product[ListPrice]) - Sales[UnitPrice])",
        "SUMX(Sales, -Sales[Quantity] * 2 + 0.5)",
        "AVERAGEX(Sales, Sales[UnitPrice] - Sales[Discount])",
        "MAXX(Sales, Sales[Quantity] * 2)",
        "MINX(Sales, Sales[Quantity] / 2)",
        "SUMX(Sales, DIVIDE(Sales[Quantity], Sales[Discount]))",
        "DISTINCTCOUNT(Sales[CustomerKey])",
        "DISTINCTCOUNT(Sales[Channel])",
        "DISTINCTCOUNT(Sales[Discount])",
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
    assert_eq!(used("SUMX(Sales, Sales[Quantity])"), 1);
    assert_eq!(used("SUMX(Sales, IF(Sales[Quantity] > 3, 1, 0))"), 0, "a condition is evaluated by the engine");
    assert_eq!(used("SUMX(Sales, Sales[Quantity] / Sales[UnitPrice])"), 0, "a division by a column is evaluated by the engine");
}

/// Queries the report layer and the harness use: a whole GROUP BY in one SQL statement must give exactly the rows the
/// engine gives combination by combination.
#[test]
fn grouped_queries_in_sql_match_the_engine() {
    let (store, dax) = setup();
    let measures = "\"q\", SUM(Sales[Quantity]), \"o\", COUNTROWS(Sales), \"p\", AVERAGE(Sales[UnitPrice]), \"a\", SUMX(Sales, Sales[Quantity] * Sales[UnitPrice] * (1 - Sales[Discount])), \"d\", DISTINCTCOUNT(Sales[CustomerKey]), \"mx\", MAX(Sales[OrderDate])";
    let groups = [
        "Product[Category]",
        "Customer[Country], Product[Category]",
        "'Date'[Year], 'Date'[Month]",
        "Sales[Channel]",
        "Promotion[Promotion], Sales[Channel]",
        "Customer[Segment]",
        "Product[Color], Customer[City]",
        "Sales[Quantity]",
    ];
    let filters = ["", "Customer[Country] IN {\"France\", \"Germany\"}, ", "FILTER(ALL(Product[Category]), Product[Category] <> \"Bikes\"), ", "TREATAS({(\"Bikes\", \"France\")}, Product[Category], Customer[Country]), "];
    let mut sql_runs = 0;
    for g in groups {
        for f in filters {
            let q = format!("EVALUATE SUMMARIZECOLUMNS({g}, {f}{measures}) ORDER BY {g}");
            let plain = dax.query_with(&q, None).unwrap_or_else(|e| panic!("{q}: {}", e.message));
            let viasql = dax.query_with(&q, Some(&store)).unwrap_or_else(|e| panic!("{q} (sql): {}", e.message));
            assert_eq!(plain.len(), viasql.len());
            for (a, b) in plain.iter().zip(&viasql) {
                assert_eq!(a.rows.len(), b.rows.len(), "{q}: row count");
                for (ra, rb) in a.rows.iter().zip(&b.rows) {
                    assert!(ra.iter().zip(rb).all(|(x, y)| same(x, y)), "{q}: engine {ra:?} vs SQL {rb:?}");
                }
            }
            sql_runs += 1;
        }
    }
    assert_eq!(sql_runs, groups.len() * filters.len());
    // the batch really runs: one statement per fact table, not one per combination
    let (v, hits) = dax.eval_scalar_with("COUNTROWS(SUMMARIZECOLUMNS(Product[Category], Customer[Country], \"q\", SUM(Sales[Quantity])))", Some(&store)).unwrap();
    assert!(matches!(v, Value::Int(n) if n > 5));
    assert_eq!(hits, 1, "the whole group-by should be one SQL statement");
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

#[test]
fn define_column_and_function_run_over_the_store_with_and_without_sql() {
    let (store, dax) = setup();
    let q = "DEFINE
        COLUMN Sales[Net] = Sales[Quantity] * Sales[UnitPrice] * (1 - Sales[Discount])
        FUNCTION Round2 = (x : scalar numeric) => ROUND(x, 2)
     EVALUATE ROW(\"net\", Round2(SUM(Sales[Net])), \"viaX\", Round2(SUMX(Sales, Sales[Net])), \"rows\", COUNTROWS(FILTER(Sales, Sales[Net] > 100)))";
    let plain = dax.query(q).unwrap_or_else(|e| panic!("{}", e.message));
    let with_sql = dax.query_with(q, Some(&store)).unwrap_or_else(|e| panic!("{}", e.message));
    assert_eq!(plain, with_sql, "the SQL path must not read a column the store does not have");
    assert_eq!(plain[0].rows[0][0], plain[0].rows[0][1]);
    // a plain query still sees only the model's columns afterwards
    assert!(dax.query("EVALUATE ROW(\"x\", SUM(Sales[Net]))").is_err());
}
