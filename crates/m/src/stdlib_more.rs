//! A few more date/time, number, list and value functions of the M standard library: the hour/minute/second windows
//! ("is in the next 3 hours"), start/end of day, the ToRecord family, rounding away from / toward zero, covariance and
//! nullable equality. Cases: tests/m/stdlib/more.json.
use crate::eval::Ev;
use crate::stdlib::values_equal;
use crate::value::*;

type R<T> = MResult<T>;

pub const MORE_FNS: &[&str] = &[
    "DateTime.IsInNextHour", "DateTime.IsInNextMinute", "DateTime.IsInNextSecond", "DateTime.IsInPreviousHour", "DateTime.IsInPreviousMinute",
    "DateTime.IsInPreviousSecond", "DateTime.IsInNextNHours", "DateTime.IsInNextNMinutes", "DateTime.IsInNextNSeconds",
    "DateTime.IsInPreviousNHours", "DateTime.IsInPreviousNMinutes", "DateTime.IsInPreviousNSeconds", "Date.StartOfDay", "Date.EndOfDay",
    "DateTime.Time", "Date.ToRecord", "DateTime.ToRecord", "Time.ToRecord", "Duration.ToRecord", "Number.RoundAwayFromZero",
    "Number.RoundTowardZero", "List.Covariance", "Value.NullableEquals",
];

const NOW: &str = "CAST(current_localtimestamp() AS TIMESTAMP)";

pub fn call(ev: &Ev, name: &str, a: &[Value]) -> Option<R<Value>> {
    if !MORE_FNS.contains(&name) {
        return None;
    }
    Some(dispatch(ev, name, a))
}

