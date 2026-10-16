//! Statistical tranche: MEDIAN, GEOMEAN, PERCENTILE.INC/EXC, STDEV.S/P, VAR.S/P and their X forms, RANKX, RANK.EQ,
//! and the distribution functions (NORM*, T*, CHISQ*, BETA*, EXPON, POISSON, CONFIDENCE*).
//!
//! Distribution functions are computed with the regularized incomplete gamma and beta functions (series and
//! continued fractions, about 1e-14 relative accuracy); inverses solve cdf(x) = p by bracketing and bisection.
//! Aggregates over a column ignore BLANK and non-numeric values; with no numeric value they return BLANK
//! (harness: a sample statistic over one value).

use crate::bind::{BExpr, BKind};
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, Val};
use crate::functions::{col_arg, column_values, err, eval_args, for_each_row};
use crate::value::{self, EvalError, VResult, Value};
use std::cmp::Ordering;

pub const NAMES: &[&str] = &[
    "BETA.DIST", "BETA.INV", "CHISQ.DIST", "CHISQ.DIST.RT", "CHISQ.INV", "CHISQ.INV.RT", "CONFIDENCE.NORM", "CONFIDENCE.T", "EXPON.DIST", "GEOMEAN", "GEOMEANX", "MEDIAN", "MEDIANX", "NORM.DIST",
    "NORM.INV", "NORM.S.DIST", "NORM.S.INV", "PERCENTILE.EXC", "PERCENTILE.INC", "PERCENTILEX.EXC", "PERCENTILEX.INC", "POISSON.DIST", "RANK.EQ", "RANKX", "STDEV.P", "STDEV.S", "STDEVX.P",
    "STDEVX.S", "T.DIST", "T.DIST.2T", "T.DIST.RT", "T.INV", "T.INV.2T", "VAR.P", "VAR.S", "VARX.P", "VARX.S",
];

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env).map(Val::S))
}

// ---------------------------------------------------------------------------------------------------------
// Special functions

const EPS: f64 = 1e-16;
const FPMIN: f64 = 1e-300;

pub fn ln_gamma(x: f64) -> f64 {
    const COF: [f64; 14] = [
        57.1562356658629235,
        -59.5979603554754912,
        14.1360979747417471,
        -0.491913816097620199,
        0.339946499848118887e-4,
        0.465236289270485756e-4,
        -0.983744753048795646e-4,
        0.158088703224912494e-3,
        -0.210264441724104883e-3,
        0.217439618115212643e-3,
        -0.164318106536763890e-3,
        0.844182239838527433e-4,
        -0.261908384015814087e-4,
        0.368991826595316234e-5,
    ];
    let mut y = x;
    let mut tmp = x + 5.24218750000000000;
    tmp = (x + 0.5) * tmp.ln() - tmp;
    let mut ser = 0.999999999999997092;
    for c in COF {
        y += 1.0;
        ser += c / y;
    }
    tmp + (2.5066282746310005 * ser / x).ln()
}

/// Regularized lower incomplete gamma P(a, x).
pub fn gamma_p(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x < a + 1.0 {
        let mut ap = a;
        let mut sum = 1.0 / a;
        let mut del = sum;
        for _ in 0..100_000 {
            ap += 1.0;
            del *= x / ap;
            sum += del;
            if del.abs() < sum.abs() * EPS {
                break;
            }
        }
        sum * (-x + a * x.ln() - ln_gamma(a)).exp()
    } else {
        1.0 - gamma_q_cf(a, x)
    }
}

fn gamma_q_cf(a: f64, x: f64) -> f64 {
    let mut b = x + 1.0 - a;
    let mut c = 1.0 / FPMIN;
    let mut d = 1.0 / b;
    let mut h = d;
    for i in 1..100_000 {
        let an = -(i as f64) * (i as f64 - a);
        b += 2.0;
        d = an * d + b;
        if d.abs() < FPMIN {
            d = FPMIN;
        }
        c = b + an / c;
        if c.abs() < FPMIN {
            c = FPMIN;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < EPS {
            break;
        }
    }
    (-x + a * x.ln() - ln_gamma(a)).exp() * h
}

/// Regularized upper incomplete gamma Q(a, x).
pub fn gamma_q(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        1.0
    } else if x < a + 1.0 {
        1.0 - gamma_p(a, x)
    } else {
        gamma_q_cf(a, x)
    }
}

