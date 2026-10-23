//! Financial functions (FV, PV, PMT, NPER, RATE, XNPV, XIRR), parent-child functions (PATH, PATHITEM, PATHITEMREVERSE,
//! PATHLENGTH, PATHCONTAINS), TOCSV, COLUMNSTATISTICS and LINEST / LINESTX.
//!
//! Semantics come from Microsoft's public documentation of these functions and the standard formulas (not recorded from
//! Power BI Desktop: the cases in tests/dax/cases/extra.json have no expected result yet and wait for a recording).

use crate::bind::BExpr;
use crate::diag::ErrorCode;
use crate::eval::{Env, Evaluator, RowRef, Val};
use crate::functions::{col_arg, err, for_each_row};
use crate::model::ColId;
use crate::table::{TCol, TableVal};
use crate::value::{VResult, Value};

pub const NAMES: &[&str] = &["FV", "PV", "PMT", "NPER", "RATE", "XNPV", "XIRR", "PATH", "PATHITEM", "PATHITEMREVERSE", "PATHLENGTH", "PATHCONTAINS", "TOCSV", "COLUMNSTATISTICS", "LINEST", "LINESTX"];

pub fn call<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> Option<VResult<Val>> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(run(ev, name, args, env))
}

fn num(ev: &Evaluator, args: &[BExpr], i: usize, env: &Env, default: Option<f64>) -> VResult<f64> {
    match args.get(i) {
        Some(a) if !a.is_missing() => {
            let v = ev.scalar(a, env)?;
            if v.is_blank() {
                return Ok(default.unwrap_or(0.0));
            }
            v.to_f64()
        }
        _ => default.ok_or_else(|| err(ErrorCode::MissingParameters, "A required argument is missing.")),
    }
}

fn bad(msg: &str) -> crate::value::EvalError {
    err(ErrorCode::InvalidValue, msg)
}

// ---- financial ---------------------------------------------------------------------------------------------

fn fv(r: f64, n: f64, pmt: f64, pv: f64, t: f64) -> f64 {
    if r == 0.0 {
        return -(pv + pmt * n);
    }
    let g = (1.0 + r).powf(n);
    -(pv * g + pmt * (1.0 + r * t) * (g - 1.0) / r)
}

fn pv_(r: f64, n: f64, pmt: f64, fv: f64, t: f64) -> f64 {
    if r == 0.0 {
        return -(fv + pmt * n);
    }
    let g = (1.0 + r).powf(n);
    -(fv + pmt * (1.0 + r * t) * (g - 1.0) / r) / g
}

fn pmt_(r: f64, n: f64, pv: f64, fv: f64, t: f64) -> f64 {
    if r == 0.0 {
        return -(pv + fv) / n;
    }
    let g = (1.0 + r).powf(n);
    -(fv + pv * g) * r / ((1.0 + r * t) * (g - 1.0))
}

fn xnpv(rate: f64, flows: &[(f64, f64)]) -> f64 {
    let d0 = flows[0].1;
    flows.iter().map(|(v, d)| v / (1.0 + rate).powf((d - d0) / 365.0)).sum()
}

fn xirr(flows: &[(f64, f64)], guess: f64) -> Option<f64> {
    let f = |r: f64| xnpv(r, flows);
    // Newton's method from the guess; the secant of a bracket as a fallback
    let mut r = guess;
    for _ in 0..100 {
        let y = f(r);
        let h = 1e-6 * r.abs().max(1e-3);
        let d = (f(r + h) - y) / h;
        if !d.is_finite() || d == 0.0 {
            break;
        }
        let next = r - y / d;
        if !next.is_finite() || next <= -1.0 {
            break;
        }
        if (next - r).abs() < 1e-12 {
            return Some(next);
        }
        r = next;
    }
    let (mut lo, mut hi) = (-0.999999, 1e6);
    let (mut flo, fhi) = (f(lo), f(hi));
    if !(flo.is_finite() && fhi.is_finite()) || flo * fhi > 0.0 {
        return None;
    }
    for _ in 0..300 {
        let mid = (lo + hi) / 2.0;
        let fm = f(mid);
        if fm == 0.0 || (hi - lo) < 1e-14 {
            return Some(mid);
        }
        if flo * fm < 0.0 {
            hi = mid;
        } else {
            lo = mid;
            flo = fm;
        }
    }
    Some((lo + hi) / 2.0)
}

