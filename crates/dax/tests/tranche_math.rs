//! Math function tranche. Expected values are worked out by hand; result *types* (Integer vs Number) and the
//! treatment of BLANK are our reading of the public documentation and are marked "harness" where the recorded
//! cases (tests/dax/cases/math.json) must confirm them.

mod common;
use biforge_dax::value::CURRENCY_SCALE;
use biforge_dax::{ErrorCode, Value};
use common::*;

fn near(e: &biforge_dax::Engine, src: &str, want: f64) {
    match ev(e, src) {
        Value::Double(x) => assert!((x - want).abs() <= 1e-12 * want.abs().max(1.0), "{src}: {x} vs {want}"),
        other => panic!("{src}: expected a number, got {other:?}"),
    }
}

fn fails(e: &biforge_dax::Engine, src: &str) {
    assert!(e.eval_scalar(src).is_err(), "{src} should fail");
}

#[test]
fn abs_sign_and_integer_types() {
    let e = engine();
    assert_eq!(ev(&e, "ABS(-5)"), i(5));
    assert_eq!(ev(&e, "ABS(-2.5)"), f(2.5));
    assert_eq!(ev(&e, "ABS(CURRENCY(-1.5))"), Value::Currency(15_000));
    assert_eq!(ev(&e, "SIGN(-3)"), i(-1));
    assert_eq!(ev(&e, "SIGN(0)"), i(0));
    assert_eq!(ev(&e, "SIGN(2.5)"), i(1));
    // recorded from Power BI: a BLANK argument gives BLANK when the result would be 0, otherwise f(0)
    assert_eq!(ev(&e, "ABS(BLANK())"), B);
    assert_eq!(ev(&e, "SIN(BLANK())"), B);
    assert_eq!(ev(&e, "COS(BLANK())"), f(1.0));
    assert_eq!(ev(&e, "EXP(BLANK())"), f(1.0));
    assert_eq!(ev(&e, "FACT(BLANK())"), i(1));
}

#[test]
fn rounding_rounds_half_away_from_zero() {
    let e = engine();
    assert_eq!(ev(&e, "ROUND(2.5, 0)"), f(3.0));
    assert_eq!(ev(&e, "ROUND(-2.5, 0)"), f(-3.0));
    assert_eq!(ev(&e, "ROUND(1.005, 2)"), f(1.01));
    assert_eq!(ev(&e, "ROUND(2.567, 1)"), f(2.6));
    assert_eq!(ev(&e, "ROUND(1234, -2)"), i(1200));
    assert_eq!(ev(&e, "ROUND(1250, -2)"), i(1300));
    assert_eq!(ev(&e, "ROUND(7, 2)"), i(7));
    assert_eq!(ev(&e, "ROUNDUP(2.01, 1)"), f(2.1));
    assert_eq!(ev(&e, "ROUNDUP(-2.01, 1)"), f(-2.1));
    assert_eq!(ev(&e, "ROUNDDOWN(-2.99, 1)"), f(-2.9));
    assert_eq!(ev(&e, "ROUNDDOWN(2.99, 0)"), f(2.0));
    assert_eq!(ev(&e, "TRUNC(-8.9)"), f(-8.0));
    assert_eq!(ev(&e, "TRUNC(3.14159, 2)"), f(3.14));
    assert_eq!(ev(&e, "INT(-1.5)"), i(-2));
    assert_eq!(ev(&e, "INT(1.9)"), i(1));
    assert_eq!(ev(&e, "ROUND(CURRENCY(1.2345), 2)"), Value::Currency(12_300));
}

#[test]
fn ceiling_floor_and_multiples() {
    let e = engine();
    assert_eq!(ev(&e, "CEILING(2.1, 1)"), i(3));
    assert_eq!(ev(&e, "CEILING(-2.5, 1)"), i(-2));
    assert_eq!(ev(&e, "CEILING(-2.5, -1)"), i(-3));
    assert_eq!(ev(&e, "CEILING(2.5, 0)"), i(0));
    fails(&e, "CEILING(2.5, -1)");
    fails(&e, "FLOOR(2.5, -1)");
    fails(&e, "FLOOR(7, 0)");
    assert_eq!(ev(&e, "FLOOR(-2.5, -1)"), i(-2));
    assert_eq!(ev(&e, "CEILING(2.1, 0.5)"), f(2.5));
    assert_eq!(ev(&e, "CEILING(4, 3)"), i(6));
    assert_eq!(ev(&e, "FLOOR(-2.5, 1)"), i(-3));
    assert_eq!(ev(&e, "FLOOR(2.7, 0.5)"), f(2.5));
    assert_eq!(ev(&e, "ISO.CEILING(4.3)"), i(5));
    assert_eq!(ev(&e, "MROUND(10, 3)"), i(9));
    assert_eq!(ev(&e, "MROUND(5, 0)"), i(0));
    assert_eq!(ev(&e, "MROUND(-10, -3)"), i(-9));
    fails(&e, "MROUND(5, -2)");
    assert_eq!(ev(&e, "EVEN(1.5)"), i(2));
    assert_eq!(ev(&e, "EVEN(3)"), i(4));
    assert_eq!(ev(&e, "EVEN(-1)"), i(-2));
    assert_eq!(ev(&e, "ODD(1.5)"), i(3));
    assert_eq!(ev(&e, "ODD(2)"), i(3));
    assert_eq!(ev(&e, "ODD(-1)"), i(-1));
}