fn erfc(x: f64) -> f64 {
    if x == 0.0 {
        1.0
    } else if x > 0.0 {
        gamma_q(0.5, x * x)
    } else {
        1.0 + gamma_p(0.5, x * x)
    }
}

pub fn norm_cdf(z: f64) -> f64 {
    0.5 * erfc(-z / std::f64::consts::SQRT_2)
}

fn norm_pdf(z: f64) -> f64 {
    (-0.5 * z * z).exp() / (2.0 * std::f64::consts::PI).sqrt()
}

fn beta_cf(a: f64, b: f64, x: f64) -> f64 {
    let qab = a + b;
    let qap = a + 1.0;
    let qam = a - 1.0;
    let mut c = 1.0;
    let mut d = 1.0 - qab * x / qap;
    if d.abs() < FPMIN {
        d = FPMIN;
    }
    d = 1.0 / d;
    let mut h = d;
    for m in 1..100_000 {
        let m = m as f64;
        let m2 = 2.0 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + aa * d;
        if d.abs() < FPMIN {
            d = FPMIN;
        }
        c = 1.0 + aa / c;
        if c.abs() < FPMIN {
            c = FPMIN;
        }
        d = 1.0 / d;
        h *= d * c;
        let aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + aa * d;
        if d.abs() < FPMIN {
            d = FPMIN;
        }
        c = 1.0 + aa / c;
        if c.abs() < FPMIN {
            c = FPMIN;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < EPS {
            break;
        }
    }
    h
}

/// Regularized incomplete beta I_x(a, b).
pub fn beta_i(a: f64, b: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let bt = (ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * x.ln() + b * (1.0 - x).ln()).exp();
    if x < (a + 1.0) / (a + b + 2.0) {
        bt * beta_cf(a, b, x) / a
    } else {
        1.0 - bt * beta_cf(b, a, 1.0 - x) / b
    }
}

fn t_cdf(x: f64, df: f64) -> f64 {
    let p = 0.5 * beta_i(df / 2.0, 0.5, df / (df + x * x));
    if x > 0.0 {
        1.0 - p
    } else {
        p
    }
}

fn t_pdf(x: f64, df: f64) -> f64 {
    (ln_gamma((df + 1.0) / 2.0) - ln_gamma(df / 2.0)).exp() / (df * std::f64::consts::PI).sqrt() * (1.0 + x * x / df).powf(-(df + 1.0) / 2.0)
}

fn chisq_cdf(x: f64, df: f64) -> f64 {
    gamma_p(df / 2.0, x / 2.0)
}

fn chisq_pdf(x: f64, df: f64) -> f64 {
    if x < 0.0 {
        return 0.0;
    }
    if x == 0.0 {
        return if df < 2.0 { f64::INFINITY } else if df == 2.0 { 0.5 } else { 0.0 };
    }
    ((df / 2.0 - 1.0) * x.ln() - x / 2.0 - (df / 2.0) * std::f64::consts::LN_2 - ln_gamma(df / 2.0)).exp()
}

/// Solves cdf(x) = p for a nondecreasing cdf by expanding a bracket from `lo`/`hi` and bisecting.
fn invert(cdf: impl Fn(f64) -> f64, p: f64, mut lo: f64, mut hi: f64, lo_bound: Option<f64>) -> f64 {
    let mut guard = 0;
    while cdf(hi) < p && guard < 2000 {
        lo = hi;
        hi = hi * 2.0 + 1.0;
        guard += 1;
    }
    if lo_bound.is_none() {
        guard = 0;
        while cdf(lo) > p && guard < 2000 {
            hi = lo;
            lo = lo * 2.0 - 1.0;
            guard += 1;
        }
    }
    for _ in 0..400 {
        let mid = 0.5 * (lo + hi);
        if mid == lo || mid == hi {
            break;
        }
        if cdf(mid) < p {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

// ---------------------------------------------------------------------------------------------------------

fn domain(name: &str, what: &str) -> EvalError {
    err(ErrorCode::InvalidValue, format!("The function {name} cannot be applied: {what}."))
}

fn numbers(vals: impl Iterator<Item = Value>) -> Vec<f64> {
    vals.filter(|v| matches!(v, Value::Int(_) | Value::Double(_) | Value::Currency(_) | Value::DateTime(_))).map(|v| v.as_f64().unwrap()).collect()
}

fn sorted(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    v
}

fn median(v: Vec<f64>) -> Value {
    if v.is_empty() {
        return Value::Blank;
    }
    let s = sorted(v);
    let n = s.len();
    Value::Double(if n % 2 == 1 { s[n / 2] } else { (s[n / 2 - 1] + s[n / 2]) / 2.0 })
}

fn percentile(name: &str, v: Vec<f64>, k: f64, exclusive: bool) -> VResult<Value> {
    if v.is_empty() {
        return Ok(Value::Blank);
    }
    let s = sorted(v);
    let n = s.len() as f64;
    let rank = if exclusive {
        if k < 1.0 / (n + 1.0) || k > n / (n + 1.0) {
            return Err(domain(name, "k is outside the valid range for this number of values"));
        }
        k * (n + 1.0) - 1.0
    } else {
        if !(0.0..=1.0).contains(&k) {
            return Err(domain(name, "k must be between 0 and 1"));
        }
        k * (n - 1.0)
    };
    let lo = rank.floor() as usize;
    let frac = rank - rank.floor();
    let hi = (lo + 1).min(s.len() - 1);
    Ok(Value::Double(s[lo] + frac * (s[hi] - s[lo])))
}

fn variance(v: &[f64], sample: bool) -> Option<f64> {
    let n = v.len();
    if n == 0 {
        return None;
    }
    if sample && n < 2 {
        // recorded from Power BI: VAR.S / STDEV.S over a single value is NaN, not BLANK
        return Some(f64::NAN);
    }
    let mean = v.iter().sum::<f64>() / n as f64;
    let ss: f64 = v.iter().map(|x| (x - mean) * (x - mean)).sum();
    Some(ss / if sample { (n - 1) as f64 } else { n as f64 })
}

fn geomean(name: &str, v: Vec<f64>) -> VResult<Value> {
    if v.is_empty() {
        return Ok(Value::Blank);
    }
    // recorded from Power BI: no error for zero or negative values: a zero gives 0, a negative product gives the
    // real root when the count is odd and NaN when it is even
    let _ = name;
    if v.iter().any(|x| *x == 0.0) {
        return Ok(Value::Double(0.0));
    }
    let negatives = v.iter().filter(|x| **x < 0.0).count();
    let root = (v.iter().map(|x| x.abs().ln()).sum::<f64>() / v.len() as f64).exp();
    Ok(Value::Double(if negatives % 2 == 0 { root } else if v.len() % 2 == 1 { -root } else { f64::NAN }))
}

/// Evaluates `expr` for each row of the table argument.
fn x_values<'a>(ev: &'a Evaluator<'a>, table: &'a BExpr, expr: &'a BExpr, env: &Env<'a>) -> VResult<Vec<Value>> {
    let src = ev.table(table, env)?;
    let mut out = Vec::with_capacity(src.nrows());
    for_each_row(ev, &src, env, |_, e2| {
        out.push(ev.scalar(expr, e2)?);
        Ok(true)
    })?;
    Ok(out)
}

fn aggregate(name: &str, base: &str, v: Vec<f64>, k: Option<f64>) -> VResult<Value> {
    Ok(match base {
        "MEDIAN" => median(v),
        "GEOMEAN" => geomean(name, v)?,
        "STDEV.S" | "STDEV.P" | "VAR.S" | "VAR.P" => match variance(&v, base.ends_with(".S")) {
            None => Value::Blank,
            Some(var) => Value::Double(if base.starts_with("STDEV") { var.sqrt() } else { var }),
        },
        "PERCENTILE.INC" | "PERCENTILE.EXC" => percentile(name, v, k.unwrap_or(0.5), base.ends_with(".EXC"))?,
        _ => unreachable!(),
    })
}

fn median_type_check(t: crate::model::DataType) -> VResult<()> {
    use crate::model::DataType::*;
    if matches!(t, String | Boolean | DateTime) {
        return Err(err(ErrorCode::TypeMismatch, "MEDIAN does not support expressions of type string/Boolean/date."));
    }
    Ok(())
}

fn bool_arg(v: &Option<Value>) -> VResult<bool> {
    v.as_ref().map(|v| v.to_bool()).transpose().map(|b| b.unwrap_or(false))
}

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    match name {
        "MEDIAN" | "GEOMEAN" | "STDEV.S" | "STDEV.P" | "VAR.S" | "VAR.P" => {
            let c = col_arg(name, args, 0)?;
            if name == "MEDIAN" {
                median_type_check(ev.data.model.column(c).data_type)?;
            }
            return aggregate(name, name, numbers(column_values(ev, c, env).into_iter()), None);
        }
        "PERCENTILE.INC" | "PERCENTILE.EXC" => {
            let c = col_arg(name, args, 0)?;
            let k = ev.scalar(&args[1], env)?.to_f64()?;
            return aggregate(name, name, numbers(column_values(ev, c, env).into_iter()), Some(k));
        }
        "MEDIANX" | "GEOMEANX" | "STDEVX.S" | "STDEVX.P" | "VARX.S" | "VARX.P" => {
            let vals = x_values(ev, &args[0], &args[1], env)?;
            if name == "MEDIANX" && vals.iter().any(|v| matches!(v, Value::Str(_) | Value::Bool(_) | Value::DateTime(_))) {
                return Err(err(ErrorCode::TypeMismatch, "MEDIANX does not support expressions of type string/Boolean/date."));
            }
            let v = numbers(vals.into_iter());
            let base = name.replace("X.", ".").replace("MEDIANX", "MEDIAN").replace("GEOMEANX", "GEOMEAN");
            return aggregate(name, &base, v, None);
        }
        "PERCENTILEX.INC" | "PERCENTILEX.EXC" => {
            let v = numbers(x_values(ev, &args[0], &args[1], env)?.into_iter());
            let k = ev.scalar(&args[2], env)?.to_f64()?;
            return aggregate(name, &name.replace("PERCENTILEX", "PERCENTILE"), v, Some(k));
        }
        "RANKX" => return rankx(ev, args, env),
        "RANK.EQ" => {
            let value = ev.scalar(&args[0], env)?;
            if value.is_blank() {
                return Ok(Value::Blank);
            }
            let c = col_arg(name, args, 1)?;
            let asc = args.get(2).filter(|a| !a.is_missing()).map(|a| ev.scalar(a, env).and_then(|v| v.to_bool())).transpose()?.unwrap_or(false);
            let x = value.to_f64()?;
            let nums = numbers(column_values(ev, c, env).into_iter());
            if !nums.iter().any(|n| *n == x) {
                return Ok(Value::Blank);
            }
            let better = nums.iter().filter(|n| if asc { **n < x } else { **n > x }).count();
            return Ok(Value::Int(better as i64 + 1));
        }
        _ => {}
    }
    // distribution functions: plain numeric arguments
    let a = eval_args(ev, args, env)?;
    let n = |i: usize| -> VResult<f64> { a.get(i).cloned().flatten().unwrap_or(Value::Blank).to_f64() };
    let opt = |i: usize| a.get(i).cloned().flatten();
    let d = |x: f64| -> VResult<Value> {
        if x.is_nan() {
            Err(domain(name, "the result is not a number"))
        } else {
            Ok(Value::Double(x))
        }
    };
    match name {
        "NORM.S.DIST" => {
            let z = n(0)?;
            d(if bool_arg(&opt(1))? { norm_cdf(z) } else { norm_pdf(z) })
        }
        "NORM.DIST" => {
            let (x, mean, sd) = (n(0)?, n(1)?, n(2)?);
            if sd <= 0.0 {
                return Err(domain(name, "the standard deviation must be positive"));
            }
            let z = (x - mean) / sd;
            d(if bool_arg(&opt(3))? { norm_cdf(z) } else { norm_pdf(z) / sd })
        }
        "NORM.S.INV" | "NORM.INV" => {
            let p = n(0)?;
            if p <= 0.0 || p >= 1.0 {
                return Err(domain(name, "the probability must be between 0 and 1"));
            }
            let z = invert(norm_cdf, p, -10.0, 10.0, None);
            if name == "NORM.S.INV" {
                d(z)
            } else {
                let (mean, sd) = (n(1)?, n(2)?);
                if sd <= 0.0 {
                    return Err(domain(name, "the standard deviation must be positive"));
                }
                d(mean + sd * z)
            }
        }
        "EXPON.DIST" => {
            let (x, lambda) = (n(0)?, n(1)?);
            if x < 0.0 || lambda <= 0.0 {
                return Err(domain(name, "x must not be negative and lambda must be positive"));
            }
            d(if bool_arg(&opt(2))? { 1.0 - (-lambda * x).exp() } else { lambda * (-lambda * x).exp() })
        }
        "POISSON.DIST" => {
            let (x, mean) = (n(0)?.trunc(), n(1)?);
            if x < 0.0 || mean < 0.0 {
                return Err(domain(name, "x and the mean must not be negative"));
            }
            let pmf = |k: f64| if mean == 0.0 { if k == 0.0 { 1.0 } else { 0.0 } } else { (-mean + k * mean.ln() - ln_gamma(k + 1.0)).exp() };
            d(if bool_arg(&opt(2))? { gamma_q(x + 1.0, mean) } else { pmf(x) })
        }
        "T.DIST" => {
            let (x, df) = (n(0)?, n(1)?.round());
            if df < 1.0 {
                return Err(domain(name, "the degrees of freedom must be 1 or more"));
            }
            d(if bool_arg(&opt(2))? { t_cdf(x, df) } else { t_pdf(x, df) })
        }
        "T.DIST.RT" | "T.DIST.2T" => {
            let (x, df) = (n(0)?, n(1)?.round());
            if df < 1.0 || (name == "T.DIST.2T" && x < 0.0) {
                return Err(domain(name, "invalid arguments"));
            }
            d(if name == "T.DIST.RT" { 1.0 - t_cdf(x, df) } else { 2.0 * (1.0 - t_cdf(x, df)) })
        }
        "T.INV" | "T.INV.2T" => {
            let (mut p, df) = (n(0)?, n(1)?.round());
            if p <= 0.0 || p >= 1.0 || df < 1.0 {
                return Err(domain(name, "the probability must be between 0 and 1 and the degrees of freedom 1 or more"));
            }
            if name == "T.INV.2T" {
                p = 1.0 - p / 2.0;
            }
            if p == 0.5 {
                return Ok(Value::Double(0.0));
            }
            d(invert(|x| t_cdf(x, df), p, -10.0, 10.0, None))
        }
        "CHISQ.DIST" | "CHISQ.DIST.RT" => {
            let (x, df) = (n(0)?, n(1)?.round());
            if x < 0.0 || df < 1.0 {
                return Err(domain(name, "x must not be negative and the degrees of freedom must be 1 or more"));
            }
            if name == "CHISQ.DIST.RT" {
                d(1.0 - chisq_cdf(x, df))
            } else {
                d(if bool_arg(&opt(2))? { chisq_cdf(x, df) } else { chisq_pdf(x, df) })
            }
        }
        "CHISQ.INV" | "CHISQ.INV.RT" => {
            let (mut p, df) = (n(0)?, n(1)?.round());
            if !(0.0..1.0).contains(&p) || df < 1.0 {
                return Err(domain(name, "the probability must be between 0 and 1 and the degrees of freedom 1 or more"));
            }
            if name == "CHISQ.INV.RT" {
                p = 1.0 - p;
            }
            d(invert(|x| chisq_cdf(x, df), p, 0.0, 10.0, Some(0.0)))
        }
        "BETA.DIST" | "BETA.INV" => {
            let dist = name == "BETA.DIST";
            let (x, alpha, beta) = (n(0)?, n(1)?, n(2)?);
            let (lo, hi) = if dist { (a.get(4).cloned().flatten().map(|v| v.to_f64()).transpose()?.unwrap_or(0.0), a.get(5).cloned().flatten().map(|v| v.to_f64()).transpose()?.unwrap_or(1.0)) } else { (a.get(3).cloned().flatten().map(|v| v.to_f64()).transpose()?.unwrap_or(0.0), a.get(4).cloned().flatten().map(|v| v.to_f64()).transpose()?.unwrap_or(1.0)) };
            if alpha <= 0.0 || beta <= 0.0 || hi <= lo {
                return Err(domain(name, "alpha and beta must be positive and the interval must not be empty"));
            }
            if dist {
                if x < lo || x > hi {
                    return Err(domain(name, "x is outside the interval"));
                }
                let u = (x - lo) / (hi - lo);
                if bool_arg(&opt(3))? {
                    d(beta_i(alpha, beta, u))
                } else {
                    let ln_b = ln_gamma(alpha) + ln_gamma(beta) - ln_gamma(alpha + beta);
                    d(((alpha - 1.0) * u.ln() + (beta - 1.0) * (1.0 - u).ln() - ln_b).exp() / (hi - lo))
                }
            } else {
                if x <= 0.0 || x >= 1.0 {
                    return Err(domain(name, "the probability must be between 0 and 1"));
                }
                d(lo + (hi - lo) * invert(|u| beta_i(alpha, beta, u), x, 0.0, 1.0, Some(0.0)).min(1.0))
            }
        }
        "CONFIDENCE.NORM" | "CONFIDENCE.T" => {
            // recorded from Power BI: degrees of freedom and the size are rounded, not truncated (T.DIST(2, 10.9) = T.DIST(2, 11))
            let (alpha, sd, size) = (n(0)?, n(1)?, n(2)?.round());
            if alpha <= 0.0 || alpha >= 1.0 || sd <= 0.0 || size < 1.0 || (name == "CONFIDENCE.T" && size < 2.0) {
                return Err(domain(name, "alpha must be between 0 and 1, the standard deviation positive and the size large enough"));
            }
            let q = if name == "CONFIDENCE.NORM" { invert(norm_cdf, 1.0 - alpha / 2.0, -10.0, 10.0, None) } else { invert(|x| t_cdf(x, size - 1.0), 1.0 - alpha / 2.0, -10.0, 10.0, None) };
            d(q * sd / size.sqrt())
        }
        _ => unreachable!("{name}"),
    }
}

/// RANKX(table, expression, [value], [order], [ties]).
fn rankx<'a>(ev: &'a Evaluator<'a>, args: &'a [BExpr], env: &Env<'a>) -> VResult<Value> {
    let values = x_values(ev, &args[0], &args[1], env)?;
    let value = if args.len() > 2 && !args[2].is_missing() { ev.scalar(&args[2], env)? } else { ev.scalar(&args[1], env)? };
    // recorded from Power BI: a BLANK value is compared like 0 (RANKX({1, 2, 2, 3}, [Value], BLANK()) is 5)
    let mut asc = false;
    if let Some(a) = args.get(3).filter(|a| !a.is_missing()) {
        asc = match &a.kind {
            BKind::Sort(desc) => !*desc,
            _ => ev.scalar(a, env)?.to_bool()?,
        };
    }
    let dense = args.get(4).and_then(|a| a.ident()) == Some("DENSE");
    let mut better: Vec<&Value> = Vec::new();
    for v in values.iter().filter(|v| !v.is_blank()) {
        let o = value::compare(v, &value)?;
        if (asc && o == Ordering::Less) || (!asc && o == Ordering::Greater) {
            better.push(v);
        }
    }
    let n = if dense {
        let mut keys: Vec<_> = better.iter().map(|v| v.key()).collect();
        keys.sort();
        keys.dedup();
        keys.len()
    } else {
        better.len()
    };
    Ok(Value::Int(n as i64 + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() <= 1e-9 * b.abs().max(1.0), "{a} vs {b}");
    }

    #[test]
    fn special_functions() {
        close(ln_gamma(5.0), 24f64.ln());
        close(ln_gamma(0.5), std::f64::consts::PI.sqrt().ln());
        close(norm_cdf(0.0), 0.5);
        close(norm_cdf(1.96), 0.9750021048517795);
        close(norm_cdf(-3.0), 0.0013498980316301);
        close(gamma_p(2.0, 3.0), 0.8008517265285442);
        close(beta_i(2.0, 3.0, 0.4), 0.5248);
        close(t_cdf(2.0, 10.0), 0.9633059826146299);
        assert!((chisq_cdf(3.84, 1.0) - 0.9499565).abs() < 1e-6);
    }

    #[test]
    fn inverses() {
        close(invert(norm_cdf, 0.975, -10.0, 10.0, None), 1.959963984540054);
        close(invert(|x| t_cdf(x, 10.0), 0.975, -10.0, 10.0, None), 2.228138851986274);
        close(invert(|x| chisq_cdf(x, 4.0), 0.95, 0.0, 10.0, Some(0.0)), 9.487729036781154);
    }

    #[test]
    fn percentiles() {
        let v = vec![1.0, 2.0, 3.0, 4.0];
        assert_eq!(percentile("P", v.clone(), 0.5, false).unwrap(), Value::Double(2.5));
        assert_eq!(percentile("P", v.clone(), 0.25, true).unwrap(), Value::Double(1.25));
        assert!(percentile("P", v, 0.1, true).is_err());
    }
}
