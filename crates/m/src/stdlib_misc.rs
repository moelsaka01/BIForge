//! Smaller families of the M standard library: number conversions, Text.Format, Uri, Function, Expression, Diagnostics and
//! Type. Cases: tests/m/stdlib/misc.json.
use crate::ast::TypeExpr;
use crate::eval::Ev;
use crate::value::*;

type R<T> = MResult<T>;

pub const MISC_FNS: &[&str] = &[
    "Int8.From", "Int16.From", "Int32.From", "Double.From", "Single.From", "Decimal.From", "Currency.From", "Percentage.From", "Guid.From",
    "Text.Format", "Text.NewGuid", "Uri.EscapeDataString", "Uri.BuildQueryString", "Uri.Combine", "Uri.Parts", "Uri.FromParts",
    "Function.Invoke", "Function.IsDataSource", "Expression.Constant", "Expression.Identifier", "Expression.Evaluate",
    "Diagnostics.Trace", "Diagnostics.ValueToText", "Type.Is", "Type.IsNullable", "Type.NonNullable", "Type.ListItem",
    "Type.TableColumn", "Type.OpenRecord", "Type.ClosedRecord", "Type.IsOpenRecord",
];

pub fn call(ev: &Ev, name: &str, a: &[Value]) -> Option<R<Value>> {
    if !MISC_FNS.contains(&name) {
        return None;
    }
    Some(dispatch(ev, name, a))
}

/// M source text of a value (Expression.Constant, Diagnostics.ValueToText).
fn literal(v: &Value) -> R<String> {
    Ok(match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", *n as i64),
        Value::Num(n) => format!("{n}"),
        Value::Text(t) => format!("\"{}\"", t.replace('"', "\"\"")),
        Value::List(items) => format!("{{{}}}", items.iter().map(literal).collect::<R<Vec<_>>>()?.join(", ")),
        Value::Record(f) => {
            if f.is_empty() {
                "[]".into()
            } else {
                format!("[{}]", f.iter().map(|(k, x)| Ok(format!("{} = {}", ident(k), literal(x)?))).collect::<R<Vec<_>>>()?.join(", "))
            }
        }
        other => return Err(MError::expr(format!("Cannot write a value of type {} as M text.", other.type_name()))),
    })
}

fn ident(n: &str) -> String {
    let plain = !n.is_empty() && n.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_') && n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.');
    if plain {
        n.to_string()
    } else {
        format!("#\"{}\"", n.replace('"', "\"\""))
    }
}

fn plain_text(v: &Value) -> R<String> {
    Ok(match v {
        Value::Text(t) => t.clone(),
        Value::Num(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", *n as i64),
        Value::Num(n) => format!("{n}"),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        other => return Err(MError::expr(format!("A value of type {} cannot be converted to text.", other.type_name()))),
    })
}

fn escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn unescape(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn default_port(scheme: &str) -> f64 {
    match scheme {
        "http" => 80.0,
        "https" => 443.0,
        "ftp" => 21.0,
        _ => 0.0,
    }
}

fn text_arg<'v>(a: &'v [Value], i: usize, f: &str) -> R<&'v str> {
    match a.get(i) {
        Some(Value::Text(t)) => Ok(t),
        Some(other) => Err(MError::expr(format!("{f}: text was expected, found {}.", other.type_name()))),
        None => Err(MError::expr(format!("{f}: argument {} is missing.", i + 1))),
    }
}

fn type_arg<'v>(a: &'v [Value], i: usize, f: &str) -> R<&'v TypeExpr> {
    match a.get(i) {
        Some(Value::Type(t)) => Ok(t),
        _ => Err(MError::expr(format!("{f}: argument {} must be a type.", i + 1))),
    }
}

const NUMERIC: &[&str] = &["Int64.Type", "Int32.Type", "Int16.Type", "Int8.Type", "Byte.Type", "Double.Type", "Single.Type", "Decimal.Type", "Currency.Type", "Percentage.Type", "number"];