fn cash_flows<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Vec<(f64, f64)>> {
    let src = ev.table(&args[0], env)?;
    let mut out = Vec::new();
    for_each_row(ev, &src, env, |_, e2| {
        let v = ev.scalar(&args[1], e2)?;
        let d = ev.scalar(&args[2], e2)?;
        if v.is_blank() || d.is_blank() {
            return Ok(true);
        }
        out.push((v.to_f64()?, d.to_f64()?.floor()));
        Ok(true)
    })?;
    if out.is_empty() {
        return Err(bad(&format!("{name} needs at least one cash flow.")));
    }
    if out.iter().any(|(_, d)| *d < out[0].1) {
        return Err(bad(&format!("{name}: a date is earlier than the first date.")));
    }
    Ok(out)
}

// ---- parent-child ---------------------------------------------------------------------------------------------

fn current_row(env: &Env, table: usize) -> Option<u32> {
    let mut cur = env.rows.clone();
    while let Some(f) = cur {
        if let RowRef::Base { table: t, row } = &f.row {
            if *t == table {
                return Some(*row);
            }
        }
        cur = f.parent.clone();
    }
    None
}

fn path_of(ev: &Evaluator, id: ColId, parent: ColId, env: &Env) -> VResult<Value> {
    if id.table != parent.table {
        return Err(err(ErrorCode::InvalidParameter, "PATH needs the ID column and the parent column of the same table."));
    }
    let Some(row) = current_row(env, id.table) else { return Err(err(ErrorCode::InvalidValue, "PATH needs a row context of the table.")) };
    let n = ev.data.nrows(id.table);
    let mut by_id: std::collections::HashMap<crate::value::Key, u32> = std::collections::HashMap::new();
    for r in 0..n as u32 {
        by_id.entry(ev.data.value(id, r).key()).or_insert(r);
    }
    let mut items = vec![ev.data.value(id, row).to_text()];
    let mut seen = std::collections::HashSet::from([ev.data.value(id, row).key()]);
    let mut p = ev.data.value(parent, row).clone();
    while !p.is_blank() {
        let key = p.key();
        if !seen.insert(key.clone()) {
            return Err(err(ErrorCode::InvalidValue, "A circular reference was detected in the parent-child hierarchy."));
        }
        items.push(p.to_text());
        match by_id.get(&key) {
            Some(&r) => p = ev.data.value(parent, r).clone(),
            None => break,
        }
    }
    items.reverse();
    Ok(Value::str(&items.join("|")))
}

fn path_items(v: &Value) -> Option<Vec<String>> {
    if v.is_blank() {
        return None;
    }
    let t = v.to_text();
    Some(if t.is_empty() { vec![] } else { t.split('|').map(String::from).collect() })
}

fn item_value(text: &str, integer: bool) -> Value {
    if integer {
        text.trim().parse::<i64>().map(Value::Int).unwrap_or(Value::Blank)
    } else {
        Value::str(text)
    }
}

// ---- LINEST ---------------------------------------------------------------------------------------------------

/// Ordinary least squares with an intercept; None when the columns are collinear or there are too few rows.
fn ols(y: &[f64], xs: &[Vec<f64>]) -> Option<Vec<Value>> {
    let n = y.len();
    let k = xs.len();
    if n <= k + 1 {
        return None;
    }
    // design matrix columns: x1..xk, 1
    let cols: Vec<Vec<f64>> = xs.iter().cloned().chain(std::iter::once(vec![1.0; n])).collect();
    let m = k + 1;
    let mut a = vec![vec![0.0; m]; m];
    let mut b = vec![0.0; m];
    for i in 0..m {
        for j in 0..m {
            a[i][j] = (0..n).map(|r| cols[i][r] * cols[j][r]).sum();
        }
        b[i] = (0..n).map(|r| cols[i][r] * y[r]).sum();
    }
    let inv = invert(&a)?;
    let beta: Vec<f64> = (0..m).map(|i| (0..m).map(|j| inv[i][j] * b[j]).sum()).collect();
    let fitted: Vec<f64> = (0..n).map(|r| (0..m).map(|i| beta[i] * cols[i][r]).sum()).collect();
    let ybar = y.iter().sum::<f64>() / n as f64;
    let ss_res: f64 = (0..n).map(|r| (y[r] - fitted[r]).powi(2)).sum();
    let ss_tot: f64 = y.iter().map(|v| (v - ybar).powi(2)).sum();
    let ss_reg = ss_tot - ss_res;
    let df = (n - m) as f64;
    let s2 = ss_res / df;
    let se: Vec<f64> = (0..m).map(|i| (s2 * inv[i][i]).sqrt()).collect();
    let r2 = if ss_tot == 0.0 { 1.0 } else { ss_reg / ss_tot };
    let f = if ss_res == 0.0 { f64::INFINITY } else { (ss_reg / k as f64) / s2 };
    // the slopes first, in the order of the X columns; the intercept last (the layout of the result)
    let mut out: Vec<Value> = beta[..k].iter().map(|v| Value::Double(*v)).collect();
    out.push(Value::Double(beta[k]));
    out.extend(se[..k].iter().map(|v| Value::Double(*v)));
    out.push(Value::Double(se[k]));
    out.extend([Value::Double(r2), Value::Double(s2.sqrt()), Value::Double(f), Value::Int(df as i64), Value::Double(ss_reg), Value::Double(ss_res)]);
    Some(out)
}

