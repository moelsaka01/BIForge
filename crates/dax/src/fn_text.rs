//! Text tranche: LEFT, RIGHT, MID, LEN, LOWER, UPPER, TRIM, FIND, SEARCH, REPLACE, SUBSTITUTE, REPT, EXACT,
//! CONCATENATE, CONCATENATEX, COMBINEVALUES, FIXED, FORMAT, VALUE, UNICHAR, UNICODE. BLANK counts as "" in text
//! arguments. Positions are in characters (Unicode scalar values), 1-based.

use crate::bind::{BExpr, BKind};
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, Val};
use crate::functions::{err, eval_args, for_each_row};
use crate::value::{self, serial_to_datetime, EvalError, VResult, Value};
use chrono::{Datelike, Timelike};

pub const NAMES: &[&str] = &[
    "COMBINEVALUES", "CONCATENATE", "CONCATENATEX", "EXACT", "FIND", "FIXED", "FORMAT", "LEFT", "LEN", "LOWER", "MID", "REPLACE", "REPT", "RIGHT", "SEARCH", "SUBSTITUTE", "TRIM", "UNICHAR",
    "UNICODE", "UPPER", "VALUE",
];

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env).map(Val::S))
}

fn text(v: &Option<Value>) -> String {
    v.as_ref().map(|v| v.to_text()).unwrap_or_default()
}

fn count(name: &str, v: &Option<Value>, default: i64) -> VResult<i64> {
    match v {
        None => Ok(default),
        Some(v) => {
            let f = v.to_f64()?;
            if !f.is_finite() || f.abs() > 1.0e9 {
                return Err(err(ErrorCode::InvalidValue, format!("The function {name} cannot use an argument of this size.")));
            }
            Ok(f.round() as i64)
        }
    }
}

