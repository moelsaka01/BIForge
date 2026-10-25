//! DEFINE COLUMN and DEFINE FUNCTION in a query (hand-computed on the shared model; see common/mod.rs for the data).
mod common;
use biforge_dax::value::Value;
use common::*;

fn scalar(e: &biforge_dax::Engine, q: &str) -> Value {
    rows(e, q)[0][0].clone()
}

fn error(e: &biforge_dax::Engine, q: &str) -> String {
    e.query(q).expect_err(q).message
}

// Sales[Amount] = Qty * Price: 100, 20, 15, 120, 40, 10, 50 (sum 355)

#[test]
fn define_column_adds_a_calculated_column_for_the_query() {
    let e = engine();
    assert_eq!(scalar(&e, "DEFINE COLUMN Sales[Double] = Sales[Amount] * 2 EVALUATE ROW(\"t\", SUM(Sales[Double]))"), f(710.0));
    // the new column can group, filter and be read by a measure defined in the same query (CALCULATE replaces the filter on it: 3 big rows even in the small group)
    let q = "DEFINE
        COLUMN Sales[Size] = IF(Sales[Amount] >= 50, \"big\", \"small\")
        MEASURE Sales[Big] = CALCULATE(COUNTROWS(Sales), Sales[Size] = \"big\")
     EVALUATE SUMMARIZECOLUMNS(Sales[Size], \"n\", COUNTROWS(Sales), \"b\", [Big]) ORDER BY Sales[Size]";
    assert_eq!(rows(&e, q), vec![vec![s("big"), i(3), i(3)], vec![s("small"), i(4), i(3)]]);
    // a column can use RELATED, another column of the query, and a column of the model that is itself calculated
    let q2 = "DEFINE
        COLUMN Sales[Red] = RELATED(Product[Color]) = \"Red\"
        COLUMN Sales[RedAmount] = IF(Sales[Red], Sales[Amount], 0)
     EVALUATE ROW(\"t\", SUM(Sales[RedAmount]))";
    assert_eq!(scalar(&e, q2), f(220.0));
}

#[test]
fn a_defined_column_lives_for_one_query_only() {
    let e = engine();
    scalar(&e, "DEFINE COLUMN Sales[Double] = Sales[Amount] * 2 EVALUATE ROW(\"t\", SUM(Sales[Double]))");
    assert!(error(&e, "EVALUATE ROW(\"t\", SUM(Sales[Double]))").contains("Double"));
    assert!(e.data.model.column_id(e.data.model.table_id("Sales").unwrap(), "Double").is_none());
}

#[test]
fn define_column_refuses_what_cannot_be_a_column() {
    let e = engine();
    assert!(error(&e, "DEFINE COLUMN Sales[Amount] = 1 EVALUATE ROW(\"t\", 1)").to_lowercase().contains("amount"));
    assert!(error(&e, "DEFINE COLUMN Nope[X] = 1 EVALUATE ROW(\"t\", 1)").contains("Nope"));
    let msg = error(&e, "DEFINE COLUMN Sales[Bad] = Sales[Missing] EVALUATE ROW(\"t\", 1)");
    assert!(msg.contains("Bad") && msg.contains("defined in the query"), "{msg}");
}

#[test]
fn define_function_inlines_the_body_with_the_arguments() {
    let e = engine();
    assert_eq!(scalar(&e, "DEFINE FUNCTION AddOne = (x) => x + 1 EVALUATE ROW(\"v\", AddOne(41))"), i(42));
    // typed parameters are read; the arguments are evaluated at the call; a function can use another one and a measure
    let q = "DEFINE
        MEASURE Sales[Total] = SUM(Sales[Amount])
        FUNCTION Twice = (a : scalar numeric) => a * 2
        FUNCTION Tax = (amount : scalar decimal, rate : scalar decimal) => Twice(amount) * (1 + rate)
     EVALUATE ROW(\"v\", Tax([Total], 0.5))";
    assert_eq!(scalar(&e, q), f(1065.0));
    // a table parameter
    assert_eq!(scalar(&e, "DEFINE FUNCTION Rows = (t : table) => COUNTROWS(t) EVALUATE ROW(\"n\", Rows(Product), \"red\", Rows(FILTER(Product, Product[Color] = \"Red\")))"), i(5));
    assert_eq!(rows(&e, "DEFINE FUNCTION Rows = (t : table) => COUNTROWS(t) EVALUATE ROW(\"n\", Rows(Product), \"red\", Rows(FILTER(Product, Product[Color] = \"Red\")))")[0], vec![i(5), i(2)]);
}

#[test]
fn an_expr_parameter_is_evaluated_where_the_body_uses_it_and_a_val_parameter_at_the_call() {
    let e = engine();
    let q = |mode: &str| format!("DEFINE MEASURE Sales[Total] = SUM(Sales[Amount]) FUNCTION OnlyRed = (m : scalar {mode}) => CALCULATE(m, Product[Color] = \"Red\") EVALUATE ROW(\"v\", OnlyRed([Total]))");
    // Bike (red) sold in rows 1 and 4: 100 + 120
    assert_eq!(scalar(&e, &q("expr")), f(220.0));
    // the measure is evaluated before CALCULATE sees it: the whole total
    assert_eq!(scalar(&e, &q("val")), f(355.0));
}

#[test]
fn function_errors_are_readable() {
    let e = engine();
    assert!(error(&e, "DEFINE FUNCTION F = (x) => x EVALUATE ROW(\"v\", F(1, 2))").contains("Too many arguments"));
    assert!(error(&e, "DEFINE FUNCTION F = (x, y) => x EVALUATE ROW(\"v\", F(1))").contains("Too few arguments"));
    assert!(error(&e, "DEFINE FUNCTION F = (x) => F(x) EVALUATE ROW(\"v\", F(1))").contains("calls itself"));
    assert!(error(&e, "DEFINE FUNCTION SUM = (x) => x EVALUATE ROW(\"v\", 1)").contains("built-in"));
    assert!(error(&e, "DEFINE FUNCTION F = (x) => x FUNCTION f = (y) => y EVALUATE ROW(\"v\", 1)").contains("defined twice"));
    // the body sees its parameters, not the variables of the caller
    let msg = error(&e, "DEFINE FUNCTION F = (x) => x + outer EVALUATE VAR outer = 5 RETURN ROW(\"v\", F(1))");
    assert!(msg.contains("outer"), "{msg}");
}