fn assignable(a: &TypeExpr, b: &TypeExpr) -> bool {
    use TypeExpr::*;
    match (a, b) {
        (_, Named(n)) if n == "any" => true,
        (x, y) if x == y => true,
        (Nullable(x), Nullable(y)) => assignable(x, y),
        (x, Nullable(y)) => assignable(x, y) || matches!(x, Named(n) if n == "null"),
        (Nullable(_), _) => false,
        (Named(x), Named(y)) => (y == "number" && NUMERIC.contains(&x.as_str())) || (y == "anynonnull" && x != "null"),
        (List(x), List(y)) => assignable(x, y),
        (List(_), Named(y)) => y == "list" || y == "anynonnull",
        (Record { .. }, Named(y)) => y == "record" || y == "anynonnull",
        (Table { .. }, Named(y)) => y == "table" || y == "anynonnull",
        _ => false,
    }
}

fn dispatch(ev: &Ev, name: &str, a: &[Value]) -> R<Value> {
    let arg = |i: usize| a.get(i).ok_or_else(|| MError::expr(format!("{name}: argument {} is missing.", i + 1)));
    let s = |i: usize| -> R<String> { ev.to_sql(arg(i)?) };
    let sql = |e: String| -> R<Value> { Ok(Value::Sql(e)) };
    match name {
        // ---- number conversions ----
        "Int8.From" => sql(format!("CAST(round(CAST({} AS DOUBLE)) AS TINYINT)", s(0)?)),
        "Int16.From" => sql(format!("CAST(round(CAST({} AS DOUBLE)) AS SMALLINT)", s(0)?)),
        "Int32.From" => sql(format!("CAST(round(CAST({} AS DOUBLE)) AS INTEGER)", s(0)?)),
        "Double.From" | "Decimal.From" => sql(format!("CAST({} AS DOUBLE)", s(0)?)),
        "Single.From" => sql(format!("CAST({} AS FLOAT)", s(0)?)),
        "Currency.From" => sql(format!("round(CAST({} AS DOUBLE), 4)", s(0)?)),
        "Percentage.From" => match arg(0)? {
            Value::Text(t) if t.trim().ends_with('%') => {
                let n: f64 = t.trim().trim_end_matches('%').trim().replace(',', "").parse().map_err(|_| MError::expr("We couldn't convert the text to a percentage."))?;
                Ok(Value::Num(n / 100.0))
            }
            _ => sql(format!("CAST({} AS DOUBLE)", s(0)?)),
        },
        "Guid.From" => match arg(0)? {
            Value::Text(t) => {
                let hex: String = t.trim().trim_matches(|c| c == '{' || c == '}').replace('-', "").to_lowercase();
                if hex.len() != 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(MError::expr("We couldn't convert the text to a Guid."));
                }
                Ok(Value::Text(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])))
            }
            _ => sql(format!("lower(CAST({} AS VARCHAR))", s(0)?)),
        },
        "Text.NewGuid" => sql("CAST(uuid() AS VARCHAR)".into()),
        "Text.Format" => {
            let template = text_arg(a, 0, name)?;
            let mut out = String::new();
            let mut rest = template;
            while let Some(i) = rest.find("#{") {
                out.push_str(&rest[..i]);
                let Some(j) = rest[i..].find('}') else {
                    return Err(MError::expr("Text.Format: a placeholder is not closed."));
                };
                let key = &rest[i + 2..i + j];
                let v = match arg(1)? {
                    Value::List(items) => key.parse::<usize>().ok().and_then(|k| items.get(k)),
                    Value::Record(f) => f.iter().find(|(k, _)| k == key).map(|(_, v)| v),
                    _ => return Err(MError::expr("Text.Format: the arguments must be a list or a record.")),
                };
                out.push_str(&plain_text(v.ok_or_else(|| MError::expr(format!("Text.Format: there is no argument '{key}'.")))?)?);
                rest = &rest[i + j + 1..];
            }
            out.push_str(rest);
            Ok(Value::Text(out))
        }
        // ---- Uri ----
        "Uri.EscapeDataString" => Ok(Value::Text(escape(text_arg(a, 0, name)?))),
        "Uri.BuildQueryString" => {
            let Value::Record(f) = arg(0)? else {
                return Err(MError::expr("Uri.BuildQueryString needs a record."));
            };
            let parts: R<Vec<String>> = f.iter().map(|(k, v)| Ok(format!("{}={}", escape(k), escape(&plain_text(v)?)))).collect();
            Ok(Value::Text(parts?.join("&")))
        }
        "Uri.Combine" => {
            let (base, rel) = (text_arg(a, 0, name)?, text_arg(a, 1, name)?);
            if rel.contains("://") {
                return Ok(Value::Text(rel.to_string()));
            }
            let (origin, path) = match base.find("://") {
                Some(i) => match base[i + 3..].find('/') {
                    Some(j) => base.split_at(i + 3 + j),
                    None => (base, "/"),
                },
                None => return Err(MError::expr("Uri.Combine needs an absolute base address.")),
            };
            let joined = if rel.starts_with('/') {
                rel.to_string()
            } else {
                let dir = &path[..path.rfind('/').map(|i| i + 1).unwrap_or(0)];
                format!("{dir}{rel}")
            };
            Ok(Value::Text(format!("{origin}{joined}")))
        }
        "Uri.Parts" => {
            let url = text_arg(a, 0, name)?;
            let (scheme, rest) = url.split_once("://").ok_or_else(|| MError::expr("The address must start with a scheme such as https://."))?;
            let (rest, fragment) = rest.split_once('#').unwrap_or((rest, ""));
            let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
            let (authority, path) = match rest.find('/') {
                Some(i) => rest.split_at(i),
                None => (rest, "/"),
            };
            let (userinfo, hostport) = authority.rsplit_once('@').unwrap_or(("", authority));
            let (user, pass) = userinfo.split_once(':').unwrap_or((userinfo, ""));
            let (host, port) = match hostport.rsplit_once(':') {
                Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h, p.parse::<f64>().unwrap_or(0.0)),
                _ => (hostport, default_port(scheme)),
            };
            let q: Vec<(String, Value)> = query
                .split('&')
                .filter(|p| !p.is_empty())
                .map(|p| {
                    let (k, v) = p.split_once('=').unwrap_or((p, ""));
                    (unescape(k), Value::Text(unescape(v)))
                })
                .collect();
            Ok(Value::Record(vec![
                ("Scheme".into(), Value::Text(scheme.to_string())),
                ("Host".into(), Value::Text(host.to_string())),
                ("Port".into(), Value::Num(port)),
                ("Path".into(), Value::Text(path.to_string())),
                ("Query".into(), Value::Record(q)),
                ("Fragment".into(), Value::Text(fragment.to_string())),
                ("UserName".into(), Value::Text(user.to_string())),
                ("Password".into(), Value::Text(pass.to_string())),
            ]))
        }
        "Uri.FromParts" => {
            let Value::Record(f) = arg(0)? else {
                return Err(MError::expr("Uri.FromParts needs a record."));
            };
            let get = |k: &str| f.iter().find(|(n, _)| n == k).map(|(_, v)| v);
            let text = |k: &str| -> R<String> { get(k).map(plain_text).transpose().map(|o| o.unwrap_or_default()) };
            let scheme = text("Scheme")?;
            let mut url = format!("{scheme}://");
            let user = text("UserName")?;
            if !user.is_empty() {
                url.push_str(&user);
                let pass = text("Password")?;
                if !pass.is_empty() {
                    url.push(':');
                    url.push_str(&pass);
                }
                url.push('@');
            }
            url.push_str(&text("Host")?);
            if let Some(Value::Num(p)) = get("Port") {
                if *p != default_port(&scheme) && *p != 0.0 {
                    url.push_str(&format!(":{}", *p as i64));
                }
            }
            let path = text("Path")?;
            url.push_str(if path.is_empty() { "/" } else { &path });
            if let Some(Value::Record(q)) = get("Query") {
                if !q.is_empty() {
                    let parts: R<Vec<String>> = q.iter().map(|(k, v)| Ok(format!("{}={}", escape(k), escape(&plain_text(v)?)))).collect();
                    url.push('?');
                    url.push_str(&parts?.join("&"));
                }
            }
            let frag = text("Fragment")?;
            if !frag.is_empty() {
                url.push('#');
                url.push_str(&frag);
            }
            Ok(Value::Text(url))
        }
        // ---- Function, Expression, Diagnostics ----
        "Function.Invoke" => {
            let Value::List(args) = arg(1)? else {
                return Err(MError::expr("Function.Invoke needs a list of arguments."));
            };
            ev.apply(arg(0)?, args.clone())
        }
        "Function.IsDataSource" => Ok(Value::Bool(false)),
        "Expression.Constant" | "Diagnostics.ValueToText" => Ok(Value::Text(literal(arg(0)?)?)),
        "Expression.Identifier" => Ok(Value::Text(ident(text_arg(a, 0, name)?))),
        "Expression.Evaluate" => {
            let text = text_arg(a, 0, name)?;
            let expr = crate::parser::parse(text).map_err(|e| MError::expr(format!("Expression.Evaluate: {e}")))?;
            let scope = Scope::new(None);
            if let Some(Value::Record(env)) = a.get(1) {
                for (k, v) in env {
                    scope.set(k, v.clone());
                }
            }
            ev.eval(&expr, &scope)
        }
        // the trace goes nowhere (BIForge has no trace log); the value passes through, as the function documents
        "Diagnostics.Trace" => Ok(arg(2)?.clone()),
        // ---- types ----
        "Type.Is" => Ok(Value::Bool(assignable(type_arg(a, 0, name)?, type_arg(a, 1, name)?))),
        "Type.IsNullable" => Ok(Value::Bool(matches!(type_arg(a, 0, name)?, TypeExpr::Nullable(_)) || matches!(type_arg(a, 0, name)?, TypeExpr::Named(n) if n == "any" || n == "null"))),
        "Type.NonNullable" => Ok(Value::Type(match type_arg(a, 0, name)? {
            TypeExpr::Nullable(t) => (**t).clone(),
            t => t.clone(),
        })),
        "Type.ListItem" => match type_arg(a, 0, name)? {
            TypeExpr::List(t) => Ok(Value::Type((**t).clone())),
            _ => Err(MError::expr("Type.ListItem needs a list type.")),
        },
        "Type.TableColumn" => {
            let col = text_arg(a, 1, name)?;
            match type_arg(a, 0, name)? {
                TypeExpr::Table { fields } => match fields.iter().find(|(n, _)| n == col) {
                    Some((_, t)) => Ok(Value::Type(t.clone().unwrap_or_else(|| TypeExpr::Named("any".into())))),
                    None => Err(MError::expr(format!("The column '{col}' of the table type wasn't found."))),
                },
                _ => Err(MError::expr("Type.TableColumn needs a table type.")),
            }
        }
        "Type.OpenRecord" | "Type.ClosedRecord" => match type_arg(a, 0, name)? {
            TypeExpr::Record { fields, .. } => Ok(Value::Type(TypeExpr::Record { fields: fields.clone(), open: name == "Type.OpenRecord" })),
            _ => Err(MError::expr(format!("{name} needs a record type."))),
        },
        "Type.IsOpenRecord" => match type_arg(a, 0, name)? {
            TypeExpr::Record { open, .. } => Ok(Value::Bool(*open)),
            _ => Err(MError::expr("Type.IsOpenRecord needs a record type.")),
        },
        _ => Err(MError::unsupported(format!("{name} is not supported yet."))),
    }
}
