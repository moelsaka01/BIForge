//! Math tranche: rounding, trigonometry, logarithms, integer functions and conversions. Arguments are evaluated
//! eagerly; BLANK counts as 0 in numeric arguments (harness: confirm per function), text converts to a number when
//! it parses.

use crate::bind::BExpr;
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, Val};
use crate::functions::{err, eval_args};
use crate::value::{EvalError, VResult, Value, CURRENCY_SCALE};

pub const NAMES: &[&str] = &[
    "ABS", "ACOS", "ACOSH", "ACOT", "ACOTH", "ASIN", "ASINH", "ATAN", "ATANH", "CEILING", "COMBIN", "COMBINA", "CONVERT", "COS", "COSH", "COT", "COTH", "CURRENCY", "DEGREES", "EVEN", "EXP",
    "FACT", "FLOOR", "GCD", "INT", "ISO.CEILING", "LCM", "LN", "LOG", "LOG10", "MOD", "MROUND", "ODD", "PI", "POWER", "QUOTIENT", "RADIANS", "RAND", "RANDBETWEEN", "ROUND", "ROUNDDOWN",
    "ROUNDUP", "SIGN", "SIN", "SINH", "SQRT", "SQRTPI", "TAN", "TANH", "TRUNC",
];

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env).map(Val::S))
}

fn num(v: &Option<Value>) -> VResult<f64> {
    match v {
        None => Ok(0.0),
        Some(v) => v.to_f64(),
    }
}

fn domain(name: &str, what: &str) -> EvalError {
    err(ErrorCode::InvalidValue, format!("The function {name} cannot be applied: {what}."))
}

fn finite(name: &str, x: f64) -> VResult<Value> {
    if x.is_nan() || x.is_infinite() {
        Err(domain(name, "the result is not a finite number"))
    } else {
        Ok(Value::Double(x))
    }
}

/// Rounds to 15 significant digits first, the way the engine's decimal handling hides binary noise (so that
/// 1.005 * 100 rounds like 100.5).
fn norm(y: f64) -> f64 {
    if y == 0.0 || !y.is_finite() {
        return y;
    }
    format!("{y:.14e}").parse().unwrap_or(y)
}

#[derive(Clone, Copy)]
enum Mode {
    Nearest,
    Up,
    Down,
}

fn round_to(x: f64, digits: i32, mode: Mode) -> f64 {
    if digits > 15 {
        return x;
    }
    let p = 10f64.powi(digits.abs());
    let y = norm(if digits >= 0 { x * p } else { x / p });
    let r = match mode {
        Mode::Nearest => y.round(),
        Mode::Up => y.signum() * y.abs().ceil(),
        Mode::Down => y.trunc(),
    };
    if digits >= 0 {
        r / p
    } else {
        r * p
    }
}

/// Keeps Integer / Currency types where the input had them and the result is whole / representable.
fn like(input: &Value, x: f64) -> Value {
    match input {
        Value::Currency(_) => Value::Currency((x * CURRENCY_SCALE as f64).round() as i64),
        Value::Int(_) | Value::Bool(_) | Value::Blank if x.fract() == 0.0 && x.abs() < 9.0e15 => Value::Int(x as i64),
        _ => Value::Double(x),
    }
}