/// SEARCH pattern: `?` one character, `*` any run, `~` escapes the next character. Case-insensitive.
fn wildcard_find(find: &[char], within: &[char], start: usize) -> Option<usize> {
    fn matches_at(p: &[char], t: &[char]) -> Option<usize> {
        // returns the matched length of t, shortest match for `*`
        match p.first() {
            None => Some(0),
            Some('*') => {
                for k in 0..=t.len() {
                    if let Some(n) = matches_at(&p[1..], &t[k..]) {
                        return Some(k + n);
                    }
                }
                None
            }
            Some('?') => t.first().and_then(|_| matches_at(&p[1..], &t[1..])).map(|n| n + 1),
            Some('~') if p.len() > 1 => (t.first().map(|c| c.to_lowercase().eq(p[1].to_lowercase())) == Some(true)).then(|| matches_at(&p[2..], &t[1..])).flatten().map(|n| n + 1),
            Some(c) => (t.first().map(|x| x.to_lowercase().eq(c.to_lowercase())) == Some(true)).then(|| matches_at(&p[1..], &t[1..])).flatten().map(|n| n + 1),
        }
    }
    (start..=within.len()).find(|&i| matches_at(find, &within[i..]).is_some())
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    if name == "CONCATENATEX" {
        return concatenatex(ev, args, env);
    }
    let a = eval_args(ev, args, env)?;
    let arg = |i: usize| a.get(i).cloned().flatten();
    let s0 = || text(&arg(0));
    // recorded from Power BI: BLANK in, BLANK out (REPLACE and CONCATENATE treat it as empty text)
    if matches!(name, "LEN" | "LOWER" | "UPPER" | "TRIM" | "LEFT" | "RIGHT" | "MID" | "REPT" | "SUBSTITUTE" | "UNICODE") && matches!(arg(0), Some(Value::Blank)) {
        return Ok(Value::Blank);
    }
    match name {
        "LEN" => Ok(Value::Int(s0().chars().count() as i64)),
        "LOWER" => Ok(Value::str(&s0().to_lowercase())),
        "UPPER" => Ok(Value::str(&s0().to_uppercase())),
        "TRIM" => Ok(Value::str(&s0().split(' ').filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" "))),
        "LEFT" | "RIGHT" => {
            let n = count(name, &arg(1), 1)?;
            if n < 0 {
                return Err(err(ErrorCode::InvalidValue, format!("The second argument of {name} must not be negative.")));
            }
            let ch: Vec<char> = s0().chars().collect();
            let n = (n as usize).min(ch.len());
            Ok(Value::str(&if name == "LEFT" { ch[..n].iter().collect::<String>() } else { ch[ch.len() - n..].iter().collect::<String>() }))
        }
        "MID" => {
            let (start, n) = (count(name, &arg(1), 1)?, count(name, &arg(2), 0)?);
            if start < 1 || n < 0 {
                return Err(err(ErrorCode::InvalidValue, "MID: the start position must be 1 or more and the length must not be negative."));
            }
            let ch: Vec<char> = s0().chars().collect();
            let from = ((start - 1) as usize).min(ch.len());
            let to = (from + n as usize).min(ch.len());
            Ok(Value::str(&ch[from..to].iter().collect::<String>()))
        }
        "REPLACE" => {
            let (start, n) = (count(name, &arg(1), 1)?, count(name, &arg(2), 0)?);
            if start < 1 || n < 0 {
                return Err(err(ErrorCode::InvalidValue, "REPLACE: the start position must be 1 or more and the length must not be negative."));
            }
            let ch: Vec<char> = s0().chars().collect();
            let from = ((start - 1) as usize).min(ch.len());
            let to = (from + n as usize).min(ch.len());
            let mut out: String = ch[..from].iter().collect();
            out.push_str(&text(&arg(3)));
            out.extend(ch[to..].iter());
            Ok(Value::str(&out))
        }
        "SUBSTITUTE" => {
            let (src, old, new) = (s0(), text(&arg(1)), text(&arg(2)));
            if old.is_empty() {
                return Ok(Value::str(&src));
            }
            match arg(3) {
                None => Ok(Value::str(&src.replace(&old, &new))),
                Some(inst) => {
                    let k = inst.to_f64()?.trunc() as i64;
                    if k < 1 {
                        return Err(err(ErrorCode::InvalidValue, "SUBSTITUTE: the instance number must be 1 or more."));
                    }
                    let mut out = String::new();
                    let mut rest = src.as_str();
                    let mut seen = 0;
                    while let Some(pos) = rest.find(&old) {
                        seen += 1;
                        out.push_str(&rest[..pos]);
                        if seen == k {
                            out.push_str(&new);
                        } else {
                            out.push_str(&old);
                        }
                        rest = &rest[pos + old.len()..];
                        if seen == k {
                            break;
                        }
                    }
                    out.push_str(rest);
                    Ok(Value::str(&out))
                }
            }
        }
        "REPT" => {
            let n = count(name, &arg(1), 0)?;
            if n < 0 {
                return Err(err(ErrorCode::InvalidValue, "REPT: the repeat count must not be negative."));
            }
            let s = s0();
            if s.len() as i64 * n > 10_000_000 {
                return Err(err(ErrorCode::InvalidValue, "REPT: the result would be too long."));
            }
            Ok(Value::str(&s.repeat(n as usize)))
        }
        "EXACT" => Ok(Value::Bool(s0() == text(&arg(1)))),
        "CONCATENATE" => {
            if arg(0).is_none_or(|v| v.is_blank()) && arg(1).is_none_or(|v| v.is_blank()) {
                return Ok(Value::Blank);
            }
            Ok(Value::str(&(s0() + &text(&arg(1)))))
        }
        "COMBINEVALUES" => {
            let d = s0();
            Ok(Value::str(&a[1..].iter().map(text).collect::<Vec<_>>().join(&d)))
        }
        "FIND" | "SEARCH" => {
            let find: Vec<char> = text(&arg(0)).chars().collect();
            let within: Vec<char> = text(&arg(1)).chars().collect();
            let start = count(name, &arg(2), 1)?;
            let not_found = arg(3);
            if start < 1 || start as usize > within.len() + 1 {
                return Err(err(ErrorCode::InvalidValue, format!("{name}: the start position is out of range.")));
            }
            let from = (start - 1) as usize;
            let pos = if name == "FIND" {
                (from..=within.len()).find(|&i| within[i..].starts_with(&find))
            } else {
                wildcard_find(&find, &within, from)
            };
            match (pos, not_found) {
                (Some(p), _) => Ok(Value::Int(p as i64 + 1)),
                (None, Some(v)) => Ok(v),
                (None, None) => Err(err(ErrorCode::InvalidValue, format!("The text '{}' cannot be found within the text.", find.iter().collect::<String>()))),
            }
        }
        "UNICHAR" => {
            let n = count(name, &arg(0), 0)?;
            u32::try_from(n).ok().and_then(char::from_u32).map(|c| Value::str(&c.to_string())).ok_or_else(|| err(ErrorCode::InvalidValue, "UNICHAR: not a valid Unicode code point."))
        }
        "UNICODE" => Ok(s0().chars().next().map(|c| Value::Int(c as i64)).unwrap_or(Value::Blank)),
        "FIXED" => {
            let v = arg(0).unwrap_or(Value::Blank).to_f64()?;
            let d = count(name, &arg(1), 2)? as i32;
            let no_commas = arg(2).map(|v| v.to_bool()).transpose()?.unwrap_or(false);
            Ok(Value::str(&fixed(v, d, !no_commas)))
        }
        "VALUE" => match arg(0) {
            None | Some(Value::Blank) => Ok(Value::Blank),
            Some(Value::Str(s)) => parse_value(&s).map(to_number),
            Some(Value::Bool(_)) => Err(EvalError::type_mismatch("Cannot convert value 'TRUE' of type Text to type Number.")),
            Some(v) => v.to_number().map(to_number),
        },
        "FORMAT" => match arg(0) {
            None | Some(Value::Blank) => Ok(Value::str("")),
            Some(v) => format_value(&v, &text(&arg(1))).map(|s| Value::str(&s)),
        },
        _ => unreachable!("{name}"),
    }
}

