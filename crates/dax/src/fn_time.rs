//! Time intelligence tranche (default behavior, not the "enhanced" preview): DATESBETWEEN, DATESINPERIOD, DATESMTD /
//! QTD / YTD, DATEADD, SAMEPERIODLASTYEAR, PARALLELPERIOD, PREVIOUS* / NEXT*, STARTOF* / ENDOF*, FIRSTDATE, LASTDATE,
//! FIRSTNONBLANK, LASTNONBLANK (and their VALUE forms), OPENINGBALANCE*, CLOSINGBALANCE*, TOTALMTD / QTD / YTD,
//! plus CALENDAR and CALENDARAUTO.
//!
//! Model of the semantics (public descriptions; the details marked "harness" are confirmed with recorded cases):
//! - `dates` is a date column (or a one-column table with date lineage). The *context dates* are its values that
//!   are visible in the current filter context. Functions that return dates return values of the *whole* column
//!   (all rows of its table, filters ignored), restricted to a range computed from the context dates, as a table
//!   with the column's lineage so that CALCULATE can apply it.
//! - Period anchors: PREVIOUS* / NEXT* / PARALLELPERIOD use the first (earliest) context date, DATES*TD and
//!   STARTOF* / ENDOF* the last (latest) one (harness).
//! - A filter on the key column of a marked date table replaces all filters on that table (see
//!   `Evaluator::apply_filters`).

use crate::bind::BExpr;
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, Val};
use crate::filter::Filter;
use crate::functions::{distinct_values, err};
use crate::model::{ColId, DataType};
use crate::table::{TCol, TableVal};
use crate::value::{VResult, Value};
use chrono::{Datelike, NaiveDate};

pub const NAMES: &[&str] = &[
    "CALENDAR", "CALENDARAUTO", "CLOSINGBALANCEMONTH", "CLOSINGBALANCEQUARTER", "CLOSINGBALANCEYEAR", "DATEADD", "DATESBETWEEN", "DATESINPERIOD", "DATESMTD", "DATESQTD", "DATESYTD",
    "ENDOFMONTH", "ENDOFQUARTER", "ENDOFYEAR", "FIRSTDATE", "FIRSTNONBLANK", "FIRSTNONBLANKVALUE", "LASTDATE", "LASTNONBLANK", "LASTNONBLANKVALUE", "NEXTDAY", "NEXTMONTH",
    "NEXTQUARTER", "NEXTYEAR", "OPENINGBALANCEMONTH", "OPENINGBALANCEQUARTER", "OPENINGBALANCEYEAR", "PARALLELPERIOD", "PREVIOUSDAY", "PREVIOUSMONTH", "PREVIOUSQUARTER", "PREVIOUSYEAR",
    "SAMEPERIODLASTYEAR", "STARTOFMONTH", "STARTOFQUARTER", "STARTOFYEAR", "TOTALMTD", "TOTALQTD", "TOTALYTD",
];

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env))
}

// ---------------------------------------------------------------------------------------------------------
// Calendar arithmetic on day numbers (days since 1899-12-30)

fn base() -> NaiveDate {
    NaiveDate::from_ymd_opt(1899, 12, 30).unwrap()
}

fn date_of(day: i64) -> VResult<NaiveDate> {
    base().checked_add_signed(chrono::Duration::days(day)).ok_or_else(|| err(ErrorCode::InvalidValue, "The date is out of range."))
}

fn day_of(d: NaiveDate) -> i64 {
    (d - base()).num_days()
}

fn last_dom(y: i32, m: u32) -> u32 {
    let next = if m == 12 { NaiveDate::from_ymd_opt(y + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y, m + 1, 1) };
    next.map(|n| n.pred_opt().unwrap().day()).unwrap_or(28)
}

