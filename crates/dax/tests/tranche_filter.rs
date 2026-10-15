//! Filter and table function tranche: ALLSELECTED, ALLCROSSFILTERED, FILTERS, GENERATESERIES, UNION / INTERSECT /
//! EXCEPT, GENERATE(ALL), NATURAL joins, TOPN, GROUPBY, DATATABLE, SUMMARIZE with added columns. Hand-computed on
//! the model of common/mod.rs (total quantity 14: Bikes 2, Accessories 11, Clothing none, one sale of 1 with a
//! blank product).

mod common;
use biforge_dax::Value;
use common::*;

fn fails(e: &biforge_dax::Engine, src: &str) {
    assert!(e.eval_scalar(src).is_err(), "{src} should fail");
}

#[test]
fn allselected_restores_the_outer_selection() {
    let e = engine();
    // the filter table is the "outer" selection (like a slicer); the group-by value is the inner one
    let r = sorted(rows(
        &e,
        "EVALUATE SUMMARIZECOLUMNS(Product[Category], FILTER(ALL(Product[Category]), Product[Category] IN {\"Bikes\", \"Accessories\"}), \"qty\", SUM(Sales[Qty]), \"sel\", CALCULATE(SUM(Sales[Qty]), ALLSELECTED(Product[Category])), \"all\", CALCULATE(SUM(Sales[Qty]), ALL(Product[Category])))",
    ));
    assert_eq!(r, vec![vec![s("Accessories"), i(11), i(13), i(14)], vec![s("Bikes"), i(2), i(13), i(14)]]);
    // without any outer filter ALLSELECTED sees everything, including the sale with a blank product
    let r = sorted(rows(&e, "EVALUATE SUMMARIZECOLUMNS(Product[Category], \"sel\", CALCULATE(SUM(Sales[Qty]), ALLSELECTED(Product[Category])))"));
    assert_eq!(r.len(), 4);
    assert!(r.iter().all(|row| row[1] == i(14)));
    // inside a plain CALCULATE the explicit filter is the selection
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALLSELECTED(Product[Category])), Product[Category] = \"Bikes\")"), i(2));
    // row context counts as inner too
    let r = rows(&e, "EVALUATE ADDCOLUMNS(VALUES(Product[Category]), \"v\", CALCULATE(SUM(Sales[Qty]), ALLSELECTED(Product[Category])))");
    assert!(r.iter().all(|row| row[1] == i(14)));
}

#[test]
fn allselected_without_arguments_restores_every_column() {
    let e = engine();
    let r = sorted(rows(
        &e,
        "EVALUATE SUMMARIZECOLUMNS(Product[Category], Customer[Country], FILTER(ALL(Customer[Country]), Customer[Country] = \"US\"), \"sel\", CALCULATE(SUM(Sales[Qty]), ALLSELECTED()))",
    ));
    // customers 1 and 3 are in the US: sales 1, 3, 5 -> quantity 1 + 3 + 4 = 8 for every row
    assert!(!r.is_empty());
    assert!(r.iter().all(|row| row[2] == i(8)));
}

#[test]
fn allcrossfiltered_clears_the_connected_tables() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALLCROSSFILTERED(Product)), Product[Color] = \"Red\")"), i(14));
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALLCROSSFILTERED(Product)), Customer[Country] = \"US\")"), i(14));
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALL(Product)), Customer[Country] = \"US\")"), i(8));
}

#[test]
fn filters_returns_the_directly_filtered_values() {
    let e = engine();
    // four distinct colors including blank
    assert_eq!(ev(&e, "COUNTROWS(FILTERS(Product[Color]))"), i(4));
    // a filter on Category is not a direct filter on Color
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(FILTERS(Product[Color])), Product[Category] = \"Clothing\")"), i(4));
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(VALUES(Product[Color])), Product[Category] = \"Clothing\")"), i(2));
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(FILTERS(Product[Color])), Product[Color] IN {\"Red\", \"Blue\"})"), i(2));
}

