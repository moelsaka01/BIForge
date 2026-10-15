//! DAX scalar values and their operators.
//!
//! Rules implemented here come from Microsoft's public DAX documentation ("Data types in DAX", "Handling
//! blanks", operator reference). Items marked "harness" are to be confirmed with recorded cases.
//! - BLANK in arithmetic: BLANK+BLANK=BLANK, BLANK+5=5, 5-BLANK=5, BLANK-5=-5, BLANK*5=BLANK,
//!   BLANK/BLANK=BLANK, BLANK/5=BLANK, 5/BLANK=+Infinity, 0/BLANK=NaN (x/0 likewise).
//! - BLANK in logic: TRUE||BLANK=TRUE, FALSE||BLANK=FALSE, TRUE&&BLANK=FALSE, FALSE&&BLANK=FALSE,
//!   BLANK||BLANK=BLANK, BLANK&&BLANK=BLANK.
//! - `=` treats BLANK as equal to 0, "" and FALSE; `==` only matches BLANK with BLANK.
//! - Text comparison ignores case. Comparing text with a number (or boolean with number) is an error.
//! - Result types: Integer+-*Integer=Integer (Real on overflow); any division gives Real except
//!   Currency/number=Currency; Currency mixed with Integer stays Currency, with Real gives Real for +- and
//!   Currency for * (harness); Date+-number=Date; Date-Date=Date (a duration shown as a date).

use crate::diag::ErrorCode;
use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use std::cmp::Ordering;
use std::fmt;
use std::sync::Arc;

/// Days between 1899-12-30 (serial 0) and 1970-01-01.
const UNIX_EPOCH_SERIAL: f64 = 25569.0;
pub const CURRENCY_SCALE: i64 = 10_000;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Blank,
    Bool(bool),
    Int(i64),
    Double(f64),
    /// Fixed decimal: value times 10,000.
    Currency(i64),
    Str(Arc<str>),
    /// OLE automation date: days since 1899-12-30, time as the fraction.
    DateTime(f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct EvalError {
    pub code: ErrorCode,
    pub message: String,
}

impl EvalError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> EvalError {
        EvalError { code, message: message.into() }
    }
    pub fn eval(message: impl Into<String>) -> EvalError {
        EvalError::new(ErrorCode::Evaluation, message)
    }
    pub fn type_mismatch(message: impl Into<String>) -> EvalError {
        EvalError::new(ErrorCode::TypeMismatch, message)
    }
}

impl fmt::Display for EvalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for EvalError {}

pub type VResult<T> = Result<T, EvalError>;

/// Hashable identity of a value, used by filters, VALUES and grouping. Numbers of any type with the same
/// numeric value are one key; text keys ignore case (the storage engine's default collation).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Key {
    Blank,
    Bool(bool),
    Int(i64),
    Float(u64),
    Str(Box<str>),
}

