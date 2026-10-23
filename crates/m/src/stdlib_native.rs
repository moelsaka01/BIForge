//! Splitters and combiners as values: `Splitter.SplitTextByDelimiter(",")` and friends return a function that can be called on a
//! text ("a,b" gives {"a", "b"}), `Combiner.CombineTextByDelimiter("-")` one that can be called on a list of texts. (Table.SplitColumn
//! folds the same constructors to SQL in fold.rs; this module is the call on a literal value.) Cases: tests/m/stdlib/splitter.json.
use crate::eval::Ev;
use crate::value::*;

type R<T> = MResult<T>;

pub const NATIVE_FNS: &[&str] = &[
    "Splitter.SplitByNothing", "Splitter.SplitTextByRanges", "Splitter.SplitTextByEachDelimiter", "Combiner.CombineTextByEachDelimiter",
    "Combiner.CombineTextByLengths", "Combiner.CombineTextByPositions", "Comparer.Equals", "Comparer.FromCulture", "Function.From",
    "Function.InvokeAfter",
];

pub fn call(ev: &Ev, name: &str, a: &[Value]) -> Option<R<Value>> {
    if !NATIVE_FNS.contains(&name) {
        return None;
    }
    Some(match name {
        "Splitter.SplitByNothing" | "Splitter.SplitTextByRanges" | "Splitter.SplitTextByEachDelimiter" | "Combiner.CombineTextByEachDelimiter" | "Combiner.CombineTextByLengths" | "Combiner.CombineTextByPositions" => {
            Ok(Value::Native(name.to_string(), a.to_vec()))
        }
        // the culture is accepted and ignored: ordinal comparison, as everywhere in BIForge's M engine
        "Comparer.FromCulture" => Ok(Value::Builtin("Comparer.Ordinal".into())),
        "Comparer.Equals" => match (a.first(), a.get(1), a.get(2)) {
            (Some(cmp), Some(Value::Text(x)), Some(Value::Text(y))) => Ok(Value::Bool(if matches!(cmp, Value::Builtin(n) if n == "Comparer.OrdinalIgnoreCase") { x.to_lowercase() == y.to_lowercase() } else { x == y })),
            (Some(_), Some(x), Some(y)) => Ok(Value::Bool(crate::stdlib::values_equal(x, y))),
            _ => Err(MError::expr("Comparer.Equals needs a comparer and two values.")),
        },
        // the function of Function.From is the one given; the type is not checked
        "Function.From" => a.get(1).cloned().ok_or_else(|| MError::expr("Function.From needs a type and a function.")),
        // the delay is ignored: BIForge evaluates the call at once
        "Function.InvokeAfter" => match a.first() {
            Some(f) => ev.apply(f, vec![]),
            None => Err(MError::expr("Function.InvokeAfter needs a function.")),
        },
        _ => Err(MError::unsupported(format!("{name} is not supported yet."))),
    })
}

fn texts(v: &Value, what: &str) -> R<Vec<String>> {
    match v {
        Value::Text(t) => Ok(vec![t.clone()]),
        Value::List(l) => l.iter().map(|x| if let Value::Text(t) = x { Ok(t.clone()) } else { Err(MError::expr(format!("{what} must be text."))) }).collect(),
        _ => Err(MError::expr(format!("{what} must be text or a list of text."))),
    }
}

fn nums(v: &Value, what: &str) -> R<Vec<usize>> {
    match v {
        Value::List(l) => l.iter().map(|x| if let Value::Num(n) = x { Ok(*n as usize) } else { Err(MError::expr(format!("{what} must be numbers."))) }).collect(),
        _ => Err(MError::expr(format!("{what} must be a list of numbers."))),
    }
}

fn slice(chars: &[char], start: usize, len: usize) -> String {
    chars.iter().skip(start).take(len).collect()
}

