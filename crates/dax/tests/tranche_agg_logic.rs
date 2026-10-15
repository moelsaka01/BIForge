//! Aggregation and logical/information function tranches on the hand-computable model (common/mod.rs).
//! Sales Qty = 1,2,3,1,4,2,1 (sum 14, product 48). Product ListPrice = 100,10,5,60,20. Colors Red, Black, Blue,
//! Red, (blank). Rules marked "harness" are our reading of the public documentation, to be confirmed with
//! recorded cases (tests/dax/cases).

mod common;
use biforge_dax::{ErrorCode, Value};
use common::*;

fn t(x: bool) -> Value {
    Value::Bool(x)
}

#[test]
fn product_and_productx_multiply_non_blank_values() {
    let e = engine();
    assert_eq!(ev(&e, "PRODUCT(Sales[Qty])"), f(48.0));
    assert_eq!(ev(&e, "PRODUCTX(Product, Product[ListPrice])"), f(6000000.0));
    assert_eq!(ev(&e, "CALCULATE(PRODUCT(Sales[Qty]), Product[Color] = \"Red\")"), f(1.0));
    // nothing to multiply
    assert_eq!(ev(&e, "CALCULATE(PRODUCT(Sales[Qty]), Product[Color] = \"Purple\")"), B);
    assert_eq!(e.eval_scalar("PRODUCT(Product[Name])").unwrap_err().code, ErrorCode::TypeMismatch);
}

#[test]
fn a_aggregations_count_text_as_zero() {
    let e = engine();
    // four non-blank colors, each text counts as 0 (harness)
    assert_eq!(ev(&e, "AVERAGEA(Product[Color])"), f(0.0));
    assert_eq!(ev(&e, "MINA(Product[Color])"), i(0));
    assert_eq!(ev(&e, "MAXA(Product[Color])"), i(0));
    assert_eq!(ev(&e, "AVERAGEA(Sales[Qty])"), f(2.0));
    assert_eq!(ev(&e, "MAXA(Sales[Qty])"), i(4));
    assert_eq!(ev(&e, "MINA(Sales[Qty])"), i(1));
}

#[test]
fn approximate_distinct_count_is_exact() {
    let e = engine();
    assert_eq!(ev(&e, "APPROXIMATEDISTINCTCOUNT(Sales[CustomerKey])"), i(3));
}

#[test]
fn iferror_and_iserror() {
    let e = engine();
    assert_eq!(ev(&e, "IFERROR(\"a\" + 1, \"bad\")"), s("bad"));
    assert_eq!(ev(&e, "IFERROR(1 + 1, \"bad\")"), i(2));
    assert_eq!(ev(&e, "ISERROR(\"a\" + 1)"), t(true));
    assert_eq!(ev(&e, "ISERROR(1)"), t(false));
    // the fallback is only evaluated when needed
    assert_eq!(ev(&e, "IFERROR(5, \"a\" + 1)"), i(5));
}

#[test]
fn switch_picks_the_first_match_or_the_default() {
    let e = engine();
    assert_eq!(ev(&e, "SWITCH(2, 1, \"a\", 2, \"b\", \"z\")"), s("b"));
    assert_eq!(ev(&e, "SWITCH(9, 1, \"a\", \"z\")"), s("z"));
    assert_eq!(ev(&e, "SWITCH(9, 1, \"a\")"), B);
    assert_eq!(ev(&e, "SWITCH(TRUE(), 5 > 10, \"big\", 5 > 1, \"mid\", \"small\")"), s("mid"));
    // results after the match are not evaluated
    assert_eq!(ev(&e, "SWITCH(1, 1, \"ok\", 2, \"a\" + 1)"), s("ok"));
}

#[test]
fn if_eager_evaluates_both_branches() {
    let e = engine();
    assert_eq!(ev(&e, "IF.EAGER(TRUE(), 1, 2)"), i(1));
    assert!(e.eval_scalar("IF.EAGER(TRUE(), 1, \"a\" + 1)").is_err());
    assert_eq!(ev(&e, "IF(TRUE(), 1, \"a\" + 1)"), i(1));
}

