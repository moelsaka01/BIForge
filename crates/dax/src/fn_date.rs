//! Date and time tranche: DATE, TIME, DAY, MONTH, YEAR, QUARTER, HOUR, MINUTE, SECOND, WEEKDAY, WEEKNUM, EDATE,
//! EOMONTH, DATEDIFF, DATEVALUE, TIMEVALUE, NOW, TODAY, UTCNOW, UTCTODAY, YEARFRAC, NETWORKDAYS.
//! A date is a serial number (days since 1899-12-30, time of day as the fraction). BLANK counts as serial 0
//! (harness: 12/30/1899). Text converts with the same rules as `DATEVALUE`.

use crate::bind::BExpr;
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, Val};
use crate::functions::{err, eval_args};
use crate::value::{datetime_to_serial, parse_datetime_literal, serial_to_datetime, VResult, Value};
use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, Timelike};

pub const NAMES: &[&str] = &[
    "DATE", "DATEDIFF", "DATEVALUE", "DAY", "EDATE", "EOMONTH", "HOUR", "MINUTE", "MONTH", "NETWORKDAYS", "NOW", "QUARTER", "SECOND", "TIME", "TIMEVALUE", "TODAY", "UTCNOW", "UTCTODAY",
    "WEEKDAY", "WEEKNUM", "YEAR", "YEARFRAC",
];

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env).map(Val::S))
}

pub fn base_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(1899, 12, 30).unwrap()
}

/// Serial number of a date argument.
pub fn to_serial(name: &str, v: &Option<Value>) -> VResult<f64> {
    match v {
        None | Some(Value::Blank) => Ok(0.0),
        Some(Value::DateTime(d)) => Ok(*d),
        Some(Value::Str(s)) => text_to_serial(s).ok_or_else(|| err(ErrorCode::TypeMismatch, format!("The function {name} cannot convert '{s}' of type Text to a date."))),
        Some(v) => v.to_f64(),
    }
}

fn text_to_serial(s: &str) -> Option<f64> {
    let t = s.trim();
    if let Some(x) = parse_datetime_literal(t) {
        return Some(x);
    }
    for f in ["%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%d %B %Y", "%B %d, %Y", "%b %d, %Y", "%d-%b-%Y"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(t, f) {
            return Some(datetime_to_serial(dt));
        }
    }
    for f in ["%m/%d/%Y", "%d %B %Y", "%B %d, %Y", "%b %d, %Y", "%d-%b-%Y", "%B %d %Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(t, f) {
            return Some(datetime_to_serial(d.and_time(NaiveTime::MIN)));
        }
    }
    if let Some(f) = time_text_to_fraction(t) {
        return Some(f);
    }
    t.parse::<f64>().ok()
}

pub(crate) fn time_text_to_fraction(t: &str) -> Option<f64> {
    for f in ["%I:%M:%S %p", "%I:%M %p", "%H:%M:%S", "%H:%M"] {
        if let Ok(tm) = NaiveTime::parse_from_str(t, f) {
            return Some(tm.num_seconds_from_midnight() as f64 / 86400.0);
        }
    }
    None
}

fn dt(name: &str, serial: f64) -> VResult<NaiveDateTime> {
    serial_to_datetime(serial).ok_or_else(|| err(ErrorCode::InvalidValue, format!("The function {name} cannot use this date value.")))
}

fn from_ymd(name: &str, y: i64, m: i64, d: i64) -> VResult<f64> {
    let y = if (0..1900).contains(&y) { y + 1900 } else { y };
    let months = y * 12 + (m - 1);
    let (yy, mm) = (months.div_euclid(12), months.rem_euclid(12) + 1);
    if !(1900..=9999).contains(&yy) {
        return Err(err(ErrorCode::InvalidValue, format!("The function {name} produced a year outside 1900-9999.")));
    }
    let first = NaiveDate::from_ymd_opt(yy as i32, mm as u32, 1).unwrap();
    let date = first.checked_add_signed(chrono::Duration::days(d - 1)).ok_or_else(|| err(ErrorCode::InvalidValue, format!("The function {name} produced an invalid date.")))?;
    if date.year() < 1900 || date.year() > 9999 {
        return Err(err(ErrorCode::InvalidValue, format!("The function {name} produced a year outside 1900-9999.")));
    }
    Ok(datetime_to_serial(date.and_time(NaiveTime::MIN)))
}

fn days_in_month(y: i32, m: u32) -> u32 {
    let next = if m == 12 { NaiveDate::from_ymd_opt(y + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y, m + 1, 1) }.unwrap();
    next.pred_opt().unwrap().day()
}