/// Calls a splitter or combiner value on its argument.
pub fn apply(name: &str, ctor: &[Value], args: &[Value]) -> R<Value> {
    let arg = args.first().ok_or_else(|| MError::expr("There are not enough arguments to the function."))?;
    match name {
        n if n.starts_with("Splitter.") => {
            let text = match arg {
                Value::Text(t) => t.clone(),
                Value::Null => return Ok(Value::List(vec![])),
                _ => return Err(MError::expr("A splitter can only be called on text.")),
            };
            let chars: Vec<char> = text.chars().collect();
            let parts: Vec<String> = match n {
                "Splitter.SplitByNothing" => vec![text.clone()],
                "Splitter.SplitTextByDelimiter" => {
                    let Some(Value::Text(d)) = ctor.first() else { return Err(MError::expr("The delimiter must be text.")) };
                    // QuoteStyle.Csv (the default) keeps a delimiter inside double quotes; QuoteStyle.None splits everywhere
                    let csv = !matches!(ctor.get(1), Some(Value::Num(q)) if *q == 0.0);
                    split_quoted(&text, d, csv)
                }
                "Splitter.SplitTextByAnyDelimiter" => {
                    let seps: Vec<char> = texts(ctor.first().ok_or_else(|| MError::expr("The delimiters are missing."))?, "The delimiters")?.concat().chars().collect();
                    text.split(|c| seps.contains(&c)).map(String::from).collect()
                }
                "Splitter.SplitTextByEachDelimiter" => {
                    let seps = texts(ctor.first().ok_or_else(|| MError::expr("The delimiters are missing."))?, "The delimiters")?;
                    let mut out = Vec::new();
                    let mut rest = text.as_str();
                    for d in &seps {
                        match rest.find(d.as_str()) {
                            Some(i) => {
                                out.push(rest[..i].to_string());
                                rest = &rest[i + d.len()..];
                            }
                            None => break,
                        }
                    }
                    out.push(rest.to_string());
                    out
                }
                "Splitter.SplitTextByPositions" => {
                    let pos = nums(ctor.first().ok_or_else(|| MError::expr("The positions are missing."))?, "The positions")?;
                    (0..pos.len()).map(|i| slice(&chars, pos[i], pos.get(i + 1).map(|n| n.saturating_sub(pos[i])).unwrap_or(usize::MAX))).collect()
                }
                "Splitter.SplitTextByLengths" => {
                    let lens = nums(ctor.first().ok_or_else(|| MError::expr("The lengths are missing."))?, "The lengths")?;
                    let mut at = 0;
                    lens.iter().map(|l| {
                        let piece = slice(&chars, at, *l);
                        at += l;
                        piece
                    }).collect()
                }
                "Splitter.SplitTextByRepeatedLengths" => {
                    let Some(Value::Num(n)) = ctor.first() else { return Err(MError::expr("The length must be a number.")) };
                    let n = (*n as usize).max(1);
                    chars.chunks(n).map(|c| c.iter().collect()).collect()
                }
                "Splitter.SplitTextByRanges" => {
                    let Some(Value::List(ranges)) = ctor.first() else { return Err(MError::expr("The ranges must be a list of {offset, count}.")) };
                    ranges
                        .iter()
                        .map(|r| match r {
                            Value::List(p) if p.len() == 2 => match (&p[0], &p[1]) {
                                (Value::Num(o), Value::Num(c)) => Ok(slice(&chars, *o as usize, *c as usize)),
                                _ => Err(MError::expr("A range is {offset, count}.")),
                            },
                            _ => Err(MError::expr("A range is {offset, count}.")),
                        })
                        .collect::<R<_>>()?
                }
                other => return Err(MError::unsupported(format!("{other} cannot be called on a value here."))),
            };
            Ok(Value::List(parts.into_iter().map(Value::Text).collect()))
        }
        n if n.starts_with("Combiner.") => {
            let Value::List(items) = arg else {
                return Err(MError::expr("A combiner can only be called on a list."));
            };
            let parts: Vec<String> = items.iter().map(|x| match x { Value::Text(t) => Ok(t.clone()), Value::Null => Ok(String::new()), _ => Err(MError::expr("A combiner needs a list of text.")) }).collect::<R<_>>()?;
            let s = match n {
                "Combiner.CombineTextByDelimiter" => {
                    let Some(Value::Text(d)) = ctor.first() else { return Err(MError::expr("The delimiter must be text.")) };
                    parts.join(d)
                }
                "Combiner.CombineTextByEachDelimiter" => {
                    let seps = texts(ctor.first().ok_or_else(|| MError::expr("The delimiters are missing."))?, "The delimiters")?;
                    let mut out = String::new();
                    for (i, p) in parts.iter().enumerate() {
                        out.push_str(p);
                        if i + 1 < parts.len() {
                            out.push_str(seps.get(i).or(seps.last()).map(String::as_str).unwrap_or(""));
                        }
                    }
                    out
                }
                "Combiner.CombineTextByLengths" => {
                    let lens = nums(ctor.first().ok_or_else(|| MError::expr("The lengths are missing."))?, "The lengths")?;
                    parts.iter().zip(&lens).map(|(p, l)| format!("{:<width$}", p.chars().take(*l).collect::<String>(), width = *l)).collect()
                }
                "Combiner.CombineTextByPositions" => {
                    let pos = nums(ctor.first().ok_or_else(|| MError::expr("The positions are missing."))?, "The positions")?;
                    let mut out: Vec<char> = Vec::new();
                    for (p, at) in parts.iter().zip(&pos) {
                        while out.len() < *at {
                            out.push(' ');
                        }
                        out.truncate(*at);
                        out.extend(p.chars());
                    }
                    out.into_iter().collect()
                }
                other => return Err(MError::unsupported(format!("{other} cannot be called on a value here."))),
            };
            Ok(Value::Text(s))
        }
        other => Err(MError::unsupported(format!("{other}(...) cannot be called directly here."))),
    }
}

/// Splits at every `delim`; with `csv`, a delimiter inside a double-quoted part does not split and the quotes are removed ("" is one quote).
fn split_quoted(text: &str, delim: &str, csv: bool) -> Vec<String> {
    if delim.is_empty() {
        return vec![text.to_string()];
    }
    if !csv {
        return text.split(delim).map(String::from).collect();
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < text.len() {
        if bytes[i] == b'"' {
            if quoted && text[i + 1..].starts_with('"') {
                cur.push('"');
                i += 2;
                continue;
            }
            quoted = !quoted;
            i += 1;
        } else if !quoted && text[i..].starts_with(delim) {
            out.push(std::mem::take(&mut cur));
            i += delim.len();
        } else {
            let c = text[i..].chars().next().unwrap_or(' ');
            cur.push(c);
            i += c.len_utf8();
        }
    }
    out.push(cur);
    out
}