fn invert(a: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let n = a.len();
    let mut m: Vec<Vec<f64>> = a.iter().enumerate().map(|(i, r)| r.iter().cloned().chain((0..n).map(|j| if i == j { 1.0 } else { 0.0 })).collect()).collect();
    for c in 0..n {
        let p = (c..n).max_by(|&x, &y| m[x][c].abs().partial_cmp(&m[y][c].abs()).unwrap())?;
        if m[p][c].abs() < 1e-12 {
            return None;
        }
        m.swap(c, p);
        let d = m[c][c];
        for v in m[c].iter_mut() {
            *v /= d;
        }
        for r in 0..n {
            if r != c {
                let f = m[r][c];
                if f != 0.0 {
                    let row = m[c].clone();
                    for (x, y) in m[r].iter_mut().zip(row) {
                        *x -= f * y;
                    }
                }
            }
        }
    }
    Some(m.into_iter().map(|r| r[n..].to_vec()).collect())
}

fn linest_table(k: usize, values: Option<Vec<Value>>) -> TableVal {
    let mut names: Vec<String> = (1..=k).map(|i| format!("Slope{i}")).collect();
    names.push("Intercept".into());
    names.extend((1..=k).map(|i| format!("StandardErrorSlope{i}")));
    names.extend(["StandardErrorIntercept", "CoefficientOfDetermination", "StandardErrorY", "F", "DegreesOfFreedom", "RegressionSumSquares", "ResidualSumSquares"].map(String::from));
    let cols = names.into_iter().map(|name| TCol { name, lineage: None, renamed: false }).collect();
    TableVal::mat(cols, values.into_iter().collect())
}

// ---- dispatch -------------------------------------------------------------------------------------------------