#[test]
fn generateseries() {
    let e = engine();
    assert_eq!(ev(&e, "COUNTROWS(GENERATESERIES(1, 5))"), i(5));
    assert_eq!(ev(&e, "SUMX(GENERATESERIES(1, 5), [Value])"), i(15));
    assert_eq!(ev(&e, "COUNTROWS(GENERATESERIES(1, 2, 0.5))"), i(3));
    assert_eq!(ev(&e, "SUMX(GENERATESERIES(1, 2, 0.5), [Value])"), f(4.5));
    assert_eq!(ev(&e, "COUNTROWS(GENERATESERIES(5, 1, -1))"), i(5));
    assert_eq!(ev(&e, "COUNTROWS(GENERATESERIES(5, 1))"), B);
    assert_eq!(ev(&e, "COUNTROWS(GENERATESERIES(DATE(2024, 1, 1), DATE(2024, 1, 5)))"), i(5));
    assert_eq!(ev(&e, "MAXX(GENERATESERIES(DATE(2024, 1, 1), DATE(2024, 1, 5)), [Value])"), d(2024, 1, 5));
}

#[test]
fn set_functions() {
    let e = engine();
    assert_eq!(ev(&e, "COUNTROWS(UNION({1, 2}, {2, 3}))"), i(4));
    assert_eq!(ev(&e, "COUNTROWS(DISTINCT(UNION({1, 2}, {2, 3})))"), i(3));
    assert_eq!(ev(&e, "COUNTROWS(INTERSECT({1, 2, 2, 3}, {2, 3, 4}))"), i(3));
    assert_eq!(ev(&e, "COUNTROWS(EXCEPT({1, 2, 2, 3}, {2}))"), i(2));
    assert_eq!(ev(&e, "SUMX(EXCEPT({1, 2, 2, 3}, {2}), [Value])"), i(4));
    fails(&e, "UNION({1}, ROW(\"a\", 1, \"b\", 2))");
}

#[test]
fn generate_and_generateall() {
    let e = engine();
    assert_eq!(ev(&e, "COUNTROWS(GENERATE({1, 2}, {10, 20}))"), i(4));
    assert_eq!(ev(&e, "SUMX(GENERATE(SELECTCOLUMNS({1, 2}, \"a\", [Value]), SELECTCOLUMNS({10, 20}, \"b\", [Value])), [a] * [b])"), i(90));
    let right = "FILTER(SELECTCOLUMNS({10, 20}, \"b\", [Value]), [b] > [a] * 10)";
    assert_eq!(ev(&e, &format!("COUNTROWS(GENERATE(SELECTCOLUMNS({{1, 2}}, \"a\", [Value]), {right}))")), i(1));
    assert_eq!(ev(&e, &format!("COUNTROWS(GENERATEALL(SELECTCOLUMNS({{1, 2}}, \"a\", [Value]), {right}))")), i(2));
}

#[test]
fn natural_joins_use_columns_with_the_same_lineage() {
    let e = engine();
    let left = "SELECTCOLUMNS(Product, \"ProductKey\", Product[ProductKey], \"Color\", Product[Color])";
    let right = "SELECTCOLUMNS(Product, \"ProductKey\", Product[ProductKey], \"Cat\", Product[Category])";
    assert_eq!(ev(&e, &format!("COUNTROWS(NATURALINNERJOIN({left}, {right}))")), i(5));
    assert_eq!(ev(&e, &format!("COUNTROWS(FILTER(NATURALINNERJOIN({left}, {right}), [Cat] = \"Clothing\"))")), i(2));
    let clothing = "SELECTCOLUMNS(FILTER(Product, Product[Category] = \"Clothing\"), \"ProductKey\", Product[ProductKey], \"X\", Product[Product])";
    let _ = clothing;
    let clothing = "SELECTCOLUMNS(FILTER(Product, Product[Category] = \"Clothing\"), \"ProductKey\", Product[ProductKey], \"X\", Product[Name])";
    let all = "SELECTCOLUMNS(Product, \"ProductKey\", Product[ProductKey])";
    assert_eq!(ev(&e, &format!("COUNTROWS(NATURALLEFTOUTERJOIN({all}, {clothing}))")), i(5));
    assert_eq!(ev(&e, &format!("COUNTROWS(FILTER(NATURALLEFTOUTERJOIN({all}, {clothing}), ISBLANK([X])))")), i(3));
    assert_eq!(ev(&e, &format!("COUNTROWS(NATURALINNERJOIN({all}, {clothing}))")), i(2));
    fails(&e, "COUNTROWS(NATURALINNERJOIN(SELECTCOLUMNS(Product, \"a\", Product[Name]), SELECTCOLUMNS(Customer, \"b\", Customer[Name])))");
}