fn add_months(d: NaiveDate, n: i64) -> VResult<NaiveDate> {
    let total = d.year() as i64 * 12 + d.month0() as i64 + n;
    let (y, m) = (total.div_euclid(12) as i32, total.rem_euclid(12) as u32 + 1);
    if !(1..=9999).contains(&y) {
        return Err(err(ErrorCode::InvalidValue, "The shifted date is out of range."));
    }
    // recorded from Power BI: the last day of a month moves to the last day of the target month (Jun 30 - 6 months is
    // Dec 31, Jan 31 + 1 month is Feb 29)
    let day = if d.day() == last_dom(d.year(), d.month()) { last_dom(y, m) } else { d.day().min(last_dom(y, m)) };
    Ok(NaiveDate::from_ymd_opt(y, m, day).unwrap())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Interval {
    Day,
    Month,
    Quarter,
    Year,
}

fn interval_arg(name: &str, e: &BExpr) -> VResult<Interval> {
    match e.ident() {
        Some("DAY") => Ok(Interval::Day),
        Some("MONTH") => Ok(Interval::Month),
        Some("QUARTER") => Ok(Interval::Quarter),
        Some("YEAR") => Ok(Interval::Year),
        _ => Err(err(ErrorCode::InvalidParameter, format!("{name}: the interval must be DAY, MONTH, QUARTER or YEAR."))),
    }
}

fn shift(d: NaiveDate, n: i64, iv: Interval) -> VResult<NaiveDate> {
    match iv {
        Interval::Day => d.checked_add_signed(chrono::Duration::days(n)).ok_or_else(|| err(ErrorCode::InvalidValue, "The shifted date is out of range.")),
        Interval::Month => add_months(d, n),
        Interval::Quarter => add_months(d, 3 * n),
        Interval::Year => add_months(d, 12 * n),
    }
}

/// Year-end date (month, day) from the optional year_end_date argument ("6/30", "30-Jun", a date).
#[derive(Clone, Copy)]
struct YearEnd {
    month: u32,
    day: u32,
}

impl YearEnd {
    const DEC31: YearEnd = YearEnd { month: 12, day: 31 };

    fn parse(v: &Value) -> VResult<YearEnd> {
        let bad = || err(ErrorCode::InvalidValue, "The year_end_date argument must be a date such as \"6/30\" or \"12/31\".");
        match v {
            Value::DateTime(s) => {
                let d = crate::value::serial_to_datetime(*s).ok_or_else(bad)?.date();
                Ok(YearEnd { month: d.month(), day: d.day() })
            }
            Value::Str(s) => {
                let t = s.trim();
                let nums: Vec<&str> = t.split(|c: char| c == '/' || c == '-' || c == ' ' || c == '.').filter(|x| !x.is_empty()).collect();
                let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
                let month_of = |x: &str| months.iter().position(|m| x.to_ascii_lowercase().starts_with(m)).map(|i| i as u32 + 1);
                let (m, d) = match nums.as_slice() {
                    [a, b] | [a, b, _] => {
                        if let (Ok(m), Ok(d)) = (a.parse::<u32>(), b.parse::<u32>()) {
                            (m, d)
                        } else if let (Ok(d), Some(m)) = (a.parse::<u32>(), month_of(b)) {
                            (m, d)
                        } else if let (Some(m), Ok(d)) = (month_of(a), b.parse::<u32>()) {
                            (m, d)
                        } else {
                            return Err(bad());
                        }
                    }
                    _ => return Err(bad()),
                };
                if !(1..=12).contains(&m) || d < 1 || d > last_dom(2000, m) {
                    return Err(bad());
                }
                Ok(YearEnd { month: m, day: d })
            }
            Value::Blank => Ok(YearEnd::DEC31),
            _ => Err(bad()),
        }
    }

    fn end_in(self, year: i32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, self.month, self.day.min(last_dom(year, self.month))).unwrap()
    }

    /// First and last day of the fiscal year that contains `d`.
    fn year_of(self, d: NaiveDate) -> (NaiveDate, NaiveDate) {
        let this_end = self.end_in(d.year());
        if d <= this_end {
            (self.end_in(d.year() - 1).succ_opt().unwrap(), this_end)
        } else {
            (this_end.succ_opt().unwrap(), self.end_in(d.year() + 1))
        }
    }
}