fn int_arg(name: &str, v: &Option<Value>) -> VResult<i64> {
    let f = num(v)?;
    if !f.is_finite() || f.abs() > 9.0e15 {
        return Err(domain(name, "the argument is out of range"));
    }
    Ok(f.trunc() as i64)
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

fn combin(n: u64, k: u64) -> f64 {
    let k = k.min(n - k);
    let mut r = 1f64;
    for i in 1..=k {
        r = r * (n - k + i) as f64 / i as f64;
    }
    r.round()
}

/// Cheap xorshift generator for RAND / RANDBETWEEN (not cryptographic, seeded from the clock).
fn next_random() -> f64 {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<u64> = Cell::new(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(88172645463325252) | 1);
    }
    STATE.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        (x >> 11) as f64 / (1u64 << 53) as f64
    })
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    if name == "CONVERT" {
        let v = ev.scalar(&args[0], env)?;
        let ty = args[1].ident().map(str::to_string).or_else(|| match ev.scalar(&args[1], env) {
            Ok(Value::Str(s)) => Some(s.to_ascii_uppercase()),
            _ => None,
        });
        return convert(&v, ty.as_deref().unwrap_or(""));
    }
    let a = eval_args(ev, args, env)?;
    let x0 = a.first().cloned().flatten();
    let n0 = || num(&a.first().cloned().unwrap_or(None));
    let n1 = || num(&a.get(1).cloned().unwrap_or(None));
    match name {
        "PI" => Ok(Value::Double(std::f64::consts::PI)),
        "ABS" => {
            let v = x0.unwrap_or(Value::Blank).to_number()?;
            Ok(match v {
                Value::Int(i) => i.checked_abs().map(Value::Int).unwrap_or(Value::Double((i as f64).abs())),
                Value::Currency(c) => Value::Currency(c.abs()),
                Value::DateTime(d) => Value::DateTime(d.abs()),
                Value::Blank => Value::Int(0),
                other => Value::Double(other.as_f64().unwrap_or(0.0).abs()),
            })
        }
        "SIGN" => {
            let x = n0()?;
            Ok(Value::Int(if x > 0.0 { 1 } else if x < 0.0 { -1 } else { 0 }))
        }
        "SQRT" => {
            let x = n0()?;
            if x < 0.0 {
                return Err(domain(name, "the argument is negative"));
            }
            Ok(Value::Double(x.sqrt()))
        }
        "SQRTPI" => {
            let x = n0()?;
            if x < 0.0 {
                return Err(domain(name, "the argument is negative"));
            }
            Ok(Value::Double((x * std::f64::consts::PI).sqrt()))
        }
        "EXP" => finite(name, n0()?.exp()),
        "LN" => {
            let x = n0()?;
            if x <= 0.0 {
                return Err(domain(name, "the argument must be positive"));
            }
            Ok(Value::Double(x.ln()))
        }
        "LOG10" => {
            let x = n0()?;
            if x <= 0.0 {
                return Err(domain(name, "the argument must be positive"));
            }
            Ok(Value::Double(x.log10()))
        }
        "LOG" => {
            let x = n0()?;
            let base = if a.len() > 1 && a[1].is_some() { n1()? } else { 10.0 };
            if x <= 0.0 || base <= 0.0 || base == 1.0 {
                return Err(domain(name, "the argument or base is out of range"));
            }
            Ok(Value::Double(x.ln() / base.ln()))
        }
        "POWER" => {
            let (x, y) = (n0()?, n1()?);
            finite(name, x.powf(y))
        }
        "SIN" => finite(name, n0()?.sin()),
        "COS" => finite(name, n0()?.cos()),
        "TAN" => finite(name, n0()?.tan()),
        "COT" => {
            let t = n0()?.tan();
            if t == 0.0 {
                return Err(domain(name, "the argument is 0"));
            }
            finite(name, 1.0 / t)
        }
        "SINH" => finite(name, n0()?.sinh()),
        "COSH" => finite(name, n0()?.cosh()),
        "TANH" => finite(name, n0()?.tanh()),
        "COTH" => {
            let x = n0()?;
            if x == 0.0 {
                return Err(domain(name, "the argument is 0"));
            }
            finite(name, 1.0 / x.tanh())
        }
        "ASIN" | "ACOS" => {
            let x = n0()?;
            if !(-1.0..=1.0).contains(&x) {
                return Err(domain(name, "the argument must be between -1 and 1"));
            }
            Ok(Value::Double(if name == "ASIN" { x.asin() } else { x.acos() }))
        }
        "ATAN" => Ok(Value::Double(n0()?.atan())),
        "ACOT" => Ok(Value::Double(std::f64::consts::FRAC_PI_2 - n0()?.atan())),
        "ASINH" => Ok(Value::Double(n0()?.asinh())),
        "ACOSH" => {
            let x = n0()?;
            if x < 1.0 {
                return Err(domain(name, "the argument must be 1 or more"));
            }
            Ok(Value::Double(x.acosh()))
        }
        "ATANH" => {
            let x = n0()?;
            if x <= -1.0 || x >= 1.0 {
                return Err(domain(name, "the argument must be between -1 and 1"));
            }
            Ok(Value::Double(x.atanh()))
        }
        "ACOTH" => {
            let x = n0()?;
            if x.abs() <= 1.0 {
                return Err(domain(name, "the absolute value must be greater than 1"));
            }
            Ok(Value::Double(0.5 * ((x + 1.0) / (x - 1.0)).ln()))
        }
        "DEGREES" => Ok(Value::Double(n0()?.to_degrees())),
        "RADIANS" => Ok(Value::Double(n0()?.to_radians())),
        "INT" => {
            let v = x0.unwrap_or(Value::Blank).to_number()?;
            let x = v.as_f64().unwrap_or(0.0).floor();
            Ok(if x.abs() < 9.0e15 { Value::Int(x as i64) } else { Value::Double(x) })
        }
        "TRUNC" => {
            let v = x0.unwrap_or(Value::Blank).to_number()?;
            let d = if a.len() > 1 && a[1].is_some() { int_arg(name, &a[1])? as i32 } else { 0 };
            let x = round_to(v.as_f64().unwrap_or(0.0), d, Mode::Down);
            Ok(like(&v, x))
        }
        "ROUND" | "ROUNDUP" | "ROUNDDOWN" => {
            let v = x0.unwrap_or(Value::Blank).to_number()?;
            let d = int_arg(name, &a.get(1).cloned().unwrap_or(None))? as i32;
            let mode = match name {
                "ROUND" => Mode::Nearest,
                "ROUNDUP" => Mode::Up,
                _ => Mode::Down,
            };
            let x = round_to(v.as_f64().unwrap_or(0.0), d, mode);
            Ok(match v {
                Value::Int(_) if d >= 0 => v,
                Value::Int(_) => like(&v, x),
                Value::Currency(_) => like(&v, x),
                _ => Value::Double(x),
            })
        }
        "CEILING" | "FLOOR" | "ISO.CEILING" => {
            let v = x0.unwrap_or(Value::Blank).to_number()?;
            let x = v.as_f64().unwrap_or(0.0);
            let sig = if a.len() > 1 && a[1].is_some() { n1()?.abs() } else { 1.0 };
            if sig == 0.0 {
                return Ok(Value::Double(0.0));
            }
            let q = norm(x / sig);
            let r = if name == "FLOOR" { q.floor() } else { q.ceil() } * sig;
            Ok(like(&v, r))
        }
        "MROUND" => {
            let (x, m) = (n0()?, n1()?);
            if m == 0.0 {
                return Ok(Value::Double(0.0));
            }
            if x * m < 0.0 {
                return Err(domain(name, "the number and multiple must have the same sign"));
            }
            Ok(Value::Double((norm(x / m)).round() * m))
        }
        "EVEN" | "ODD" => {
            let x = n0()?;
            let step = if name == "EVEN" { 2.0 } else { 1.0 };
            let up = x.abs().ceil();
            let mut r = if name == "EVEN" { (up / 2.0).ceil() * 2.0 } else { up };
            if name == "ODD" && r % 2.0 == 0.0 {
                r += 1.0;
            }
            let _ = step;
            Ok(like(&Value::Int(0), x.signum() * r))
        }
        "MOD" => {
            let (va, vb) = (x0.clone().unwrap_or(Value::Blank).to_number()?, a.get(1).cloned().flatten().unwrap_or(Value::Blank).to_number()?);
            let (x, d) = (va.as_f64().unwrap_or(0.0), vb.as_f64().unwrap_or(0.0));
            if d == 0.0 {
                return Err(domain(name, "the divisor is 0"));
            }
            let r = x - d * (x / d).floor();
            Ok(match (&va, &vb) {
                (Value::Int(p), Value::Int(q)) => Value::Int(((p % q) + q) % q),
                _ => Value::Double(r),
            })
        }
        "QUOTIENT" => {
            let (x, d) = (n0()?, n1()?);
            if d == 0.0 {
                return Err(domain(name, "the divisor is 0"));
            }
            Ok(Value::Int((x / d).trunc() as i64))
        }
        "FACT" => {
            let n = n0()?.trunc();
            if n < 0.0 {
                return Err(domain(name, "the argument is negative"));
            }
            if n > 170.0 {
                return Err(domain(name, "the result is too large"));
            }
            let mut r = 1f64;
            for i in 2..=(n as u64) {
                r *= i as f64;
            }
            Ok(if n <= 20.0 { Value::Int(r as i64) } else { Value::Double(r) })
        }
        "COMBIN" | "COMBINA" => {
            let (n, k) = (int_arg(name, &a.first().cloned().unwrap_or(None))?, int_arg(name, &a.get(1).cloned().unwrap_or(None))?);
            if n < 0 || k < 0 || (name == "COMBIN" && k > n) || (name == "COMBINA" && n == 0 && k > 0) {
                return Err(domain(name, "the arguments are out of range"));
            }
            let r = if name == "COMBIN" { combin(n as u64, k as u64) } else if k == 0 { 1.0 } else { combin((n + k - 1) as u64, k as u64) };
            Ok(if r.abs() < 9.0e15 { Value::Int(r as i64) } else { Value::Double(r) })
        }
        "GCD" | "LCM" => {
            let mut acc: Option<u64> = None;
            for v in &a {
                let n = int_arg(name, v)?;
                if n < 0 {
                    return Err(domain(name, "the arguments must not be negative"));
                }
                let n = n as u64;
                acc = Some(match acc {
                    None => n,
                    Some(p) if name == "GCD" => gcd(p, n),
                    Some(p) => {
                        if p == 0 || n == 0 {
                            0
                        } else {
                            p / gcd(p, n) * n
                        }
                    }
                });
            }
            Ok(Value::Int(acc.unwrap_or(0) as i64))
        }
        "CURRENCY" => {
            let x = n0()?;
            Ok(Value::Currency((norm(x * CURRENCY_SCALE as f64)).round() as i64))
        }
        "RAND" => Ok(Value::Double(next_random())),
        "RANDBETWEEN" => {
            let (lo, hi) = (int_arg(name, &a.first().cloned().unwrap_or(None))?, int_arg(name, &a.get(1).cloned().unwrap_or(None))?);
            if lo > hi {
                return Err(domain(name, "the lower bound is greater than the upper bound"));
            }
            Ok(Value::Int(lo + (next_random() * (hi - lo + 1) as f64).floor() as i64))
        }
        _ => unreachable!("{name}"),
    }
}