fn concatenatex<'a>(ev: &'a Evaluator<'a>, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    let src = ev.table(&args[0], env)?;
    let delim = if args.len() > 2 && !args[2].is_missing() { ev.scalar(&args[2], env)?.to_text() } else { String::new() };
    // order by pairs: expression [, ASC|DESC]
    let mut keys: Vec<(&'a BExpr, bool)> = Vec::new();
    let mut i = 3;
    while i < args.len() {
        if args[i].is_missing() {
            i += 1;
            continue;
        }
        let key = &args[i];
        let desc = match args.get(i + 1).map(|a| &a.kind) {
            Some(BKind::Sort(d)) => {
                i += 1;
                *d
            }
            _ => false,
        };
        keys.push((key, desc));
        i += 1;
    }
    let mut rows: Vec<(Vec<Value>, String)> = Vec::new();
    for_each_row(ev, &src, env, |_, e2| {
        let k = keys.iter().map(|(k, _)| ev.scalar(k, e2)).collect::<VResult<Vec<_>>>()?;
        rows.push((k, ev.scalar(&args[1], e2)?.to_text()));
        Ok(true)
    })?;
    if !keys.is_empty() {
        rows.sort_by(|x, y| {
            for (n, (_, desc)) in keys.iter().enumerate() {
                let o = value::sort_cmp(&x.0[n], &y.0[n]);
                let o = if *desc { o.reverse() } else { o };
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            std::cmp::Ordering::Equal
        });
    }
    // recorded from Power BI: over an empty table the result is BLANK
    if rows.is_empty() {
        return Ok(Value::Blank);
    }
    Ok(Value::str(&rows.into_iter().map(|r| r.1).collect::<Vec<_>>().join(&delim)))
}

// ---------------------------------------------------------------------------------------------------------
// Number to text

fn round_half_away(x: f64, digits: i32) -> f64 {
    let p = 10f64.powi(digits.abs());
    let y = if digits >= 0 { x * p } else { x / p };
    let y: f64 = format!("{y:.14e}").parse().unwrap_or(y);
    let r = y.round();
    if digits >= 0 {
        r / p
    } else {
        r * p
    }
}

fn group_thousands(int: &str) -> String {
    let mut out = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// FIXED(number, decimals, commas): rounds, then prints with exactly `decimals` places (none when negative).
fn fixed(x: f64, decimals: i32, commas: bool) -> String {
    let r = round_half_away(x, decimals);
    let places = decimals.max(0) as usize;
    let s = format!("{:.*}", places, r.abs());
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i.to_string(), Some(f.to_string())),
        None => (s, None),
    };
    let int = if commas { group_thousands(&int) } else { int };
    let neg = r < 0.0;
    format!("{}{}{}", if neg { "-" } else { "" }, int, frac.map(|f| format!(".{f}")).unwrap_or_default())
}

