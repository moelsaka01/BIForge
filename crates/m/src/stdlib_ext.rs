//! More of the M standard library, added family by family. Scalar functions return SQL (they work on table columns and on
//! literals alike); functions that build lists and records work on literal values and are evaluated here. Every function in
//! `EXT_FNS` has cases in tests/m/stdlib/*.json that crates/engine/tests/m_stdlib.rs runs.
use crate::eval::Ev;
use crate::value::*;

type R<T> = MResult<T>;

pub const EXT_FNS: &[&str] = &[
    // numbers
    "Number.BitwiseAnd", "Number.BitwiseOr", "Number.BitwiseXor", "Number.BitwiseNot", "Number.BitwiseShiftLeft", "Number.BitwiseShiftRight",
    "Number.Combinations", "Number.Permutations", "Number.Factorial", "Number.Cosh", "Number.Sinh", "Number.Tanh", "Number.Log",
    "Number.IsNaN", "Number.FromText", "Number.Random", "Number.RandomBetween",
    // named values (constants)
    "Number.PI", "Number.E", "Number.Epsilon", "Number.NaN", "Number.PositiveInfinity", "Number.NegativeInfinity",
    // logical
    "Logical.FromText", "Logical.ToText",
    // text
    "Text.At", "Text.Insert", "Text.PositionOfAny", "Text.Proper", "Text.Remove", "Text.RemoveRange", "Text.ReplaceRange", "Text.Select",
    "Text.Range", "Text.Split", "Text.SplitAny", "Text.ToList",
];

/// Named values: `Number.PI` and friends.
pub fn constant(name: &str) -> Option<Value> {
    match name {
        "Number.PI" => Some(Value::Num(std::f64::consts::PI)),
        "Number.E" => Some(Value::Num(std::f64::consts::E)),
        "Number.Epsilon" => Some(Value::Num(f64::from_bits(1))),
        "Number.NaN" => Some(Value::Num(f64::NAN)),
        "Number.PositiveInfinity" => Some(Value::Num(f64::INFINITY)),
        "Number.NegativeInfinity" => Some(Value::Num(f64::NEG_INFINITY)),
        _ => None,
    }
}

/// The text values a character-set argument stands for: a text ("abc") or a list of one-character texts.
fn char_set(v: &Value, f: &str) -> R<Vec<char>> {
    match v {
        Value::Text(t) => Ok(t.chars().collect()),
        Value::List(items) => {
            let mut out = Vec::new();
            for i in items {
                match i {
                    Value::Text(t) if t.chars().count() == 1 => out.extend(t.chars()),
                    _ => return Err(MError::expr(format!("{f}: the characters must be a text or a list of one-character texts."))),
                }
            }
            Ok(out)
        }
        other => Err(MError::expr(format!("{f}: the characters must be a text or a list, found {}.", other.type_name()))),
    }
}

/// A regular-expression class "[...]" that matches exactly these characters.
fn class(chars: &[char]) -> String {
    let mut s = String::from("[");
    for c in chars {
        if "\\]^-[".contains(*c) {
            s.push('\\');
        }
        s.push(*c);
    }
    s.push(']');
    s
}

/// Every function added in the stdlib_*.rs modules.
pub fn all_names() -> &'static [&'static str] {
    static ALL: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    ALL.get_or_init(|| EXT_FNS.iter().chain(crate::stdlib_list::LIST_FNS.iter()).chain(crate::stdlib_date::DATE_FNS.iter()).chain(crate::stdlib_rec::REC_FNS.iter()).chain(crate::fold::TABLE_EXT_FNS.iter()).chain(crate::stdlib_misc::MISC_FNS.iter()).copied().collect())
}

pub fn is_ext(name: &str) -> bool {
    all_names().contains(&name)
}

pub fn call(ev: &Ev, name: &str, a: &[Value]) -> Option<R<Value>> {
    if EXT_FNS.contains(&name) {
        return Some(dispatch(ev, name, a));
    }
    crate::stdlib_list::call(ev, name, a)
        .or_else(|| crate::stdlib_date::call(ev, name, a))
        .or_else(|| crate::stdlib_rec::call(ev, name, a))
        .or_else(|| ev.table_ext(name, a).transpose())
        .or_else(|| crate::stdlib_misc::call(ev, name, a))
}