#[test]
fn topn_keeps_ties() {
    let e = engine();
    assert_eq!(ev(&e, "COUNTROWS(TOPN(2, Product, Product[ListPrice]))"), i(2));
    assert_eq!(ev(&e, "SUMX(TOPN(2, Product, Product[ListPrice]), Product[ListPrice])"), f(160.0));
    assert_eq!(ev(&e, "SUMX(TOPN(1, Product, Product[ListPrice], 1), Product[ListPrice])"), f(5.0));
    assert_eq!(ev(&e, "SUMX(TOPN(1, Product, Product[ListPrice], ASC), Product[ListPrice])"), f(5.0));
    // both Accessories rows tie for the first place in ascending category order
    assert_eq!(ev(&e, "COUNTROWS(TOPN(1, Product, Product[Category], ASC))"), i(2));
    assert_eq!(ev(&e, "COUNTROWS(TOPN(0, Product, Product[ListPrice]))"), B);
    assert_eq!(ev(&e, "COUNTROWS(TOPN(50, Product, Product[ListPrice]))"), i(5));
    // order by two keys
    assert_eq!(ev(&e, "CONCATENATEX(TOPN(2, Product, Product[Category], ASC, Product[ListPrice], DESC), Product[Name], \",\", Product[ListPrice], DESC)"), s("Helmet,Bottle"));
}

#[test]
fn groupby_aggregates_the_current_group() {
    let e = engine();
    let r = sorted(rows(&e, "EVALUATE GROUPBY(Product, Product[Category], \"total\", SUMX(CURRENTGROUP(), Product[ListPrice]), \"n\", COUNTX(CURRENTGROUP(), Product[ListPrice]))"));
    assert_eq!(r, vec![vec![s("Accessories"), f(15.0), i(2)], vec![s("Bikes"), f(100.0), i(1)], vec![s("Clothing"), f(80.0), i(2)]]);
    fails(&e, "CURRENTGROUP()");
}

#[test]
fn datatable_builds_a_typed_table() {
    let e = engine();
    assert_eq!(ev(&e, "SUMX(DATATABLE(\"a\", INTEGER, \"b\", STRING, {{1, \"x\"}, {2, \"y\"}}), [a])"), i(3));
    assert_eq!(ev(&e, "CONCATENATEX(DATATABLE(\"a\", INTEGER, \"b\", STRING, {{1, \"x\"}, {2, \"y\"}}), [b], \"\", [a], DESC)"), s("yx"));
    assert_eq!(ev(&e, "SUMX(DATATABLE(\"a\", DOUBLE, {{\"1.5\"}, {2}}), [a])"), f(3.5));
}

#[test]
fn summarize_with_added_columns() {
    let e = engine();
    let r = sorted(rows(&e, "EVALUATE SUMMARIZE(Product, Product[Category], \"qty\", SUM(Sales[Qty]), \"n\", COUNTROWS(Product))"));
    assert_eq!(r, vec![vec![s("Accessories"), i(11), i(2)], vec![s("Bikes"), i(2), i(1)], vec![s("Clothing"), B, i(2)]]);
}

#[test]
fn pass_through_functions() {
    let e = engine();
    assert_eq!(ev(&e, "EVALUATEANDLOG(5)"), i(5));
    assert_eq!(ev(&e, "CALCULATE(NONVISUAL(SUM(Sales[Qty])), Product[Color] = \"Red\")"), i(2));
    let _: Value = B;
}