#[test]
fn bit_functions() {
    let e = engine();
    assert_eq!(ev(&e, "BITAND(12, 10)"), i(8));
    assert_eq!(ev(&e, "BITOR(12, 10)"), i(14));
    assert_eq!(ev(&e, "BITXOR(12, 10)"), i(6));
    assert_eq!(ev(&e, "BITLSHIFT(1, 4)"), i(16));
    assert_eq!(ev(&e, "BITRSHIFT(256, 4)"), i(16));
    // a negative shift count shifts the other way (harness)
    assert_eq!(ev(&e, "BITLSHIFT(16, -2)"), i(4));
    assert_eq!(ev(&e, "BITAND(BLANK(), 1)"), B);
}

#[test]
fn type_tests() {
    let e = engine();
    assert_eq!(ev(&e, "ISNUMBER(1)"), t(true));
    assert_eq!(ev(&e, "ISNUMBER(1.5)"), t(true));
    assert_eq!(ev(&e, "ISNUMBER(\"1\")"), t(false));
    assert_eq!(ev(&e, "ISTEXT(\"a\")"), t(true));
    assert_eq!(ev(&e, "ISTEXT(1)"), t(false));
    assert_eq!(ev(&e, "ISNONTEXT(BLANK())"), t(true));
    assert_eq!(ev(&e, "ISNONTEXT(\"x\")"), t(false));
    assert_eq!(ev(&e, "ISLOGICAL(TRUE())"), t(true));
    assert_eq!(ev(&e, "ISLOGICAL(1)"), t(false));
    assert_eq!(ev(&e, "ISEVEN(4)"), t(true));
    assert_eq!(ev(&e, "ISODD(3)"), t(true));
    assert_eq!(ev(&e, "ISEVEN(3.9)"), t(false));
    assert_eq!(ev(&e, "ISEVEN(BLANK())"), B);
}

#[test]
fn contains_family() {
    let e = engine();
    assert_eq!(ev(&e, "CONTAINS(Product, Product[Color], \"red\")"), t(true));
    assert_eq!(ev(&e, "CONTAINS(Product, Product[Color], \"Red\", Product[Category], \"Clothing\")"), t(true));
    assert_eq!(ev(&e, "CONTAINS(Product, Product[Color], \"Red\", Product[Category], \"Accessories\")"), t(false));
    assert_eq!(ev(&e, "CONTAINS(VALUES(Product[Color]), Product[Color], \"Blue\")"), t(true));
    assert_eq!(ev(&e, "CONTAINSROW({1, 2, 3}, 2)"), t(true));
    assert_eq!(ev(&e, "CONTAINSROW({1, 2}, 5)"), t(false));
    assert_eq!(ev(&e, "CONTAINSSTRING(\"Hello World\", \"WORLD\")"), t(true));
    assert_eq!(ev(&e, "CONTAINSSTRINGEXACT(\"Hello World\", \"WORLD\")"), t(false));
    assert_eq!(ev(&e, "CONTAINSSTRINGEXACT(\"Hello World\", \"World\")"), t(true));
}

#[test]
fn lookupvalue_finds_one_distinct_result() {
    let e = engine();
    assert_eq!(ev(&e, "LOOKUPVALUE(Product[Name], Product[ProductKey], 3)"), s("Bottle"));
    assert_eq!(ev(&e, "LOOKUPVALUE(Product[Name], Product[ProductKey], 99, \"none\")"), s("none"));
    assert_eq!(ev(&e, "LOOKUPVALUE(Product[Name], Product[ProductKey], 99)"), B);
    // two different names match: an error; two identical results are fine
    assert!(e.eval_scalar("LOOKUPVALUE(Product[Name], Product[Color], \"Red\")").is_err());
    assert_eq!(ev(&e, "LOOKUPVALUE(Product[Color], Product[Color], \"red\")"), s("Red"));
}

#[test]
fn hasonefilter_looks_at_direct_filters() {
    let e = engine();
    assert_eq!(ev(&e, "HASONEFILTER(Product[Category])"), t(false));
    assert_eq!(ev(&e, "CALCULATE(HASONEFILTER(Product[Category]), Product[Category] = \"Bikes\")"), t(true));
    assert_eq!(ev(&e, "CALCULATE(HASONEFILTER(Product[Category]), Product[Category] IN {\"Bikes\", \"Clothing\"})"), t(false));
}

#[test]
fn userculture_is_en_us() {
    assert_eq!(ev(&engine(), "USERCULTURE()"), s("en-US"));
}
