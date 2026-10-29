//! Small functions on concrete values: percentiles, metadata (BIForge keeps no metadata, so it is dropped), table keys (BIForge
//! tables have none) and the diagnostics hooks (no tracing is active, so they pass the value through). Cases: tests/m/stdlib/batch.json.
use crate::eval::Ev;
use crate::value::*;

type R<T> = MResult<T>;

pub const BATCH_FNS: &[&str] = &[
    "List.Percentile", "Value.RemoveMetadata", "Table.Keys", "Type.TableKeys", "Diagnostics.ActivityId", "Diagnostics.CorrelationId",
    "Diagnostics.LogValue",
];

pub fn call(_ev: &Ev, name: &str, a: &[Value]) -> Option<R<Value>> {
    if !BATCH_FNS.contains(&name) {
        return None;
    }
    Some(dispatch(name, a))
}

fn arg<'v>(a: &'v [Value], i: usize, f: &str) -> R<&'v Value> {
    a.get(i).ok_or_else(|| MError::expr(format!("{f}: argument {} is missing.", i + 1)))
}

fn dispatch(name: &str, a: &[Value]) -> R<Value> {
    match name {
        "Value.RemoveMetadata" => Ok(arg(a, 0, name)?.clone()),
        "Diagnostics.LogValue" => Ok(arg(a, 1, name)?.clone()),
        "Diagnostics.ActivityId" | "Diagnostics.CorrelationId" => Ok(Value::Null),
        "Table.Keys" | "Type.TableKeys" => Ok(Value::List(Vec::new())),
        "List.Percentile" => percentile(a),
        _ => Err(MError::unsupported(format!("{name} is not supported."))),
    }
}

/// Linear interpolation between the closest ranks, (n - 1) * p (PercentileMode.ExcelInc, the default).
fn percentile(a: &[Value]) -> R<Value> {
    let f = "List.Percentile";
    let mut xs = Vec::new();
    match arg(a, 0, f)? {
        Value::List(l) => {
            for v in l {
                match v {
                    Value::Num(n) => xs.push(*n),
                    Value::Null => {}
                    other => return Err(MError::expr(format!("{f}: a list item is {} instead of a number.", other.type_name()))),
                }
            }
        }
        other => return Err(MError::expr(format!("{f}: a list was expected, found {}.", other.type_name()))),
    }
    if let Some(Value::Record(opts)) = a.get(2) {
        if let Some((_, m)) = opts.iter().find(|(k, _)| k == "PercentileMode") {
            if !matches!(m, Value::Num(n) if *n == 0.0) {
                return Err(MError::unsupported(format!("{f}: only PercentileMode.ExcelInc is supported.")));
            }
        }
    }
    if xs.is_empty() {
        return Ok(Value::Null);
    }
    xs.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
    let at = |p: f64| -> R<Value> {
        if !(0.0..=1.0).contains(&p) {
            return Err(MError::expr(format!("{f}: a percentile must be between 0 and 1.")));
        }
        let pos = (xs.len() - 1) as f64 * p;
        let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
        Ok(Value::Num(xs[lo] + (xs[hi] - xs[lo]) * (pos - lo as f64)))
    };
    match arg(a, 1, f)? {
        Value::Num(p) => at(*p),
        Value::List(ps) => ps
            .iter()
            .map(|p| match p {
                Value::Num(p) => at(*p),
                other => Err(MError::expr(format!("{f}: a percentile must be a number, found {}.", other.type_name()))),
            })
            .collect::<R<Vec<_>>>()
            .map(Value::List),
        other => Err(MError::expr(format!("{f}: the percentile must be a number or a list, found {}.", other.type_name()))),
    }
}
