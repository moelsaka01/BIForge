//! Library functions that are not table steps: text, number, date, list and record helpers, constants.
use crate::ast::TypeExpr;
use crate::eval::Ev;
use crate::fold::TABLE_FNS;
use crate::value::*;

type R<T> = MResult<T>;

const SCALAR_FNS: &[&str] = &[
    "Text.Upper", "Text.Lower", "Text.Trim", "Text.TrimStart", "Text.TrimEnd", "Text.Clean", "Text.Length", "Text.Contains",
    "Text.StartsWith", "Text.EndsWith", "Text.Start", "Text.End", "Text.Middle", "Text.Replace", "Text.PadStart", "Text.PadEnd",
    "Text.From", "Text.Reverse", "Text.Repeat", "Text.PositionOf", "Text.Combine", "Number.Round", "Number.RoundUp",
    "Number.RoundDown", "Number.Abs", "Number.Sign", "Number.Sqrt", "Number.Power", "Number.Mod", "Number.IntegerDivide",
    "Number.From", "Number.ToText", "Int64.From", "Date.Year", "Date.Month", "Date.Day", "Date.AddDays", "Date.AddMonths",
    "Date.AddYears", "Date.Quarter", "Date.StartOfMonth", "Date.EndOfMonth", "Date.StartOfYear", "Date.DayOfWeek", "Date.From",
    "DateTime.Date", "DateTime.From", "Logical.From", "#date", "#datetime", "#duration", "#time", "Record.Field",
    "Record.FieldNames", "List.Sum", "List.Count", "List.NonNullCount", "List.Min", "List.Max", "List.Average",
    "List.StandardDeviation", "List.Median", "List.Distinct", "List.Contains", "List.Transform", "List.Select", "List.Numbers",
    "List.Combine", "List.Union", "List.Sort", "List.Reverse", "List.First", "List.Last", "List.Buffer", "List.IsEmpty",
    "Splitter.SplitTextByDelimiter", "Splitter.SplitTextByAnyDelimiter", "Splitter.SplitTextByPositions",
    "Splitter.SplitTextByLengths", "Splitter.SplitTextByRepeatedLengths", "Splitter.SplitTextByEachDelimiter",
    "Splitter.SplitTextByCharacterTransition", "Replacer.ReplaceText", "Replacer.ReplaceValue", "Comparer.Ordinal",
    "Comparer.OrdinalIgnoreCase", "Text.BeforeDelimiter", "Text.AfterDelimiter", "Text.BetweenDelimiters", "Number.Ln",
    "Number.Log10", "Number.Exp", "Number.Sin", "Number.Cos", "Number.Tan", "Number.IsEven", "Number.IsOdd", "Date.DayOfYear",
    "Date.MonthName", "Date.DayOfWeekName", "Date.EndOfYear", "Date.StartOfQuarter", "Date.EndOfQuarter", "Date.DaysInMonth",
    "Date.AddQuarters", "Date.AddWeeks", "DateTime.Hour", "DateTime.Minute", "DateTime.Second", "Time.Hour", "Time.Minute",
    "Time.Second", "Combiner.CombineTextByDelimiter",
];

pub fn is_builtin(name: &str) -> bool {
    SCALAR_FNS.contains(&name) || TABLE_FNS.contains(&name) || crate::stdlib_ext::is_ext(name)
}

