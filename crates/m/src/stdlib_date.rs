//! Date and time functions of the M standard library beyond the basics in stdlib.rs: the "is in the current / next / previous
//! day, week, month, quarter, year" family, week numbers, text conversion and the clock. All return SQL, so they work on columns.
//! Weeks start on Sunday (the en-US culture), like Power Query's default. Cases: tests/m/stdlib/date*.json.
use crate::eval::Ev;
use crate::value::*;

type R<T> = MResult<T>;

pub const DATE_FNS: &[&str] = &[
    "Date.IsInCurrentDay", "Date.IsInCurrentWeek", "Date.IsInCurrentMonth", "Date.IsInCurrentQuarter", "Date.IsInCurrentYear",
    "Date.IsInNextDay", "Date.IsInNextWeek", "Date.IsInNextMonth", "Date.IsInNextQuarter", "Date.IsInNextYear",
    "Date.IsInPreviousDay", "Date.IsInPreviousWeek", "Date.IsInPreviousMonth", "Date.IsInPreviousQuarter", "Date.IsInPreviousYear",
    "Date.IsInNextNDays", "Date.IsInNextNWeeks", "Date.IsInNextNMonths", "Date.IsInNextNQuarters", "Date.IsInNextNYears",
    "Date.IsInPreviousNDays", "Date.IsInPreviousNWeeks", "Date.IsInPreviousNMonths", "Date.IsInPreviousNQuarters", "Date.IsInPreviousNYears",
    "Date.IsInYearToDate", "DateTime.IsInCurrentHour", "DateTime.IsInCurrentMinute", "DateTime.IsInCurrentSecond",
    "DateTime.LocalNow", "DateTime.FixedLocalNow", "Date.IsLeapYear", "Date.StartOfWeek", "Date.EndOfWeek", "Date.WeekOfYear",
    "Date.WeekOfMonth", "Date.ToText", "DateTime.ToText", "Date.FromText", "DateTime.FromText",
];

const NOW: &str = "CAST(current_localtimestamp() AS TIMESTAMP)";

/// The first day of the unit that contains `d` (a date expression).
fn start(d: &str, unit: &str) -> String {
    match unit {
        "Day" => format!("CAST({d} AS DATE)"),
        "Week" => format!("(CAST(date_trunc('week', CAST({d} AS DATE) + INTERVAL 1 DAY) AS DATE) - INTERVAL 1 DAY)"),
        "Month" => format!("CAST(date_trunc('month', {d}) AS DATE)"),
        "Quarter" => format!("CAST(date_trunc('quarter', {d}) AS DATE)"),
        _ => format!("CAST(date_trunc('year', {d}) AS DATE)"),
    }
}

/// `n` units after the start expression.
fn plus(s: &str, unit: &str, n: &str) -> String {
    let step = match unit {
        "Day" => format!("to_days({n})"),
        "Week" => format!("to_days(7 * ({n}))"),
        "Month" => format!("to_months({n})"),
        "Quarter" => format!("to_months(3 * ({n}))"),
        _ => format!("to_years({n})"),
    };
    format!("({s} + {step})")
}

/// M's format text ("yyyy-MM-dd", "MMM d, yyyy h:mm tt") as a strftime format; a quoted part is literal.
fn strftime_of(format: &str) -> String {
    let chars: Vec<char> = format.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            i += 1;
            while i < chars.len() && chars[i] != '\'' {
                out.push(chars[i]);
                i += 1;
            }
            i += 1;
            continue;
        }
        let run = chars[i..].iter().take_while(|x| **x == c).count();
        let piece = match (c, run) {
            ('y', 4..) => "%Y",
            ('y', _) => "%y",
            ('M', 4..) => "%B",
            ('M', 3) => "%b",
            ('M', 2) => "%m",
            ('M', _) => "%-m",
            ('d', 4..) => "%A",
            ('d', 3) => "%a",
            ('d', 2) => "%d",
            ('d', _) => "%-d",
            ('H', 2..) => "%H",
            ('H', _) => "%-H",
            ('h', 2..) => "%I",
            ('h', _) => "%-I",
            ('m', 2..) => "%M",
            ('m', _) => "%-M",
            ('s', 2..) => "%S",
            ('s', _) => "%-S",
            ('t', _) => "%p",
            _ => "",
        };
        if piece.is_empty() {
            out.push(c);
            i += 1;
        } else {
            out.push_str(piece);
            i += run;
        }
    }
    out.replace('\'', "''")
}

pub fn call(ev: &Ev, name: &str, a: &[Value]) -> Option<R<Value>> {
    if !DATE_FNS.contains(&name) {
        return None;
    }
    Some(dispatch(ev, name, a))
}

