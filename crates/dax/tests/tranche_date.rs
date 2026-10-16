//! Date and time function tranche (hand-computed from the calendar). 2024-01-01 is a Monday; 2024 is a leap year.

mod common;
use biforge_dax::value::date_serial;
use biforge_dax::Value;
use common::*;

fn t(x: bool) -> Value {
    Value::Bool(x)
}

fn date(y: i32, m: u32, d: u32) -> Value {
    Value::DateTime(date_serial(y, m, d).unwrap())
}

#[test]
fn building_dates() {
    let e = engine();
    assert_eq!(ev(&e, "DATE(2024, 2, 29)"), date(2024, 2, 29));
    assert_eq!(ev(&e, "DATE(2024, 14, 1)"), date(2025, 2, 1));
    assert_eq!(ev(&e, "DATE(2024, 1, -5)"), date(2023, 12, 26));
    // a day of 0 is an error; two-digit years: 0..29 -> 2000.., 30..99 -> 1930..; 100..1899 are literal (recorded)
    assert!(e.eval_scalar("DATE(2024, 1, 0)").is_err());
    assert_eq!(ev(&e, "DATE(29, 1, 1)"), date(2029, 1, 1));
    assert_eq!(ev(&e, "DATE(30, 1, 1)"), date(1930, 1, 1));
    assert_eq!(ev(&e, "DATE(1000, 1, 1)"), date(1000, 1, 1));
    assert_eq!(ev(&e, "DATE(2024, 3, 35)"), date(2024, 4, 4));
    assert_eq!(ev(&e, "DATE(99, 1, 1)"), date(1999, 1, 1));
    assert!(e.eval_scalar("DATE(10000, 1, 1)").is_err());
    assert_eq!(ev(&e, "TIME(14, 30, 0)"), Value::DateTime(52200.0 / 86400.0));
    assert_eq!(ev(&e, "TIME(25, 0, 0)"), Value::DateTime(3600.0 / 86400.0));
    assert!(e.eval_scalar("TIME(0, 0, 86400)").is_err());
    assert!(e.eval_scalar("TIME(-1, 0, 0)").is_err());
    assert_eq!(ev(&e, "TIME(1.9, 0, 0)"), Value::DateTime(7200.0 / 86400.0));
    assert_eq!(ev(&e, "DATEVALUE(\"2024-03-05\")"), date(2024, 3, 5));
    assert_eq!(ev(&e, "DATEVALUE(\"3/5/2024\")"), date(2024, 3, 5));
    assert_eq!(ev(&e, "TIMEVALUE(\"2:30 PM\")"), ev(&e, "TIME(14, 30, 0)"));
}

#[test]
fn date_parts() {
    let e = engine();
    assert_eq!(ev(&e, "YEAR(DATE(2024, 3, 5))"), i(2024));
    assert_eq!(ev(&e, "MONTH(DATE(2024, 3, 5))"), i(3));
    assert_eq!(ev(&e, "DAY(DATE(2024, 3, 5))"), i(5));
    assert_eq!(ev(&e, "QUARTER(DATE(2024, 5, 1))"), i(2));
    assert_eq!(ev(&e, "QUARTER(DATE(2024, 12, 31))"), i(4));
    assert_eq!(ev(&e, "HOUR(DATE(2024, 3, 5) + TIME(14, 30, 15))"), i(14));
    assert_eq!(ev(&e, "MINUTE(DATE(2024, 3, 5) + TIME(14, 30, 15))"), i(30));
    assert_eq!(ev(&e, "SECOND(DATE(2024, 3, 5) + TIME(14, 30, 15))"), i(15));
    // text converts to a date
    assert_eq!(ev(&e, "YEAR(\"2024-03-05\")"), i(2024));
    // BLANK in, BLANK out (recorded from Power BI)
    assert_eq!(ev(&e, "YEAR(BLANK())"), B);
    assert_eq!(ev(&e, "YEAR(MIN('Date'[Date]))"), i(2023));
}

#[test]
fn weekdays_and_week_numbers() {
    let e = engine();
    assert_eq!(ev(&e, "WEEKDAY(DATE(2024, 1, 1))"), i(2));
    assert_eq!(ev(&e, "WEEKDAY(DATE(2024, 1, 1), 2)"), i(1));
    assert_eq!(ev(&e, "WEEKDAY(DATE(2024, 1, 1), 3)"), i(0));
    assert_eq!(ev(&e, "WEEKDAY(DATE(2024, 1, 7))"), i(1));
    assert_eq!(ev(&e, "WEEKDAY(DATE(2024, 1, 7), 2)"), i(7));
    assert_eq!(ev(&e, "WEEKDAY(DATE(2024, 1, 3), 12)"), i(2));
    assert_eq!(ev(&e, "WEEKNUM(DATE(2024, 1, 1))"), i(1));
    assert_eq!(ev(&e, "WEEKNUM(DATE(2024, 1, 6))"), i(1));
    assert_eq!(ev(&e, "WEEKNUM(DATE(2024, 1, 7))"), i(2));
    assert_eq!(ev(&e, "WEEKNUM(DATE(2024, 1, 8), 2)"), i(2));
    assert_eq!(ev(&e, "WEEKNUM(DATE(2024, 12, 31), 21)"), i(1));
    assert!(e.eval_scalar("WEEKDAY(DATE(2024, 1, 1), 9)").is_err());
}