impl Value {
    pub fn str(s: &str) -> Value {
        Value::Str(Arc::from(s))
    }
    pub fn is_blank(&self) -> bool {
        matches!(self, Value::Blank)
    }
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Blank => "Blank",
            Value::Bool(_) => "True/False",
            Value::Int(_) => "Integer",
            Value::Double(_) => "Number",
            Value::Currency(_) => "Currency",
            Value::Str(_) => "Text",
            Value::DateTime(_) => "Date",
        }
    }
    fn is_numeric(&self) -> bool {
        matches!(self, Value::Int(_) | Value::Double(_) | Value::Currency(_) | Value::DateTime(_))
    }

    pub fn key(&self) -> Key {
        match self {
            Value::Blank => Key::Blank,
            Value::Bool(b) => Key::Bool(*b),
            Value::Str(s) => Key::Str(s.to_lowercase().into_boxed_str()),
            Value::Int(i) => Key::Int(*i),
            other => num_key(other.as_f64().unwrap_or(0.0)),
        }
    }

    /// Numeric value for numbers and dates; booleans count as 1/0, BLANK as 0. Text is not converted here.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Blank => Some(0.0),
            Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Value::Int(i) => Some(*i as f64),
            Value::Double(d) | Value::DateTime(d) => Some(*d),
            Value::Currency(c) => Some(*c as f64 / CURRENCY_SCALE as f64),
            Value::Str(_) => None,
        }
    }

    /// Implicit conversion to a number (text is parsed), as arithmetic does.
    pub fn to_number(&self) -> VResult<Value> {
        match self {
            Value::Str(s) => parse_number_text(s).ok_or_else(|| {
                EvalError::type_mismatch(format!("Cannot convert value '{s}' of type Text to type Number."))
            }),
            Value::Bool(b) => Ok(Value::Int(*b as i64)),
            v => Ok(v.clone()),
        }
    }

    pub fn to_f64(&self) -> VResult<f64> {
        Ok(self.to_number()?.as_f64().unwrap_or(0.0))
    }

    /// Truthiness for IF, FILTER and logical operators. BLANK is FALSE; numbers are TRUE unless 0.
    pub fn to_bool(&self) -> VResult<bool> {
        match self {
            Value::Blank => Ok(false),
            Value::Bool(b) => Ok(*b),
            Value::Str(s) => match s.to_ascii_lowercase().as_str() {
                "true" => Ok(true),
                "false" => Ok(false),
                _ => Err(EvalError::type_mismatch(format!("Cannot convert value '{s}' of type Text to type True/False."))),
            },
            v => Ok(v.as_f64().unwrap_or(0.0) != 0.0),
        }
    }

    /// Text form used by `&`, CONCATENATE and conversion to text (en-US).
    pub fn to_text(&self) -> String {
        match self {
            Value::Blank => String::new(),
            Value::Bool(b) => if *b { "True" } else { "False" }.into(),
            Value::Int(i) => i.to_string(),
            Value::Double(d) => format_general(*d),
            Value::Currency(c) => format_general(*c as f64 / CURRENCY_SCALE as f64),
            Value::Str(s) => s.to_string(),
            Value::DateTime(d) => format_datetime(*d),
        }
    }
}

fn num_key(f: f64) -> Key {
    if f.fract() == 0.0 && f.abs() < 9.0e18 {
        Key::Int(f as i64)
    } else {
        Key::Float(if f == 0.0 { 0f64.to_bits() } else { f.to_bits() })
    }
}

fn parse_number_text(s: &str) -> Option<Value> {
    let t = s.trim();
    if t.is_empty() {
        return Some(Value::Blank);
    }
    if let Ok(i) = t.parse::<i64>() {
        return Some(Value::Int(i));
    }
    t.parse::<f64>().ok().filter(|f| f.is_finite()).map(Value::Double)
}