/// Named constants: enumerations and type values.
pub fn constant(name: &str) -> Option<Value> {
    if let Some(v) = crate::stdlib_ext::constant(name) {
        return Some(v);
    }
    let num = |n: f64| Some(Value::Num(n));
    let ty = |t: &str| Some(Value::Type(TypeExpr::Named(t.to_string())));
    match name {
        "Order.Ascending" => num(0.0),
        "Order.Descending" => num(1.0),
        "JoinKind.Inner" => num(0.0),
        "JoinKind.LeftOuter" => num(1.0),
        "JoinKind.RightOuter" => num(2.0),
        "JoinKind.FullOuter" => num(3.0),
        "JoinKind.LeftAnti" => num(4.0),
        "JoinKind.RightAnti" => num(5.0),
        "GroupKind.Local" => num(0.0),
        "GroupKind.Global" => num(1.0),
        "MissingField.Error" => num(0.0),
        "MissingField.Ignore" => num(1.0),
        "MissingField.UseNull" => num(2.0),
        "QuoteStyle.None" => num(0.0),
        "QuoteStyle.Csv" => num(1.0),
        "Day.Sunday" => num(0.0),
        "Day.Monday" => num(1.0),
        "Day.Tuesday" => num(2.0),
        "Day.Wednesday" => num(3.0),
        "Day.Thursday" => num(4.0),
        "Day.Friday" => num(5.0),
        "Day.Saturday" => num(6.0),
        "RoundingMode.Up" => num(0.0),
        "RoundingMode.Down" => num(1.0),
        "RoundingMode.AwayFromZero" => num(2.0),
        "RoundingMode.TowardZero" => num(3.0),
        "RoundingMode.ToEven" => num(4.0),
        "Int64.Type" | "Int32.Type" | "Int16.Type" | "Int8.Type" | "Byte.Type" | "Double.Type" | "Single.Type" | "Decimal.Type"
        | "Currency.Type" | "Percentage.Type" => ty(name),
        "Text.Type" => ty("text"),
        "Number.Type" => ty("number"),
        "Logical.Type" => ty("logical"),
        "Date.Type" => ty("date"),
        "DateTime.Type" => ty("datetime"),
        "Time.Type" => ty("time"),
        "DateTimeZone.Type" => ty("datetimezone"),
        "Any.Type" => ty("any"),
        "Binary.Type" => ty("binary"),
        _ => None,
    }
}

pub fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Num(x), Value::Num(y)) => x == y,
        (Value::Text(x), Value::Text(y)) => x == y,
        (Value::List(x), Value::List(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| values_equal(p, q)),
        (Value::Record(x), Value::Record(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.iter().any(|(k2, v2)| k == k2 && values_equal(v, v2)))
        }
        _ => false,
    }
}

pub fn value_is(v: &Value, t: &TypeExpr) -> R<bool> {
    Ok(match t {
        TypeExpr::Nullable(inner) => matches!(v, Value::Null) || value_is(v, inner)?,
        TypeExpr::List(_) => matches!(v, Value::List(_)),
        TypeExpr::Record { .. } => matches!(v, Value::Record(_)),
        TypeExpr::Table { .. } => matches!(v, Value::Table(_)),
        TypeExpr::Named(n) => match n.as_str() {
            "any" => true,
            "anynonnull" => !matches!(v, Value::Null),
            "null" => matches!(v, Value::Null),
            "text" => matches!(v, Value::Text(_)),
            "number" => matches!(v, Value::Num(_)),
            "Int64.Type" | "Int32.Type" | "Int16.Type" | "Int8.Type" | "Byte.Type" => matches!(v, Value::Num(n) if n.fract() == 0.0),
            "logical" => matches!(v, Value::Bool(_)),
            "list" => matches!(v, Value::List(_)),
            "record" => matches!(v, Value::Record(_)),
            "table" => matches!(v, Value::Table(_)),
            "function" => matches!(v, Value::Func(_) | Value::Builtin(_) | Value::Native(..)),
            "type" => matches!(v, Value::Type(_)),
            "binary" => matches!(v, Value::Binary(_)),
            other => return Err(MError::unsupported(format!("The type \"{other}\" cannot be checked here."))),
        },
    })
}

fn arg<'v>(args: &'v [Value], i: usize, f: &str) -> R<&'v Value> {
    args.get(i).ok_or_else(|| MError::expr(format!("{f}: argument {} is missing.", i + 1)))
}

fn nums(items: &[Value], f: &str) -> R<Vec<f64>> {
    let mut out = Vec::new();
    for i in items {
        match i {
            Value::Num(n) => out.push(*n),
            Value::Null => {}
            other => return Err(MError::expr(format!("{f}: a list item is {} instead of a number.", other.type_name()))),
        }
    }
    Ok(out)
}