fn month_range(d: NaiveDate) -> (NaiveDate, NaiveDate) {
    (NaiveDate::from_ymd_opt(d.year(), d.month(), 1).unwrap(), NaiveDate::from_ymd_opt(d.year(), d.month(), last_dom(d.year(), d.month())).unwrap())
}

fn quarter_range(d: NaiveDate) -> (NaiveDate, NaiveDate) {
    let sm = (d.month0() / 3) * 3 + 1;
    (NaiveDate::from_ymd_opt(d.year(), sm, 1).unwrap(), NaiveDate::from_ymd_opt(d.year(), sm + 2, last_dom(d.year(), sm + 2)).unwrap())
}

fn period_range(d: NaiveDate, iv: Interval, ye: YearEnd) -> (NaiveDate, NaiveDate) {
    match iv {
        Interval::Day => (d, d),
        Interval::Month => month_range(d),
        Interval::Quarter => quarter_range(d),
        Interval::Year => ye.year_of(d),
    }
}

// ---------------------------------------------------------------------------------------------------------
// The dates argument

struct DateSet {
    col: Option<ColId>,
    name: String,
    /// Distinct non-blank values of the whole column, ascending.
    universe: Vec<(i64, Value)>,
    /// Day numbers visible in the current context, ascending and distinct.
    ctx: Vec<i64>,
}

fn day_of_value(v: &Value) -> VResult<Option<i64>> {
    match v {
        Value::Blank => Ok(None),
        Value::Str(s) => crate::fn_date::to_serial("dates", &Some(Value::str(s))).map(|x| Some(x.floor() as i64)),
        other => Ok(Some(other.to_f64()?.floor() as i64)),
    }
}

fn date_set<'a>(ev: &'a Evaluator<'a>, arg: &'a BExpr, env: &Env<'a>) -> VResult<DateSet> {
    let universe_of = |c: ColId| -> VResult<Vec<(i64, Value)>> {
        let mut seen = std::collections::BTreeMap::new();
        for r in ev.all_rows(c.table, false) {
            let v = ev.data.value(c, r);
            if let Some(d) = day_of_value(v)? {
                seen.entry(d).or_insert_with(|| v.clone());
            }
        }
        Ok(seen.into_iter().collect())
    };
    if let Some(c) = arg.col() {
        let mut ctx = Vec::new();
        for v in distinct_values(ev, c, env, false) {
            if let Some(d) = day_of_value(&v)? {
                ctx.push(d);
            }
        }
        ctx.sort_unstable();
        ctx.dedup();
        return Ok(DateSet { col: Some(c), name: ev.data.model.column(c).name.clone(), universe: universe_of(c)?, ctx });
    }
    let t = ev.table(arg, env)?;
    if t.ncols(ev.data) != 1 {
        return Err(err(ErrorCode::InvalidParameter, "The dates argument must be a date column or a table with one date column."));
    }
    let cols = t.cols(ev.data);
    let mut ctx = Vec::new();
    let mut vals = std::collections::BTreeMap::new();
    for r in 0..t.nrows() {
        let v = t.value(ev.data, r, 0);
        if let Some(d) = day_of_value(&v)? {
            ctx.push(d);
            vals.entry(d).or_insert(v);
        }
    }
    ctx.sort_unstable();
    ctx.dedup();
    let col = cols[0].lineage;
    let universe = match col {
        Some(c) => universe_of(c)?,
        None => vals.into_iter().collect(),
    };
    Ok(DateSet { col, name: cols[0].name.clone(), universe, ctx })
}

impl DateSet {
    fn table(&self, keep: impl Fn(i64) -> bool) -> TableVal {
        let rows = self.universe.iter().filter(|(d, _)| keep(*d)).map(|(_, v)| vec![v.clone()]).collect();
        TableVal::mat(vec![TCol { name: self.name.clone(), lineage: self.col, renamed: false }], rows)
    }

    fn between(&self, from: i64, to: i64) -> TableVal {
        self.table(|d| d >= from && d <= to)
    }