/// "General" number format: up to 15 significant digits, no trailing zeros, scientific notation when the
/// exponent is 15 or more or below -5.
pub fn format_general(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let sci = format!("{:.14e}", x);
    let (mant, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    if !(-5..15).contains(&exp) {
        let m = trim_zeros(mant);
        return format!("{m}E{}{:02}", if exp < 0 { "-" } else { "+" }, exp.abs());
    }
    let rounded: f64 = format!("{:.14e}", x).parse().unwrap();
    trim_zeros(&format!("{:.*}", (14 - exp).max(0) as usize, rounded))
}

fn trim_zeros(s: &str) -> String {
    if !s.contains('.') {
        return s.to_string();
    }
    let t = s.trim_end_matches('0').trim_end_matches('.');
    if t == "-0" { "0".into() } else { t.to_string() }
}

pub fn serial_to_datetime(serial: f64) -> Option<NaiveDateTime> {
    if !serial.is_finite() {
        return None;
    }
    let days = serial.floor();
    let secs = ((serial - days) * 86400.0).round() as i64;
    let base = NaiveDate::from_ymd_opt(1899, 12, 30)?;
    let date = base.checked_add_signed(chrono::Duration::days(days as i64))?;
    Some(date.and_time(NaiveTime::MIN) + chrono::Duration::seconds(secs))
}

pub fn datetime_to_serial(dt: NaiveDateTime) -> f64 {
    let base = NaiveDate::from_ymd_opt(1899, 12, 30).unwrap().and_time(NaiveTime::MIN);
    let d = dt - base;
    d.num_seconds() as f64 / 86400.0
}

pub fn date_serial(y: i32, m: u32, d: u32) -> Option<f64> {
    NaiveDate::from_ymd_opt(y, m, d).map(|nd| datetime_to_serial(nd.and_time(NaiveTime::MIN)))
}

/// Unix epoch microseconds to a serial date (used when loading TIMESTAMP columns).
pub fn micros_to_serial(us: i64) -> f64 {
    us as f64 / 86_400_000_000.0 + UNIX_EPOCH_SERIAL
}

/// en-US default text for a date: "M/D/YYYY" plus " h:mm:ss AM" when there is a time part (harness).
pub fn format_datetime(serial: f64) -> String {
    match serial_to_datetime(serial) {
        None => format_general(serial),
        Some(dt) => {
            let date = format!("{}/{}/{}", dt.month(), dt.day(), dt.year());
            if dt.time() == NaiveTime::MIN {
                date
            } else {
                let h = dt.hour();
                let (h12, ampm) = match h {
                    0 => (12, "AM"),
                    1..=11 => (h, "AM"),
                    12 => (12, "PM"),
                    _ => (h - 12, "PM"),
                };
                format!("{date} {h12}:{:02}:{:02} {ampm}", dt.minute(), dt.second())
            }
        }
    }
}

/// Parses `dt"..."` literal text: `YYYY-MM-DD` with optional `Thh:mm[:ss]` or ` hh:mm[:ss]`.
pub fn parse_datetime_literal(s: &str) -> Option<f64> {
    let s = s.trim();
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, f) {
            return Some(datetime_to_serial(dt));
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| datetime_to_serial(d.and_time(NaiveTime::MIN)))
}

// ---------------------------------------------------------------------------------------------------------
// Comparison

fn cmp_text(a: &str, b: &str) -> Ordering {
    let la = a.to_lowercase();
    let lb = b.to_lowercase();
    la.cmp(&lb)
}

/// Orders two values for `<`, `>`, `=`: BLANK takes the "zero" of the other side's type.
pub fn compare(a: &Value, b: &Value) -> VResult<Ordering> {
    use Value::*;
    Ok(match (a, b) {
        (Blank, Blank) => Ordering::Equal,
        (Str(x), Str(y)) => cmp_text(x, y),
        (Str(x), Blank) => cmp_text(x, ""),
        (Blank, Str(y)) => cmp_text("", y),
        (Bool(x), Bool(y)) => x.cmp(y),
        (Bool(x), Blank) => x.cmp(&false),
        (Blank, Bool(y)) => false.cmp(y),
        (Int(x), Int(y)) => x.cmp(y),
        (Currency(x), Currency(y)) => x.cmp(y),
        (x, y) if (x.is_numeric() || x.is_blank()) && (y.is_numeric() || y.is_blank()) => {
            let (p, q) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            p.partial_cmp(&q).unwrap_or(if p.is_nan() && q.is_nan() { Ordering::Equal } else if p.is_nan() { Ordering::Less } else { Ordering::Greater })
        }
        (x, y) => {
            return Err(EvalError::type_mismatch(format!(
                "DAX comparison operations do not support comparing values of type {} with values of type {}. Consider using the VALUE or FORMAT function to convert one of the values.",
                x.type_name(),
                y.type_name()
            )))
        }
    })
}

/// `==`: like `=`, except BLANK only equals BLANK.
pub fn strict_eq(a: &Value, b: &Value) -> VResult<bool> {
    match (a, b) {
        (Value::Blank, Value::Blank) => Ok(true),
        (Value::Blank, _) | (_, Value::Blank) => Ok(false),
        _ => Ok(compare(a, b)? == Ordering::Equal),
    }
}

/// Total order used for sorting results (ORDER BY, TOPN ties, sorted output): BLANK first, then
/// booleans, numbers/dates, text. Never fails.
pub fn sort_cmp(a: &Value, b: &Value) -> Ordering {
    fn rank(v: &Value) -> u8 {
        match v {
            Value::Blank => 0,
            Value::Bool(_) => 1,
            Value::Int(_) | Value::Double(_) | Value::Currency(_) | Value::DateTime(_) => 2,
            Value::Str(_) => 3,
        }
    }
    match (rank(a), rank(b)) {
        (x, y) if x != y => x.cmp(&y),
        _ => compare(a, b).unwrap_or(Ordering::Equal),
    }
}

