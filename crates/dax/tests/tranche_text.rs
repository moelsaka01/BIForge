//! Text function tranche. Hand-computed expectations from the public function descriptions; behaviors the
//! documentation leaves open are covered by recorded cases (tests/dax/cases/text.json).

mod common;
use biforge_dax::Value;
use common::*;

fn fails(e: &biforge_dax::Engine, src: &str) {
    assert!(e.eval_scalar(src).is_err(), "{src} should fail");
}

#[test]
fn slicing() {
    let e = engine();
    assert_eq!(ev(&e, "LEFT(\"Hello\", 2)"), s("He"));
    assert_eq!(ev(&e, "LEFT(\"Hello\")"), s("H"));
    assert_eq!(ev(&e, "LEFT(\"Hi\", 10)"), s("Hi"));
    assert_eq!(ev(&e, "RIGHT(\"Hello\", 3)"), s("llo"));
    assert_eq!(ev(&e, "MID(\"Hello\", 2, 3)"), s("ell"));
    assert_eq!(ev(&e, "MID(\"Hello\", 9, 3)"), s(""));
    assert_eq!(ev(&e, "MID(\"Hello\", 4, 50)"), s("lo"));
    fails(&e, "LEFT(\"Hello\", -1)");
    fails(&e, "MID(\"Hello\", 0, 1)");
    assert_eq!(ev(&e, "LEN(\"héllo\")"), i(5));
    assert_eq!(ev(&e, "LEN(BLANK())"), i(0));
    assert_eq!(ev(&e, "LEN(12345)"), i(5));
}

#[test]
fn case_and_trim() {
    let e = engine();
    assert_eq!(ev(&e, "UPPER(\"abC\")"), s("ABC"));
    assert_eq!(ev(&e, "LOWER(\"AbC\")"), s("abc"));
    assert_eq!(ev(&e, "TRIM(\"  a   b  \")"), s("a b"));
    assert_eq!(ev(&e, "EXACT(\"a\", \"A\")"), Value::Bool(false));
    assert_eq!(ev(&e, "EXACT(\"a\", \"a\")"), Value::Bool(true));
}

#[test]
fn find_and_search() {
    let e = engine();
    assert_eq!(ev(&e, "FIND(\"l\", \"Hello\")"), i(3));
    assert_eq!(ev(&e, "FIND(\"l\", \"Hello\", 4)"), i(4));
    fails(&e, "FIND(\"L\", \"Hello\")");
    assert_eq!(ev(&e, "FIND(\"L\", \"Hello\", 1, 0)"), i(0));
    assert_eq!(ev(&e, "SEARCH(\"L\", \"Hello\")"), i(3));
    assert_eq!(ev(&e, "SEARCH(\"h*o\", \"Say Hello\")"), i(5));
    assert_eq!(ev(&e, "SEARCH(\"~?\", \"Why? Because\")"), i(4));
    assert_eq!(ev(&e, "SEARCH(\"zz\", \"abc\", 1, -1)"), i(-1));
    fails(&e, "FIND(\"a\", \"abc\", 9)");
}

#[test]
fn replacing() {
    let e = engine();
    assert_eq!(ev(&e, "REPLACE(\"abcdef\", 2, 3, \"X\")"), s("aXef"));
    assert_eq!(ev(&e, "SUBSTITUTE(\"a-b-c\", \"-\", \"+\")"), s("a+b+c"));
    assert_eq!(ev(&e, "SUBSTITUTE(\"a-b-c\", \"-\", \"+\", 2)"), s("a-b+c"));
    assert_eq!(ev(&e, "SUBSTITUTE(\"Aa\", \"a\", \"x\")"), s("Ax"));
    assert_eq!(ev(&e, "REPT(\"ab\", 3)"), s("ababab"));
    assert_eq!(ev(&e, "REPT(\"ab\", 0)"), s(""));
    fails(&e, "REPT(\"a\", -1)");
}

#[test]
fn joining() {
    let e = engine();
    assert_eq!(ev(&e, "CONCATENATE(\"a\", 1)"), s("a1"));
    assert_eq!(ev(&e, "COMBINEVALUES(\"|\", \"a\", 2, BLANK())"), s("a|2|"));
    assert_eq!(ev(&e, "CONCATENATEX(Product, Product[Name], \", \", Product[ListPrice], DESC)"), s("Bike, Jersey, Gloves, Helmet, Bottle"));
    assert_eq!(ev(&e, "CONCATENATEX(FILTER(Product, Product[Category] = \"Accessories\"), Product[Name], \"+\", Product[Name])"), s("Bottle+Helmet"));
    assert_eq!(ev(&e, "CONCATENATEX(Product, Product[Name])").to_text().len(), "BikeHelmetBottleJerseyGloves".len());
}

#[test]
fn unicode() {
    let e = engine();
    assert_eq!(ev(&e, "UNICODE(\"A\")"), i(65));
    assert_eq!(ev(&e, "UNICHAR(66)"), s("B"));
    fails(&e, "UNICODE(\"\")");
}

#[test]
fn value_and_fixed() {
    let e = engine();
    assert_eq!(ev(&e, "VALUE(\"42\")"), i(42));
    assert_eq!(ev(&e, "VALUE(\"1,234.5\")"), f(1234.5));
    assert_eq!(ev(&e, "VALUE(\"50%\")"), f(0.5));
    fails(&e, "VALUE(\"abc\")");
    assert_eq!(ev(&e, "FIXED(1234.567, 1)"), s("1,234.6"));
    assert_eq!(ev(&e, "FIXED(1234.567, 0, TRUE())"), s("1235"));
    assert_eq!(ev(&e, "FIXED(1234.567)"), s("1,234.57"));
}

#[test]
fn format_numbers_and_dates() {
    let e = engine();
    assert_eq!(ev(&e, "FORMAT(1234.5, \"#,##0.00\")"), s("1,234.50"));
    assert_eq!(ev(&e, "FORMAT(0.256, \"0.0%\")"), s("25.6%"));
    assert_eq!(ev(&e, "FORMAT(0.256, \"Percent\")"), s("25.60%"));
    assert_eq!(ev(&e, "FORMAT(5, \"000\")"), s("005"));
    assert_eq!(ev(&e, "FORMAT(TRUE(), \"Yes/No\")"), s("Yes"));
    assert_eq!(ev(&e, "FORMAT(MIN('Date'[Date]), \"yyyy-MM-dd\")"), s("2023-01-01"));
    assert_eq!(ev(&e, "FORMAT(MIN('Date'[Date]), \"MMMM d, yyyy\")"), s("January 1, 2023"));
    assert_eq!(ev(&e, "FORMAT(MIN('Date'[Date]), \"Short Date\")"), s("1/1/2023"));
    assert_eq!(ev(&e, "FORMAT(\"abc\", \">\")"), s("ABC"));
    assert_eq!(ev(&e, "FORMAT(1234, \"General Number\")"), s("1234"));
}

#[test]
fn text_functions_work_row_by_row() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Product), LEFT(Product[Name], 1) = \"B\")"), i(2));
    assert_eq!(ev(&e, "SUMX(Product, LEN(Product[Name]))"), i(4 + 6 + 6 + 6 + 6));
}