    fn one(&self, day: i64) -> TableVal {
        let v = self.universe.iter().find(|(d, _)| *d == day).map(|(_, v)| v.clone());
        let rows = v.into_iter().map(|v| vec![v]).collect();
        TableVal::mat(vec![TCol { name: self.name.clone(), lineage: self.col, renamed: false }], rows)
    }

    fn first(&self) -> VResult<NaiveDate> {
        date_of(*self.ctx.first().unwrap())
    }

    fn last(&self) -> VResult<NaiveDate> {
        date_of(*self.ctx.last().unwrap())
    }
}

fn empty_like(ds: &DateSet) -> TableVal {
    ds.table(|_| false)
}

fn year_end_arg<'a>(ev: &'a Evaluator<'a>, arg: Option<&'a BExpr>, env: &Env<'a>) -> VResult<YearEnd> {
    match arg {
        Some(a) if !a.is_missing() => YearEnd::parse(&ev.scalar(a, env)?),
        _ => Ok(YearEnd::DEC31),
    }
}

fn int_arg<'a>(ev: &'a Evaluator<'a>, e: &'a BExpr, env: &Env<'a>) -> VResult<i64> {
    let f = ev.scalar(e, env)?.to_f64()?;
    if !f.is_finite() || f.abs() > 1.0e7 {
        return Err(err(ErrorCode::InvalidValue, "The number of intervals is out of range."));
    }
    Ok(f.trunc() as i64)
}

fn bound<'a>(ev: &'a Evaluator<'a>, e: &'a BExpr, env: &Env<'a>, default: i64) -> VResult<i64> {
    Ok(day_of_value(&ev.scalar(e, env)?)?.unwrap_or(default))
}

// ---------------------------------------------------------------------------------------------------------