pub fn call(ev: &Ev, name: &str, args: Vec<Value>) -> R<Value> {
    if TABLE_FNS.contains(&name) {
        return match ev.table_fn(name, args)? {
            Some(v) => Ok(v),
            None => Err(MError::expr(format!("The function {name} is not available."))),
        };
    }
    if let Some(r) = crate::stdlib_ext::call(ev, name, &args) {
        return r;
    }
    let a = &args;
    // SQL text of a scalar argument
    let s = |i: usize| -> R<String> { ev.to_sql(arg(a, i, name)?) };
    let sql = |e: String| -> R<Value> { Ok(Value::Sql(e)) };
    match name {
        // ---- text ----
        "Text.Upper" => sql(format!("upper({})", s(0)?)),
        "Text.Lower" => sql(format!("lower({})", s(0)?)),
        "Text.Trim" => sql(format!("regexp_replace({}, '^\\s+|\\s+$', '', 'g')", s(0)?)),
        "Text.TrimStart" => sql(format!("regexp_replace({}, '^\\s+', '')", s(0)?)),
        "Text.TrimEnd" => sql(format!("regexp_replace({}, '\\s+$', '')", s(0)?)),
        "Text.Clean" => sql(format!("regexp_replace({}, '[\\x00-\\x1f]', '', 'g')", s(0)?)),
        "Text.Length" => sql(format!("length({})", s(0)?)),
        "Text.Contains" | "Text.StartsWith" | "Text.EndsWith" => {
            let ci = matches!(a.get(2), Some(Value::Builtin(n)) if n == "Comparer.OrdinalIgnoreCase");
            let (x, y) = if ci { (format!("lower({})", s(0)?), format!("lower({})", s(1)?)) } else { (s(0)?, s(1)?) };
            let f = match name {
                "Text.Contains" => "contains",
                "Text.StartsWith" => "starts_with",
                _ => "ends_with",
            };
            sql(format!("{f}({x}, {y})"))
        }
        "Text.Start" => sql(format!("left({}, {})", s(0)?, s(1)?)),
        "Text.End" => sql(format!("right({}, {})", s(0)?, s(1)?)),
        "Text.Middle" => match a.get(2) {
            Some(_) => sql(format!("substring({}, {} + 1, {})", s(0)?, s(1)?, s(2)?)),
            None => sql(format!("substring({}, {} + 1)", s(0)?, s(1)?)),
        },
        "Text.Replace" => sql(format!("replace({}, {}, {})", s(0)?, s(1)?, s(2)?)),
        "Text.PadStart" | "Text.PadEnd" => {
            let pad = if a.get(2).is_some() { s(2)? } else { "' '".to_string() };
            let (x, n) = (s(0)?, s(1)?);
            let f = if name == "Text.PadStart" { "lpad" } else { "rpad" };
            sql(format!("(CASE WHEN length({x}) >= {n} THEN {x} ELSE {f}({x}, {n}, {pad}) END)"))
        }
        "Text.From" => sql(format!("CAST({} AS VARCHAR)", s(0)?)),
        "Text.Reverse" => sql(format!("reverse({})", s(0)?)),
        "Text.Repeat" => sql(format!("repeat({}, {})", s(0)?, s(1)?)),
        "Text.PositionOf" => sql(format!("(instr({}, {}) - 1)", s(0)?, s(1)?)),
        // the first occurrence of the delimiter; text without it gives an empty text
        "Text.BeforeDelimiter" | "Text.AfterDelimiter" => {
            if a.len() > 2 {
                return Err(MError::unsupported(format!("{name} with an occurrence or a direction is not supported; use the first occurrence.")));
            }
            let (x, d) = (s(0)?, s(1)?);
            if name == "Text.BeforeDelimiter" {
                sql(format!("(CASE WHEN instr({x}, {d}) = 0 THEN '' ELSE left({x}, instr({x}, {d}) - 1) END)"))
            } else {
                sql(format!("(CASE WHEN instr({x}, {d}) = 0 THEN '' ELSE substring({x}, instr({x}, {d}) + length({d})) END)"))
            }
        }
        "Text.BetweenDelimiters" => {
            if a.len() > 3 {
                return Err(MError::unsupported("Text.BetweenDelimiters with occurrences or directions is not supported; use the first occurrences."));
            }
            let (x, d1, d2) = (s(0)?, s(1)?, s(2)?);
            let rest = format!("substring({x}, instr({x}, {d1}) + length({d1}))");
            sql(format!("(CASE WHEN instr({x}, {d1}) = 0 OR instr({rest}, {d2}) = 0 THEN '' ELSE left({rest}, instr({rest}, {d2}) - 1) END)"))
        }
        "Text.Combine" => {
            let Value::List(items) = arg(a, 0, name)? else {
                return Err(MError::expr("Text.Combine needs a list of text."));
            };
            let sep = match a.get(1) {
                Some(v) => ev.to_sql(v)?,
                None => "''".to_string(),
            };
            if items.iter().all(|i| matches!(i, Value::Text(_) | Value::Null)) && !items.iter().any(|i| i.is_symbolic()) {
                let sepv = match a.get(1) {
                    Some(Value::Text(t)) => t.clone(),
                    None => String::new(),
                    _ => return Err(MError::expr("The separator must be text.")),
                };
                let parts: Vec<&str> = items.iter().filter_map(|i| if let Value::Text(t) = i { Some(t.as_str()) } else { None }).collect();
                return Ok(Value::Text(parts.join(&sepv)));
            }
            let parts: R<Vec<String>> = items.iter().map(|i| ev.to_sql(i)).collect();
            sql(format!("concat_ws({sep}, {})", parts?.join(", ")))
        }
        // ---- numbers ----
        "Number.Round" => {
            let digits = if a.get(1).is_some_and(|v| !matches!(v, Value::Null)) { s(1)? } else { "0".to_string() };
            let away = matches!(a.get(2), Some(Value::Num(m)) if *m == 2.0);
            sql(format!("{}({}, {digits})", if away { "round" } else { "round_even" }, s(0)?))
        }
        "Number.RoundUp" | "Number.RoundDown" => {
            let digits = if a.get(1).is_some() { s(1)? } else { "0".to_string() };
            let f = if name == "Number.RoundUp" { "ceil" } else { "floor" };
            sql(format!("({f}({} * power(10, {digits})) / power(10, {digits}))", s(0)?))
        }
        "Number.Abs" => sql(format!("abs({})", s(0)?)),
        "Number.Sign" => sql(format!("sign({})", s(0)?)),
        "Number.Sqrt" => sql(format!("sqrt({})", s(0)?)),
        "Number.Ln" => sql(format!("ln({})", s(0)?)),
        "Number.Log10" => sql(format!("log10({})", s(0)?)),
        "Number.Exp" => sql(format!("exp({})", s(0)?)),
        "Number.Sin" => sql(format!("sin({})", s(0)?)),
        "Number.Cos" => sql(format!("cos({})", s(0)?)),
        "Number.Tan" => sql(format!("tan({})", s(0)?)),
        "Number.IsEven" => sql(format!("(CAST({} AS BIGINT) % 2 = 0)", s(0)?)),
        "Number.IsOdd" => sql(format!("(CAST({} AS BIGINT) % 2 <> 0)", s(0)?)),
        "Number.Power" => sql(format!("power({}, {})", s(0)?, s(1)?)),
        "Number.Mod" => sql(format!("({} % {})", s(0)?, s(1)?)),
        "Number.IntegerDivide" => sql(format!("CAST(trunc({} / CAST({} AS DOUBLE)) AS BIGINT)", s(0)?, s(1)?)),
        "Number.From" => sql(format!("CAST({} AS DOUBLE)", s(0)?)),
        "Int64.From" => sql(format!("CAST(round({}) AS BIGINT)", s(0)?)),
        "Number.ToText" => sql(format!("CAST({} AS VARCHAR)", s(0)?)),
        "Logical.From" => sql(format!("CAST({} AS BOOLEAN)", s(0)?)),
        // ---- dates ----
        "Date.Year" => sql(format!("year({})", s(0)?)),
        "Date.Month" => sql(format!("month({})", s(0)?)),
        "Date.Day" => sql(format!("day({})", s(0)?)),
        "Date.Quarter" => sql(format!("quarter({})", s(0)?)),
        "Date.AddDays" => sql(format!("({} + to_days(CAST({} AS INTEGER)))", s(0)?, s(1)?)),
        "Date.AddMonths" => sql(format!("({} + to_months(CAST({} AS INTEGER)))", s(0)?, s(1)?)),
        "Date.AddYears" => sql(format!("({} + to_years(CAST({} AS INTEGER)))", s(0)?, s(1)?)),
        "Date.StartOfMonth" => sql(format!("CAST(date_trunc('month', {}) AS DATE)", s(0)?)),
        "Date.StartOfYear" => sql(format!("CAST(date_trunc('year', {}) AS DATE)", s(0)?)),
        "Date.EndOfMonth" => sql(format!("last_day(CAST({} AS DATE))", s(0)?)),
        "Date.DayOfWeek" => {
            let first = match a.get(1) {
                Some(Value::Num(n)) => *n as i64,
                _ => 0,
            };
            sql(format!("((dayofweek({}) - {first} + 7) % 7)", s(0)?))
        }
        "Date.DayOfYear" => sql(format!("dayofyear({})", s(0)?)),
        "Date.MonthName" => sql(format!("monthname({})", s(0)?)),
        "Date.DayOfWeekName" => sql(format!("dayname({})", s(0)?)),
        "Date.EndOfYear" => sql(format!("CAST(date_trunc('year', {}) + INTERVAL 1 YEAR - INTERVAL 1 DAY AS DATE)", s(0)?)),
        "Date.StartOfQuarter" => sql(format!("CAST(date_trunc('quarter', {}) AS DATE)", s(0)?)),
        "Date.EndOfQuarter" => sql(format!("CAST(date_trunc('quarter', {}) + INTERVAL 3 MONTH - INTERVAL 1 DAY AS DATE)", s(0)?)),
        "Date.DaysInMonth" => sql(format!("day(last_day(CAST({} AS DATE)))", s(0)?)),
        "Date.AddQuarters" => sql(format!("({} + to_months(3 * CAST({} AS INTEGER)))", s(0)?, s(1)?)),
        "Date.AddWeeks" => sql(format!("({} + to_days(7 * CAST({} AS INTEGER)))", s(0)?, s(1)?)),
        "DateTime.Hour" | "Time.Hour" => sql(format!("hour({})", s(0)?)),
        "DateTime.Minute" | "Time.Minute" => sql(format!("minute({})", s(0)?)),
        "DateTime.Second" | "Time.Second" => sql(format!("CAST(floor(second({})) AS BIGINT)", s(0)?)),
        "Date.From" => sql(format!("CAST({} AS DATE)", s(0)?)),
        "DateTime.Date" => sql(format!("CAST({} AS DATE)", s(0)?)),
        "DateTime.From" => sql(format!("CAST({} AS TIMESTAMP)", s(0)?)),
        "#date" => sql(format!("make_date({}, {}, {})", s(0)?, s(1)?, s(2)?)),
        "#datetime" => sql(format!(
            "make_timestamp(CAST({} AS BIGINT), CAST({} AS BIGINT), CAST({} AS BIGINT), CAST({} AS BIGINT), CAST({} AS BIGINT), CAST({} AS DOUBLE))",
            s(0)?, s(1)?, s(2)?, s(3)?, s(4)?, s(5)?
        )),
        "#time" | "#duration" => Err(MError::unsupported(format!("{name} is not supported yet."))),
        // ---- records ----
        "Record.Field" => match arg(a, 1, name)? {
            Value::Text(f) => ev.field_of(arg(a, 0, name)?, f, false),
            _ => Err(MError::expr("The field name must be text.")),
        },
        "Record.FieldNames" => match arg(a, 0, name)? {
            Value::Record(f) => Ok(Value::List(f.iter().map(|(k, _)| Value::Text(k.clone())).collect())),
            Value::Row(r) => Ok(Value::List(r.cols.iter().map(|c| Value::Text(c.clone())).collect())),
            other => Err(MError::expr(format!("Record.FieldNames needs a record, found {}.", other.type_name()))),
        },
        // ---- lists and aggregates ----
        "List.Sum" | "List.Count" | "List.NonNullCount" | "List.Min" | "List.Max" | "List.Average" | "List.StandardDeviation" | "List.Median" => {
            // a list of values computed from the columns of a row ({[A], [B]}): aggregated across the row in SQL
            if let Value::List(items) = arg(a, 0, name)? {
                if items.iter().any(|i| i.is_symbolic()) {
                    return row_aggregate(ev, name, items);
                }
            }
            aggregate(name, arg(a, 0, name)?)
        }
        "List.Distinct" => match arg(a, 0, name)? {
            Value::ColList { sql, .. } => Ok(Value::ColList { sql: sql.clone(), distinct: true }),
            Value::List(items) => {
                let mut out: Vec<Value> = Vec::new();
                for i in items {
                    if !out.iter().any(|o| values_equal(o, i)) {
                        out.push(i.clone());
                    }
                }
                Ok(Value::List(out))
            }
            other => Err(MError::expr(format!("List.Distinct needs a list, found {}.", other.type_name()))),
        },
        "List.Contains" => {
            let Value::List(items) = arg(a, 0, name)? else {
                return Err(MError::expr("List.Contains needs a list."));
            };
            let x = arg(a, 1, name)?;
            if x.is_symbolic() {
                if items.is_empty() {
                    return Ok(Value::Bool(false));
                }
                let vals: R<Vec<String>> = items.iter().map(|i| ev.to_sql(i)).collect();
                sql(format!("({} IN ({}))", ev.to_sql(x)?, vals?.join(", ")))
            } else {
                Ok(Value::Bool(items.iter().any(|i| values_equal(i, x))))
            }
        }
        "List.Transform" => {
            let Value::List(items) = arg(a, 0, name)? else {
                return Err(MError::expr("List.Transform needs a list."));
            };
            let f = arg(a, 1, name)?;
            items.iter().map(|i| ev.apply(f, vec![i.clone()])).collect::<R<Vec<_>>>().map(Value::List)
        }
        "List.Select" => {
            let Value::List(items) = arg(a, 0, name)? else {
                return Err(MError::expr("List.Select needs a list."));
            };
            let f = arg(a, 1, name)?;
            let mut out = Vec::new();
            for i in items {
                match ev.apply(f, vec![i.clone()])? {
                    Value::Bool(true) => out.push(i.clone()),
                    Value::Bool(false) => {}
                    other => return Err(MError::expr(format!("The condition must be logical, found {}.", other.type_name()))),
                }
            }
            Ok(Value::List(out))
        }
        "List.Numbers" => {
            let (Value::Num(start), Value::Num(count)) = (arg(a, 0, name)?, arg(a, 1, name)?) else {
                return Err(MError::expr("List.Numbers needs a start and a count."));
            };
            let step = match a.get(2) {
                Some(Value::Num(n)) => *n,
                _ => 1.0,
            };
            Ok(Value::List((0..*count as i64).map(|i| Value::Num(start + step * i as f64)).collect()))
        }
        "List.Combine" | "List.Union" => {
            let Value::List(lists) = arg(a, 0, name)? else {
                return Err(MError::expr("List.Combine needs a list of lists."));
            };
            let mut out: Vec<Value> = Vec::new();
            for l in lists {
                match l {
                    Value::List(items) => {
                        for i in items {
                            if name == "List.Union" && out.iter().any(|o| values_equal(o, i)) {
                                continue;
                            }
                            out.push(i.clone());
                        }
                    }
                    other => return Err(MError::expr(format!("A list was expected, found {}.", other.type_name()))),
                }
            }
            Ok(Value::List(out))
        }
        "List.Sort" => {
            let Value::List(items) = arg(a, 0, name)? else {
                return Err(MError::expr("List.Sort needs a list."));
            };
            let mut v = items.clone();
            if v.iter().all(|i| matches!(i, Value::Num(_))) {
                v.sort_by(|x, y| match (x, y) {
                    (Value::Num(p), Value::Num(q)) => p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal),
                    _ => std::cmp::Ordering::Equal,
                });
            } else if v.iter().all(|i| matches!(i, Value::Text(_))) {
                v.sort_by(|x, y| match (x, y) {
                    (Value::Text(p), Value::Text(q)) => p.cmp(q),
                    _ => std::cmp::Ordering::Equal,
                });
            } else {
                return Err(MError::unsupported("List.Sort supports lists of only numbers or only text."));
            }
            if matches!(a.get(1), Some(Value::Num(o)) if *o == 1.0) {
                v.reverse();
            }
            Ok(Value::List(v))
        }
        "List.Reverse" => match arg(a, 0, name)? {
            Value::List(items) => Ok(Value::List(items.iter().rev().cloned().collect())),
            _ => Err(MError::expr("List.Reverse needs a list.")),
        },
        "List.First" | "List.Last" => match arg(a, 0, name)? {
            Value::List(items) => Ok(if name == "List.First" { items.first() } else { items.last() }.cloned().unwrap_or(Value::Null)),
            _ => Err(MError::expr("A list is needed.")),
        },
        "List.Buffer" => Ok(arg(a, 0, name)?.clone()),
        "List.IsEmpty" => match arg(a, 0, name)? {
            Value::List(items) => Ok(Value::Bool(items.is_empty())),
            _ => Err(MError::expr("A list is needed.")),
        },
        // ---- splitters, replacers, comparers (used as values) ----
        n if n.starts_with("Splitter.") || n.starts_with("Combiner.") => Ok(Value::Native(n.to_string(), args)),
        _ => Err(MError::unsupported(format!(
            "The function {name} cannot be used on its own here, or is not supported by BIForge's query engine yet."
        ))),
    }
}