#[test]
fn mod_and_quotient_follow_the_divisor_sign() {
    let e = engine();
    assert_eq!(ev(&e, "MOD(10, 3)"), i(1));
    assert_eq!(ev(&e, "MOD(-10, 3)"), i(2));
    assert_eq!(ev(&e, "MOD(10, -3)"), i(-2));
    assert_eq!(ev(&e, "MOD(5.5, 2)"), f(1.5));
    fails(&e, "MOD(1, 0)");
    assert_eq!(ev(&e, "QUOTIENT(7, 2)"), i(3));
    assert_eq!(ev(&e, "QUOTIENT(-7, 2)"), i(-3));
    fails(&e, "QUOTIENT(1, 0)");
}

#[test]
fn powers_roots_and_logs() {
    let e = engine();
    assert_eq!(ev(&e, "POWER(2, 10)"), f(1024.0));
    assert_eq!(ev(&e, "SQRT(16)"), f(4.0));
    near(&e, "SQRTPI(1)", std::f64::consts::PI.sqrt());
    fails(&e, "SQRT(-1)");
    assert_eq!(ev(&e, "EXP(0)"), f(1.0));
    near(&e, "EXP(1)", std::f64::consts::E);
    assert_eq!(ev(&e, "LN(1)"), f(0.0));
    fails(&e, "LN(0)");
    assert_eq!(ev(&e, "LOG10(1000)"), f(3.0));
    near(&e, "LOG(8, 2)", 3.0);
    near(&e, "LOG(100)", 2.0);
    fails(&e, "LOG(8, 1)");
}

#[test]
fn trigonometry() {
    let e = engine();
    near(&e, "PI()", std::f64::consts::PI);
    assert_eq!(ev(&e, "SIN(0)"), f(0.0));
    assert_eq!(ev(&e, "COS(0)"), f(1.0));
    near(&e, "ATAN(1)", std::f64::consts::FRAC_PI_4);
    near(&e, "DEGREES(PI())", 180.0);
    near(&e, "RADIANS(180)", std::f64::consts::PI);
    near(&e, "COT(PI() / 4)", 1.0);
    near(&e, "ACOT(1)", std::f64::consts::FRAC_PI_4);
    near(&e, "TANH(0.5)", 0.5f64.tanh());
    near(&e, "ASINH(1)", 1f64.asinh());
    near(&e, "ACOSH(1)", 0.0);
    near(&e, "ATANH(0.5)", 0.5f64.atanh());
    near(&e, "ACOTH(2)", 0.5 * 3f64.ln());
    fails(&e, "ACOS(2)");
    fails(&e, "ASIN(-2)");
    fails(&e, "ACOSH(0.5)");
    fails(&e, "ATANH(1)");
}

#[test]
fn integer_math() {
    let e = engine();
    assert_eq!(ev(&e, "FACT(5)"), i(120));
    assert_eq!(ev(&e, "FACT(0)"), i(1));
    fails(&e, "FACT(-1)");
    near(&e, "FACT(21)", 51090942171709440000.0);
    assert_eq!(ev(&e, "COMBIN(5, 2)"), i(10));
    assert_eq!(ev(&e, "COMBINA(3, 2)"), i(6));
    fails(&e, "COMBIN(2, 5)");
    assert_eq!(ev(&e, "GCD(12, 18)"), i(6));
    assert_eq!(ev(&e, "LCM(4, 6)"), i(12));
}

#[test]
fn currency_and_convert() {
    let e = engine();
    assert_eq!(ev(&e, "CURRENCY(1.23456)"), Value::Currency(12_346));
    assert_eq!(ev(&e, "CURRENCY(1.5) * 2"), Value::Currency(3 * CURRENCY_SCALE));
    assert_eq!(ev(&e, "CONVERT(\"5\", INTEGER)"), i(5));
    assert_eq!(ev(&e, "CONVERT(2.5, INTEGER)"), i(3));
    assert_eq!(ev(&e, "CONVERT(1, STRING)"), s("1"));
    assert_eq!(ev(&e, "CONVERT(1, BOOLEAN)"), Value::Bool(true));
    assert_eq!(ev(&e, "CONVERT(3, DOUBLE)"), f(3.0));
    assert_eq!(ev(&e, "CONVERT(BLANK(), INTEGER)"), B);
    assert_eq!(e.eval_scalar("CONVERT(\"x\", INTEGER)").unwrap_err().code, ErrorCode::TypeMismatch);
}

#[test]
fn random_numbers_stay_in_range() {
    let e = engine();
    for _ in 0..50 {
        match ev(&e, "RAND()") {
            Value::Double(x) => assert!((0.0..1.0).contains(&x)),
            other => panic!("{other:?}"),
        }
        match ev(&e, "RANDBETWEEN(3, 5)") {
            Value::Int(x) => assert!((3..=5).contains(&x)),
            other => panic!("{other:?}"),
        }
    }
    fails(&e, "RANDBETWEEN(5, 3)");
}

#[test]
fn math_functions_work_row_by_row() {
    let e = engine();
    // as a boolean filter: the function is row-level, the column inside it is filtered
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Sales), MOD(Sales[Qty], 2) = 0)"), i(3));
    assert_eq!(ev(&e, "SUMX(Sales, ROUND(Sales[Price] / 3, 0))"), f(100.0));
}