#[derive(Default)]
struct NumFormat {
    prefix: String,
    suffix: String,
    int_zeros: usize,
    int_hashes: usize,
    frac_zeros: usize,
    frac_hashes: usize,
    thousands: bool,
    percent: bool,
    sci: Option<(bool, usize)>, // (always show +, min exponent digits)
    has_digits: bool,
}

fn parse_num_format(f: &str) -> NumFormat {
    let mut n = NumFormat::default();
    let ch: Vec<char> = f.chars().collect();
    let mut i = 0;
    let mut seen_point = false;
    let mut in_digits = false;
    let mut lit = String::new();
    let push_lit = |n: &mut NumFormat, lit: &mut String, after: bool| {
        if after {
            n.suffix.push_str(lit);
        } else {
            n.prefix.push_str(lit);
        }
        lit.clear();
    };
    while i < ch.len() {
        let c = ch[i];
        match c {
            '0' | '#' => {
                if !in_digits {
                    { let hd = n.has_digits; push_lit(&mut n, &mut lit, hd); }
                }
                in_digits = true;
                n.has_digits = true;
                match (seen_point, c) {
                    (false, '0') => n.int_zeros += 1,
                    (false, _) => n.int_hashes += 1,
                    (true, '0') => n.frac_zeros += 1,
                    (true, _) => n.frac_hashes += 1,
                }
            }
            '.' if in_digits || !n.has_digits => {
                if !in_digits {
                    { let hd = n.has_digits; push_lit(&mut n, &mut lit, hd); }
                }
                in_digits = true;
                seen_point = true;
            }
            ',' if in_digits => n.thousands = true,
            '%' => {
                n.percent = true;
                lit.push('%');
            }
            'E' | 'e' if in_digits && matches!(ch.get(i + 1), Some('+') | Some('-')) => {
                let plus = ch[i + 1] == '+';
                let mut k = i + 2;
                let mut digits = 0;
                while ch.get(k) == Some(&'0') {
                    digits += 1;
                    k += 1;
                }
                n.sci = Some((plus, digits.max(1)));
                in_digits = false;
                i = k;
                continue;
            }
            '"' => {
                i += 1;
                while i < ch.len() && ch[i] != '"' {
                    lit.push(ch[i]);
                    i += 1;
                }
            }
            '\\' => {
                i += 1;
                if let Some(c) = ch.get(i) {
                    lit.push(*c);
                }
            }
            c => {
                if in_digits {
                    push_lit(&mut n, &mut lit, false);
                    in_digits = false;
                }
                lit.push(c);
            }
        }
        i += 1;
    }
    let after = n.has_digits;
    push_lit(&mut n, &mut lit, after);
    n
}

fn render_number(x: f64, nf: &NumFormat, negative_is_marked: bool) -> String {
    let mut v = x.abs();
    if nf.percent {
        v *= 100.0;
    }
    let places = nf.frac_zeros + nf.frac_hashes;
    let body = if let Some((plus, min_digits)) = nf.sci {
        let exp = if v == 0.0 { 0 } else { v.log10().floor() as i32 };
        let int_digits = (nf.int_zeros + nf.int_hashes).max(1) as i32;
        let e = exp - (int_digits - 1);
        let m = round_half_away(v / 10f64.powi(e), places as i32);
        let m_str = format!("{:.*}", places, m);
        format!("{m_str}E{}{:0w$}", if e < 0 { "-" } else if plus { "+" } else { "" }, e.abs(), w = min_digits)
    } else {
        let r = round_half_away(v, places as i32);
        let s = format!("{:.*}", places, r);
        let (int, frac) = match s.split_once('.') {
            Some((i, f)) => (i.to_string(), f.to_string()),
            None => (s, String::new()),
        };
        let mut int = int.trim_start_matches('0').to_string();
        while int.len() < nf.int_zeros {
            int.insert(0, '0');
        }
        if nf.thousands {
            int = group_thousands(&int);
        }
        let mut frac = frac;
        while frac.len() > nf.frac_zeros && frac.ends_with('0') {
            frac.pop();
        }
        if frac.is_empty() {
            int
        } else {
            format!("{int}.{frac}")
        }
    };
    format!("{}{}{}{}", if negative_is_marked { "-" } else { "" }, nf.prefix, body, nf.suffix)
}

