//! Time intelligence tranche on a daily calendar 2023-01-01 .. 2024-12-31 (731 days). F has one row per day with
//! Amt = 1, so a sum is a day count; G has two sparse rows (2024-02-10 = 5, 2024-02-20 = 7). 2024 is a leap year.
//! Behaviors marked "harness" are our current reading and are confirmed with the recorded cases
//! (tests/dax/cases/time.json).

mod common;
use biforge_dax::value::date_serial;
use biforge_dax::{CrossFilter, DataType, Engine, MemorySource, Model, Value};
use common::{i, B};

fn day(n: i64) -> Value {
    Value::DateTime(date_serial(2023, 1, 1).unwrap() + n as f64)
}

fn model(mark: bool) -> Model {
    use DataType::*;
    let mut m = Model::new();
    m.add_table("Date", &[("Date", DateTime), ("Year", Int64), ("Month", Int64)]).unwrap();
    m.add_table("F", &[("Day", DateTime), ("Amt", Int64)]).unwrap();
    m.add_table("G", &[("Day", DateTime), ("Amt", Int64)]).unwrap();
    m.add_relationship(("F", "Day"), ("Date", "Date"), CrossFilter::Single, true).unwrap();
    m.add_relationship(("G", "Day"), ("Date", "Date"), CrossFilter::Single, true).unwrap();
    m.add_measure("F", "Total", "SUM(F[Amt])").unwrap();
    m.add_measure("F", "Balance", "CALCULATE(SUM(F[Amt]), FILTER(ALL('Date'), 'Date'[Date] <= MAX('Date'[Date])))").unwrap();
    if mark {
        m.mark_date_table("Date", "Date").unwrap();
    }
    m
}

fn source() -> MemorySource {
    let mut dates = Vec::new();
    let mut facts = Vec::new();
    for n in 0..731 {
        let d = day(n);
        let ymd = biforge_dax::value::serial_to_datetime(date_serial(2023, 1, 1).unwrap() + n as f64).unwrap();
        use chrono::Datelike;
        dates.push(vec![d.clone(), i(ymd.year() as i64), i(ymd.month() as i64)]);
        facts.push(vec![d, i(1)]);
    }
    let g = vec![vec![Value::DateTime(date_serial(2024, 2, 10).unwrap()), i(5)], vec![Value::DateTime(date_serial(2024, 2, 20).unwrap()), i(7)]];
    MemorySource::new().with_rows("Date", dates).with_rows("F", facts).with_rows("G", g)
}

fn eng() -> Engine {
    Engine::new(model(true), &source()).unwrap()
}

fn ev(e: &Engine, src: &str) -> Value {
    e.eval_scalar(src).unwrap_or_else(|err| panic!("{src}\n  -> {:?}: {}", err.code, err.message))
}

/// The expression under the context of one day.
fn at(d: &str, expr: &str) -> String {
    format!("CALCULATE({expr}, 'Date'[Date] = DATE({d}))")
}

/// The expression under the context Mar 10 .. Mar 20, 2024.
fn mid(expr: &str) -> String {
    format!("CALCULATE({expr}, DATESBETWEEN('Date'[Date], DATE(2024, 3, 10), DATE(2024, 3, 20)))")
}

fn dt(y: i32, m: u32, d: u32) -> Value {
    Value::DateTime(date_serial(y, m, d).unwrap())
}