// ---------------------------------------------------------------------------------------------------------
// Arithmetic

#[derive(Clone, Copy, PartialEq, Eq)]
enum NumKind {
    Int,
    Currency,
    Double,
    Date,
}

fn kind(v: &Value) -> NumKind {
    match v {
        Value::Int(_) | Value::Bool(_) | Value::Blank => NumKind::Int,
        Value::Currency(_) => NumKind::Currency,
        Value::DateTime(_) => NumKind::Date,
        _ => NumKind::Double,
    }
}

fn currency_of(f: f64) -> Value {
    Value::Currency((f * CURRENCY_SCALE as f64).round() as i64)
}

fn from_kind(k: NumKind, f: f64) -> Value {
    match k {
        NumKind::Double => Value::Double(f),
        NumKind::Currency => currency_of(f),
        NumKind::Date => Value::DateTime(f),
        NumKind::Int => Value::Double(f),
    }
}

pub fn add(a: &Value, b: &Value) -> VResult<Value> {
    addsub(a, b, false)
}
pub fn sub(a: &Value, b: &Value) -> VResult<Value> {
    addsub(a, b, true)
}

fn addsub(a: &Value, b: &Value, minus: bool) -> VResult<Value> {
    if a.is_blank() && b.is_blank() {
        return Ok(Value::Blank);
    }
    let (a, b) = (a.to_number()?, b.to_number()?);
    if matches!(a, Value::Int(_) | Value::Blank) && matches!(b, Value::Int(_) | Value::Blank) {
        let x = if let Value::Int(x) = a { x } else { 0 };
        let y = if let Value::Int(y) = b { y } else { 0 };
        let r = if minus { x.checked_sub(y) } else { x.checked_add(y) };
        return Ok(r.map(Value::Int).unwrap_or_else(|| Value::Double(if minus { x as f64 - y as f64 } else { x as f64 + y as f64 })));
    }
    if let (Value::Currency(x), Value::Currency(y)) = (&a, &b) {
        return Ok(Value::Currency(if minus { x - y } else { x + y }));
    }
    let (ka, kb) = (kind(&a), kind(&b));
    let k = if ka == NumKind::Date || kb == NumKind::Date {
        NumKind::Date
    } else if ka == NumKind::Double || kb == NumKind::Double {
        NumKind::Double
    } else {
        NumKind::Currency
    };
    let (x, y) = (a.as_f64().unwrap(), b.as_f64().unwrap());
    Ok(from_kind(k, if minus { x - y } else { x + y }))
}

pub fn mul(a: &Value, b: &Value) -> VResult<Value> {
    if a.is_blank() || b.is_blank() {
        return Ok(Value::Blank);
    }
    let (a, b) = (a.to_number()?, b.to_number()?);
    if let (Value::Int(x), Value::Int(y)) = (&a, &b) {
        return Ok(x.checked_mul(*y).map(Value::Int).unwrap_or(Value::Double(*x as f64 * *y as f64)));
    }
    let (ka, kb) = (kind(&a), kind(&b));
    let k = if ka == NumKind::Currency || kb == NumKind::Currency {
        NumKind::Currency
    } else {
        NumKind::Double
    };
    Ok(from_kind(k, a.as_f64().unwrap() * b.as_f64().unwrap()))
}

pub fn div(a: &Value, b: &Value) -> VResult<Value> {
    if a.is_blank() {
        return Ok(Value::Blank);
    }
    let (a, b) = (a.to_number()?, b.to_number()?);
    let x = a.as_f64().unwrap();
    let y = b.as_f64().unwrap();
    let k = if kind(&a) == NumKind::Currency && kind(&b) != NumKind::Currency { NumKind::Currency } else { NumKind::Double };
    if y == 0.0 {
        let r = if x == 0.0 || x.is_nan() { f64::NAN } else if x > 0.0 { f64::INFINITY } else { f64::NEG_INFINITY };
        return Ok(Value::Double(r));
    }
    Ok(from_kind(k, x / y))
}