fn add_months(name: &str, serial: f64, months: i64) -> VResult<NaiveDateTime> {
    let d = dt(name, serial)?;
    let total = d.year() as i64 * 12 + d.month0() as i64 + months;
    let (y, m) = (total.div_euclid(12) as i32, total.rem_euclid(12) as u32 + 1);
    if !(1900..=9999).contains(&y) {
        return Err(err(ErrorCode::InvalidValue, format!("The function {name} produced a year outside 1900-9999.")));
    }
    let day = d.day().min(days_in_month(y, m));
    Ok(NaiveDate::from_ymd_opt(y, m, day).unwrap().and_time(d.time()))
}

/// Day-of-week with `start` = the weekday that counts as 1 (0 = Sunday .. 6 = Saturday).
fn weekday_from(d: NaiveDate, start: u32) -> u32 {
    (d.weekday().num_days_from_sunday() + 7 - start) % 7 + 1
}

fn week_start_of(name: &str, t: i64) -> VResult<u32> {
    Ok(match t {
        1 | 17 => 0,
        2 => 1,
        11..=16 => (t - 10) as u32 % 7,
        _ => return Err(err(ErrorCode::InvalidValue, format!("The function {name} does not accept the week type {t}."))),
    })
}

fn weekend_days(weekend: &Option<Value>) -> VResult<[bool; 7]> {
    // index 0 = Monday .. 6 = Sunday
    let mut w = [false; 7];
    match weekend {
        None => {
            w[5] = true;
            w[6] = true;
        }
        Some(Value::Str(s)) => {
            if s.len() != 7 || !s.chars().all(|c| c == '0' || c == '1') || s.chars().all(|c| c == '1') {
                return Err(err(ErrorCode::InvalidValue, "NETWORKDAYS: the weekend string must have 7 characters of 0 and 1, not all 1."));
            }
            for (i, c) in s.chars().enumerate() {
                w[i] = c == '1';
            }
        }
        Some(v) => match v.to_f64()?.trunc() as i64 {
            n @ 1..=7 => {
                let a = (n - 1) as usize; // 1 = Sat+Sun, 2 = Sun+Mon, 3 = Mon+Tue ...
                let first = (a + 5) % 7;
                w[first] = true;
                w[(first + 1) % 7] = true;
            }
            n @ 11..=17 => w[(n - 12).rem_euclid(7) as usize] = true,
            n => return Err(err(ErrorCode::InvalidValue, format!("NETWORKDAYS: the weekend code {n} is not valid."))),
        },
    }
    Ok(w)
}

fn is_last_feb(d: NaiveDate) -> bool {
    d.month() == 2 && d.day() == days_in_month(d.year(), 2)
}

fn yearfrac(a: NaiveDate, b: NaiveDate, basis: i64) -> VResult<f64> {
    let (a, b) = if a <= b { (a, b) } else { (b, a) };
    let days = (b - a).num_days() as f64;
    let thirty360 = |us: bool| {
        let (mut d1, mut d2) = (a.day() as i64, b.day() as i64);
        if us {
            if is_last_feb(a) && is_last_feb(b) {
                d2 = 30;
            }
            if is_last_feb(a) {
                d1 = 30;
            }
            if d2 == 31 && d1 >= 30 {
                d2 = 30;
            }
            if d1 == 31 {
                d1 = 30;
            }
        } else {
            d1 = d1.min(30);
            d2 = d2.min(30);
        }
        ((b.year() - a.year()) as i64 * 360 + (b.month() as i64 - a.month() as i64) * 30 + (d2 - d1)) as f64 / 360.0
    };
    Ok(match basis {
        0 => thirty360(true),
        4 => thirty360(false),
        2 => days / 360.0,
        3 => days / 365.0,
        1 => {
            let leap = |y: i32| NaiveDate::from_ymd_opt(y, 2, 29).is_some();
            let denom = if a.year() == b.year() {
                if leap(a.year()) { 366.0 } else { 365.0 }
            } else {
                let n = (b.year() - a.year() + 1) as f64;
                (a.year()..=b.year()).map(|y| if leap(y) { 366.0 } else { 365.0 }).sum::<f64>() / n
            };
            days / denom
        }
        _ => return Err(err(ErrorCode::InvalidValue, "YEARFRAC: the basis must be 0 to 4.")),
    })
}