fn run<'a>(ev: &'a Evaluator<'a>, name: &str, args: &'a [BExpr], env: &Env<'a>) -> VResult<Val> {
    let s = |v: Value| Ok(Val::S(v));
    match name {
        "FV" => s(Value::Double(fv(num(ev, args, 0, env, None)?, num(ev, args, 1, env, None)?, num(ev, args, 2, env, None)?, num(ev, args, 3, env, Some(0.0))?, num(ev, args, 4, env, Some(0.0))?))),
        "PV" => s(Value::Double(pv_(num(ev, args, 0, env, None)?, num(ev, args, 1, env, None)?, num(ev, args, 2, env, None)?, num(ev, args, 3, env, Some(0.0))?, num(ev, args, 4, env, Some(0.0))?))),
        "PMT" => {
            let (r, n) = (num(ev, args, 0, env, None)?, num(ev, args, 1, env, None)?);
            if n == 0.0 {
                return Err(bad("PMT: the number of periods cannot be zero."));
            }
            s(Value::Double(pmt_(r, n, num(ev, args, 2, env, None)?, num(ev, args, 3, env, Some(0.0))?, num(ev, args, 4, env, Some(0.0))?)))
        }
        "NPER" => {
            let (r, pmt, pv, fv, t) = (num(ev, args, 0, env, None)?, num(ev, args, 1, env, None)?, num(ev, args, 2, env, None)?, num(ev, args, 3, env, Some(0.0))?, num(ev, args, 4, env, Some(0.0))?);
            let n = if r == 0.0 {
                if pmt == 0.0 {
                    return Err(bad("NPER: the payment cannot be zero when the rate is zero."));
                }
                -(pv + fv) / pmt
            } else {
                let a = pmt * (1.0 + r * t) - fv * r;
                let b = pmt * (1.0 + r * t) + pv * r;
                if a / b <= 0.0 || !(a / b).is_finite() {
                    return Err(bad("NPER: the payment is too small to repay the loan."));
                }
                (a / b).ln() / (1.0 + r).ln()
            };
            s(Value::Double(n))
        }
        "RATE" => {
            let (n, pmt, pv, fv, t, guess) = (num(ev, args, 0, env, None)?, num(ev, args, 1, env, None)?, num(ev, args, 2, env, None)?, num(ev, args, 3, env, Some(0.0))?, num(ev, args, 4, env, Some(0.0))?, num(ev, args, 5, env, Some(0.1))?);
            let f = |r: f64| if r == 0.0 { pv + pmt * n + fv } else { let g = (1.0 + r).powf(n); pv * g + pmt * (1.0 + r * t) * (g - 1.0) / r + fv };
            let mut r = guess;
            for _ in 0..100 {
                let y = f(r);
                let h = 1e-7;
                let d = (f(r + h) - f(r - h)) / (2.0 * h);
                if d == 0.0 || !d.is_finite() {
                    break;
                }
                let next = r - y / d;
                if (next - r).abs() < 1e-12 {
                    return s(Value::Double(next));
                }
                r = next;
            }
            Err(bad("RATE did not converge."))
        }
        "XNPV" => {
            let flows = cash_flows(ev, name, args, env)?;
            let rate = num(ev, args, 3, env, None)?;
            if rate <= -1.0 {
                return Err(bad("XNPV: the rate must be above -1."));
            }
            s(Value::Double(xnpv(rate, &flows)))
        }
        "XIRR" => {
            let flows = cash_flows(ev, name, args, env)?;
            if !(flows.iter().any(|(v, _)| *v > 0.0) && flows.iter().any(|(v, _)| *v < 0.0)) {
                return Err(bad("XIRR needs at least one positive and one negative cash flow."));
            }
            let guess = num(ev, args, 3, env, Some(0.1))?;
            xirr(&flows, guess).map(|r| Val::S(Value::Double(r))).ok_or_else(|| bad("XIRR did not converge."))
        }
        "PATH" => s(path_of(ev, col_arg(name, args, 0)?, col_arg(name, args, 1)?, env)?),
        "PATHITEM" | "PATHITEMREVERSE" => {
            let Some(items) = path_items(&ev.scalar(&args[0], env)?) else { return s(Value::Blank) };
            let pos = num(ev, args, 1, env, None)?;
            let integer = match args.get(2) {
                Some(a) if !a.is_missing() => matches!(&a.kind, crate::bind::BKind::Ident(w) if w == "INTEGER"),
                _ => false,
            };
            let i = pos as i64;
            if i < 1 || i as usize > items.len() {
                return s(Value::Blank);
            }
            let idx = if name == "PATHITEM" { i as usize - 1 } else { items.len() - i as usize };
            s(item_value(&items[idx], integer))
        }
        "PATHLENGTH" => match path_items(&ev.scalar(&args[0], env)?) {
            Some(items) => s(Value::Int(items.len() as i64)),
            None => s(Value::Blank),
        },
        "PATHCONTAINS" => {
            let Some(items) = path_items(&ev.scalar(&args[0], env)?) else { return s(Value::Blank) };
            let item = ev.scalar(&args[1], env)?.to_text();
            s(Value::Bool(items.iter().any(|x| x.eq_ignore_ascii_case(item.trim()))))
        }
        "TOCSV" => {
            let t = ev.table(&args[0], env)?;
            let max = if args.len() > 1 && !args[1].is_missing() { num(ev, args, 1, env, None)? as usize } else { 50 };
            let delim = if args.len() > 2 && !args[2].is_missing() { ev.scalar(&args[2], env)?.to_text() } else { ",".into() };
            let headers = if args.len() > 3 && !args[3].is_missing() { ev.scalar(&args[3], env)?.to_bool()? } else { true };
            let q = |x: &str| if x.contains(&delim) || x.contains('"') || x.contains('\n') { format!("\"{}\"", x.replace('"', "\"\"")) } else { x.to_string() };
            let mut lines = Vec::new();
            if headers {
                lines.push(t.cols(ev.data).iter().map(|c| q(&c.name)).collect::<Vec<_>>().join(&delim));
            }
            for r in 0..t.nrows().min(max) {
                lines.push(t.row(ev.data, r).iter().map(|v| q(&v.to_text())).collect::<Vec<_>>().join(&delim));
            }
            s(Value::str(&lines.join("\n")))
        }
        "COLUMNSTATISTICS" => {
            let mut rows = Vec::new();
            for (ti, t) in ev.data.model.tables.iter().enumerate() {
                for ci in 0..t.columns.len() {
                    let c = ColId { table: ti, col: ci };
                    let vals: Vec<Value> = (0..ev.data.nrows(ti) as u32).map(|r| ev.data.value(c, r).clone()).collect();
                    let non_blank: Vec<&Value> = vals.iter().filter(|v| !v.is_blank()).collect();
                    let mut sorted = non_blank.clone();
                    sorted.sort_by(|a, b| crate::value::sort_cmp(a, b));
                    let distinct = vals.iter().map(|v| v.key()).collect::<std::collections::HashSet<_>>().len();
                    let maxlen = non_blank.iter().map(|v| v.to_text().chars().count()).max().unwrap_or(0);
                    rows.push(vec![
                        Value::str(&t.name),
                        Value::str(&t.columns[ci].name),
                        sorted.first().map(|v| Value::str(&v.to_text())).unwrap_or(Value::Blank),
                        sorted.last().map(|v| Value::str(&v.to_text())).unwrap_or(Value::Blank),
                        Value::Int(distinct as i64),
                        Value::Int(maxlen as i64),
                    ]);
                }
            }
            let cols = ["Table Name", "Column Name", "Min", "Max", "Cardinality", "Max Length"].iter().map(|n| TCol { name: n.to_string(), lineage: None, renamed: false }).collect();
            Ok(Val::T(TableVal::mat(cols, rows)))
        }
        "LINEST" => {
            let ycol = col_arg(name, args, 0)?;
            let rows = ev.table_rows(&env.filter, ycol.table, false);
            let get = |c: ColId| -> VResult<Vec<f64>> { rows.iter().map(|&r| ev.data.value(c, r).to_f64()).collect() };
            let ys = get(ycol)?;
            let xs: Vec<Vec<f64>> = (1..args.len()).map(|i| col_arg(name, args, i).and_then(&get)).collect::<VResult<_>>()?;
            if xs.is_empty() {
                return Err(err(ErrorCode::MissingParameters, "LINEST needs at least one X column."));
            }
            Ok(Val::T(linest_table(xs.len(), ols(&ys, &xs))))
        }
        "LINESTX" => {
            let src = ev.table(&args[0], env)?;
            let k = args.len() - 2;
            if k < 1 {
                return Err(err(ErrorCode::MissingParameters, "LINESTX needs the table, a Y expression and at least one X expression."));
            }
            let mut ys = Vec::new();
            let mut xs: Vec<Vec<f64>> = vec![Vec::new(); k];
            for_each_row(ev, &src, env, |_, e2| {
                let y = ev.scalar(&args[1], e2)?;
                let xv: Vec<Value> = (0..k).map(|i| ev.scalar(&args[2 + i], e2)).collect::<VResult<_>>()?;
                if y.is_blank() || xv.iter().any(|v| v.is_blank()) {
                    return Ok(true);
                }
                ys.push(y.to_f64()?);
                for (i, v) in xv.iter().enumerate() {
                    xs[i].push(v.to_f64()?);
                }
                Ok(true)
            })?;
            Ok(Val::T(linest_table(k, ols(&ys, &xs))))
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_annuity_formulas() {
        // 5% a year, 10 years, 100 a year paid at the end
        assert!((fv(0.05, 10.0, -100.0, 0.0, 0.0) - 1257.789253554883).abs() < 1e-9);
        assert!((pv_(0.05, 10.0, -100.0, 0.0, 0.0) - 772.1734929184818).abs() < 1e-9);
        assert!((pmt_(0.05, 10.0, 1000.0, 0.0, 0.0) + 129.5045749654567).abs() < 1e-9);
        assert_eq!(fv(0.0, 10.0, -100.0, 0.0, 0.0), 1000.0);
    }

    #[test]
    fn xirr_finds_the_rate_that_zeroes_the_xnpv() {
        // -1000 now, 1100 a year (365 days) later: 10 %
        let flows = [(-1000.0, 45000.0), (1100.0, 45365.0)];
        assert!((xirr(&flows, 0.1).unwrap() - 0.1).abs() < 1e-9);
        assert!(xnpv(0.1, &flows).abs() < 1e-9);
        assert!(xirr(&[(1.0, 0.0), (2.0, 365.0)], 0.1).is_none());
    }

    #[test]
    fn least_squares_recovers_a_line_and_reports_the_fit() {
        let y = [3.0, 5.0, 7.0, 9.0, 11.0];
        let x = vec![vec![1.0, 2.0, 3.0, 4.0, 5.0]];
        let r = ols(&y, &x).unwrap();
        let f = |i: usize| match &r[i] { Value::Double(v) => *v, Value::Int(v) => *v as f64, _ => f64::NAN };
        assert!((f(0) - 2.0).abs() < 1e-9 && (f(1) - 1.0).abs() < 1e-9);
        assert!((f(4) - 1.0).abs() < 1e-9, "R squared");
        assert_eq!(f(7), 3.0, "degrees of freedom");
        assert!(ols(&[1.0, 2.0], &[vec![1.0, 1.0]]).is_none());
    }
}