fn format_number(x: f64, fmt: &str) -> VResult<String> {
    let named = match fmt.to_ascii_lowercase().as_str() {
        "general number" | "g" | "" => return Ok(value::format_general(x)),
        "currency" | "c" => Some("$#,##0.00;($#,##0.00)"),
        "fixed" | "f" => Some("0.00"),
        "standard" | "n" => Some("#,##0.00"),
        "percent" | "p" => Some("0.00%"),
        "scientific" | "e" => Some("0.00E+00"),
        "yes/no" => return Ok(if x != 0.0 { "Yes" } else { "No" }.into()),
        "true/false" => return Ok(if x != 0.0 { "True" } else { "False" }.into()),
        "on/off" => return Ok(if x != 0.0 { "On" } else { "Off" }.into()),
        _ => None,
    };
    let fmt = named.unwrap_or(fmt);
    let sections: Vec<&str> = fmt.split(';').collect();
    let (sec, mark_neg) = if x < 0.0 && sections.len() > 1 {
        (sections[1], false)
    } else if x == 0.0 && sections.len() > 2 {
        (sections[2], false)
    } else {
        (sections[0], x < 0.0)
    };
    let nf = parse_num_format(sec);
    if !nf.has_digits {
        return Ok(format!("{}{}", nf.prefix, nf.suffix));
    }
    Ok(render_number(x, &nf, mark_neg && round_half_away(x, (nf.frac_zeros + nf.frac_hashes) as i32) != 0.0))
}

// ---------------------------------------------------------------------------------------------------------
// Dates

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

fn is_date_format(f: &str) -> bool {
    if matches!(f.to_ascii_lowercase().as_str(), "general number" | "currency" | "fixed" | "standard" | "percent" | "scientific" | "yes/no" | "true/false" | "on/off") {
        return false;
    }
    matches!(f.to_ascii_lowercase().as_str(), "general date" | "long date" | "medium date" | "short date" | "long time" | "medium time" | "short time")
        || (!f.contains('0') && !f.contains('#') && f.chars().any(|c| matches!(c, 'y' | 'M' | 'd' | 'h' | 'H' | 's' | 'm')))
}