fn dispatch(ev: &Ev, name: &str, a: &[Value]) -> R<Value> {
    let arg = |i: usize| a.get(i).ok_or_else(|| MError::expr(format!("{name}: argument {} is missing.", i + 1)));
    let s = |i: usize| -> R<String> { ev.to_sql(arg(i)?) };
    let sql = |e: String| -> R<Value> { Ok(Value::Sql(e)) };
    let today = format!("CAST({NOW} AS DATE)");
    if let Some(rest) = name.strip_prefix("Date.IsIn") {
        if rest == "YearToDate" {
            let d = s(0)?;
            return sql(format!("(CAST({d} AS DATE) >= {} AND CAST({d} AS DATE) <= {today})", start(&today, "Year")));
        }
        let (kind, unit) = ["Current", "Next", "Previous"]
            .iter()
            .find_map(|k| rest.strip_prefix(k).map(|u| (*k, u)))
            .ok_or_else(|| MError::unsupported(format!("{name} is not supported.")))?;
        let (n_form, unit) = match unit.strip_prefix('N') {
            Some(u) if matches!(kind, "Next" | "Previous") => (true, u.trim_end_matches('s')),
            _ => (false, unit),
        };
        let d = start(&s(0)?, unit);
        let t = start(&today, unit);
        return sql(if n_form {
            let n = s(1)?;
            if kind == "Next" {
                format!("({d} >= {} AND {d} <= {})", plus(&t, unit, "1"), plus(&t, unit, &n))
            } else {
                format!("({d} >= {} AND {d} <= {})", plus(&t, unit, &format!("-({n})")), plus(&t, unit, "-1"))
            }
        } else {
            let k = match kind {
                "Current" => "0",
                "Next" => "1",
                _ => "-1",
            };
            format!("({d} = {})", plus(&t, unit, k))
        });
    }
    match name {
        "DateTime.IsInCurrentHour" | "DateTime.IsInCurrentMinute" | "DateTime.IsInCurrentSecond" => {
            let unit = name.trim_start_matches("DateTime.IsInCurrent").to_lowercase();
            sql(format!("(date_trunc('{unit}', CAST({} AS TIMESTAMP)) = date_trunc('{unit}', {NOW}))", s(0)?))
        }
        "DateTime.LocalNow" | "DateTime.FixedLocalNow" => sql(NOW.into()),
        "Date.IsLeapYear" => {
            let y = format!("year({})", s(0)?);
            sql(format!("({y} % 4 = 0 AND ({y} % 100 <> 0 OR {y} % 400 = 0))"))
        }
        "Date.StartOfWeek" | "Date.EndOfWeek" => {
            let first = match a.get(1) {
                Some(Value::Num(n)) => *n as i64,
                _ => 0,
            };
            let d = format!("CAST({} AS DATE)", s(0)?);
            let back = format!("((dayofweek({d}) - {first} + 7) % 7)");
            if name == "Date.StartOfWeek" {
                sql(format!("CAST({d} - to_days({back}) AS DATE)"))
            } else {
                sql(format!("CAST({d} + to_days(6 - {back}) AS DATE)"))
            }
        }
        "Date.WeekOfYear" | "Date.WeekOfMonth" => {
            let first = match a.get(1) {
                Some(Value::Num(n)) => *n as i64,
                _ => 0,
            };
            let d = format!("CAST({} AS DATE)", s(0)?);
            let (unit, day_of) = if name == "Date.WeekOfYear" { ("year", format!("dayofyear({d})")) } else { ("month", format!("day({d})")) };
            let lead = format!("((dayofweek(date_trunc('{unit}', {d})) - {first} + 7) % 7)");
            sql(format!("CAST(floor(({day_of} - 1 + {lead}) / 7) + 1 AS BIGINT)"))
        }
        "Date.ToText" | "DateTime.ToText" => {
            let fmt = match a.get(1) {
                Some(Value::Text(f)) => strftime_of(f),
                None | Some(Value::Null) => if name == "Date.ToText" { "%-m/%-d/%Y".into() } else { "%-m/%-d/%Y %-I:%M:%S %p".into() },
                _ => return Err(MError::unsupported(format!("{name} needs the format as a text value."))),
            };
            let v = if name == "Date.ToText" { format!("CAST({} AS DATE)", s(0)?) } else { format!("CAST({} AS TIMESTAMP)", s(0)?) };
            sql(format!("strftime({v}, '{fmt}')"))
        }
        "Date.FromText" | "DateTime.FromText" => {
            let t = format!("trim({})", s(0)?);
            let tries = ["%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d", "%d-%b-%Y", "%B %d, %Y", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %I:%M:%S %p", "%Y-%m-%dT%H:%M:%S"];
            let parsed = format!("COALESCE({})", tries.iter().map(|f| format!("try_strptime({t}, '{f}')")).collect::<Vec<_>>().join(", "));
            let body = format!("(CASE WHEN {parsed} IS NULL THEN error('We couldn''t parse the text as a date.') ELSE {parsed} END)");
            sql(if name == "Date.FromText" { format!("CAST({body} AS DATE)") } else { body })
        }
        _ => Err(MError::unsupported(format!("{name} is not supported yet."))),
    }
}