pub fn pow(a: &Value, b: &Value) -> VResult<Value> {
    if a.is_blank() && b.is_blank() {
        return Ok(Value::Blank);
    }
    let (x, y) = (a.to_f64()?, b.to_f64()?);
    Ok(Value::Double(x.powf(y)))
}

pub fn neg(a: &Value) -> VResult<Value> {
    Ok(match a.to_number()? {
        Value::Blank => Value::Blank,
        Value::Int(i) => i.checked_neg().map(Value::Int).unwrap_or(Value::Double(-(i as f64))),
        Value::Currency(c) => Value::Currency(-c),
        Value::Double(d) => Value::Double(-d),
        Value::DateTime(d) => Value::DateTime(-d),
        other => other,
    })
}

pub fn concat(a: &Value, b: &Value) -> Value {
    if a.is_blank() && b.is_blank() {
        return Value::Blank;
    }
    Value::str(&(a.to_text() + &b.to_text()))
}

/// `&&` with BLANK semantics.
pub fn and(a: &Value, b: &Value) -> VResult<Value> {
    if a.is_blank() && b.is_blank() {
        return Ok(Value::Blank);
    }
    Ok(Value::Bool(a.to_bool()? && b.to_bool()?))
}

/// `||` with BLANK semantics.
pub fn or(a: &Value, b: &Value) -> VResult<Value> {
    if a.is_blank() && b.is_blank() {
        return Ok(Value::Blank);
    }
    Ok(Value::Bool(a.to_bool()? || b.to_bool()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use Value::*;

    fn s(x: &str) -> Value {
        Value::str(x)
    }

    #[test]
    fn blank_arithmetic_table() {
        assert_eq!(add(&Blank, &Blank).unwrap(), Blank);
        assert_eq!(add(&Blank, &Int(5)).unwrap(), Int(5));
        assert_eq!(sub(&Int(5), &Blank).unwrap(), Int(5));
        assert_eq!(sub(&Blank, &Int(5)).unwrap(), Int(-5));
        assert_eq!(mul(&Blank, &Int(5)).unwrap(), Blank);
        assert_eq!(div(&Blank, &Blank).unwrap(), Blank);
        assert_eq!(div(&Blank, &Int(5)).unwrap(), Blank);
        assert_eq!(div(&Int(5), &Blank).unwrap(), Double(f64::INFINITY));
        assert_eq!(div(&Int(-5), &Int(0)).unwrap(), Double(f64::NEG_INFINITY));
        assert!(matches!(div(&Int(0), &Blank).unwrap(), Double(d) if d.is_nan()));
    }

    #[test]
    fn blank_logic_table() {
        let t = Bool(true);
        let f = Bool(false);
        assert_eq!(or(&f, &Blank).unwrap(), f);
        assert_eq!(and(&f, &Blank).unwrap(), f);
        assert_eq!(or(&t, &Blank).unwrap(), t);
        assert_eq!(and(&t, &Blank).unwrap(), f);
        assert_eq!(or(&Blank, &Blank).unwrap(), Blank);
        assert_eq!(and(&Blank, &Blank).unwrap(), Blank);
    }

    #[test]
    fn equality_and_strict_equality_with_blank() {
        assert_eq!(compare(&Blank, &Int(0)).unwrap(), Ordering::Equal);
        assert_eq!(compare(&Blank, &s("")).unwrap(), Ordering::Equal);
        assert_eq!(compare(&Blank, &Bool(false)).unwrap(), Ordering::Equal);
        assert!(!strict_eq(&Blank, &Int(0)).unwrap());
        assert!(!strict_eq(&Blank, &s("")).unwrap());
        assert!(strict_eq(&Blank, &Blank).unwrap());
        assert!(strict_eq(&Int(2), &Double(2.0)).unwrap());
        assert_eq!(compare(&Blank, &Int(1)).unwrap(), Ordering::Less);
        assert_eq!(compare(&Blank, &Int(-1)).unwrap(), Ordering::Greater);
    }

    #[test]
    fn text_comparison_ignores_case_and_mixed_types_fail() {
        assert_eq!(compare(&s("Red"), &s("RED")).unwrap(), Ordering::Equal);
        assert_eq!(compare(&s("apple"), &s("Banana")).unwrap(), Ordering::Less);
        assert_eq!(compare(&s("1"), &Int(1)).unwrap_err().code, ErrorCode::TypeMismatch);
        assert_eq!(compare(&Bool(true), &Int(1)).unwrap_err().code, ErrorCode::TypeMismatch);
        assert_eq!(compare(&DateTime(45000.0), &Int(45000)).unwrap(), Ordering::Equal);
        assert_eq!(s("Red").key(), s("red").key());
        assert_eq!(Int(3).key(), Double(3.0).key());
        assert_ne!(Blank.key(), Int(0).key());
    }

    #[test]
    fn result_types() {
        assert_eq!(add(&Int(1), &Int(2)).unwrap(), Int(3));
        assert_eq!(add(&Int(i64::MAX), &Int(1)).unwrap(), Double(i64::MAX as f64 + 1.0));
        assert_eq!(div(&Int(1), &Int(2)).unwrap(), Double(0.5));
        assert_eq!(div(&Int(4), &Int(2)).unwrap(), Double(2.0));
        assert_eq!(add(&Int(1), &Double(0.5)).unwrap(), Double(1.5));
        assert_eq!(add(&Currency(15000), &Int(1)).unwrap(), Currency(25000));
        assert_eq!(mul(&Currency(15000), &Int(2)).unwrap(), Currency(30000));
        assert_eq!(div(&Currency(30000), &Currency(15000)).unwrap(), Double(2.0));
        assert_eq!(add(&DateTime(45000.0), &Int(1)).unwrap(), DateTime(45001.0));
        assert_eq!(sub(&DateTime(45010.0), &DateTime(45000.0)).unwrap(), DateTime(10.0));
        assert_eq!(pow(&Int(2), &Int(10)).unwrap(), Double(1024.0));
        assert_eq!(neg(&Int(3)).unwrap(), Int(-3));
    }

    #[test]
    fn implicit_text_and_boolean_conversion() {
        assert_eq!(add(&s("1"), &Int(1)).unwrap(), Int(2));
        assert_eq!(add(&s("1.5"), &Int(1)).unwrap(), Double(2.5));
        assert_eq!(add(&Bool(true), &Int(1)).unwrap(), Int(2));
        assert_eq!(add(&s("a"), &Int(1)).unwrap_err().code, ErrorCode::TypeMismatch);
        assert_eq!(concat(&Int(1), &s("a")), s("1a"));
        assert_eq!(concat(&Blank, &s("a")), s("a"));
        assert_eq!(concat(&Blank, &Blank), Blank);
        assert_eq!(concat(&Bool(true), &Double(0.1 + 0.2)), s("True0.3"));
        assert!(Int(2).to_bool().unwrap());
        assert!(!Blank.to_bool().unwrap());
    }

    #[test]
    fn text_forms() {
        assert_eq!(format_general(1504210000000.0), "1504210000000");
        assert_eq!(format_general(1.0 / 3.0), "0.333333333333333");
        assert_eq!(format_general(1e15), "1E+15");
        assert_eq!(format_general(-1.5e-7), "-1.5E-07");
        let d = date_serial(2024, 1, 5).unwrap();
        assert_eq!(DateTime(d).to_text(), "1/5/2024");
        assert_eq!(DateTime(d + 0.5).to_text(), "1/5/2024 12:00:00 PM");
        assert_eq!(parse_datetime_literal("2024-01-05"), Some(d));
        assert_eq!(parse_datetime_literal("2024-01-05T06:00:00"), Some(d + 0.25));
        assert_eq!(date_serial(1899, 12, 30), Some(0.0));
        assert_eq!(date_serial(1900, 3, 1), Some(61.0));
    }

    #[test]
    fn sort_order_puts_blank_first() {
        let mut v = vec![s("b"), Int(2), Blank, s("A"), Int(-1)];
        v.sort_by(sort_cmp);
        assert_eq!(v, vec![Blank, Int(-1), Int(2), s("A"), s("b")]);
    }
}