fn dispatch(ev: &Ev, name: &str, a: &[Value]) -> R<Value> {
    let arg = |i: usize| a.get(i).ok_or_else(|| MError::expr(format!("{name}: argument {} is missing.", i + 1)));
    let s = |i: usize| -> R<String> { ev.to_sql(arg(i)?) };
    let sql = |e: String| -> R<Value> { Ok(Value::Sql(e)) };
    let int = |i: usize| -> R<String> { Ok(format!("CAST({} AS BIGINT)", s(i)?)) };
    match name {
        // ---- numbers ----
        "Number.BitwiseAnd" => sql(format!("({} & {})", int(0)?, int(1)?)),
        "Number.BitwiseOr" => sql(format!("({} | {})", int(0)?, int(1)?)),
        "Number.BitwiseXor" => sql(format!("xor({}, {})", int(0)?, int(1)?)),
        "Number.BitwiseNot" => sql(format!("(~{})", int(0)?)),
        "Number.BitwiseShiftLeft" => sql(format!("({} << {})", int(0)?, int(1)?)),
        "Number.BitwiseShiftRight" => sql(format!("({} >> {})", int(0)?, int(1)?)),
        "Number.Factorial" => sql(format!("CAST(factorial(CAST({} AS INTEGER)) AS DOUBLE)", s(0)?)),
        "Number.Combinations" => {
            let (n, k) = (s(0)?, s(1)?);
            sql(format!("round(exp(lgamma({n} + 1) - lgamma({k} + 1) - lgamma({n} - {k} + 1)))"))
        }
        "Number.Permutations" => {
            let (n, k) = (s(0)?, s(1)?);
            sql(format!("round(exp(lgamma({n} + 1) - lgamma({n} - {k} + 1)))"))
        }
        "Number.Cosh" => sql(format!("cosh({})", s(0)?)),
        "Number.Sinh" => sql(format!("sinh({})", s(0)?)),
        "Number.Tanh" => sql(format!("tanh({})", s(0)?)),
        "Number.Log" => match a.get(1) {
            Some(_) => sql(format!("(ln({}) / ln({}))", s(0)?, s(1)?)),
            None => sql(format!("ln({})", s(0)?)),
        },
        "Number.IsNaN" => sql(format!("isnan(CAST({} AS DOUBLE))", s(0)?)),
        "Number.FromText" => sql(format!("CAST(replace(trim({}), ',', '') AS DOUBLE)", s(0)?)),
        "Number.Random" => sql("random()".into()),
        "Number.RandomBetween" => sql(format!("({lo} + random() * ({hi} - {lo}))", lo = s(0)?, hi = s(1)?)),
        // ---- logical ----
        "Logical.FromText" => sql(format!(
            "(CASE lower(trim({t})) WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE ELSE error('We couldn''t convert to Logical.') END)",
            t = s(0)?
        )),
        "Logical.ToText" => sql(format!("(CASE WHEN {b} THEN 'true' ELSE 'false' END)", b = s(0)?)),
        // ---- text ----
        "Text.At" => sql(format!("substring({}, {} + 1, 1)", s(0)?, s(1)?)),
        "Text.Insert" => {
            let (t, o) = (s(0)?, s(1)?);
            sql(format!("(left({t}, {o}) || {} || substring({t}, {o} + 1))", s(2)?))
        }
        "Text.PositionOfAny" => {
            let chars = char_set(arg(1)?, name)?;
            let t = s(0)?;
            let parts: Vec<String> = chars.iter().map(|c| format!("instr({t}, {})", ql(&c.to_string()))).collect();
            if parts.is_empty() {
                return sql("-1".into());
            }
            sql(format!("COALESCE(list_min(list_filter([{}], x -> x > 0)) - 1, -1)", parts.join(", ")))
        }
        "Text.Proper" => sql(format!(
            "array_to_string(list_transform(regexp_extract_all({}, '\\pL+|\\PL+'), w -> CASE WHEN regexp_matches(w, '^\\pL') THEN upper(w[1]) || lower(w[2:]) ELSE w END), '')",
            s(0)?
        )),
        "Text.Remove" => {
            let chars = char_set(arg(1)?, name)?;
            if chars.is_empty() {
                return sql(s(0)?);
            }
            sql(format!("regexp_replace({}, {}, '', 'g')", s(0)?, ql(&class(&chars))))
        }
        "Text.Select" => {
            let chars = char_set(arg(1)?, name)?;
            if chars.is_empty() {
                return sql("''".into());
            }
            let neg = class(&chars).replacen('[', "[^", 1);
            sql(format!("regexp_replace({}, {}, '', 'g')", s(0)?, ql(&neg)))
        }
        "Text.RemoveRange" => {
            let (t, o) = (s(0)?, s(1)?);
            let n = if a.get(2).is_some() { s(2)? } else { "1".into() };
            sql(format!("(left({t}, {o}) || substring({t}, {o} + {n} + 1))"))
        }
        "Text.ReplaceRange" => {
            let (t, o, n) = (s(0)?, s(1)?, s(2)?);
            sql(format!("(left({t}, {o}) || {} || substring({t}, {o} + {n} + 1))", s(3)?))
        }
        "Text.Range" => match a.get(2) {
            Some(_) => sql(format!("substring({}, {} + 1, {})", s(0)?, s(1)?, s(2)?)),
            None => sql(format!("substring({}, {} + 1)", s(0)?, s(1)?)),
        },
        "Text.Split" | "Text.SplitAny" | "Text.ToList" => {
            let Value::Text(t) = arg(0)? else {
                return Err(MError::unsupported(format!("{name} works on a text value here, not on a column; use Splitter.* for columns.")));
            };
            let parts: Vec<String> = match name {
                "Text.ToList" => t.chars().map(|c| c.to_string()).collect(),
                "Text.Split" => match arg(1)? {
                    Value::Text(sep) if !sep.is_empty() => t.split(sep.as_str()).map(String::from).collect(),
                    _ => return Err(MError::expr("The separator must be a non-empty text.")),
                },
                _ => {
                    let seps = char_set(arg(1)?, name)?;
                    t.split(|c| seps.contains(&c)).map(String::from).collect()
                }
            };
            Ok(Value::List(parts.into_iter().map(Value::Text).collect()))
        }
        _ => Err(MError::unsupported(format!("{name} is not supported yet."))),
    }
}