fn dispatch(ev: &Ev, name: &str, a: &[Value]) -> R<Value> {
    let arg = |i: usize| a.get(i).ok_or_else(|| MError::expr(format!("{name}: argument {} is missing.", i + 1)));
    let s = |i: usize| -> R<String> { ev.to_sql(arg(i)?) };
    let sql = |e: String| -> R<Value> { Ok(Value::Sql(e)) };
    if let Some(rest) = name.strip_prefix("DateTime.IsIn") {
        let (next, rest) = match (rest.strip_prefix("Next"), rest.strip_prefix("Previous")) {
            (Some(r), _) => (true, r),
            (_, Some(r)) => (false, r),
            _ => return Err(MError::unsupported(format!("{name} is not supported."))),
        };
        let (n_form, unit) = match rest.strip_prefix('N') {
            Some(u) => (true, u.trim_end_matches('s')),
            None => (false, rest),
        };
        let unit = unit.to_lowercase();
        let step = |k: &str| format!("to_{unit}s(CAST(({k}) AS BIGINT))");
        let d = format!("date_trunc('{unit}', CAST({} AS TIMESTAMP))", s(0)?);
        let t = format!("date_trunc('{unit}', {NOW})");
        return sql(if n_form {
            let n = s(1)?;
            if next {
                format!("({d} >= {t} + {} AND {d} <= {t} + {})", step("1"), step(&n))
            } else {
                format!("({d} >= {t} - {} AND {d} <= {t} - {})", step(&n), step("1"))
            }
        } else if next {
            format!("({d} = {t} + {})", step("1"))
        } else {
            format!("({d} = {t} - {})", step("1"))
        });
    }
    match name {
        "Date.StartOfDay" => sql(format!("date_trunc('day', CAST({} AS TIMESTAMP))", s(0)?)),
        // DuckDB timestamps have microseconds, so the last instant of the day is .999999
        "Date.EndOfDay" => sql(format!("(date_trunc('day', CAST({} AS TIMESTAMP)) + to_microseconds(CAST(86399999999 AS BIGINT)))", s(0)?)),
        "DateTime.Time" => sql(format!("CAST(CAST({} AS TIMESTAMP) AS TIME)", s(0)?)),
        "Date.ToRecord" => {
            let d = format!("CAST({} AS DATE)", s(0)?);
            Ok(Value::Record(vec![
                ("Year".into(), Value::Sql(format!("CAST(year({d}) AS BIGINT)"))),
                ("Month".into(), Value::Sql(format!("CAST(month({d}) AS BIGINT)"))),
                ("Day".into(), Value::Sql(format!("CAST(day({d}) AS BIGINT)"))),
            ]))
        }
        "DateTime.ToRecord" | "Time.ToRecord" => {
            let ts = if name == "Time.ToRecord" { format!("CAST({} AS TIME)", s(0)?) } else { format!("CAST({} AS TIMESTAMP)", s(0)?) };
            let part = |p: &str| Value::Sql(format!("CAST(date_part('{p}', {ts}) AS BIGINT)"));
            let mut fields = Vec::new();
            if name == "DateTime.ToRecord" {
                fields.extend([("Year".to_string(), part("year")), ("Month".to_string(), part("month")), ("Day".to_string(), part("day"))]);
            }
            fields.extend([
                ("Hour".to_string(), part("hour")),
                ("Minute".to_string(), part("minute")),
                ("Second".to_string(), Value::Sql(format!("(CAST(date_part('microsecond', {ts}) AS DOUBLE) / 1000000)"))),
            ]);
            Ok(Value::Record(fields))
        }
        "Duration.ToRecord" => {
            let mut fields = Vec::new();
            for (field, f) in [("Days", "Duration.Days"), ("Hours", "Duration.Hours"), ("Minutes", "Duration.Minutes"), ("Seconds", "Duration.Seconds")] {
                let v = crate::stdlib_date::call(ev, f, a).ok_or_else(|| MError::unsupported(format!("{f} is not supported.")))??;
                fields.push((field.to_string(), v));
            }
            Ok(Value::Record(fields))
        }
        "Number.RoundAwayFromZero" | "Number.RoundTowardZero" => {
            let digits = match a.get(1) {
                Some(Value::Num(n)) => *n as i32,
                None | Some(Value::Null) => 0,
                Some(other) => return Err(MError::expr(format!("{name}: the digits must be a number, found {}.", other.type_name()))),
            };
            let x = s(0)?;
            let m = 10f64.powi(digits);
            // round(…, 6) first: 1.1 * 10 is 11.000000000000002 and must not round up to 12
            let scaled = format!("round(abs({x}) * {m}, 6)");
            let f = if name == "Number.RoundAwayFromZero" { "ceil" } else { "floor" };
            sql(format!("(sign({x}) * {f}({scaled}) / {m})"))
        }
        "List.Covariance" => {
            let nums = |i: usize| -> R<Vec<f64>> {
                match arg(i)? {
                    Value::List(l) => l
                        .iter()
                        .map(|v| match v {
                            Value::Num(n) => Ok(*n),
                            other => Err(MError::expr(format!("{name}: numbers were expected, found {}.", other.type_name()))),
                        })
                        .collect(),
                    other => Err(MError::expr(format!("{name}: a list was expected, found {}.", other.type_name()))),
                }
            };
            let (x, y) = (nums(0)?, nums(1)?);
            if x.len() != y.len() {
                return Err(MError::expr("List.Covariance: the lists must have the same number of items."));
            }
            if x.is_empty() {
                return Ok(Value::Null);
            }
            let n = x.len() as f64;
            let (mx, my) = (x.iter().sum::<f64>() / n, y.iter().sum::<f64>() / n);
            Ok(Value::Num(x.iter().zip(&y).map(|(p, q)| (p - mx) * (q - my)).sum::<f64>() / n))
        }
        "Value.NullableEquals" => {
            let (p, q) = (arg(0)?, arg(1)?);
            if p.is_symbolic() || q.is_symbolic() {
                let (p, q) = (ev.to_sql(p)?, ev.to_sql(q)?);
                return sql(format!("(CASE WHEN ({p}) IS NULL OR ({q}) IS NULL THEN NULL ELSE ({p}) = ({q}) END)"));
            }
            Ok(if matches!(p, Value::Null) || matches!(q, Value::Null) { Value::Null } else { Value::Bool(values_equal(p, q)) })
        }
        _ => Err(MError::unsupported(format!("{name} is not supported yet."))),
    }
}