fn format_date(serial: f64, fmt: &str) -> VResult<String> {
    let dt = serial_to_datetime(serial).ok_or_else(|| err(ErrorCode::InvalidValue, "FORMAT: the date is out of range."))?;
    let fmt = match fmt.to_ascii_lowercase().as_str() {
        "general date" => return Ok(value::format_datetime(serial)),
        "long date" => "dddd, MMMM d, yyyy",
        "medium date" => "dd-MMM-yy",
        "short date" => "M/d/yyyy",
        "long time" => "h:mm:ss tt",
        "medium time" => "hh:mm tt",
        "short time" => "HH:mm",
        _ => fmt,
    };
    let ch: Vec<char> = fmt.chars().collect();
    let h24 = dt.hour();
    let h12 = if h24 % 12 == 0 { 12 } else { h24 % 12 };
    let uses_ampm = fmt.to_ascii_lowercase().contains("am/pm") || fmt.contains("tt") || fmt.contains("A/P");
    let mut out = String::new();
    let mut i = 0;
    let run = |i: usize, c: char| ch[i..].iter().take_while(|&&x| x == c).count();
    while i < ch.len() {
        let c = ch[i];
        match c {
            'y' => {
                let n = run(i, 'y');
                out.push_str(&if n >= 3 { format!("{:04}", dt.year()) } else { format!("{:02}", dt.year() % 100) });
                i += n;
            }
            'M' => {
                let n = run(i, 'M');
                let m = dt.month() as usize;
                out.push_str(&match n {
                    1 => m.to_string(),
                    2 => format!("{m:02}"),
                    3 => MONTHS[m - 1][..3].to_string(),
                    _ => MONTHS[m - 1].to_string(),
                });
                i += n;
            }
            'd' => {
                let n = run(i, 'd');
                let wd = dt.weekday().num_days_from_sunday() as usize;
                out.push_str(&match n {
                    1 => dt.day().to_string(),
                    2 => format!("{:02}", dt.day()),
                    3 => DAYS[wd][..3].to_string(),
                    _ => DAYS[wd].to_string(),
                });
                i += n;
            }
            'h' | 'H' => {
                let n = run(i, c);
                let hour = if c == 'H' || !uses_ampm { h24 } else { h12 };
                out.push_str(&if n == 1 { hour.to_string() } else { format!("{hour:02}") });
                i += n;
            }
            'm' => {
                let n = run(i, 'm');
                out.push_str(&if n == 1 { dt.minute().to_string() } else { format!("{:02}", dt.minute()) });
                i += n;
            }
            's' => {
                let n = run(i, 's');
                out.push_str(&if n == 1 { dt.second().to_string() } else { format!("{:02}", dt.second()) });
                i += n;
            }
            't' if ch.get(i + 1) == Some(&'t') => {
                out.push_str(if h24 < 12 { "AM" } else { "PM" });
                i += 2;
            }
            'A' | 'a' if ch[i..].iter().take(5).collect::<String>().eq_ignore_ascii_case("am/pm") => {
                out.push_str(if h24 < 12 { "AM" } else { "PM" });
                i += 5;
            }
            '"' => {
                i += 1;
                while i < ch.len() && ch[i] != '"' {
                    out.push(ch[i]);
                    i += 1;
                }
                i += 1;
            }
            '\\' => {
                if let Some(c) = ch.get(i + 1) {
                    out.push(*c);
                }
                i += 2;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    Ok(out)
}

/// FORMAT(value, format) for numbers, dates, booleans and text.
pub fn format_value(v: &Value, fmt: &str) -> VResult<String> {
    match v {
        Value::Blank => Ok(String::new()),
        // recorded from Power BI: "<" and ">" leave the text unchanged
        Value::Str(s) => Ok(s.to_string()),
        Value::Bool(b) => Ok(match fmt.to_ascii_lowercase().as_str() {
            "yes/no" => if *b { "Yes" } else { "No" }.into(),
            "on/off" => if *b { "On" } else { "Off" }.into(),
            "" | "general" => if *b { "True" } else { "False" }.into(),
            // a number format sees True as -1 (recorded from Power BI)
            _ => return format_number(if *b { -1.0 } else { 0.0 }, fmt),
        }),
        Value::DateTime(d) if is_date_format(fmt) || fmt.is_empty() => {
            if fmt.is_empty() {
                Ok(value::format_datetime(*d))
            } else {
                format_date(*d, fmt)
            }
        }
        other => {
            let x = other.as_f64().unwrap_or(0.0);
            format_number(x, fmt)
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// VALUE

/// VALUE returns a Number (Double) whatever the text looks like, dates and times included (recorded from Power BI).
fn to_number(v: Value) -> Value {
    match v {
        Value::Int(i) => Value::Double(i as f64),
        Value::DateTime(d) => Value::Double(d),
        other => other,
    }
}

fn parse_value(s: &str) -> VResult<Value> {
    let t = s.trim();
    let bad = || EvalError::type_mismatch(format!("Cannot convert value '{s}' of type Text to type Number."));
    if t.is_empty() {
        return Err(bad());
    }
    let (neg_paren, t2) = if t.starts_with('(') && t.ends_with(')') { (true, &t[1..t.len() - 1]) } else { (false, t) };
    // recorded from Power BI: VALUE("50%") fails
    let (percent, t3) = (false, t2);
    let cleaned: String = t3.trim().trim_start_matches('$').replace(',', "");
    if let Ok(mut x) = cleaned.parse::<f64>() {
        if !x.is_finite() {
            return Err(bad());
        }
        if percent {
            x /= 100.0;
        }
        if neg_paren {
            x = -x;
        }
        return Ok(if x.fract() == 0.0 && x.abs() < 9.0e15 && !percent { Value::Int(x as i64) } else { Value::Double(x) });
    }
    for f in ["%m/%d/%Y", "%Y-%m-%d", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(t, f) {
            return Ok(Value::DateTime(value::datetime_to_serial(dt)));
        }
        if let Ok(d) = chrono::NaiveDate::parse_from_str(t, f) {
            return Ok(Value::DateTime(value::datetime_to_serial(d.and_time(chrono::NaiveTime::MIN))));
        }
    }
    if let Some(f) = crate::fn_date::time_text_to_fraction(t) {
        return Ok(Value::DateTime(f));
    }
    Err(bad())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(x: f64, f: &str) -> String {
        format_number(x, f).unwrap()
    }

    #[test]
    fn number_formats() {
        assert_eq!(n(1234.567, "0.00"), "1234.57");
        assert_eq!(n(1234.567, "#,0"), "1,235");
        assert_eq!(n(1234.5, "#,##0.00"), "1,234.50");
        assert_eq!(n(0.256, "0%"), "26%");
        assert_eq!(n(0.256, "0.0%"), "25.6%");
        assert_eq!(n(5.0, "000"), "005");
        assert_eq!(n(-5.0, "0.0"), "-5.0");
        assert_eq!(n(-1234.5, "Currency"), "($1,234.50)");
        assert_eq!(n(1234.5, "Currency"), "$1,234.50");
        assert_eq!(n(0.5, "#.##"), ".5");
        assert_eq!(n(1234.5, "Standard"), "1,234.50");
        assert_eq!(n(12345.678, "0.00E+00"), "1.23E+04");
        assert_eq!(n(7.0, "\"Qty: \"0"), "Qty: 7");
        assert_eq!(n(3.0, "0;(0);zero"), "3");
        assert_eq!(n(-3.0, "0;(0);zero"), "(3)");
        assert_eq!(n(0.0, "0;(0);zero"), "zero");
        assert_eq!(n(1234.0, "General Number"), "1234");
    }

    #[test]
    fn date_formats() {
        let d = value::date_serial(2024, 3, 5).unwrap() + (14.0 * 3600.0 + 7.0 * 60.0 + 9.0) / 86400.0;
        assert_eq!(format_date(d, "yyyy-MM-dd").unwrap(), "2024-03-05");
        assert_eq!(format_date(d, "dd/MM/yy").unwrap(), "05/03/24");
        assert_eq!(format_date(d, "MMM d, yyyy").unwrap(), "Mar 5, 2024");
        assert_eq!(format_date(d, "dddd MMMM").unwrap(), "Tuesday March");
        assert_eq!(format_date(d, "HH:mm:ss").unwrap(), "14:07:09");
        assert_eq!(format_date(d, "h:mm AM/PM").unwrap(), "2:07 PM");
        assert_eq!(format_date(d, "Short Date").unwrap(), "3/5/2024");
        assert_eq!(format_date(d, "Long Date").unwrap(), "Tuesday, March 5, 2024");
    }

    #[test]
    fn fixed_and_value() {
        assert_eq!(fixed(1234.567, 1, true), "1,234.6");
        assert_eq!(fixed(1234.567, 0, false), "1235");
        assert_eq!(fixed(-0.5, 0, true), "-1");
        assert_eq!(fixed(1234.0, -2, true), "1,200");
        assert_eq!(parse_value("1,234.5").unwrap(), Value::Double(1234.5));
        assert_eq!(parse_value("$12").unwrap(), Value::Int(12));
        assert!(parse_value("50%").is_err());
        assert_eq!(parse_value("(5)").unwrap(), Value::Int(-5));
        assert!(parse_value("abc").is_err());
    }

    #[test]
    fn wildcards() {
        let f = |p: &str, t: &str, s| wildcard_find(&p.chars().collect::<Vec<_>>(), &t.chars().collect::<Vec<_>>(), s);
        assert_eq!(f("b?d", "Abcd bad", 0), Some(1));
        assert_eq!(f("b?d", "Abcd bad", 2), Some(5));
        assert_eq!(f("a*d", "xxabcd", 0), Some(2));
        assert_eq!(f("~?", "what? yes", 0), Some(4));
        assert_eq!(f("zz", "abc", 0), None);
    }
}