#[test]
fn datesbetween_and_datesinperiod() {
    let e = eng();
    assert_eq!(ev(&e, "COUNTROWS(DATESBETWEEN('Date'[Date], DATE(2024, 3, 10), DATE(2024, 3, 20)))"), i(11));
    // an open end runs to the end of the column
    assert_eq!(ev(&e, "COUNTROWS(DATESBETWEEN('Date'[Date], DATE(2024, 12, 1), BLANK()))"), i(31));
    assert_eq!(ev(&e, "COUNTROWS(DATESBETWEEN('Date'[Date], BLANK(), DATE(2023, 1, 10)))"), i(10));
    assert_eq!(ev(&e, "COUNTROWS(DATESINPERIOD('Date'[Date], DATE(2024, 3, 31), -1, MONTH))"), i(31));
    assert_eq!(ev(&e, "COUNTROWS(DATESINPERIOD('Date'[Date], DATE(2024, 1, 31), 1, MONTH))"), i(29));
    assert_eq!(ev(&e, "COUNTROWS(DATESINPERIOD('Date'[Date], DATE(2024, 3, 15), -7, DAY))"), i(7));
    assert_eq!(ev(&e, "COUNTROWS(DATESINPERIOD('Date'[Date], DATE(2024, 12, 31), -1, YEAR))"), i(366));
    assert_eq!(ev(&e, "COUNTROWS(DATESINPERIOD('Date'[Date], DATE(2024, 6, 30), -2, QUARTER))"), i(183));
    // the filtered result drives CALCULATE
    assert_eq!(ev(&e, "CALCULATE([Total], DATESBETWEEN('Date'[Date], DATE(2024, 3, 10), DATE(2024, 3, 20)))"), i(11));
    assert_eq!(ev(&e, "CALCULATE([Total], DATESINPERIOD('Date'[Date], DATE(2024, 3, 31), -1, MONTH))"), i(31));
}

#[test]
fn period_to_date() {
    let e = eng();
    assert_eq!(ev(&e, &at("2024, 3, 15", "CALCULATE([Total], DATESYTD('Date'[Date]))")), i(75));
    assert_eq!(ev(&e, &at("2024, 3, 15", "CALCULATE([Total], DATESMTD('Date'[Date]))")), i(15));
    assert_eq!(ev(&e, &at("2024, 5, 20", "CALCULATE([Total], DATESQTD('Date'[Date]))")), i(50));
    assert_eq!(ev(&e, &at("2024, 3, 15", "TOTALYTD([Total], 'Date'[Date])")), i(75));
    assert_eq!(ev(&e, &at("2024, 3, 15", "TOTALMTD([Total], 'Date'[Date])")), i(15));
    assert_eq!(ev(&e, &at("2024, 5, 20", "TOTALQTD([Total], 'Date'[Date])")), i(50));
    // fiscal year ending June 30: July 1, 2023 .. March 15, 2024
    assert_eq!(ev(&e, &at("2024, 3, 15", "TOTALYTD([Total], 'Date'[Date], \"6/30\")")), i(259));
    assert_eq!(ev(&e, &at("2024, 3, 15", "CALCULATE([Total], DATESYTD('Date'[Date], \"6/30\"))")), i(259));
    // a context spanning several days uses the last one
    assert_eq!(ev(&e, &mid("CALCULATE([Total], DATESYTD('Date'[Date]))")), i(80));
    assert_eq!(ev(&e, "COUNTROWS(DATESYTD('Date'[Date]))"), i(366));
}

#[test]
fn a_marked_date_table_replaces_all_date_filters() {
    let marked = eng();
    let plain = Engine::new(model(false), &source()).unwrap();
    let q = "CALCULATE(CALCULATE([Total], DATESYTD('Date'[Date])), 'Date'[Date] = DATE(2024, 3, 15), 'Date'[Month] = 3)";
    assert_eq!(ev(&marked, q), i(75));
    // without the mark the Month filter survives: March 1 .. March 15
    assert_eq!(ev(&plain, q), i(15));
    // the key column of a marked date table also resets other columns for ordinary filters (harness)
    let q2 = "CALCULATE(CALCULATE([Total], 'Date'[Date] = DATE(2023, 5, 1)), 'Date'[Month] = 3)";
    assert_eq!(ev(&marked, q2), i(1));
    assert_eq!(ev(&plain, q2), B);
}