/// CONVERT(expression, type): INTEGER, DOUBLE, STRING, BOOLEAN, CURRENCY, DATETIME.
fn convert(v: &Value, ty: &str) -> VResult<Value> {
    if v.is_blank() {
        return Ok(Value::Blank);
    }
    match ty {
        "INTEGER" => Ok(Value::Int(round_to(v.to_f64()?, 0, Mode::Nearest) as i64)),
        "DOUBLE" => Ok(Value::Double(v.to_f64()?)),
        "STRING" => Ok(Value::str(&v.to_text())),
        "BOOLEAN" => Ok(Value::Bool(v.to_bool()?)),
        "CURRENCY" => Ok(Value::Currency((norm(v.to_f64()? * CURRENCY_SCALE as f64)).round() as i64)),
        "DATETIME" => match v {
            Value::DateTime(_) => Ok(v.clone()),
            Value::Str(s) => crate::value::parse_datetime_literal(s).map(Value::DateTime).ok_or_else(|| err(ErrorCode::TypeMismatch, format!("Cannot convert value '{s}' of type Text to type Date."))),
            other => Ok(Value::DateTime(other.to_f64()?)),
        },
        other => Err(err(ErrorCode::InvalidParameter, format!("CONVERT: unknown data type '{other}'."))),
    }
}
