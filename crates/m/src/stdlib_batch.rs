//! Small functions on concrete values: percentiles, metadata (BIForge keeps no metadata, so it is dropped), table keys (BIForge
//! tables have none) and the diagnostics hooks (no tracing is active, so they pass the value through). Cases: tests/m/stdlib/batch.json.
use crate::eval::Ev;
use crate::value::*;

type R<T> = MResult<T>;

pub const BATCH_FNS: &[&str] = &[
    "List.Percentile", "Value.RemoveMetadata", "Table.Keys", "Type.TableKeys", "Diagnostics.ActivityId", "Diagnostics.CorrelationId",
    "Diagnostics.LogValue", "List.Alternate", "List.FindText", "List.Normalize", "List.Random", "List.ParallelInvoke", "Value.Metadata",
    "Value.ReplaceMetadata", "Value.ReplaceType", "Value.Optimize", "Value.VersionIdentity", "Diagnostics.LogFailure",
];

pub fn call(ev: &Ev, name: &str, a: &[Value]) -> Option<R<Value>> {
    if !BATCH_FNS.contains(&name) {
        return None;
    }
    Some(dispatch(ev, name, a))
}

fn arg<'v>(a: &'v [Value], i: usize, f: &str) -> R<&'v Value> {
    a.get(i).ok_or_else(|| MError::expr(format!("{f}: argument {} is missing.", i + 1)))
}

fn dispatch(ev: &Ev, name: &str, a: &[Value]) -> R<Value> {
    match name {
        "Value.RemoveMetadata" => Ok(arg(a, 0, name)?.clone()),
        "Diagnostics.LogValue" => Ok(arg(a, 1, name)?.clone()),
        "Diagnostics.ActivityId" | "Diagnostics.CorrelationId" => Ok(Value::Null),
        "Table.Keys" | "Type.TableKeys" => Ok(Value::List(Vec::new())),
        "List.Percentile" => percentile(a),
        // metadata is not kept: a value has an empty record, replacing it or its type (an ascription) leaves the value as it is
        "Value.Metadata" => Ok(Value::Record(Vec::new())),
        "Value.ReplaceMetadata" | "Value.ReplaceType" | "Value.Optimize" => Ok(arg(a, 0, name)?.clone()),
        "Value.VersionIdentity" => Ok(Value::Null),
        "Diagnostics.LogFailure" => ev.apply(arg(a, 1, name)?, Vec::new()),
        "List.ParallelInvoke" => match arg(a, 0, name)? {
            Value::List(fs) => fs.iter().map(|f| ev.apply(f, Vec::new())).collect::<R<Vec<_>>>().map(Value::List),
            other => Err(MError::expr(format!("{name}: a list of functions was expected, found {}.", other.type_name()))),
        },
        "List.Alternate" => alternate(a),
        "List.FindText" => find_text(a),
        "List.Normalize" => normalize(a),
        "List.Random" => random(a),
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

fn list_arg<'v>(a: &'v [Value], f: &str) -> R<&'v Vec<Value>> {
    match arg(a, 0, f)? {
        Value::List(l) => Ok(l),
        other => Err(MError::expr(format!("{f}: a list was expected, found {}.", other.type_name()))),
    }
}

fn count_arg(a: &[Value], i: usize, f: &str, default: usize) -> R<usize> {
    match a.get(i) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Num(n)) if *n >= 0.0 => Ok(*n as usize),
        Some(other) => Err(MError::expr(format!("{f}: argument {} must be a non-negative number, found {}.", i + 1, other.type_name()))),
    }
}

/// List.Alternate(list, count, repeatInterval = 1, offset = 0): skip `offset` items, then drop `count` items, keep `repeatInterval`
/// items, and repeat to the end of the list.
fn alternate(a: &[Value]) -> R<Value> {
    let f = "List.Alternate";
    let list = list_arg(a, f)?;
    let count = count_arg(a, 1, f, 0)?;
    let keep = count_arg(a, 2, f, 1)?;
    let offset = count_arg(a, 3, f, 0)?;
    let mut out: Vec<Value> = list.iter().take(offset).cloned().collect();
    let mut i = offset;
    while i < list.len() {
        i += count;
        out.extend(list.iter().skip(i).take(keep).cloned());
        i += keep;
        if count + keep == 0 {
            break;
        }
    }
    Ok(Value::List(out))
}

/// Does the value contain the text (case-insensitive)? Records and lists are searched item by item.
fn mentions(v: &Value, needle: &str) -> bool {
    match v {
        Value::Text(t) => t.to_lowercase().contains(needle),
        Value::Num(n) => n.to_string().to_lowercase().contains(needle),
        Value::List(l) => l.iter().any(|x| mentions(x, needle)),
        Value::Record(r) => r.iter().any(|(_, x)| mentions(x, needle)),
        _ => false,
    }
}

fn find_text(a: &[Value]) -> R<Value> {
    let f = "List.FindText";
    let list = list_arg(a, f)?;
    let Value::Text(t) = arg(a, 1, f)? else {
        return Err(MError::expr(format!("{f}: the search text must be text.")));
    };
    let needle = t.to_lowercase();
    Ok(Value::List(list.iter().filter(|v| mentions(v, &needle)).cloned().collect()))
}

/// List.Normalize(values, total = sum): each number divided by the total.
fn normalize(a: &[Value]) -> R<Value> {
    let f = "List.Normalize";
    let list = list_arg(a, f)?;
    let nums = list
        .iter()
        .map(|v| match v {
            Value::Num(n) => Ok(Some(*n)),
            Value::Null => Ok(None),
            other => Err(MError::expr(format!("{f}: a list item is {} instead of a number.", other.type_name()))),
        })
        .collect::<R<Vec<_>>>()?;
    let total = match a.get(1) {
        Some(Value::Num(t)) => *t,
        Some(Value::Null) | None => nums.iter().flatten().sum(),
        Some(other) => return Err(MError::expr(format!("{f}: the total must be a number, found {}.", other.type_name()))),
    };
    Ok(Value::List(nums.into_iter().map(|n| n.map_or(Value::Null, |x| Value::Num(x / total))).collect()))
}

/// List.Random(count, seed): numbers in [0, 1). A seed makes the sequence repeatable (xorshift64*; not Power Query's generator).
fn random(a: &[Value]) -> R<Value> {
    let count = count_arg(a, 0, "List.Random", 0)?;
    let mut state: u64 = match a.get(1) {
        Some(Value::Num(s)) => (*s as i64 as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1,
        _ => std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) | 1,
    };
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let x = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        out.push(Value::Num((x >> 11) as f64 / (1u64 << 53) as f64));
    }
    Ok(Value::List(out))
}