#[test]
fn month_arithmetic() {
    let e = engine();
    assert_eq!(ev(&e, "EDATE(DATE(2024, 1, 31), 1)"), date(2024, 2, 29));
    assert_eq!(ev(&e, "EDATE(DATE(2024, 3, 31), -1)"), date(2024, 2, 29));
    assert_eq!(ev(&e, "EDATE(DATE(2024, 1, 15), 12)"), date(2025, 1, 15));
    assert_eq!(ev(&e, "EOMONTH(DATE(2024, 1, 15), 1)"), date(2024, 2, 29));
    assert_eq!(ev(&e, "EOMONTH(DATE(2024, 1, 15), -1)"), date(2023, 12, 31));
    assert_eq!(ev(&e, "EOMONTH(DATE(2023, 2, 1), 0)"), date(2023, 2, 28));
}

#[test]
fn datediff_counts_boundaries() {
    let e = engine();
    assert_eq!(ev(&e, "DATEDIFF(DATE(2024, 1, 31), DATE(2024, 2, 1), MONTH)"), i(1));
    assert_eq!(ev(&e, "DATEDIFF(DATE(2024, 1, 1), DATE(2024, 1, 31), MONTH)"), i(0));
    assert_eq!(ev(&e, "DATEDIFF(DATE(2024, 1, 1), DATE(2024, 3, 1), DAY)"), i(60));
    assert_eq!(ev(&e, "DATEDIFF(DATE(2023, 12, 31), DATE(2024, 1, 1), YEAR)"), i(1));
    assert_eq!(ev(&e, "DATEDIFF(DATE(2024, 3, 31), DATE(2024, 4, 1), QUARTER)"), i(1));
    assert_eq!(ev(&e, "DATEDIFF(DATE(2024, 1, 6), DATE(2024, 1, 7), WEEK)"), i(1));
    assert_eq!(ev(&e, "DATEDIFF(DATE(2024, 1, 1), DATE(2024, 1, 6), WEEK)"), i(0));
    assert_eq!(ev(&e, "DATEDIFF(DATE(2024, 3, 1), DATE(2024, 1, 1), DAY)"), i(-60));
    assert_eq!(ev(&e, "DATEDIFF(DATE(2024, 1, 1), DATE(2024, 1, 1) + TIME(2, 30, 0), MINUTE)"), i(150));
    assert_eq!(ev(&e, "DATEDIFF(DATE(2024, 1, 1) + TIME(0, 59, 0), DATE(2024, 1, 1) + TIME(1, 1, 0), HOUR)"), i(1));
    assert_eq!(ev(&e, "DATEDIFF(BLANK(), DATE(2024, 1, 1), DAY)"), B);
}

#[test]
fn working_days_and_year_fractions() {
    let e = engine();
    assert_eq!(ev(&e, "NETWORKDAYS(DATE(2024, 1, 1), DATE(2024, 1, 7))"), i(5));
    assert_eq!(ev(&e, "NETWORKDAYS(DATE(2024, 1, 1), DATE(2024, 1, 7), 11)"), i(6));
    // the string form of the weekend is refused (recorded from Power BI)
    assert!(e.eval_scalar("NETWORKDAYS(DATE(2024, 1, 1), DATE(2024, 1, 7), \"0000011\")").is_err());
    assert_eq!(ev(&e, "NETWORKDAYS(DATE(2024, 1, 1), DATE(2024, 1, 7), 1, {DATE(2024, 1, 3)})"), i(4));
    assert_eq!(ev(&e, "NETWORKDAYS(DATE(2024, 1, 7), DATE(2024, 1, 1))"), i(-5));
    assert_eq!(ev(&e, "YEARFRAC(DATE(2024, 1, 1), DATE(2024, 7, 1))"), f(0.5));
    assert_eq!(ev(&e, "YEARFRAC(DATE(2024, 1, 1), DATE(2024, 7, 1), 3)"), f(182.0 / 365.0));
}

#[test]
fn clock_functions() {
    let e = engine();
    assert_eq!(ev(&e, "NOW() > DATE(2024, 1, 1)"), t(true));
    assert_eq!(ev(&e, "TODAY() <= NOW()"), t(true));
    assert_eq!(ev(&e, "TODAY() = INT(TODAY())"), t(true));
    assert_eq!(ev(&e, "UTCTODAY() <= UTCNOW()"), t(true));
}

#[test]
fn date_functions_work_row_by_row() {
    let e = engine();
    // Date table rows: 2023-01-01, 2023-02-01, 2024-01-01, 2024-02-01
    assert_eq!(ev(&e, "COUNTROWS(FILTER('Date', MONTH('Date'[Date]) = 2))"), i(2));
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), YEAR('Date'[Date]) = 2024)"), ev(&e, "CALCULATE(SUM(Sales[Qty]), 'Date'[Year] = 2024)"));
}