/// The table of dates that a named function stands for (None when the name is not a date-set function).
fn date_table<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], ye_arg: Option<&'a BExpr>, env: &Env<'a>) -> VResult<Option<TableVal>> {
    let ds_ = || date_set(ev, &args[0], env);
    Ok(Some(match name {
        "DATESBETWEEN" => {
            let ds = ds_()?;
            let (from, to) = (bound(ev, &args[1], env, i64::MIN)?, bound(ev, &args[2], env, i64::MAX)?);
            ds.between(from, to)
        }
        "DATESINPERIOD" => {
            let ds = ds_()?;
            let start = date_of(bound(ev, &args[1], env, 0)?)?;
            let n = int_arg(ev, &args[2], env)?;
            let iv = interval_arg(name, &args[3])?;
            let moved = shift(start, n, iv)?;
            if n >= 0 {
                ds.between(day_of(start), day_of(moved) - 1)
            } else {
                ds.between(day_of(moved) + 1, day_of(start))
            }
        }
        "DATESMTD" | "DATESQTD" | "DATESYTD" => {
            let ds = ds_()?;
            if ds.ctx.is_empty() {
                return Ok(Some(empty_like(&ds)));
            }
            let last = ds.last()?;
            let (iv, ye) = match name {
                "DATESMTD" => (Interval::Month, YearEnd::DEC31),
                "DATESQTD" => (Interval::Quarter, YearEnd::DEC31),
                _ => (Interval::Year, year_end_arg(ev, ye_arg, env)?),
            };
            ds.between(day_of(period_range(last, iv, ye).0), day_of(last))
        }
        "DATEADD" | "SAMEPERIODLASTYEAR" => {
            let ds = ds_()?;
            let (n, iv) = if name == "DATEADD" { (int_arg(ev, &args[1], env)?, interval_arg(name, &args[2])?) } else { (-1, Interval::Year) };
            if ds.ctx.is_empty() {
                return Ok(Some(empty_like(&ds)));
            }
            let (first, last) = (*ds.ctx.first().unwrap(), *ds.ctx.last().unwrap());
            // recorded from Power BI: when the context dates are a continuous run of the column (no date of the
            // column between the first and the last is missing) the result is the whole shifted interval,
            // otherwise each date is moved on its own
            let in_run = ds.universe.iter().filter(|(d, _)| *d >= first && *d <= last).count();
            if in_run == ds.ctx.len() {
                let (from, to) = (day_of(shift(date_of(first)?, n, iv)?), day_of(shift(date_of(last)?, n, iv)?));
                ds.between(from, to)
            } else {
                let mut set = std::collections::HashSet::new();
                for &d in &ds.ctx {
                    set.insert(day_of(shift(date_of(d)?, n, iv)?));
                }
                ds.table(|d| set.contains(&d))
            }
        }
        "PARALLELPERIOD" => {
            let ds = ds_()?;
            if ds.ctx.is_empty() {
                return Ok(Some(empty_like(&ds)));
            }
            let n = int_arg(ev, &args[1], env)?;
            let iv = interval_arg(name, &args[2])?;
            if iv == Interval::Day {
                return Err(err(ErrorCode::InvalidParameter, "PARALLELPERIOD: the interval must be MONTH, QUARTER or YEAR."));
            }
            let from = period_range(shift(ds.first()?, n, iv)?, iv, YearEnd::DEC31).0;
            let to = period_range(shift(ds.last()?, n, iv)?, iv, YearEnd::DEC31).1;
            ds.between(day_of(from), day_of(to))
        }
        "FIRSTDATE" | "LASTDATE" => {
            let ds = ds_()?;
            match (name, ds.ctx.first(), ds.ctx.last()) {
                ("FIRSTDATE", Some(&d), _) | ("LASTDATE", _, Some(&d)) => ds.one(d),
                _ => empty_like(&ds),
            }
        }
        "STARTOFMONTH" | "STARTOFQUARTER" | "STARTOFYEAR" | "ENDOFMONTH" | "ENDOFQUARTER" | "ENDOFYEAR" => {
            let ds = ds_()?;
            if ds.ctx.is_empty() {
                return Ok(Some(empty_like(&ds)));
            }
            let iv = match name {
                n if n.ends_with("MONTH") => Interval::Month,
                n if n.ends_with("QUARTER") => Interval::Quarter,
                _ => Interval::Year,
            };
            let ye = if iv == Interval::Year { year_end_arg(ev, ye_arg, env)? } else { YearEnd::DEC31 };
            // recorded from Power BI: STARTOF* is the first date of the period of the first context date, ENDOF* the last
            // date of the period of the last context date, taken from the whole date column
            let target = if name.starts_with("START") { period_range(ds.first()?, iv, ye).0 } else { period_range(ds.last()?, iv, ye).1 };
            ds.one(day_of(target))
        }
        "PREVIOUSDAY" | "NEXTDAY" => {
            let ds = ds_()?;
            if ds.ctx.is_empty() {
                return Ok(Some(empty_like(&ds)));
            }
            // recorded from Power BI: PREVIOUSDAY looks at the first context date, NEXTDAY at the last one
            ds.one(if name == "PREVIOUSDAY" { day_of(ds.first()?) - 1 } else { day_of(ds.last()?) + 1 })
        }
        "PREVIOUSMONTH" | "PREVIOUSQUARTER" | "PREVIOUSYEAR" | "NEXTMONTH" | "NEXTQUARTER" | "NEXTYEAR" => {
            let ds = ds_()?;
            if ds.ctx.is_empty() {
                return Ok(Some(empty_like(&ds)));
            }
            let iv = match name {
                n if n.ends_with("MONTH") => Interval::Month,
                n if n.ends_with("QUARTER") => Interval::Quarter,
                _ => Interval::Year,
            };
            let ye = if iv == Interval::Year { year_end_arg(ev, ye_arg, env)? } else { YearEnd::DEC31 };
            let n = if name.starts_with("PREVIOUS") { -1 } else { 1 };
            // recorded from Power BI: PREVIOUS* anchors on the first context date, NEXT* on the last one
            let anchor = if n < 0 { ds.first()? } else { ds.last()? };
            let (ps, pe) = period_range(anchor, iv, ye);
            let (from, to) = if iv == Interval::Year {
                // fiscal years: shift the boundaries of the containing year
                let (ns, ne) = if n < 0 { ye.year_of(ps.pred_opt().unwrap()) } else { ye.year_of(pe.succ_opt().unwrap()) };
                (ns, ne)
            } else {
                period_range(shift(ps, n, iv)?, iv, ye)
            };
            ds.between(day_of(from), day_of(to))
        }
        _ => return Ok(None),
    }))
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Val> {
    if let Some(t) = date_table(ev, name, args, args.get(1), env)? {
        return Ok(Val::T(t));
    }
    match name {
        "CALENDAR" => {
            let s = day_of_value(&ev.scalar(&args[0], env)?)?.ok_or_else(|| err(ErrorCode::InvalidValue, "CALENDAR needs a start date."))?;
            let e = day_of_value(&ev.scalar(&args[1], env)?)?.ok_or_else(|| err(ErrorCode::InvalidValue, "CALENDAR needs an end date."))?;
            if e < s {
                return Err(err(ErrorCode::InvalidValue, "CALENDAR: the end date is before the start date."));
            }
            if e - s > 4_000_000 {
                return Err(err(ErrorCode::InvalidValue, "CALENDAR would produce too many rows."));
            }
            let rows = (s..=e).map(|d| vec![Value::DateTime(d as f64)]).collect();
            Ok(Val::T(TableVal::mat(vec![TCol { name: "Date".into(), lineage: None, renamed: false }], rows)))
        }
        "CALENDARAUTO" => {
            let fy = if args.is_empty() || args[0].is_missing() { 12 } else { int_arg(ev, &args[0], env)? };
            if !(1..=12).contains(&fy) {
                return Err(err(ErrorCode::InvalidParameter, "CALENDARAUTO: the fiscal year end month must be 1 to 12."));
            }
            let mut lo: Option<i64> = None;
            let mut hi: Option<i64> = None;
            for (t, table) in ev.data.model.tables.iter().enumerate() {
                for (ci, col) in table.columns.iter().enumerate() {
                    if col.data_type != DataType::DateTime || col.expression.is_some() {
                        continue;
                    }
                    let c = ColId { table: t, col: ci };
                    for r in ev.all_rows(t, false) {
                        if let Some(d) = day_of_value(ev.data.value(c, r))? {
                            lo = Some(lo.map_or(d, |x| x.min(d)));
                            hi = Some(hi.map_or(d, |x| x.max(d)));
                        }
                    }
                }
            }
            let (lo, hi) = match (lo, hi) {
                (Some(l), Some(h)) => (date_of(l)?, date_of(h)?),
                _ => return Err(err(ErrorCode::InvalidValue, "CALENDARAUTO found no date columns with values in the model.")),
            };
            let fy = fy as u32;
            let start_month = fy % 12 + 1;
            let start_year = if lo.month() >= start_month { lo.year() } else { lo.year() - 1 };
            let end_year = if hi.month() <= fy { hi.year() } else { hi.year() + 1 };
            let start = NaiveDate::from_ymd_opt(start_year, start_month, 1).unwrap();
            let end = NaiveDate::from_ymd_opt(end_year, fy, last_dom(end_year, fy)).unwrap();
            let rows = (day_of(start)..=day_of(end)).map(|d| vec![Value::DateTime(d as f64)]).collect();
            Ok(Val::T(TableVal::mat(vec![TCol { name: "Date".into(), lineage: None, renamed: false }], rows)))
        }
        "FIRSTNONBLANK" | "LASTNONBLANK" | "FIRSTNONBLANKVALUE" | "LASTNONBLANKVALUE" => {
            let c = crate::functions::col_arg(name, args, 0)?;
            let mut vals = distinct_values(ev, c, env, false);
            vals.sort_by(crate::value::sort_cmp);
            if name.starts_with("LAST") {
                vals.reverse();
            }
            let g = ev.graph(&env.filter);
            for v in vals {
                let ctx = env.filter.remove_columns(ev.data, &g, &std::iter::once(c).collect()).push(Filter::single(c, v.key()));
                let r = ev.scalar(&args[1], &Env { filter: ctx, rows: env.rows.clone(), vars: env.vars.clone() })?;
                if !r.is_blank() {
                    return Ok(if name.ends_with("VALUE") {
                        Val::S(r)
                    } else {
                        Val::T(TableVal::mat(vec![TCol { name: ev.data.model.column(c).name.clone(), lineage: Some(c), renamed: false }], vec![vec![v]]))
                    });
                }
            }
            Ok(if name.ends_with("VALUE") { Val::S(Value::Blank) } else { Val::T(TableVal::mat(vec![TCol { name: ev.data.model.column(c).name.clone(), lineage: Some(c), renamed: false }], vec![])) })
        }
        "TOTALMTD" | "TOTALQTD" | "TOTALYTD" => {
            // TOTALxTD(expression, dates, [filter], [year_end_date]) = CALCULATE(expression, DATESxTD(dates), filter)
            let fname = format!("DATES{}", &name[5..]);
            let (filter, ye) = year_end_split(name == "TOTALYTD", args);
            let table = date_table(ev, &fname, std::slice::from_ref(&args[1]), ye, env)?;
            eval_with_tables(ev, &args[0], vec![table.unwrap()], filter, env)
        }
        "OPENINGBALANCEMONTH" | "OPENINGBALANCEQUARTER" | "OPENINGBALANCEYEAR" | "CLOSINGBALANCEMONTH" | "CLOSINGBALANCEQUARTER" | "CLOSINGBALANCEYEAR" => {
            let opening = name.starts_with("OPENING");
            let period = &name[14..];
            let ds = date_set(ev, &args[1], env)?;
            let table = if ds.ctx.is_empty() {
                empty_like(&ds)
            } else {
                let iv = match period {
                    "MONTH" => Interval::Month,
                    "QUARTER" => Interval::Quarter,
                    _ => Interval::Year,
                };
                let ye = if iv == Interval::Year { year_end_arg(ev, year_end_split(true, args).1, env)? } else { YearEnd::DEC31 };
                // recorded from Power BI: closing = the last date of the period of the last context date (from the whole
                // column, not only the visible dates); opening = the day before the first date of the period of the
                // first context date
                if opening {
                    ds.one(day_of(period_range(ds.first()?, iv, ye).0) - 1)
                } else {
                    ds.one(day_of(period_range(ds.last()?, iv, ye).1))
                }
            };
            eval_with_tables(ev, &args[0], vec![table], year_end_split(true, args).0, env)
        }
        _ => unreachable!("{name}"),
    }
}

/// (filter, year_end_date) of TOTALYTD / balance functions: a text literal in the filter position is the year end
/// (TOTALYTD(sales, dates, "6/30")).
fn year_end_split<'a>(has_year_end: bool, args: &'a [BExpr]) -> (Option<&'a BExpr>, Option<&'a BExpr>) {
    let third = args.get(2).filter(|a| !a.is_missing());
    if !has_year_end {
        return (third, None);
    }
    match third {
        Some(a) if matches!(&a.kind, crate::bind::BKind::Const(Value::Str(_))) => (None, Some(a)),
        _ => (third, args.get(3)),
    }
}

/// CALCULATE(expression, tables..., filter): context transition, the optional filter argument, then the date
/// tables as filters.
fn eval_with_tables<'a>(ev: &'a Evaluator<'a>, expr: &'a BExpr, tables: Vec<TableVal>, filter: Option<&'a BExpr>, env: &Env<'a>) -> VResult<Val> {
    let filters: Vec<&'a BExpr> = filter.into_iter().collect();
    let base = ev.calculate_ctx(&filters, env)?;
    let g = ev.graph(&base);
    let mut apply = Vec::new();
    for t in &tables {
        if let Some(f) = ev.table_filter(t, &env.filter)? {
            apply.push((f, false));
        }
    }
    let ctx = ev.apply_filters(base, &g, apply);
    Ok(Val::S(ev.scalar(expr, &env.with_filter(ctx))?))
}

