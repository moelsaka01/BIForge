//! Ribbon transforms as data: each one becomes the M text of one or more steps (the same text Power Query writes).
use crate::steps::{insert_step, m_text, raw_name, unique_step_name};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeChange {
    pub column: String,
    /// text, int64, number, decimal, percentage, date, datetime, time, datetimezone, logical, any
    #[serde(rename = "type")]
    pub ty: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub column: String,
    /// eq, ne, gt, ge, lt, le, contains, notContains, startsWith, endsWith, isNull, isNotNull
    pub op: String,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
    /// text, number, date, datetime, logical
    #[serde(default)]
    pub value_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub column: String,
    #[serde(default)]
    pub descending: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aggregate {
    pub name: String,
    /// sum, average, min, max, median, count, countDistinct, countRows
    pub op: String,
    #[serde(default)]
    pub column: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalClause {
    pub condition: Condition,
    pub result: serde_json::Value,
    #[serde(default)]
    pub result_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expand {
    pub name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Transform {
    PromoteHeaders,
    DemoteHeaders,
    ChangeType { changes: Vec<TypeChange>, #[serde(default)] culture: Option<String> },
    RemoveColumns { columns: Vec<String> },
    KeepColumns { columns: Vec<String> },
    ReorderColumns { columns: Vec<String> },
    RenameColumns { pairs: Vec<(String, String)> },
    DuplicateColumn { column: String, new_name: String },
    FilterRows { conditions: Vec<Condition>, #[serde(default = "and")] combine: String },
    RemoveBlankRows { text_columns: Vec<String>, other_columns: Vec<String> },
    RemoveDuplicates { columns: Vec<String> },
    Sort { keys: Vec<SortKey> },
    KeepTopRows { count: u64 },
    KeepBottomRows { count: u64 },
    KeepRange { offset: u64, count: u64 },
    RemoveTopRows { count: u64 },
    RemoveBottomRows { count: u64 },
    ReplaceValues {
        columns: Vec<String>,
        find: Option<serde_json::Value>,
        replace: Option<serde_json::Value>,
        /// "text" replaces inside text, "value" replaces the entire cell
        mode: String,
        #[serde(default)]
        value_type: Option<String>,
    },
    SplitColumn {
        column: String,
        /// delimiter, anyDelimiter, positions, lengths, repeatedLength
        by: String,
        #[serde(default)]
        delimiter: Option<String>,
        #[serde(default)]
        delimiters: Vec<String>,
        #[serde(default)]
        positions: Vec<u64>,
        #[serde(default)]
        lengths: Vec<u64>,
        #[serde(default)]
        length: Option<u64>,
        /// number of new columns
        count: usize,
        #[serde(default)]
        names: Vec<String>,
    },
    AddCustomColumn { name: String, formula: String, #[serde(default)] value_type: Option<String> },
    AddConditionalColumn { name: String, clauses: Vec<ConditionalClause>, else_value: serde_json::Value, #[serde(default)] else_type: Option<String> },
    AddIndexColumn { name: String, start: i64, step: i64 },
    FillDown { columns: Vec<String> },
    FillUp { columns: Vec<String> },
    GroupBy { keys: Vec<String>, aggregates: Vec<Aggregate> },
    Merge {
        right: String,
        left_keys: Vec<String>,
        right_keys: Vec<String>,
        /// inner, leftOuter, rightOuter, fullOuter, leftAnti, rightAnti
        join_kind: String,
        new_column: String,
        #[serde(default)]
        expand: Vec<Expand>,
    },
    Append { queries: Vec<String> },
    Pivot { attribute: String, value: String, attribute_is_text: bool, aggregate: String },
    Unpivot { columns: Vec<String> },
    UnpivotOther { columns: Vec<String> },
    TransformText { columns: Vec<String>, op: String },
    Round { columns: Vec<String>, digits: i64 },
    /// Any M expression as a new step (the formula bar / "Add step").
    Custom { name: String, expr: String },
}

fn and() -> String {
    "and".into()
}

pub fn m_type(t: &str) -> Result<&'static str, String> {
    Ok(match t {
        "text" => "type text",
        "int64" => "Int64.Type",
        "number" => "type number",
        "decimal" => "Currency.Type",
        "percentage" => "Percentage.Type",
        "date" => "type date",
        "datetime" => "type datetime",
        "time" => "type time",
        "datetimezone" => "type datetimezone",
        "logical" => "type logical",
        "any" => "type any",
        other => return Err(format!("Unknown data type \"{other}\".")),
    })
}

fn list_text(items: &[String]) -> String {
    format!("{{{}}}", items.iter().map(|i| m_text(i)).collect::<Vec<_>>().join(", "))
}

fn literal(v: &serde_json::Value, ty: Option<&str>) -> Result<String, String> {
    use serde_json::Value::*;
    Ok(match (v, ty) {
        (Null, _) => "null".into(),
        (Bool(b), _) => b.to_string(),
        (Number(n), Some("text")) => m_text(&n.to_string()),
        (Number(n), _) => n.to_string(),
        (String(s), Some("number")) => {
            s.trim().parse::<f64>().map_err(|_| format!("\"{s}\" is not a number."))?;
            s.trim().to_string()
        }
        (String(s), Some("logical")) => match s.to_lowercase().as_str() {
            "true" => "true".into(),
            "false" => "false".into(),
            _ => return Err(format!("\"{s}\" is not true or false.")),
        },
        (String(s), Some("date")) => {
            let p: Vec<&str> = s.trim().split('-').collect();
            if p.len() != 3 || p.iter().any(|x| x.parse::<u32>().is_err()) {
                return Err(format!("\"{s}\" is not a date (use yyyy-mm-dd)."));
            }
            format!("#date({}, {}, {})", p[0].parse::<u32>().unwrap(), p[1].parse::<u32>().unwrap(), p[2].parse::<u32>().unwrap())
        }
        (String(s), _) => m_text(s),
        _ => return Err("This kind of value cannot be written as an M literal.".into()),
    })
}

fn field(c: &str) -> String {
    let plain = !c.is_empty()
        && c == c.trim()
        && c.chars().all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | ' ' | '.'))
        && !c.contains("  ");
    if plain {
        format!("[{c}]")
    } else {
        format!("[#\"{}\"]", c.replace('"', "\"\""))
    }
}

fn condition(c: &Condition) -> Result<String, String> {
    let f = field(&c.column);
    let v = |c: &Condition| -> Result<String, String> { literal(c.value.as_ref().unwrap_or(&serde_json::Value::Null), c.value_type.as_deref()) };
    Ok(match c.op.as_str() {
        "eq" => format!("{f} = {}", v(c)?),
        "ne" => format!("{f} <> {}", v(c)?),
        "gt" => format!("{f} > {}", v(c)?),
        "ge" => format!("{f} >= {}", v(c)?),
        "lt" => format!("{f} < {}", v(c)?),
        "le" => format!("{f} <= {}", v(c)?),
        "contains" => format!("Text.Contains({f}, {})", v(c)?),
        "notContains" => format!("not Text.Contains({f}, {})", v(c)?),
        "startsWith" => format!("Text.StartsWith({f}, {})", v(c)?),
        "endsWith" => format!("Text.EndsWith({f}, {})", v(c)?),
        "isNull" => format!("{f} = null"),
        "isNotNull" => format!("{f} <> null"),
        other => return Err(format!("Unknown filter operator \"{other}\".")),
    })
}

fn agg_expr(a: &Aggregate) -> Result<String, String> {
    let col = || a.column.as_ref().map(|c| field(c)).ok_or_else(|| format!("The aggregation \"{}\" needs a column.", a.name));
    let (body, ty) = match a.op.as_str() {
        "sum" => (format!("List.Sum({})", col()?), "type nullable number"),
        "average" => (format!("List.Average({})", col()?), "type nullable number"),
        "min" => (format!("List.Min({})", col()?), "type nullable number"),
        "max" => (format!("List.Max({})", col()?), "type nullable number"),
        "median" => (format!("List.Median({})", col()?), "type nullable number"),
        "count" => (format!("List.Count({})", col()?), "Int64.Type"),
        "countDistinct" => (format!("List.Count(List.Distinct({}))", col()?), "Int64.Type"),
        "countRows" => ("Table.RowCount(_)".to_string(), "Int64.Type"),
        other => return Err(format!("Unknown aggregation \"{other}\".")),
    };
    Ok(format!("{{{}, each {body}, {ty}}}", m_text(&a.name)))
}

fn join_kind(k: &str) -> Result<&'static str, String> {
    Ok(match k {
        "inner" => "JoinKind.Inner",
        "leftOuter" => "JoinKind.LeftOuter",
        "rightOuter" => "JoinKind.RightOuter",
        "fullOuter" => "JoinKind.FullOuter",
        "leftAnti" => "JoinKind.LeftAnti",
        "rightAnti" => "JoinKind.RightAnti",
        other => return Err(format!("Unknown join kind \"{other}\".")),
    })
}

/// One step to add: its display name and its expression, written against `prev` (the raw name of the previous step).
pub struct NewStep {
    pub name: String,
    pub expr: String,
}

fn step(name: &str, expr: String) -> Vec<NewStep> {
    vec![NewStep { name: name.to_string(), expr }]
}

impl Transform {
    /// The steps this transform adds after the step called `prev`.
    pub fn steps(&self, prev: &str) -> Result<Vec<NewStep>, String> {
        let p = raw_name(prev);
        use Transform::*;
        Ok(match self {
            PromoteHeaders => step("Promoted Headers", format!("Table.PromoteHeaders({p}, [PromoteAllScalars=true])")),
            DemoteHeaders => step("Demoted Headers", format!("Table.DemoteHeaders({p})")),
            ChangeType { changes, culture } => {
                if changes.is_empty() {
                    return Err("No column was chosen.".into());
                }
                let items: Result<Vec<String>, String> = changes.iter().map(|c| Ok(format!("{{{}, {}}}", m_text(&c.column), m_type(&c.ty)?))).collect();
                let cult = culture.as_ref().map(|c| format!(", {}", m_text(c))).unwrap_or_default();
                step("Changed Type", format!("Table.TransformColumnTypes({p}, {{{}}}{cult})", items?.join(", ")))
            }
            RemoveColumns { columns } => step("Removed Columns", format!("Table.RemoveColumns({p}, {})", list_text(columns))),
            KeepColumns { columns } => step("Removed Other Columns", format!("Table.SelectColumns({p}, {})", list_text(columns))),
            ReorderColumns { columns } => step("Reordered Columns", format!("Table.ReorderColumns({p}, {})", list_text(columns))),
            RenameColumns { pairs } => {
                let items: Vec<String> = pairs.iter().map(|(a, b)| format!("{{{}, {}}}", m_text(a), m_text(b))).collect();
                step("Renamed Columns", format!("Table.RenameColumns({p}, {{{}}})", items.join(", ")))
            }
            DuplicateColumn { column, new_name } => {
                step("Duplicated Column", format!("Table.DuplicateColumn({p}, {}, {})", m_text(column), m_text(new_name)))
            }
            FilterRows { conditions, combine } => {
                if conditions.is_empty() {
                    return Err("No filter condition was given.".into());
                }
                let parts: Result<Vec<String>, String> = conditions.iter().map(condition).collect();
                let joiner = if combine == "or" { " or " } else { " and " };
                step("Filtered Rows", format!("Table.SelectRows({p}, each {})", parts?.join(joiner)))
            }
            RemoveBlankRows { text_columns, other_columns } => {
                let mut parts: Vec<String> = text_columns.iter().map(|c| format!("({0} <> null and {0} <> \"\")", field(c))).collect();
                parts.extend(other_columns.iter().map(|c| format!("{} <> null", field(c))));
                if parts.is_empty() {
                    return Err("The table has no columns.".into());
                }
                step("Removed Blank Rows", format!("Table.SelectRows({p}, each {})", parts.join(" or ")))
            }
            RemoveDuplicates { columns } => step("Removed Duplicates", format!("Table.Distinct({p}, {})", list_text(columns))),
            Sort { keys } => {
                if keys.is_empty() {
                    return Err("No sort column was chosen.".into());
                }
                let items: Vec<String> = keys
                    .iter()
                    .map(|k| format!("{{{}, {}}}", m_text(&k.column), if k.descending { "Order.Descending" } else { "Order.Ascending" }))
                    .collect();
                step("Sorted Rows", format!("Table.Sort({p}, {{{}}})", items.join(", ")))
            }
            KeepTopRows { count } => step("Kept First Rows", format!("Table.FirstN({p}, {count})")),
            KeepBottomRows { count } => step("Kept Last Rows", format!("Table.LastN({p}, {count})")),
            KeepRange { offset, count } => step("Kept Range of Rows", format!("Table.Range({p}, {offset}, {count})")),
            RemoveTopRows { count } => step("Removed Top Rows", format!("Table.Skip({p}, {count})")),
            RemoveBottomRows { count } => step("Removed Bottom Rows", format!("Table.RemoveLastN({p}, {count})")),
            ReplaceValues { columns, find, replace, mode, value_type } => {
                let null = serde_json::Value::Null;
                let f = literal(find.as_ref().unwrap_or(&null), value_type.as_deref())?;
                let r = literal(replace.as_ref().unwrap_or(&null), value_type.as_deref())?;
                let rep = if mode == "text" { "Replacer.ReplaceText" } else { "Replacer.ReplaceValue" };
                step("Replaced Value", format!("Table.ReplaceValue({p}, {f}, {r}, {rep}, {})", list_text(columns)))
            }
            SplitColumn { column, by, delimiter, delimiters, positions, lengths, length, count, names } => {
                if *count == 0 {
                    return Err("A column must be split into at least one column.".into());
                }
                let splitter = match by.as_str() {
                    "delimiter" => format!("Splitter.SplitTextByDelimiter({}, QuoteStyle.Csv)", m_text(delimiter.as_deref().ok_or("A delimiter is needed.")?)),
                    "anyDelimiter" => format!("Splitter.SplitTextByAnyDelimiter({}, QuoteStyle.Csv)", list_text(delimiters)),
                    "positions" => format!("Splitter.SplitTextByPositions({{{}}})", positions.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ")),
                    "lengths" => format!("Splitter.SplitTextByLengths({{{}}})", lengths.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ")),
                    "repeatedLength" => format!("Splitter.SplitTextByRepeatedLengths({})", length.ok_or("A length is needed.")?),
                    other => return Err(format!("Unknown split kind \"{other}\".")),
                };
                let new_names: Vec<String> = if names.len() == *count { names.clone() } else { (1..=*count).map(|i| format!("{column}.{i}")).collect() };
                let label = match by.as_str() {
                    "delimiter" | "anyDelimiter" => "Split Column by Delimiter",
                    "positions" => "Split Column by Position",
                    _ => "Split Column by Position",
                };
                step(label, format!("Table.SplitColumn({p}, {}, {splitter}, {})", m_text(column), list_text(&new_names)))
            }
            AddCustomColumn { name, formula, value_type } => {
                let ty = value_type.as_deref().map(|t| m_type(t).map(|t| format!(", {t}"))).transpose()?.unwrap_or_default();
                step("Added Custom", format!("Table.AddColumn({p}, {}, each {}{ty})", m_text(name), formula.trim()))
            }
            AddConditionalColumn { name, clauses, else_value, else_type } => {
                if clauses.is_empty() {
                    return Err("At least one condition is needed.".into());
                }
                let mut body = String::new();
                for c in clauses {
                    body.push_str(&format!("if {} then {} else ", condition(&c.condition)?, literal(&c.result, c.result_type.as_deref())?));
                }
                body.push_str(&literal(else_value, else_type.as_deref())?);
                step("Added Conditional Column", format!("Table.AddColumn({p}, {}, each {body})", m_text(name)))
            }
            AddIndexColumn { name, start, step: st } => step("Added Index", format!("Table.AddIndexColumn({p}, {}, {start}, {st}, Int64.Type)", m_text(name))),
            FillDown { columns } => step("Filled Down", format!("Table.FillDown({p}, {})", list_text(columns))),
            FillUp { columns } => step("Filled Up", format!("Table.FillUp({p}, {})", list_text(columns))),
            GroupBy { keys, aggregates } => {
                if aggregates.is_empty() {
                    return Err("At least one aggregation is needed.".into());
                }
                let aggs: Result<Vec<String>, String> = aggregates.iter().map(agg_expr).collect();
                step("Grouped Rows", format!("Table.Group({p}, {}, {{{}}})", list_text(keys), aggs?.join(", ")))
            }
            Merge { right, left_keys, right_keys, join_kind: jk, new_column, expand } => {
                let mut out = step(
                    "Merged Queries",
                    format!("Table.NestedJoin({p}, {}, {}, {}, {}, {})", list_text(left_keys), raw_name(right), list_text(right_keys), m_text(new_column), join_kind(jk)?),
                );
                if !expand.is_empty() {
                    let names: Vec<String> = expand.iter().map(|e| e.name.clone()).collect();
                    let news: Vec<String> = expand.iter().map(|e| e.new_name.clone()).collect();
                    out.push(NewStep {
                        name: format!("Expanded {new_column}"),
                        expr: format!("Table.ExpandTableColumn(@PREV@, {}, {}, {})", m_text(new_column), list_text(&names), list_text(&news)),
                    });
                }
                out
            }
            Append { queries } => {
                if queries.is_empty() {
                    return Err("Choose at least one query to append.".into());
                }
                let all: Vec<String> = std::iter::once(p.clone()).chain(queries.iter().map(|q| raw_name(q))).collect();
                step("Appended Query", format!("Table.Combine({{{}}})", all.join(", ")))
            }
            Pivot { attribute, value, attribute_is_text, aggregate } => {
                let agg = match aggregate.as_str() {
                    "sum" => ", List.Sum",
                    "count" => ", List.Count",
                    "min" => ", List.Min",
                    "max" => ", List.Max",
                    "average" => ", List.Average",
                    "none" => "",
                    other => return Err(format!("Unknown aggregation \"{other}\".")),
                };
                let mut out = Vec::new();
                let src = if *attribute_is_text {
                    p.clone()
                } else {
                    out.push(NewStep { name: "Changed Type".into(), expr: format!("Table.TransformColumnTypes({p}, {{{{{}, type text}}}})", m_text(attribute)) });
                    "@PREV@".to_string()
                };
                out.push(NewStep {
                    name: "Pivoted Column".into(),
                    expr: format!("Table.Pivot({src}, List.Distinct({src}[{attribute}]), {}, {}{agg})", m_text(attribute), m_text(value)),
                });
                out
            }
            Unpivot { columns } => step("Unpivoted Only Selected Columns", format!("Table.Unpivot({p}, {}, \"Attribute\", \"Value\")", list_text(columns))),
            UnpivotOther { columns } => step("Unpivoted Other Columns", format!("Table.UnpivotOtherColumns({p}, {}, \"Attribute\", \"Value\")", list_text(columns))),
            TransformText { columns, op } => {
                let (label, f) = match op.as_str() {
                    "upper" => ("Uppercased Text", "Text.Upper"),
                    "lower" => ("Lowercased Text", "Text.Lower"),
                    "trim" => ("Trimmed Text", "Text.Trim"),
                    "clean" => ("Cleaned Text", "Text.Clean"),
                    other => return Err(format!("Unknown text transform \"{other}\".")),
                };
                let items: Vec<String> = columns.iter().map(|c| format!("{{{}, {f}, type text}}", m_text(c))).collect();
                step(label, format!("Table.TransformColumns({p}, {{{}}})", items.join(", ")))
            }
            Round { columns, digits } => {
                let items: Vec<String> = columns.iter().map(|c| format!("{{{}, each Number.Round(_, {digits}), type number}}", m_text(c))).collect();
                step("Rounded Off", format!("Table.TransformColumns({p}, {{{}}})", items.join(", ")))
            }
            Custom { name, expr } => step(name, expr.trim().to_string()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub text: String,
    /// Names of the steps that were added, in order; the last one is what the editor selects.
    pub added: Vec<String>,
}

/// Adds the steps of `t` after the step `after` (None = at the end) of the query `text`.
pub fn apply_transform(text: &str, after: Option<&str>, t: &Transform) -> Result<Applied, String> {
    let q = crate::steps::parse_query(text)?;
    let anchor = match after {
        Some(a) => a.to_string(),
        None => q.steps.last().map(|s| s.name.clone()).ok_or("The query has no steps.")?,
    };
    let mut current = text.to_string();
    let mut prev = anchor;
    let mut added = Vec::new();
    for s in t.steps(&prev)? {
        let name = unique_step_name(&current, &s.name);
        let expr = s.expr.replace("@PREV@", &raw_name(&prev));
        current = insert_step(&current, Some(&prev), &name, &expr)?;
        prev = name.clone();
        added.push(name);
    }
    // `steps(prev)` wrote the first step against the anchor; later steps in the batch were written with @PREV@
    Ok(Applied { text: current, added })
}

/// A new query that reads every file with `extension` from `folder` and appends them (the "Combine files" flow).
pub fn folder_combine_query(folder: &str, extension: &str, delimiter: &str) -> String {
    let ext = if extension.starts_with('.') { extension.to_string() } else { format!(".{extension}") };
    format!(
        "let\n    Source = Folder.Files({}),\n    #\"Filtered Rows\" = Table.SelectRows(Source, each [Extension] = {}),\n    #\"Parsed Files\" = List.Transform(#\"Filtered Rows\"[Content], each Table.PromoteHeaders(Csv.Document(_, [Delimiter={}, QuoteStyle=QuoteStyle.Csv]), [PromoteAllScalars=true])),\n    #\"Combined Files\" = Table.Combine(#\"Parsed Files\")\nin\n    #\"Combined Files\"",
        m_text(folder),
        m_text(&ext),
        m_text(delimiter)
    )
}