/// List.Sum({[A], [B]}) and friends where some items are SQL expressions of the current row.
fn row_aggregate(ev: &Ev, name: &str, items: &[Value]) -> R<Value> {
    if name == "List.Count" {
        return Ok(Value::Num(items.len() as f64));
    }
    let parts: R<Vec<String>> = items.iter().map(|i| ev.to_sql(i)).collect();
    let parts = parts?;
    if name == "List.NonNullCount" {
        let cases: Vec<String> = parts.iter().map(|p| format!("(CASE WHEN {p} IS NULL THEN 0 ELSE 1 END)")).collect();
        return Ok(Value::Sql(format!("({})", cases.join(" + "))));
    }
    let agg = match name {
        "List.Sum" => "sum",
        "List.Min" => "min",
        "List.Max" => "max",
        "List.Average" => "avg",
        "List.StandardDeviation" => "stddev_samp",
        _ => "median",
    };
    let list: Vec<String> = parts.iter().map(|p| format!("CAST({p} AS DOUBLE)")).collect();
    Ok(Value::Sql(format!("list_aggr([{}], '{agg}')", list.join(", "))))
}

fn aggregate(name: &str, v: &Value) -> R<Value> {
    match v {
        Value::ColList { sql, distinct } => {
            let d = if *distinct { "DISTINCT " } else { "" };
            let e = match name {
                "List.Sum" => format!("sum({d}{sql})"),
                "List.Count" => {
                    if *distinct {
                        format!("count(DISTINCT {sql})")
                    } else {
                        "count(*)".to_string()
                    }
                }
                "List.NonNullCount" => format!("count({d}{sql})"),
                "List.Min" => format!("min({sql})"),
                "List.Max" => format!("max({sql})"),
                "List.Average" => format!("avg({d}{sql})"),
                "List.StandardDeviation" => format!("stddev_samp({d}{sql})"),
                _ => format!("median({sql})"),
            };
            Ok(Value::Sql(e))
        }
        Value::List(items) => {
            match name {
                "List.Count" => return Ok(Value::Num(items.len() as f64)),
                "List.NonNullCount" => return Ok(Value::Num(items.iter().filter(|i| !matches!(i, Value::Null)).count() as f64)),
                _ => {}
            }
            let n = nums(items, name)?;
            if n.is_empty() {
                return Ok(if name == "List.Sum" { Value::Num(0.0) } else { Value::Null });
            }
            Ok(Value::Num(match name {
                "List.Sum" => n.iter().sum(),
                "List.Min" => n.iter().cloned().fold(f64::INFINITY, f64::min),
                "List.Max" => n.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                "List.Average" => n.iter().sum::<f64>() / n.len() as f64,
                "List.StandardDeviation" => {
                    if n.len() < 2 {
                        return Ok(Value::Null);
                    }
                    let m = n.iter().sum::<f64>() / n.len() as f64;
                    (n.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (n.len() - 1) as f64).sqrt()
                }
                _ => {
                    let mut s = n.clone();
                    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    let k = s.len();
                    if k % 2 == 1 { s[k / 2] } else { (s[k / 2 - 1] + s[k / 2]) / 2.0 }
                }
            }))
        }
        other => Err(MError::expr(format!("{name} needs a list or a column of a group, found {}.", other.type_name()))),
    }
}

/// Functions the library knows by name but that BIForge's engine reports as not supported.
pub const NOT_SUPPORTED: &[&str] = &[
    "Web.Contents", "Sql.Database", "PostgreSQL.Database", "OData.Feed",
    "Table.ExpandRecordColumn", "Table.ExpandListColumn",
    "Table.Profile",
    "Splitter.SplitTextByCharacterTransition",
];

/// Sorted names of the library functions that work (used for editor completions; a test keeps the app's copy in sync).
pub fn supported_functions() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = SCALAR_FNS.iter().chain(TABLE_FNS.iter()).chain(crate::stdlib_ext::all_names().iter()).copied().filter(|n| !NOT_SUPPORTED.contains(n)).collect();
    v.sort_unstable();
    v.dedup();
    v
}