fn datediff(start: f64, end: f64, unit: &str) -> VResult<i64> {
    let (s, e) = (dt("DATEDIFF", start)?, dt("DATEDIFF", end)?);
    let secs = |d: NaiveDateTime| (d - base_date().and_time(NaiveTime::MIN)).num_seconds();
    let months = |d: NaiveDateTime| d.year() as i64 * 12 + d.month0() as i64;
    Ok(match unit {
        "SECOND" => secs(e) - secs(s),
        "MINUTE" => secs(e).div_euclid(60) - secs(s).div_euclid(60),
        "HOUR" => secs(e).div_euclid(3600) - secs(s).div_euclid(3600),
        "DAY" => secs(e).div_euclid(86400) - secs(s).div_euclid(86400),
        // weeks begin on Sunday; serial day 1 (1899-12-31) is a Sunday
        "WEEK" => (secs(e).div_euclid(86400) - 1).div_euclid(7) - (secs(s).div_euclid(86400) - 1).div_euclid(7),
        "MONTH" => months(e) - months(s),
        "QUARTER" => months(e).div_euclid(3) - months(s).div_euclid(3),
        "YEAR" => e.year() as i64 - s.year() as i64,
        other => return Err(err(ErrorCode::InvalidParameter, format!("DATEDIFF: the interval '{other}' is not valid."))),
    })
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    if name == "DATEDIFF" {
        let (s, e) = (ev.scalar(&args[0], env)?, ev.scalar(&args[1], env)?);
        if s.is_blank() || e.is_blank() {
            return Ok(Value::Blank);
        }
        let unit = args[2].ident().map(str::to_string).unwrap_or_default();
        return Ok(Value::Int(datediff(to_serial(name, &Some(s))?, to_serial(name, &Some(e))?, &unit)?));
    }
    if name == "NETWORKDAYS" {
        return networkdays(ev, args, env);
    }
    let a = eval_args(ev, args, env)?;
    let arg = |i: usize| a.get(i).cloned().flatten();
    let serial0 = || to_serial(name, &arg(0));
    let int = |i: usize, d: i64| -> VResult<i64> {
        match arg(i) {
            None => Ok(d),
            Some(v) => {
                let f = v.to_f64()?;
                if !f.is_finite() || f.abs() > 1.0e10 {
                    return Err(err(ErrorCode::InvalidValue, format!("The function {name} cannot use an argument of this size.")));
                }
                Ok(f.trunc() as i64)
            }
        }
    };
    match name {
        "DATE" => Ok(Value::DateTime(from_ymd(name, int(0, 0)?, int(1, 1)?, int(2, 1)?)?)),
        "TIME" => {
            let secs = int(0, 0)? * 3600 + int(1, 0)? * 60 + int(2, 0)?;
            Ok(Value::DateTime(secs.rem_euclid(86400) as f64 / 86400.0))
        }
        "YEAR" => Ok(Value::Int(dt(name, serial0()?)?.year() as i64)),
        "MONTH" => Ok(Value::Int(dt(name, serial0()?)?.month() as i64)),
        "DAY" => Ok(Value::Int(dt(name, serial0()?)?.day() as i64)),
        "QUARTER" => Ok(Value::Int((dt(name, serial0()?)?.month0() / 3 + 1) as i64)),
        "HOUR" => Ok(Value::Int(dt(name, serial0()?)?.hour() as i64)),
        "MINUTE" => Ok(Value::Int(dt(name, serial0()?)?.minute() as i64)),
        "SECOND" => Ok(Value::Int(dt(name, serial0()?)?.second() as i64)),
        "WEEKDAY" => {
            let t = int(1, 1)?;
            let d = dt(name, serial0()?)?.date();
            Ok(Value::Int(match t {
                3 => weekday_from(d, 1) as i64 - 1,
                t => weekday_from(d, week_start_of(name, t)?) as i64,
            }))
        }
        "WEEKNUM" => {
            let t = int(1, 1)?;
            let d = dt(name, serial0()?)?.date();
            if t == 21 {
                return Ok(Value::Int(d.iso_week().week() as i64));
            }
            let start = week_start_of(name, t)?;
            let jan1 = NaiveDate::from_ymd_opt(d.year(), 1, 1).unwrap();
            let offset = (weekday_from(jan1, start) - 1) as i64;
            Ok(Value::Int((d.ordinal0() as i64 + offset) / 7 + 1))
        }
        "EDATE" | "EOMONTH" => {
            let months = int(1, 0)?;
            if arg(0).is_none_or(|v| v.is_blank()) {
                return Ok(Value::Blank);
            }
            let moved = add_months(name, serial0()?, months)?;
            if name == "EDATE" {
                Ok(Value::DateTime(datetime_to_serial(moved)))
            } else {
                let last = NaiveDate::from_ymd_opt(moved.year(), moved.month(), days_in_month(moved.year(), moved.month())).unwrap();
                Ok(Value::DateTime(datetime_to_serial(last.and_time(NaiveTime::MIN))))
            }
        }
        "DATEVALUE" => match arg(0) {
            None | Some(Value::Blank) => Ok(Value::Blank),
            Some(v) => Ok(Value::DateTime(to_serial(name, &Some(v))?.floor())),
        },
        "TIMEVALUE" => match arg(0) {
            None | Some(Value::Blank) => Ok(Value::Blank),
            Some(Value::Str(s)) => time_text_to_fraction(s.trim())
                .or_else(|| text_to_serial(&s).map(|x| x.fract()))
                .map(Value::DateTime)
                .ok_or_else(|| err(ErrorCode::TypeMismatch, format!("TIMEVALUE cannot convert '{s}' to a time."))),
            Some(v) => Ok(Value::DateTime(v.to_f64()?.fract())),
        },
        "NOW" => Ok(Value::DateTime(datetime_to_serial(chrono::Local::now().naive_local()))),
        "UTCNOW" => Ok(Value::DateTime(datetime_to_serial(chrono::Utc::now().naive_utc()))),
        "TODAY" => Ok(Value::DateTime(datetime_to_serial(chrono::Local::now().date_naive().and_time(NaiveTime::MIN)))),
        "UTCTODAY" => Ok(Value::DateTime(datetime_to_serial(chrono::Utc::now().date_naive().and_time(NaiveTime::MIN)))),
        "YEARFRAC" => {
            let (s, e) = (to_serial(name, &arg(0))?, to_serial(name, &arg(1))?);
            Ok(Value::Double(yearfrac(dt(name, s)?.date(), dt(name, e)?.date(), int(2, 0)?)?))
        }
        _ => unreachable!("{name}"),
    }
}