#[test]
fn shifting_dates() {
    let e = eng();
    let march = "DATESBETWEEN('Date'[Date], DATE(2024, 3, 1), DATE(2024, 3, 31))";
    let feb = "DATESBETWEEN('Date'[Date], DATE(2024, 2, 1), DATE(2024, 2, 29))";
    assert_eq!(ev(&e, &format!("CALCULATE(CALCULATE([Total], SAMEPERIODLASTYEAR('Date'[Date])), {march})")), i(31));
    // Feb 29 maps to Feb 28
    assert_eq!(ev(&e, &format!("CALCULATE(CALCULATE([Total], SAMEPERIODLASTYEAR('Date'[Date])), {feb})")), i(28));
    assert_eq!(ev(&e, &format!("CALCULATE(CALCULATE([Total], DATEADD('Date'[Date], -1, MONTH)), {march})")), i(29));
    assert_eq!(ev(&e, &format!("CALCULATE(CALCULATE([Total], DATEADD('Date'[Date], 1, DAY)), {march})")), i(31));
    assert_eq!(ev(&e, &format!("CALCULATE(CALCULATE([Total], DATEADD('Date'[Date], -1, QUARTER)), {march})")), i(31));
    // dates beyond the calendar are dropped: March 2025 is not in the calendar, nothing is left
    assert_eq!(ev(&e, &format!("CALCULATE(CALCULATE([Total], DATEADD('Date'[Date], 1, YEAR)), {march})")), B);
    assert_eq!(ev(&e, &at("2024, 12, 15", "CALCULATE([Total], DATEADD('Date'[Date], 1, YEAR))")), B);
}

#[test]
fn parallel_periods_are_whole_periods() {
    let e = eng();
    assert_eq!(ev(&e, &at("2024, 3, 15", "CALCULATE([Total], PARALLELPERIOD('Date'[Date], -1, YEAR))")), i(365));
    assert_eq!(ev(&e, &at("2024, 3, 15", "CALCULATE([Total], PARALLELPERIOD('Date'[Date], -1, MONTH))")), i(29));
    assert_eq!(ev(&e, &at("2024, 3, 15", "CALCULATE([Total], PARALLELPERIOD('Date'[Date], -1, QUARTER))")), i(92));
    assert_eq!(ev(&e, &at("2024, 3, 15", "CALCULATE([Total], PARALLELPERIOD('Date'[Date], 1, YEAR))")), B);
    assert!(e.eval_scalar("COUNTROWS(PARALLELPERIOD('Date'[Date], 1, DAY))").is_err());
}

#[test]
fn previous_and_next_periods() {
    let e = eng();
    let q = |f: &str| at("2024, 3, 15", &format!("CALCULATE([Total], {f}('Date'[Date]))"));
    assert_eq!(ev(&e, &q("PREVIOUSDAY")), i(1));
    assert_eq!(ev(&e, &q("NEXTDAY")), i(1));
    assert_eq!(ev(&e, &q("PREVIOUSMONTH")), i(29));
    assert_eq!(ev(&e, &q("NEXTMONTH")), i(30));
    assert_eq!(ev(&e, &q("PREVIOUSQUARTER")), i(92));
    assert_eq!(ev(&e, &q("NEXTQUARTER")), i(91));
    assert_eq!(ev(&e, &q("PREVIOUSYEAR")), i(365));
    assert_eq!(ev(&e, &q("NEXTYEAR")), B);
    // fiscal year ending June 30 containing March 15, 2024 is Jul 2023 .. Jun 2024; its predecessor is cut at the calendar start
    assert_eq!(ev(&e, &at("2024, 3, 15", "CALCULATE([Total], PREVIOUSYEAR('Date'[Date], \"6/30\"))")), i(181));
    assert_eq!(ev(&e, &at("2024, 3, 15", "CALCULATE([Total], NEXTYEAR('Date'[Date], \"6/30\"))")), i(184));
}

#[test]
fn first_and_last_dates() {
    let e = eng();
    let max = |t: &str| ev(&e, &mid(&format!("MAXX({t}, [Date])")));
    assert_eq!(max("FIRSTDATE('Date'[Date])"), dt(2024, 3, 10));
    assert_eq!(max("LASTDATE('Date'[Date])"), dt(2024, 3, 20));
    assert_eq!(max("STARTOFMONTH('Date'[Date])"), dt(2024, 3, 10));
    assert_eq!(max("ENDOFMONTH('Date'[Date])"), dt(2024, 3, 20));
    assert_eq!(max("STARTOFQUARTER('Date'[Date])"), dt(2024, 3, 10));
    assert_eq!(max("STARTOFYEAR('Date'[Date])"), dt(2024, 3, 10));
    assert_eq!(max("ENDOFYEAR('Date'[Date])"), dt(2024, 3, 20));
    // the whole calendar: first / last visible date of the period holding the last date
    assert_eq!(ev(&e, "MAXX(STARTOFQUARTER('Date'[Date]), [Date])"), dt(2024, 10, 1));
    assert_eq!(ev(&e, "MAXX(STARTOFYEAR('Date'[Date]), [Date])"), dt(2024, 1, 1));
    assert_eq!(ev(&e, "MAXX(ENDOFMONTH('Date'[Date]), [Date])"), dt(2024, 12, 31));
    assert_eq!(ev(&e, "COUNTROWS(FIRSTDATE('Date'[Date]))"), i(1));
    assert_eq!(ev(&e, "COUNTROWS(FIRSTDATE(FILTER(VALUES('Date'[Date]), FALSE())))"), B);
}

#[test]
fn opening_and_closing_balances() {
    let e = eng();
    // running balance: days since 2023-01-01
    assert_eq!(ev(&e, &mid("CLOSINGBALANCEMONTH([Balance], 'Date'[Date])")), i(445));
    assert_eq!(ev(&e, &mid("OPENINGBALANCEMONTH([Balance], 'Date'[Date])")), i(434));
    assert_eq!(ev(&e, &mid("CLOSINGBALANCEQUARTER([Balance], 'Date'[Date])")), i(445));
    assert_eq!(ev(&e, &mid("OPENINGBALANCEQUARTER([Balance], 'Date'[Date])")), i(434));
    assert_eq!(ev(&e, &mid("CLOSINGBALANCEYEAR([Balance], 'Date'[Date])")), i(445));
    assert_eq!(ev(&e, &mid("OPENINGBALANCEYEAR([Balance], 'Date'[Date])")), i(434));
    // the full calendar closes on its last date
    assert_eq!(ev(&e, "CLOSINGBALANCEYEAR([Balance], 'Date'[Date])"), i(731));
    // the optional filter argument is applied as well
    assert_eq!(ev(&e, &mid("CLOSINGBALANCEMONTH([Total], 'Date'[Date], 'Date'[Month] = 3)")), i(1));
}

#[test]
fn first_and_last_non_blank() {
    let e = eng();
    let nb = "CALCULATE(SUM(G[Amt]))";
    assert_eq!(ev(&e, &format!("MAXX(FIRSTNONBLANK('Date'[Date], {nb}), [Date])")), dt(2024, 2, 10));
    assert_eq!(ev(&e, &format!("MAXX(LASTNONBLANK('Date'[Date], {nb}), [Date])")), dt(2024, 2, 20));
    assert_eq!(ev(&e, &format!("FIRSTNONBLANKVALUE('Date'[Date], {nb})")), i(5));
    assert_eq!(ev(&e, &format!("LASTNONBLANKVALUE('Date'[Date], {nb})")), i(7));
    // inside a context only the visible dates are candidates
    let late = "CALCULATE(FIRSTNONBLANKVALUE('Date'[Date], CALCULATE(SUM(G[Amt]))), DATESBETWEEN('Date'[Date], DATE(2024, 2, 15), DATE(2024, 2, 28)))";
    assert_eq!(ev(&e, late), i(7));
    assert_eq!(ev(&e, "FIRSTNONBLANKVALUE('Date'[Date], BLANK())"), B);
}

#[test]
fn calendar_tables() {
    let e = eng();
    assert_eq!(ev(&e, "COUNTROWS(CALENDAR(DATE(2024, 1, 1), DATE(2024, 1, 5)))"), i(5));
    assert_eq!(ev(&e, "MAXX(CALENDAR(DATE(2024, 1, 1), DATE(2024, 2, 29)), [Date])"), dt(2024, 2, 29));
    assert!(e.eval_scalar("COUNTROWS(CALENDAR(DATE(2024, 1, 5), DATE(2024, 1, 1)))").is_err());
    assert_eq!(ev(&e, "COUNTROWS(CALENDARAUTO())"), i(731));
    assert_eq!(ev(&e, "MINX(CALENDARAUTO(6), [Date])"), dt(2022, 7, 1));
    assert_eq!(ev(&e, "MAXX(CALENDARAUTO(6), [Date])"), dt(2025, 6, 30));
    assert_eq!(ev(&e, "COUNTROWS(CALENDARAUTO(6))"), i(1096));
}