fn networkdays<'a>(ev: &'a Evaluator<'a>, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    let name = "NETWORKDAYS";
    let s = to_serial(name, &Some(ev.scalar(&args[0], env)?))?;
    let e = to_serial(name, &Some(ev.scalar(&args[1], env)?))?;
    let weekend = if args.len() > 2 && !args[2].is_missing() { Some(ev.scalar(&args[2], env)?) } else { None };
    let w = weekend_days(&weekend)?;
    let mut holidays = Vec::new();
    if args.len() > 3 && !args[3].is_missing() {
        let t = ev.table(&args[3], env)?;
        for r in 0..t.nrows() {
            let v = t.value(ev.data, r, 0);
            if !v.is_blank() {
                holidays.push(to_serial(name, &Some(v))?.floor() as i64);
            }
        }
    }
    let (a, b) = (s.floor() as i64, e.floor() as i64);
    let (lo, hi, sign) = if a <= b { (a, b, 1) } else { (b, a, -1) };
    let mut n = 0i64;
    for day in lo..=hi {
        let date = base_date() + chrono::Duration::days(day);
        let idx = date.weekday().num_days_from_monday() as usize;
        if !w[idx] && !holidays.contains(&day) {
            n += 1;
        }
    }
    Ok(Value::Int(sign * n))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn yearfrac_bases() {
        assert!((yearfrac(d(2024, 1, 1), d(2024, 7, 1), 0).unwrap() - 0.5).abs() < 1e-12);
        assert!((yearfrac(d(2024, 1, 1), d(2024, 7, 1), 3).unwrap() - 182.0 / 365.0).abs() < 1e-12);
        assert!((yearfrac(d(2024, 1, 1), d(2024, 7, 1), 2).unwrap() - 182.0 / 360.0).abs() < 1e-12);
        assert!((yearfrac(d(2024, 1, 1), d(2024, 7, 1), 1).unwrap() - 182.0 / 366.0).abs() < 1e-12);
        assert!((yearfrac(d(2024, 1, 31), d(2024, 3, 31), 0).unwrap() - 60.0 / 360.0).abs() < 1e-12);
        assert!((yearfrac(d(2024, 7, 1), d(2024, 1, 1), 0).unwrap() - 0.5).abs() < 1e-12);
    }

    #[test]
    fn week_numbers_and_types() {
        // 2024-01-01 is a Monday
        assert_eq!(weekday_from(d(2024, 1, 1), 0), 2);
        assert_eq!(weekday_from(d(2024, 1, 1), 1), 1);
        assert_eq!(week_start_of("W", 11).unwrap(), 1);
        assert_eq!(week_start_of("W", 17).unwrap(), 0);
    }
}
