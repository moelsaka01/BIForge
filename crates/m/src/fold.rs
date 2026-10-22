//! Table functions folded to DuckDB SQL. Every table is a chain of CTEs with a hidden ordering column `__ord`.
use crate::ast::TypeExpr;
use crate::backend::SourceRequest;
use crate::eval::Ev;
use crate::value::*;
use std::rc::Rc;

pub const TABLE_FNS: &[&str] = &[
    "Csv.Document", "Excel.Workbook", "Parquet.Document", "Json.Document", "File.Contents", "Folder.Files", "Folder.Contents",
    "Odbc.Query", "Table.FromRecords", "#table", "Table.FromRows", "Table.PromoteHeaders", "Table.DemoteHeaders",
    "Table.SelectColumns", "Table.RemoveColumns", "Table.ReorderColumns", "Table.RenameColumns", "Table.DuplicateColumn",
    "Table.TransformColumnTypes", "Table.TransformColumns", "Table.ReverseRows", "Table.AlternateRows", "Table.SelectRows", "Table.Sort", "Table.FirstN", "Table.LastN",
    "Table.Skip", "Table.RemoveFirstN", "Table.RemoveLastN", "Table.Range", "Table.RemoveRows", "Table.Distinct",
    "Table.ReplaceValue", "Table.SplitColumn", "Table.AddColumn", "Table.AddIndexColumn", "Table.Group", "Table.Pivot",
    "Table.Unpivot", "Table.UnpivotOtherColumns", "Table.FillDown", "Table.FillUp", "Table.Combine", "Table.NestedJoin",
    "Table.ExpandTableColumn", "Table.Join", "Table.Buffer", "Table.ColumnNames", "Table.RowCount", "Table.Column",
    "Table.IsEmpty", "Table.RemoveRowsWithErrors", "Table.SelectRowsWithErrors", "Table.ReplaceErrorValues", "Table.Transpose",
    "Table.CombineColumns", "Table.ExpandRecordColumn", "Table.ExpandListColumn", "Table.Profile", "Table.TransformColumnNames",
    "Web.Contents", "Sql.Database", "PostgreSQL.Database", "OData.Feed",
];

type R<T> = MResult<T>;

fn text_list(v: &Value, what: &str) -> R<Vec<String>> {
    match v {
        Value::Text(t) => Ok(vec![t.clone()]),
        Value::List(items) => items
            .iter()
            .map(|i| match i {
                Value::Text(t) => Ok(t.clone()),
                other => Err(MError::expr(format!("{what} must be a list of text values, found {}.", other.type_name()))),
            })
            .collect(),
        Value::Null => Ok(vec![]),
        other => Err(MError::expr(format!("{what} must be text or a list of text, found {}.", other.type_name()))),
    }
}

fn num_arg(v: &Value, what: &str) -> R<f64> {
    match v {
        Value::Num(n) => Ok(*n),
        other => Err(MError::expr(format!("{what} must be a number, found {}.", other.type_name()))),
    }
}

fn table_arg(args: &[Value], i: usize, fname: &str) -> R<Rel> {
    match args.get(i) {
        Some(Value::Table(r)) => Ok(r.clone()),
        Some(other) => Err(MError::expr(format!("{fname}: argument {} must be a table, found {}.", i + 1, other.type_name()))),
        None => Err(MError::expr(format!("{fname}: argument {} is missing.", i + 1))),
    }
}

fn arg<'v>(args: &'v [Value], i: usize, fname: &str) -> R<&'v Value> {
    args.get(i).ok_or_else(|| MError::expr(format!("{fname}: argument {} is missing.", i + 1)))
}

fn missing_col(name: &str) -> MError {
    MError::expr(format!("The column '{name}' of the table wasn't found."))
}

fn is_text_ty(t: &str) -> bool {
    t.eq_ignore_ascii_case("VARCHAR")
}
fn is_float_ty(t: &str) -> bool {
    let u = t.to_ascii_uppercase();
    u == "DOUBLE" || u == "FLOAT" || u.starts_with("DECIMAL")
}
fn is_int_ty(t: &str) -> bool {
    matches!(t.to_ascii_uppercase().as_str(), "TINYINT" | "SMALLINT" | "INTEGER" | "BIGINT" | "HUGEINT" | "UTINYINT" | "USMALLINT" | "UINTEGER" | "UBIGINT" | "UHUGEINT")
}

/// Date formats tried when text becomes a date (en-US).
const DATE_FORMATS: &str = "['%Y-%m-%d', '%m/%d/%Y', '%m/%d/%y', '%d-%b-%Y', '%b %d, %Y', '%B %d, %Y', '%Y/%m/%d', '%Y%m%d']";
const TS_FORMATS: &str = "['%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S.%f', '%m/%d/%Y %I:%M:%S %p', '%m/%d/%Y %H:%M:%S', '%m/%d/%Y %I:%M %p', '%m/%d/%Y %H:%M', '%Y-%m-%d', '%m/%d/%Y', '%m/%d/%y']";

fn type_name_of(t: &TypeExpr) -> &str {
    match t {
        TypeExpr::Named(n) => n,
        TypeExpr::Nullable(inner) => type_name_of(inner),
        _ => "",
    }
}

impl<'a> Ev<'a> {
    // ---------- relation plumbing ----------

    fn merged(rels: &[&Rel]) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for r in rels {
            for c in r.ctes.iter() {
                if !out.iter().any(|(n, _)| *n == c.0) {
                    out.push(c.clone());
                }
            }
        }
        out
    }

    /// Adds one CTE built from `body` (a SELECT that must include `__ord`) on top of the CTEs of `base`.
    pub fn derive(&self, base: &[&Rel], body: String) -> R<Rel> {
        let mut ctes = Self::merged(base);
        let name = self.fresh();
        ctes.push((name.clone(), body));
        let sql = Rel::describe_sql(&ctes, &name);
        let desc = self.be.describe(&sql).map_err(|e| MError::expr(e))?;
        if !desc.iter().any(|(n, _)| n == ORD) {
            return Err(MError::expr("Internal error: a step lost its row-order column."));
        }
        let cols = desc.into_iter().filter(|(n, _)| n != ORD).map(|(name, ty)| Col { name, ty }).collect();
        Ok(Rel { ctes: Rc::new(ctes), name, cols, nested: vec![] })
    }

    pub fn source_rel(&self, sql: &str) -> R<Rel> {
        self.derive(&[], format!("SELECT row_number() OVER () AS {}, * FROM ({}) AS t", qi(ORD), sql))
    }

    fn no_nested(&self, r: &Rel) -> R<()> {
        if r.nested.is_empty() {
            Ok(())
        } else {
            Err(MError::unsupported(format!(
                "The nested table column \"{}\" must be expanded (Table.ExpandTableColumn) before this step.",
                r.nested[0].name
            )))
        }
    }

    fn col_list_sql(rel: &Rel) -> String {
        rel.plain_cols().map(|c| qi(&c.name)).collect::<Vec<_>>().join(", ")
    }

    fn need(&self, rel: &Rel, names: &[String]) -> R<()> {
        for n in names {
            if rel.col(n).is_none() {
                return Err(missing_col(n));
            }
        }
        Ok(())
    }

    fn cell_value(ty: &str, cell: Option<String>) -> Value {
        let Some(s) = cell else { return Value::Null };
        if is_int_ty(ty) || is_float_ty(ty) {
            return s.parse::<f64>().map(Value::Num).unwrap_or(Value::Text(s));
        }
        if ty.eq_ignore_ascii_case("BOOLEAN") {
            return Value::Bool(s == "true");
        }
        Value::Text(s)
    }

    pub fn column_list(&self, rel: &Rel, name: &str) -> R<Value> {
        self.no_nested(rel)?;
        let col = rel.col(name).ok_or_else(|| missing_col(name))?;
        let sql = format!("{}SELECT {} FROM {} ORDER BY {}", rel.prefix(), qi(name), qi(&rel.name), qi(ORD));
        let rows = self.be.rows(&sql, 1_000_000).map_err(MError::expr)?;
        Ok(Value::List(rows.into_iter().map(|mut r| Self::cell_value(&col.ty, r.remove(0))).collect()))
    }

    pub fn table_row(&self, rel: &Rel, idx: usize, opt: bool) -> R<Value> {
        self.no_nested(rel)?;
        let sql = format!("{}SELECT {} FROM {} ORDER BY {} LIMIT 1 OFFSET {}", rel.prefix(), Self::col_list_sql(rel), qi(&rel.name), qi(ORD), idx);
        let rows = self.be.rows(&sql, 1).map_err(MError::expr)?;
        match rows.into_iter().next() {
            Some(r) => Ok(Value::Record(rel.plain_cols().zip(r).map(|(c, v)| (c.name.clone(), Self::cell_value(&c.ty, v))).collect())),
            None if opt => Ok(Value::Null),
            None => Err(MError::expr("There weren't enough elements in the enumeration to complete the operation.")),
        }
    }

    pub fn nav_item(&self, nav: &NavSrc, idx: &Value) -> R<Value> {
        match nav {
            NavSrc::Excel { path, header } => {
                let sheets = self.be.excel_sheets(path).map_err(MError::source)?;
                let (name, pos) = match idx {
                    Value::Num(n) => {
                        let i = *n as usize;
                        match sheets.get(i) {
                            Some(s) => (s.clone(), i),
                            None => return Err(MError::expr("There weren't enough elements in the enumeration to complete the operation.")),
                        }
                    }
                    Value::Record(f) => {
                        let get = |k: &str| f.iter().find(|(n, _)| n == k).and_then(|(_, v)| if let Value::Text(t) = v { Some(t.clone()) } else { None });
                        if get("Kind").is_some_and(|k| k != "Sheet") {
                            return Err(MError::unsupported("Only worksheets (Kind=\"Sheet\") of a workbook are supported, not tables or named ranges."));
                        }
                        let item = get("Item").or_else(|| get("Name")).ok_or_else(|| MError::expr("The key of a workbook item needs an Item field."))?;
                        match sheets.iter().position(|s| *s == item) {
                            Some(p) => (item, p),
                            None => return Err(MError::expr("The key didn't match any rows in the table.")),
                        }
                    }
                    _ => return Err(MError::expr("A workbook item is selected by a number or a record like [Item=\"Sheet1\",Kind=\"Sheet\"].")),
                };
                let sql = self
                    .be
                    .source_sql(&SourceRequest::Excel { path: path.clone(), sheet: Some(name.clone()), index: pos, header: *header })
                    .map_err(MError::source)?;
                let rel = self.source_rel(&sql)?;
                Ok(Value::Record(vec![
                    ("Name".into(), Value::Text(name.clone())),
                    ("Data".into(), Value::Table(rel)),
                    ("Item".into(), Value::Text(name)),
                    ("Kind".into(), Value::Text("Sheet".into())),
                    ("Hidden".into(), Value::Bool(false)),
                ]))
            }
        }
    }

    // ---------- type conversion ----------

    /// SQL that converts column expression `x` of DuckDB type `from` to the M type `to`; None when nothing changes.
    pub fn convert_sql(&self, x: &str, from: &str, to: &TypeExpr) -> R<Option<String>> {
        let name = type_name_of(to);
        let from_text = is_text_ty(from);
        let from_num = is_int_ty(from) || is_float_ty(from);
        let fu = from.to_ascii_uppercase();
        let from_date = fu == "DATE";
        let from_ts = fu.starts_with("TIMESTAMP");
        let from_bool = fu == "BOOLEAN";
        let num_text = format!("NULLIF(replace(trim({x}), ',', ''), '')");
        Ok(match name {
            "any" | "" if matches!(to, TypeExpr::Named(_) | TypeExpr::Nullable(_)) && name == "any" => None,
            "text" | "Text.Type" => {
                if from_text {
                    None
                } else if is_int_ty(from) {
                    Some(format!("CAST({x} AS VARCHAR)"))
                } else if from.to_ascii_uppercase() == "DOUBLE" || fu == "FLOAT" {
                    Some(format!("(CASE WHEN {x} = floor({x}) AND abs({x}) < 1e15 THEN CAST(CAST({x} AS BIGINT) AS VARCHAR) ELSE CAST({x} AS VARCHAR) END)"))
                } else if from_bool {
                    Some(format!("(CASE WHEN {x} THEN 'true' WHEN NOT {x} THEN 'false' END)"))
                } else if from_date {
                    Some(format!("strftime({x}, '%-m/%-d/%Y')"))
                } else if from_ts {
                    Some(format!("strftime({x}, '%-m/%-d/%Y %-I:%M:%S %p')"))
                } else {
                    Some(format!("CAST({x} AS VARCHAR)"))
                }
            }
            "number" | "Double.Type" | "Percentage.Type" | "Decimal.Type" | "Single.Type" => {
                if fu == "DOUBLE" {
                    None
                } else if from_text {
                    Some(format!("CAST({num_text} AS DOUBLE)"))
                } else if from_bool {
                    Some(format!("(CASE WHEN {x} THEN 1.0 ELSE 0.0 END)"))
                } else {
                    Some(format!("CAST({x} AS DOUBLE)"))
                }
            }
            "Currency.Type" => {
                if from_text {
                    Some(format!("CAST({num_text} AS DECIMAL(19,4))"))
                } else {
                    Some(format!("CAST({x} AS DECIMAL(19,4))"))
                }
            }
            "Int64.Type" | "Int32.Type" | "Int16.Type" | "Int8.Type" | "Byte.Type" | "integer" => {
                if fu == "BIGINT" {
                    None
                } else if from_text {
                    Some(format!(
                        "(CASE WHEN {num_text} ~ '^[+-]?[0-9]+$' THEN CAST({num_text} AS BIGINT) ELSE CAST(round(CAST({num_text} AS DOUBLE)) AS BIGINT) END)"
                    ))
                } else if is_float_ty(from) {
                    Some(format!("CAST(round({x}) AS BIGINT)"))
                } else if from_bool {
                    Some(format!("(CASE WHEN {x} THEN 1 ELSE 0 END)"))
                } else {
                    Some(format!("CAST({x} AS BIGINT)"))
                }
            }
            "logical" => {
                if from_bool {
                    None
                } else if from_text {
                    Some(format!("CAST(lower(NULLIF(trim({x}), '')) AS BOOLEAN)"))
                } else if from_num {
                    Some(format!("({x} <> 0)"))
                } else {
                    Some(format!("CAST({x} AS BOOLEAN)"))
                }
            }
            "date" => {
                if from_date {
                    None
                } else if from_text {
                    Some(format!("CAST(strptime(NULLIF(trim({x}), ''), {DATE_FORMATS}) AS DATE)"))
                } else {
                    Some(format!("CAST({x} AS DATE)"))
                }
            }
            "datetime" => {
                if fu == "TIMESTAMP" {
                    None
                } else if from_text {
                    Some(format!("CAST(strptime(NULLIF(trim({x}), ''), {TS_FORMATS}) AS TIMESTAMP)"))
                } else {
                    Some(format!("CAST({x} AS TIMESTAMP)"))
                }
            }
            "time" => {
                if fu == "TIME" {
                    None
                } else if from_text {
                    Some(format!("CAST(NULLIF(trim({x}), '') AS TIME)"))
                } else {
                    Some(format!("CAST({x} AS TIME)"))
                }
            }
            "datetimezone" => Some(format!("CAST({x} AS TIMESTAMPTZ)")),
            "binary" => None,
            other => return Err(MError::unsupported(format!("Changing a column to the type \"{other}\" is not supported."))),
        })
    }

    fn type_of(&self, v: &Value) -> R<TypeExpr> {
        match v {
            Value::Type(t) => Ok(t.clone()),
            Value::Null => Ok(TypeExpr::Named("any".into())),
            other => Err(MError::expr(format!("Expected a type but found {}.", other.type_name()))),
        }
    }

    // ---------- dispatch ----------

    /// Runs a table-related library function; None when `name` is not one.
    pub fn table_fn(&self, name: &str, args: Vec<Value>) -> R<Option<Value>> {
        let a = &args;
        let v = match name {
            "File.Contents" => match arg(a, 0, name)? {
                Value::Text(p) => Value::Binary(BinSrc::File(p.clone())),
                _ => return Err(MError::expr("File.Contents needs a file path as text.")),
            },
            "Csv.Document" => self.csv_document(a)?,
            "Parquet.Document" => {
                let p = self.bin_path(arg(a, 0, name)?)?;
                let sql = self.be.source_sql(&SourceRequest::Parquet { path: p }).map_err(MError::source)?;
                Value::Table(self.source_rel(&sql)?)
            }
            "Json.Document" => Value::Json(self.bin_path(arg(a, 0, name)?)?),
            "Excel.Workbook" => {
                let path = self.bin_path(arg(a, 0, name)?)?;
                let header = match a.get(1) {
                    Some(Value::Bool(b)) => *b,
                    Some(Value::Record(f)) => !matches!(f.iter().find(|(k, _)| k == "UseHeaders"), Some((_, Value::Bool(false)))),
                    _ => false,
                };
                Value::Nav(Rc::new(NavSrc::Excel { path, header }))
            }
            "Folder.Files" | "Folder.Contents" => {
                let path = match arg(a, 0, name)? {
                    Value::Text(t) => t.clone(),
                    _ => return Err(MError::expr("The folder path must be text.")),
                };
                let sql = self.be.source_sql(&SourceRequest::Folder { path, recursive: name == "Folder.Files" }).map_err(MError::source)?;
                Value::Table(self.source_rel(&sql)?)
            }
            "Odbc.Query" => self.odbc_query(a)?,
            "Table.FromRecords" => match arg(a, 0, name)? {
                Value::Json(path) => {
                    let sql = self.be.source_sql(&SourceRequest::Json { path: path.clone() }).map_err(MError::source)?;
                    Value::Table(self.source_rel(&sql)?)
                }
                _ => return Err(MError::unsupported("Table.FromRecords is only supported on Json.Document(File.Contents(...)).")),
            },
            "#table" | "Table.FromRows" => self.table_literal(name, a)?,
            "Web.Contents" | "Sql.Database" | "PostgreSQL.Database" | "OData.Feed" => {
                return Err(MError::unsupported(format!(
                    "{name} is not supported by BIForge's query engine yet. Tables imported from files can be edited; web and database sources cannot."
                )))
            }
            "Table.Buffer" => Value::Table(table_arg(a, 0, name)?),
            "Table.ColumnNames" => Value::List(table_arg(a, 0, name)?.cols.iter().map(|c| Value::Text(c.name.clone())).collect()),
            "Table.RowCount" => {
                if let Some(Value::Row(ctx)) = a.first() {
                    if ctx.group {
                        return Ok(Some(Value::Sql("count(*)".into())));
                    }
                }
                let r = table_arg(a, 0, name)?;
                self.no_nested(&r)?;
                let sql = format!("{}SELECT count(*) FROM {}", r.prefix(), qi(&r.name));
                let rows = self.be.rows(&sql, 1).map_err(MError::expr)?;
                Value::Num(rows[0][0].as_deref().unwrap_or("0").parse::<f64>().unwrap_or(0.0))
            }
            "Table.IsEmpty" => {
                let r = table_arg(a, 0, name)?;
                let sql = format!("{}SELECT count(*) FROM {}", r.prefix(), qi(&r.name));
                let rows = self.be.rows(&sql, 1).map_err(MError::expr)?;
                Value::Bool(rows[0][0].as_deref() == Some("0"))
            }
            "Table.Column" => {
                let r = table_arg(a, 0, name)?;
                let c = text_list(arg(a, 1, name)?, "The column name")?;
                self.column_list(&r, c.first().ok_or_else(|| MError::expr("A column name is needed."))?)?
            }
            "Table.PromoteHeaders" => self.promote_headers(a)?,
            "Table.DemoteHeaders" => self.demote_headers(a)?,
            "Table.SelectColumns" => self.select_columns(a, false)?,
            "Table.RemoveColumns" => self.select_columns(a, true)?,
            "Table.ReorderColumns" => self.reorder_columns(a)?,
            "Table.RenameColumns" => self.rename_columns(a)?,
            "Table.DuplicateColumn" => self.duplicate_column(a)?,
            "Table.TransformColumnTypes" => self.transform_column_types(a)?,
            "Table.TransformColumns" => self.transform_columns(a)?,
            "Table.SelectRows" => self.select_rows(a)?,
            "Table.Sort" => self.sort(a)?,
            "Table.FirstN" | "Table.LastN" | "Table.Skip" | "Table.RemoveFirstN" | "Table.RemoveLastN" | "Table.Range" | "Table.RemoveRows" => {
                self.row_window(name, a)?
            }
            "Table.Distinct" => self.distinct(a)?,
            "Table.ReplaceValue" => self.replace_value(a)?,
            "Table.SplitColumn" => self.split_column(a)?,
            "Table.AddColumn" => self.add_column(a)?,
            "Table.AddIndexColumn" => self.add_index_column(a)?,
            "Table.Group" => self.group(a)?,
            "Table.Pivot" => self.pivot(a)?,
            "Table.Unpivot" => self.unpivot(a, false)?,
            "Table.UnpivotOtherColumns" => self.unpivot(a, true)?,
            "Table.FillDown" => self.fill(a, true)?,
            "Table.FillUp" => self.fill(a, false)?,
            "Table.Combine" => self.combine(a)?,
            "Table.NestedJoin" => self.nested_join(a)?,
            "Table.ExpandTableColumn" => self.expand_table_column(a)?,
            "Table.Join" => self.join(a)?,
            "Table.RemoveRowsWithErrors" | "Table.SelectRowsWithErrors" | "Table.ReplaceErrorValues" => {
                return Err(MError::unsupported(format!(
                    "{name} is not supported: BIForge's query engine has no cell-level errors (a failed conversion fails the whole step)."
                )))
            }
            "Table.ReverseRows" => self.reverse_rows(a)?,
            "Table.AlternateRows" => self.alternate_rows(a)?,
            "Table.Transpose" => self.transpose(a)?,
            "Table.CombineColumns" => self.combine_columns(a)?,
            "Table.ExpandRecordColumn" | "Table.ExpandListColumn" | "Table.Profile" | "Table.TransformColumnNames" => {
                return Err(MError::unsupported(format!("{name} is not supported yet.")))
            }
            _ => return Ok(None),
        };
        Ok(Some(v))
    }

    fn bin_path(&self, v: &Value) -> R<String> {
        match v {
            Value::Binary(BinSrc::File(p)) => Ok(p.clone()),
            // Folder.Files rows carry the file path in their Content column
            Value::Text(p) => Ok(p.clone()),
            other => Err(MError::expr(format!("Expected a file (File.Contents) but found {}.", other.type_name()))),
        }
    }

    fn csv_document(&self, a: &[Value]) -> R<Value> {
        let path = self.bin_path(arg(a, 0, "Csv.Document")?)?;
        let mut delimiter = ",".to_string();
        let mut quote = Some("\"".to_string());
        match a.get(1) {
            Some(Value::Record(f)) => {
                for (k, v) in f {
                    match (k.as_str(), v) {
                        ("Delimiter", Value::Text(d)) => delimiter = d.clone(),
                        ("QuoteStyle", Value::Num(n)) => quote = if *n == 0.0 { None } else { Some("\"".into()) },
                        _ => {}
                    }
                }
            }
            _ => {
                if let Some(Value::Text(d)) = a.get(2) {
                    delimiter = d.clone();
                }
            }
        }
        if delimiter.is_empty() {
            return Err(MError::expr("The CSV delimiter cannot be empty."));
        }
        let sql = self.be.source_sql(&SourceRequest::Csv { path, delimiter, quote }).map_err(MError::source)?;
        Ok(Value::Table(self.source_rel(&sql)?))
    }

    fn odbc_query(&self, a: &[Value]) -> R<Value> {
        let (Value::Text(conn), Value::Text(sql)) = (arg(a, 0, "Odbc.Query")?, arg(a, 1, "Odbc.Query")?) else {
            return Err(MError::expr("Odbc.Query needs a connection string and a SQL statement as text."));
        };
        let path = conn
            .split(';')
            .find_map(|p| p.trim().strip_prefix("Database=").map(|s| s.to_string()))
            .filter(|_| conn.to_ascii_lowercase().contains("sqlite"))
            .ok_or_else(|| MError::unsupported("Odbc.Query is only supported for SQLite (Driver={SQLite3 ODBC Driver};Database=...)."))?;
        let t = sql.trim();
        let table = t
            .strip_prefix("SELECT * FROM \"")
            .and_then(|r| r.strip_suffix('"'))
            .map(|r| r.replace("\"\"", "\""))
            .ok_or_else(|| MError::unsupported("Only SELECT * FROM \"table\" statements are supported through Odbc.Query."))?;
        let sql = self.be.source_sql(&SourceRequest::Sqlite { path, table }).map_err(MError::source)?;
        Ok(Value::Table(self.source_rel(&sql)?))
    }

    fn table_literal(&self, name: &str, a: &[Value]) -> R<Value> {
        let (cols_v, rows_v) = (arg(a, 0, name)?, arg(a, 1, name)?);
        let names: Vec<String> = match cols_v {
            Value::List(_) | Value::Text(_) => text_list(cols_v, "The column names")?,
            Value::Num(n) => (1..=(*n as usize)).map(|i| format!("Column{i}")).collect(),
            Value::Type(TypeExpr::Table { fields }) => fields.iter().map(|(n, _)| n.clone()).collect(),
            Value::Null => vec![],
            other => return Err(MError::expr(format!("The columns of a table must be a list of names, found {}.", other.type_name()))),
        };
        let Value::List(rows) = rows_v else {
            return Err(MError::expr("The rows of a table must be a list of lists."));
        };
        let names = if names.is_empty() && !rows.is_empty() {
            match &rows[0] {
                Value::List(r) => (1..=r.len()).map(|i| format!("Column{i}")).collect(),
                _ => vec![],
            }
        } else {
            names
        };
        if names.is_empty() {
            return Err(MError::unsupported("A table without columns is not supported."));
        }
        let mut seen = std::collections::HashSet::new();
        for n in &names {
            if !seen.insert(n.clone()) {
                return Err(MError::expr(format!("The column name '{n}' is used twice.")));
            }
        }
        let mut sel = Vec::new();
        for (i, r) in rows.iter().enumerate() {
            let Value::List(cells) = r else {
                return Err(MError::expr("Each row of a table must be a list of values."));
            };
            if cells.len() > names.len() {
                return Err(MError::expr("A row has more values than the table has columns."));
            }
            let mut vals = Vec::new();
            for j in 0..names.len() {
                let c = cells.get(j).cloned().unwrap_or(Value::Null);
                vals.push(match &c {
                    Value::Null => "NULL".to_string(),
                    other => self.to_sql(other)?,
                });
            }
            let aliased: Vec<String> = vals.iter().zip(&names).map(|(v, n)| format!("{v} AS {}", qi(n))).collect();
            sel.push(format!("SELECT {} AS {}, {}", i, qi(ORD), aliased.join(", ")));
        }
        let body = if sel.is_empty() {
            let cols: Vec<String> = names.iter().map(|n| format!("CAST(NULL AS VARCHAR) AS {}", qi(n))).collect();
            format!("SELECT CAST(0 AS BIGINT) AS {}, {} WHERE FALSE", qi(ORD), cols.join(", "))
        } else {
            sel.join(" UNION ALL ")
        };
        Ok(Value::Table(self.derive(&[], body)?))
    }

    // ---------- headers ----------

    fn promote_headers(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.PromoteHeaders")?;
        self.no_nested(&t)?;
        let sql = format!("{}SELECT {} FROM {} ORDER BY {} LIMIT 1", t.prefix(), Self::col_list_sql(&t), qi(&t.name), qi(ORD));
        let rows = self.be.rows(&sql, 1).map_err(MError::expr)?;
        let Some(first) = rows.into_iter().next() else {
            return Ok(Value::Table(t));
        };
        let mut names: Vec<String> = Vec::new();
        for (i, cell) in first.into_iter().enumerate() {
            let base = match cell {
                Some(s) if !s.is_empty() => s,
                _ => format!("Column{}", i + 1),
            };
            let mut n = base.clone();
            let mut k = 1;
            while names.contains(&n) {
                n = format!("{base}.{k}");
                k += 1;
            }
            names.push(n);
        }
        let sel: Vec<String> = t.plain_cols().zip(&names).map(|(c, n)| format!("{} AS {}", qi(&c.name), qi(n))).collect();
        let body = format!(
            "SELECT {}, {} FROM {} WHERE {} > (SELECT min({}) FROM {})",
            qi(ORD),
            sel.join(", "),
            qi(&t.name),
            qi(ORD),
            qi(ORD),
            qi(&t.name)
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn demote_headers(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.DemoteHeaders")?;
        self.no_nested(&t)?;
        let head: Vec<String> = t.plain_cols().enumerate().map(|(i, c)| format!("{} AS {}", ql(&c.name), qi(&format!("Column{}", i + 1)))).collect();
        let rest: Vec<String> = t.plain_cols().enumerate().map(|(i, c)| format!("CAST({} AS VARCHAR) AS {}", qi(&c.name), qi(&format!("Column{}", i + 1)))).collect();
        let body = format!(
            "SELECT CAST(-1 AS BIGINT) AS {o}, {} UNION ALL SELECT {o}, {} FROM {}",
            head.join(", "),
            rest.join(", "),
            qi(&t.name),
            o = qi(ORD)
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    // ---------- columns ----------

    fn missing_mode(&self, v: Option<&Value>) -> i32 {
        match v {
            Some(Value::Num(n)) => *n as i32,
            _ => 0,
        }
    }

    fn select_columns(&self, a: &[Value], remove: bool) -> R<Value> {
        let fname = if remove { "Table.RemoveColumns" } else { "Table.SelectColumns" };
        let t = table_arg(a, 0, fname)?;
        let names = text_list(arg(a, 1, fname)?, "The column names")?;
        let mode = self.missing_mode(a.get(2));
        if remove {
            let present: Vec<String> = names.iter().filter(|n| t.col(n).is_some()).cloned().collect();
            if mode == 0 {
                self.need(&t, &names)?;
            }
            let keep: Vec<String> = t.plain_cols().filter(|c| !present.contains(&c.name)).map(|c| qi(&c.name)).collect();
            let mut nested = t.nested.clone();
            nested.retain(|n| !present.contains(&n.name));
            self.no_nested(&Rel { nested, ..t.clone() })?;
            let body = if keep.is_empty() {
                format!("SELECT {} FROM {}", qi(ORD), qi(&t.name))
            } else {
                format!("SELECT {}, {} FROM {}", qi(ORD), keep.join(", "), qi(&t.name))
            };
            return Ok(Value::Table(self.derive(&[&t], body)?));
        }
        self.no_nested(&t)?;
        let mut sel = Vec::new();
        for n in &names {
            if t.col(n).is_some() {
                sel.push(qi(n));
            } else if mode == 1 {
                continue;
            } else if mode == 2 {
                sel.push(format!("CAST(NULL AS VARCHAR) AS {}", qi(n)));
            } else {
                return Err(missing_col(n));
            }
        }
        let body = if sel.is_empty() {
            format!("SELECT {} FROM {}", qi(ORD), qi(&t.name))
        } else {
            format!("SELECT {}, {} FROM {}", qi(ORD), sel.join(", "), qi(&t.name))
        };
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn reorder_columns(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.ReorderColumns")?;
        self.no_nested(&t)?;
        let names = text_list(arg(a, 1, "Table.ReorderColumns")?, "The column names")?;
        self.need(&t, &names)?;
        let mut order = names.iter();
        let cols: Vec<String> = t
            .plain_cols()
            .map(|c| if names.contains(&c.name) { order.next().cloned().unwrap() } else { c.name.clone() })
            .collect();
        let body = format!("SELECT {}, {} FROM {}", qi(ORD), cols.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", "), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn rename_columns(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.RenameColumns")?;
        let pairs = self.pairs(arg(a, 1, "Table.RenameColumns")?)?;
        let mode = self.missing_mode(a.get(2));
        let mut map: Vec<(String, String)> = Vec::new();
        for (old, new) in pairs {
            if t.col(&old).is_none() {
                if mode == 1 {
                    continue;
                }
                return Err(missing_col(&old));
            }
            map.push((old, new));
        }
        let mut out_names: Vec<String> = Vec::new();
        let mut sel = Vec::new();
        for c in t.cols.iter() {
            let new = map.iter().find(|(o, _)| *o == c.name).map(|(_, n)| n.clone()).unwrap_or_else(|| c.name.clone());
            if out_names.contains(&new) {
                return Err(MError::expr(format!("The name '{new}' is used by more than one column.")));
            }
            out_names.push(new.clone());
            if c.ty == NESTED_TY {
                return Err(MError::unsupported("Renaming a nested table column is not supported."));
            }
            sel.push(format!("{} AS {}", qi(&c.name), qi(&new)));
        }
        let body = format!("SELECT {}, {} FROM {}", qi(ORD), sel.join(", "), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    /// `{{a, b}, {c, d}}` or a single `{a, b}` as pairs of text.
    fn pairs(&self, v: &Value) -> R<Vec<(String, String)>> {
        let Value::List(items) = v else {
            return Err(MError::expr("Expected a list of pairs."));
        };
        if items.len() == 2 && items.iter().all(|i| matches!(i, Value::Text(_))) {
            if let (Value::Text(a), Value::Text(b)) = (&items[0], &items[1]) {
                return Ok(vec![(a.clone(), b.clone())]);
            }
        }
        let mut out = Vec::new();
        for i in items {
            match i {
                Value::List(p) if p.len() == 2 => match (&p[0], &p[1]) {
                    (Value::Text(a), Value::Text(b)) => out.push((a.clone(), b.clone())),
                    _ => return Err(MError::expr("Each pair must hold two text values.")),
                },
                _ => return Err(MError::expr("Each item must be a list of two values.")),
            }
        }
        Ok(out)
    }

    fn duplicate_column(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.DuplicateColumn")?;
        self.no_nested(&t)?;
        let (Value::Text(src), Value::Text(new)) = (arg(a, 1, "Table.DuplicateColumn")?, arg(a, 2, "Table.DuplicateColumn")?) else {
            return Err(MError::expr("Table.DuplicateColumn needs two column names as text."));
        };
        if t.col(src).is_none() {
            return Err(missing_col(src));
        }
        if t.col(new).is_some() {
            return Err(MError::expr(format!("The column '{new}' already exists in the table.")));
        }
        let body = format!("SELECT {}, {}, {} AS {} FROM {}", qi(ORD), Self::col_list_sql(&t), qi(src), qi(new), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn transform_column_types(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.TransformColumnTypes")?;
        self.no_nested(&t)?;
        let ops = arg(a, 1, "Table.TransformColumnTypes")?;
        let Value::List(items) = ops else {
            return Err(MError::expr("Expected a list of {column, type} pairs."));
        };
        // a single pair {"col", type} is accepted too
        let pairs: Vec<&[Value]> = if matches!(items.first(), Some(Value::Text(_))) {
            vec![items.as_slice()]
        } else {
            items.iter().map(|i| if let Value::List(p) = i { Ok(p.as_slice()) } else { Err(MError::expr("Each item must be a list of {column, type}.")) }).collect::<R<Vec<_>>>()?
        };
        let mut conv: Vec<(String, TypeExpr)> = Vec::new();
        for p in pairs {
            let (Some(Value::Text(c)), Some(ty)) = (p.first(), p.get(1)) else {
                return Err(MError::expr("Each item must be {column name, type}."));
            };
            if t.col(c).is_none() {
                return Err(missing_col(c));
            }
            conv.push((c.clone(), self.type_of(ty)?));
        }
        let mut sel = Vec::new();
        for c in t.plain_cols() {
            let expr = match conv.iter().rev().find(|(n, _)| *n == c.name) {
                Some((_, ty)) => self.convert_sql(&qi(&c.name), &c.ty, ty)?,
                None => None,
            };
            sel.push(match expr {
                Some(e) => format!("{e} AS {}", qi(&c.name)),
                None => qi(&c.name),
            });
        }
        let body = format!("SELECT {}, {} FROM {}", qi(ORD), sel.join(", "), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn transform_columns(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.TransformColumns")?;
        self.no_nested(&t)?;
        let Value::List(items) = arg(a, 1, "Table.TransformColumns")? else {
            return Err(MError::expr("Expected a list of transformations."));
        };
        let ops: Vec<&[Value]> = if matches!(items.first(), Some(Value::Text(_))) {
            vec![items.as_slice()]
        } else {
            items.iter().map(|i| if let Value::List(p) = i { Ok(p.as_slice()) } else { Err(MError::expr("Each transformation must be a list.")) }).collect::<R<Vec<_>>>()?
        };
        let mut sel = Vec::new();
        let mut exprs: Vec<(String, String)> = Vec::new();
        for op in ops {
            let Some(Value::Text(col)) = op.first() else {
                return Err(MError::expr("A transformation starts with a column name."));
            };
            let c = t.col(col).ok_or_else(|| missing_col(col))?;
            let f = op.get(1).ok_or_else(|| MError::expr("A transformation needs a function."))?;
            let r = self.apply(f, vec![Value::Sql(qi(col))])?;
            let mut e = self.to_sql(&r)?;
            if let Some(ty) = op.get(2) {
                let ty = self.type_of(ty)?;
                // the type applies to the *result*: describe it by casting through the expression's own type
                if let Some(conv) = self.convert_sql(&format!("({e})"), &self.probe_type(&t, &e).unwrap_or_else(|| c.ty.clone()), &ty)? {
                    e = conv;
                }
            }
            exprs.push((col.clone(), e));
        }
        for c in t.plain_cols() {
            match exprs.iter().rev().find(|(n, _)| *n == c.name) {
                Some((_, e)) => sel.push(format!("{e} AS {}", qi(&c.name))),
                None => sel.push(qi(&c.name)),
            }
        }
        let body = format!("SELECT {}, {} FROM {}", qi(ORD), sel.join(", "), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    /// DuckDB type of an expression over `t`, found by asking the database; None when it cannot be described.
    fn probe_type(&self, t: &Rel, expr: &str) -> Option<String> {
        let sql = format!("{}SELECT {} AS \"__probe\" FROM {} LIMIT 0", t.prefix(), expr, qi(&t.name));
        self.be.describe(&sql).ok().and_then(|d| d.into_iter().next().map(|(_, ty)| ty))
    }

    // ---------- rows ----------

    fn row_fn(&self, f: &Value, t: &Rel) -> R<Value> {
        let ctx = Rc::new(RowCtx { cols: t.col_names(), group: false });
        self.apply(f, vec![Value::Row(ctx)])
    }

    fn select_rows(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.SelectRows")?;
        self.no_nested(&t)?;
        let cond = self.row_fn(arg(a, 1, "Table.SelectRows")?, &t)?;
        let where_sql = match cond {
            Value::Bool(true) => "TRUE".to_string(),
            Value::Bool(false) | Value::Null => "FALSE".to_string(),
            Value::Sql(s) => s,
            other => return Err(MError::expr(format!("The condition must be logical, found {}.", other.type_name()))),
        };
        let body = format!("SELECT {}, {} FROM {} WHERE {}", qi(ORD), Self::col_list_sql(&t), qi(&t.name), where_sql);
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn sort(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.Sort")?;
        self.no_nested(&t)?;
        let spec = arg(a, 1, "Table.Sort")?;
        let mut keys: Vec<(String, bool)> = Vec::new();
        let push_item = |item: &Value, keys: &mut Vec<(String, bool)>| -> R<()> {
            match item {
                Value::Text(c) => keys.push((c.clone(), false)),
                Value::List(p) if p.len() == 2 => match (&p[0], &p[1]) {
                    (Value::Text(c), Value::Num(o)) => keys.push((c.clone(), *o == 1.0)),
                    _ => return Err(MError::expr("A sort key is {column name, Order.Ascending|Order.Descending}.")),
                },
                _ => return Err(MError::unsupported("Only column sort keys are supported.")),
            }
            Ok(())
        };
        match spec {
            Value::Text(_) => push_item(spec, &mut keys)?,
            Value::List(items) => {
                // {"a", Order.Descending} single pair vs list of keys
                if items.len() == 2 && matches!((&items[0], &items[1]), (Value::Text(_), Value::Num(_))) {
                    push_item(spec, &mut keys)?;
                } else {
                    for i in items {
                        push_item(i, &mut keys)?;
                    }
                }
            }
            _ => return Err(MError::expr("Sort keys must be column names or {column, order} pairs.")),
        }
        for (c, _) in &keys {
            if t.col(c).is_none() {
                return Err(missing_col(c));
            }
        }
        let order: Vec<String> = keys.iter().map(|(c, d)| format!("{} {}", qi(c), if *d { "DESC NULLS LAST" } else { "ASC NULLS FIRST" })).collect();
        let body = format!(
            "SELECT row_number() OVER (ORDER BY {}, {}) AS {}, {} FROM {}",
            order.join(", "),
            qi(ORD),
            qi(ORD),
            Self::col_list_sql(&t),
            qi(&t.name)
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn row_window(&self, name: &str, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, name)?;
        self.no_nested(&t)?;
        let n = |i: usize| -> R<i64> {
            let v = num_arg(arg(a, i, name)?, "The row count")?;
            if v < 0.0 {
                return Err(MError::expr("The row count cannot be negative."));
            }
            Ok(v as i64)
        };
        let cond = match name {
            "Table.FirstN" => {
                if matches!(a.get(1), Some(Value::Func(_)) | Some(Value::Builtin(_))) {
                    return Err(MError::unsupported("Table.FirstN with a condition is not supported; use a row count."));
                }
                format!("\"__rn\" <= {}", n(1)?)
            }
            "Table.LastN" => format!("\"__rn\" > \"__cnt\" - {}", n(1)?),
            "Table.Skip" | "Table.RemoveFirstN" => {
                if matches!(a.get(1), Some(Value::Func(_)) | Some(Value::Builtin(_))) {
                    return Err(MError::unsupported("Skipping rows by a condition is not supported; use a row count."));
                }
                format!("\"__rn\" > {}", n(1)?)
            }
            "Table.RemoveLastN" => format!("\"__rn\" <= \"__cnt\" - {}", n(1)?),
            "Table.Range" => {
                let off = n(1)?;
                match a.get(2) {
                    Some(Value::Num(c)) => format!("\"__rn\" > {off} AND \"__rn\" <= {}", off + *c as i64),
                    _ => format!("\"__rn\" > {off}"),
                }
            }
            _ => {
                // Table.RemoveRows(t, offset, count = 1)
                let off = n(1)?;
                let c = match a.get(2) {
                    Some(Value::Num(c)) => *c as i64,
                    _ => 1,
                };
                format!("NOT (\"__rn\" > {off} AND \"__rn\" <= {})", off + c)
            }
        };
        let body = format!(
            "SELECT {}, {} FROM (SELECT *, row_number() OVER (ORDER BY {}) AS \"__rn\", count(*) OVER () AS \"__cnt\" FROM {}) AS w WHERE {}",
            qi(ORD),
            Self::col_list_sql(&t),
            qi(ORD),
            qi(&t.name),
            cond
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn reverse_rows(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.ReverseRows")?;
        self.no_nested(&t)?;
        let body = format!("SELECT row_number() OVER (ORDER BY {o} DESC) AS {o}, {} FROM {}", Self::col_list_sql(&t), qi(&t.name), o = qi(ORD));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    /// Table.AlternateRows(table, offset, skip, take): keeps the first `offset` rows, then repeatedly drops `skip` rows and keeps `take`.
    fn alternate_rows(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.AlternateRows")?;
        self.no_nested(&t)?;
        let n = |i: usize| -> R<i64> {
            let v = num_arg(arg(a, i, "Table.AlternateRows")?, "The row count")?;
            if v < 0.0 {
                return Err(MError::expr("The row counts cannot be negative."));
            }
            Ok(v as i64)
        };
        let (offset, skip, take) = (n(1)?, n(2)?, n(3)?);
        if skip + take == 0 {
            return Err(MError::expr("Table.AlternateRows needs a skip or a take count above zero."));
        }
        let body = format!(
            "SELECT {o}, {cols} FROM (SELECT *, row_number() OVER (ORDER BY {o}) AS \"__rn\" FROM {t}) AS w WHERE \"__rn\" <= {offset} OR ((\"__rn\" - {offset} - 1) % {period}) >= {skip}",
            o = qi(ORD),
            cols = Self::col_list_sql(&t),
            t = qi(&t.name),
            period = skip + take
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    /// Rows become columns named Column1, Column2, ... (every value as text; at most 500 rows can become columns).
    fn transpose(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.Transpose")?;
        self.no_nested(&t)?;
        let count_sql = format!("{}SELECT count(*) FROM {}", t.prefix(), qi(&t.name));
        let rows = self.be.rows(&count_sql, 1).map_err(MError::expr)?;
        let n: i64 = rows[0][0].as_deref().unwrap_or("0").parse().unwrap_or(0);
        if n > 500 {
            return Err(MError::unsupported(format!("Table.Transpose makes one column for each row, and this table has {n} rows (the limit is 500).")));
        }
        let cols: Vec<String> = t.plain_cols().map(|c| c.name.clone()).collect();
        if cols.is_empty() {
            return Err(MError::expr("The table has no columns to transpose."));
        }
        let n = n.max(1);
        let pick = |c: &str| -> String { (1..=n).map(|k| format!("max(CASE WHEN \"__rn\" = {k} THEN CAST({} AS VARCHAR) END) AS {}", qi(c), qi(&format!("Column{k}")))).collect::<Vec<_>>().join(", ") };
        let numbered = format!("(SELECT *, row_number() OVER (ORDER BY {}) AS \"__rn\" FROM {}) AS w", qi(ORD), qi(&t.name));
        let parts: Vec<String> = cols.iter().enumerate().map(|(j, c)| format!("SELECT CAST({} AS BIGINT) AS {}, {} FROM {numbered}", j + 1, qi(ORD), pick(c))).collect();
        Ok(Value::Table(self.derive(&[&t], parts.join(" UNION ALL "))?))
    }

    /// Table.CombineColumns(table, columns, Combiner.CombineTextByDelimiter(delimiter, ...), newName): the new column takes the
    /// place of the first merged column; an empty value counts as empty text ("a,,c").
    fn combine_columns(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.CombineColumns")?;
        self.no_nested(&t)?;
        let cols = text_list(arg(a, 1, "Table.CombineColumns")?, "The columns")?;
        self.need(&t, &cols)?;
        let Value::Native(f, fargs) = arg(a, 2, "Table.CombineColumns")? else {
            return Err(MError::unsupported("Table.CombineColumns needs Combiner.CombineTextByDelimiter."));
        };
        if f != "Combiner.CombineTextByDelimiter" {
            return Err(MError::unsupported(format!("{f} is not supported; use Combiner.CombineTextByDelimiter.")));
        }
        let Some(Value::Text(delim)) = fargs.first() else { return Err(MError::expr("The delimiter must be text.")) };
        let Value::Text(new_name) = arg(a, 3, "Table.CombineColumns")? else { return Err(MError::expr("The new column name must be text.")) };
        if cols.is_empty() {
            return Err(MError::expr("Choose the columns to merge."));
        }
        if t.col(new_name).is_some() && !cols.contains(new_name) {
            return Err(MError::expr(format!("The column \"{new_name}\" already exists.")));
        }
        let joined = format!("concat_ws({}, {})", ql(delim), cols.iter().map(|c| format!("coalesce(CAST({} AS VARCHAR), '')", qi(c))).collect::<Vec<_>>().join(", "));
        let mut sel = Vec::new();
        let mut placed = false;
        for c in t.plain_cols() {
            if cols.contains(&c.name) {
                if !placed {
                    sel.push(format!("{joined} AS {}", qi(new_name)));
                    placed = true;
                }
            } else {
                sel.push(qi(&c.name));
            }
        }
        let body = format!("SELECT {}, {} FROM {}", qi(ORD), sel.join(", "), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn distinct(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.Distinct")?;
        self.no_nested(&t)?;
        let cols: Vec<String> = match a.get(1) {
            None | Some(Value::Null) => t.plain_cols().map(|c| c.name.clone()).collect(),
            Some(Value::Func(_)) | Some(Value::Builtin(_)) | Some(Value::Native(..)) => {
                return Err(MError::unsupported("Table.Distinct with a comparer is not supported."))
            }
            Some(v) => text_list(v, "The column names")?,
        };
        self.need(&t, &cols)?;
        let part = cols.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ");
        let body = format!(
            "SELECT {}, {} FROM {} QUALIFY row_number() OVER (PARTITION BY {} ORDER BY {}) = 1",
            qi(ORD),
            Self::col_list_sql(&t),
            qi(&t.name),
            part,
            qi(ORD)
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn replace_value(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.ReplaceValue")?;
        self.no_nested(&t)?;
        let old = arg(a, 1, "Table.ReplaceValue")?.clone();
        let new = arg(a, 2, "Table.ReplaceValue")?.clone();
        let text_mode = match arg(a, 3, "Table.ReplaceValue")? {
            Value::Builtin(n) if n == "Replacer.ReplaceText" => true,
            Value::Builtin(n) if n == "Replacer.ReplaceValue" => false,
            _ => return Err(MError::unsupported("Only Replacer.ReplaceValue and Replacer.ReplaceText are supported.")),
        };
        let cols = text_list(arg(a, 4, "Table.ReplaceValue")?, "The column names")?;
        self.need(&t, &cols)?;
        let mut sel = Vec::new();
        for c in t.plain_cols() {
            if !cols.contains(&c.name) {
                sel.push(qi(&c.name));
                continue;
            }
            let x = qi(&c.name);
            let e = if text_mode {
                let (Value::Text(o), Value::Text(n)) = (&old, &new) else {
                    return Err(MError::expr("Replacer.ReplaceText needs text values to find and replace."));
                };
                if o.is_empty() {
                    x.clone()
                } else {
                    format!("replace({x}, {}, {})", ql(o), ql(n))
                }
            } else {
                format!("(CASE WHEN {x} IS NOT DISTINCT FROM {} THEN {} ELSE {x} END)", self.to_sql(&old)?, self.to_sql(&new)?)
            };
            sel.push(format!("{e} AS {}", qi(&c.name)));
        }
        let body = format!("SELECT {}, {} FROM {}", qi(ORD), sel.join(", "), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn split_column(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.SplitColumn")?;
        self.no_nested(&t)?;
        let Value::Text(col) = arg(a, 1, "Table.SplitColumn")? else {
            return Err(MError::expr("The column to split must be given as text."));
        };
        if t.col(col).is_none() {
            return Err(missing_col(col));
        }
        let Value::Native(sp, sargs) = arg(a, 2, "Table.SplitColumn")? else {
            return Err(MError::unsupported("Table.SplitColumn needs one of the Splitter.* functions."));
        };
        let names: Vec<String> = match a.get(3) {
            Some(Value::List(_)) | Some(Value::Text(_)) => text_list(&a[3], "The new column names")?,
            Some(Value::Num(n)) => (1..=(*n as usize)).map(|i| format!("{col}.{i}")).collect(),
            _ => return Err(MError::unsupported("Table.SplitColumn needs the names of the new columns.")),
        };
        if names.is_empty() {
            return Err(MError::expr("At least one new column name is needed."));
        }
        let x = qi(col);
        let parts: Vec<String> = (0..names.len())
            .map(|i| -> R<String> {
                Ok(match sp.as_str() {
                    "Splitter.SplitTextByDelimiter" => {
                        let Some(Value::Text(d)) = sargs.first() else {
                            return Err(MError::expr("The delimiter must be text."));
                        };
                        if d.is_empty() {
                            return Err(MError::expr("The delimiter cannot be empty."));
                        }
                        format!("string_split({x}, {})[{}]", ql(d), i + 1)
                    }
                    "Splitter.SplitTextByAnyDelimiter" => {
                        let ds = text_list(sargs.first().unwrap_or(&Value::Null), "The delimiters")?;
                        let class: String = ds.iter().map(|d| regex_escape(d)).collect::<Vec<_>>().join("|");
                        format!("regexp_split_to_array({x}, {})[{}]", ql(&class), i + 1)
                    }
                    "Splitter.SplitTextByPositions" => {
                        let Some(Value::List(ps)) = sargs.first() else {
                            return Err(MError::expr("The positions must be a list of numbers."));
                        };
                        let pos: Vec<i64> = ps.iter().map(|p| if let Value::Num(n) = p { Ok(*n as i64) } else { Err(MError::expr("Positions must be numbers.")) }).collect::<R<_>>()?;
                        let start = *pos.get(i).ok_or_else(|| MError::expr("There are more new columns than positions."))?;
                        match pos.get(i + 1) {
                            Some(end) => format!("NULLIF(substring({x}, {}, {}), '')", start + 1, end - start),
                            None => format!("NULLIF(substring({x}, {}), '')", start + 1),
                        }
                    }
                    "Splitter.SplitTextByLengths" => {
                        let Some(Value::List(ls)) = sargs.first() else {
                            return Err(MError::expr("The lengths must be a list of numbers."));
                        };
                        let lens: Vec<i64> = ls.iter().map(|p| if let Value::Num(n) = p { Ok(*n as i64) } else { Err(MError::expr("Lengths must be numbers.")) }).collect::<R<_>>()?;
                        let start: i64 = lens.iter().take(i).sum();
                        let len = *lens.get(i).ok_or_else(|| MError::expr("There are more new columns than lengths."))?;
                        format!("NULLIF(substring({x}, {}, {}), '')", start + 1, len)
                    }
                    "Splitter.SplitTextByRepeatedLengths" => {
                        let Some(Value::Num(n)) = sargs.first() else {
                            return Err(MError::expr("The length must be a number."));
                        };
                        let n = *n as i64;
                        format!("NULLIF(substring({x}, {}, {}), '')", i as i64 * n + 1, n)
                    }
                    other => return Err(MError::unsupported(format!("{other} is not supported."))),
                })
            })
            .collect::<R<_>>()?;
        let mut sel = Vec::new();
        for c in t.plain_cols() {
            if c.name == *col {
                for (p, n) in parts.iter().zip(&names) {
                    sel.push(format!("{p} AS {}", qi(n)));
                }
            } else {
                if names.contains(&c.name) {
                    return Err(MError::expr(format!("The column '{}' already exists in the table.", c.name)));
                }
                sel.push(qi(&c.name));
            }
        }
        let body = format!("SELECT {}, {} FROM {}", qi(ORD), sel.join(", "), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    // ---------- new columns ----------

    fn add_column(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.AddColumn")?;
        self.no_nested(&t)?;
        let Value::Text(name) = arg(a, 1, "Table.AddColumn")? else {
            return Err(MError::expr("The new column name must be text."));
        };
        if t.col(name).is_some() {
            return Err(MError::expr(format!("The column '{name}' of the table already exists.")));
        }
        let v = self.row_fn(arg(a, 2, "Table.AddColumn")?, &t)?;
        let mut e = match &v {
            Value::Row(_) | Value::Table(_) | Value::Record(_) | Value::List(_) | Value::ColList { .. } => {
                return Err(MError::unsupported(format!("A new column of {} values is not supported.", v.type_name())))
            }
            other => self.to_sql(other)?,
        };
        if let Some(ty) = a.get(3) {
            let ty = self.type_of(ty)?;
            let from = if matches!(v, Value::Sql(_)) { self.probe_type(&t, &e).unwrap_or_else(|| "VARCHAR".into()) } else { self.concrete_ty(&v) };
            if let Some(c) = self.convert_sql(&format!("({e})"), &from, &ty)? {
                e = c;
            }
        }
        let body = format!("SELECT {}, {}, {} AS {} FROM {}", qi(ORD), Self::col_list_sql(&t), e, qi(name), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn concrete_ty(&self, v: &Value) -> String {
        match v {
            Value::Text(_) => "VARCHAR".into(),
            Value::Bool(_) => "BOOLEAN".into(),
            Value::Num(n) if n.fract() == 0.0 => "BIGINT".into(),
            Value::Num(_) => "DOUBLE".into(),
            _ => "VARCHAR".into(),
        }
    }

    fn add_index_column(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.AddIndexColumn")?;
        self.no_nested(&t)?;
        let Value::Text(name) = arg(a, 1, "Table.AddIndexColumn")? else {
            return Err(MError::expr("The new column name must be text."));
        };
        if t.col(name).is_some() {
            return Err(MError::expr(format!("The column '{name}' of the table already exists.")));
        }
        let start = match a.get(2) {
            Some(Value::Num(n)) => *n as i64,
            _ => 0,
        };
        let step = match a.get(3) {
            Some(Value::Num(n)) => *n as i64,
            _ => 1,
        };
        let body = format!(
            "SELECT {o}, {}, (row_number() OVER (ORDER BY {o}) - 1) * {step} + {start} AS {} FROM {}",
            Self::col_list_sql(&t),
            qi(name),
            qi(&t.name),
            o = qi(ORD)
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn fill(&self, a: &[Value], down: bool) -> R<Value> {
        let fname = if down { "Table.FillDown" } else { "Table.FillUp" };
        let t = table_arg(a, 0, fname)?;
        self.no_nested(&t)?;
        let cols = text_list(arg(a, 1, fname)?, "The column names")?;
        self.need(&t, &cols)?;
        let mut sel = Vec::new();
        for c in t.plain_cols() {
            if cols.contains(&c.name) {
                let x = qi(&c.name);
                let e = if down {
                    format!("last_value({x} IGNORE NULLS) OVER (ORDER BY {} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)", qi(ORD))
                } else {
                    format!("first_value({x} IGNORE NULLS) OVER (ORDER BY {} ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)", qi(ORD))
                };
                sel.push(format!("{e} AS {x}"));
            } else {
                sel.push(qi(&c.name));
            }
        }
        let body = format!("SELECT {}, {} FROM {}", qi(ORD), sel.join(", "), qi(&t.name));
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    // ---------- group / pivot / unpivot ----------

    fn group(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.Group")?;
        self.no_nested(&t)?;
        let keys = text_list(arg(a, 1, "Table.Group")?, "The key columns")?;
        self.need(&t, &keys)?;
        if let Some(Value::Num(k)) = a.get(3) {
            if *k == 0.0 {
                return Err(MError::unsupported("GroupKind.Local (grouping only adjacent rows) is not supported; use GroupKind.Global."));
            }
        }
        let Value::List(aggs) = arg(a, 2, "Table.Group")? else {
            return Err(MError::expr("The aggregations must be a list."));
        };
        let aggs: Vec<&Value> = if matches!(aggs.first(), Some(Value::Text(_))) { vec![arg(a, 2, "Table.Group")?] } else { aggs.iter().collect() };
        let ctx = Rc::new(RowCtx { cols: t.col_names(), group: true });
        let mut agg_sql: Vec<(String, String)> = Vec::new();
        for ag in aggs {
            let Value::List(p) = ag else {
                return Err(MError::expr("Each aggregation is {name, function, type}."));
            };
            let (Some(Value::Text(n)), Some(f)) = (p.first(), p.get(1)) else {
                return Err(MError::expr("Each aggregation is {name, function, type}."));
            };
            if keys.contains(n) || agg_sql.iter().any(|(m, _)| m == n) {
                return Err(MError::expr(format!("The column name '{n}' is used twice.")));
            }
            let r = self.apply(f, vec![Value::Row(ctx.clone())])?;
            let mut e = match &r {
                Value::Sql(s) => s.clone(),
                Value::Num(_) | Value::Text(_) | Value::Bool(_) | Value::Null => self.to_sql(&r)?,
                Value::Row(_) | Value::Table(_) => {
                    return Err(MError::unsupported("Nested tables (each _) in Table.Group are not supported; aggregate with List.Sum, List.Count, ... instead."))
                }
                other => return Err(MError::expr(format!("An aggregation must produce a single value, found {}.", other.type_name()))),
            };
            if let Some(ty) = p.get(2) {
                let ty = self.type_of(ty)?;
                let probe = format!("{}SELECT {} AS \"__probe\" FROM {} GROUP BY ALL LIMIT 0", t.prefix(), e, qi(&t.name));
                let from = self.be.describe(&probe).ok().and_then(|d| d.into_iter().next().map(|(_, t)| t)).unwrap_or_else(|| "DOUBLE".into());
                if let Some(c) = self.convert_sql(&format!("({e})"), &from, &ty)? {
                    e = c;
                }
            }
            agg_sql.push((n.clone(), e));
        }
        let key_list = keys.iter().map(|k| qi(k)).collect::<Vec<_>>();
        let inner_sel: Vec<String> = key_list.iter().cloned().chain(agg_sql.iter().map(|(n, e)| format!("{e} AS {}", qi(n)))).collect();
        let group_by = if key_list.is_empty() { String::new() } else { format!(" GROUP BY {}", key_list.join(", ")) };
        let outer_cols: Vec<String> = key_list.iter().cloned().chain(agg_sql.iter().map(|(n, _)| qi(n))).collect();
        let body = format!(
            "SELECT row_number() OVER (ORDER BY \"__minord\") AS {}, {} FROM (SELECT {}, min({}) AS \"__minord\" FROM {}{}) AS g",
            qi(ORD),
            outer_cols.join(", "),
            inner_sel.join(", "),
            qi(ORD),
            qi(&t.name),
            group_by
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn pivot(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.Pivot")?;
        self.no_nested(&t)?;
        let Value::List(vals) = arg(a, 1, "Table.Pivot")? else {
            return Err(MError::expr("The pivot values must be a list of text."));
        };
        let (Value::Text(attr), Value::Text(valc)) = (arg(a, 2, "Table.Pivot")?, arg(a, 3, "Table.Pivot")?) else {
            return Err(MError::expr("The attribute and value columns must be given as text."));
        };
        self.need(&t, &[attr.clone(), valc.clone()])?;
        let agg = match a.get(4) {
            Some(Value::Builtin(n)) => match n.as_str() {
                "List.Sum" => "sum",
                "List.Count" => "count",
                "List.Max" => "max",
                "List.Min" => "min",
                "List.Average" => "avg",
                other => return Err(MError::unsupported(format!("{other} is not supported as a pivot aggregation."))),
            },
            None | Some(Value::Null) => "any_value",
            Some(_) => return Err(MError::unsupported("Only List.Sum, List.Count, List.Max, List.Min and List.Average are supported as pivot aggregations.")),
        };
        let mut names: Vec<String> = Vec::new();
        for v in vals {
            match v {
                Value::Text(s) if !names.contains(s) => names.push(s.clone()),
                Value::Text(_) => {}
                other => return Err(MError::expr(format!("A pivot value must be text, found {}.", other.type_name()))),
            }
        }
        let keys: Vec<String> = t.plain_cols().filter(|c| c.name != *attr && c.name != *valc).map(|c| c.name.clone()).collect();
        for n in &names {
            if keys.contains(n) {
                return Err(MError::expr(format!("The pivoted column name '{n}' is already a column of the table.")));
            }
        }
        let pcols: Vec<String> = names
            .iter()
            .map(|n| {
                let hit = format!("CAST({} AS VARCHAR) = {}", qi(attr), ql(n));
                format!("(CASE WHEN count(CASE WHEN {hit} THEN 1 END) = 0 THEN NULL ELSE {agg}(CASE WHEN {hit} THEN {} END) END) AS {}", qi(valc), qi(n))
            })
            .collect();
        let key_q: Vec<String> = keys.iter().map(|k| qi(k)).collect();
        let sel: Vec<String> = key_q.iter().cloned().chain(pcols).collect();
        let group_by = if key_q.is_empty() { String::new() } else { format!(" GROUP BY {}", key_q.join(", ")) };
        let outer: Vec<String> = key_q.iter().cloned().chain(names.iter().map(|n| qi(n))).collect();
        let body = format!(
            "SELECT row_number() OVER (ORDER BY \"__minord\") AS {}, {} FROM (SELECT {}, min({}) AS \"__minord\" FROM {}{}) AS g",
            qi(ORD),
            outer.join(", "),
            sel.join(", "),
            qi(ORD),
            qi(&t.name),
            group_by
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    fn unpivot(&self, a: &[Value], other: bool) -> R<Value> {
        let fname = if other { "Table.UnpivotOtherColumns" } else { "Table.Unpivot" };
        let t = table_arg(a, 0, fname)?;
        self.no_nested(&t)?;
        let given = text_list(arg(a, 1, fname)?, "The column names")?;
        let (Value::Text(attr), Value::Text(valn)) = (arg(a, 2, fname)?, arg(a, 3, fname)?) else {
            return Err(MError::expr("The attribute and value column names must be text."));
        };
        self.need(&t, &given)?;
        let (keep, unp): (Vec<String>, Vec<String>) = if other {
            (given.clone(), t.plain_cols().filter(|c| !given.contains(&c.name)).map(|c| c.name.clone()).collect())
        } else {
            (t.plain_cols().filter(|c| !given.contains(&c.name)).map(|c| c.name.clone()).collect(), given.clone())
        };
        if keep.contains(attr) || keep.contains(valn) || attr == valn {
            return Err(MError::expr("The attribute and value column names must differ from the other columns."));
        }
        let keep_q: Vec<String> = keep.iter().map(|k| qi(k)).collect();
        let prefix_keys = if keep_q.is_empty() { String::new() } else { format!("{}, ", keep_q.join(", ")) };
        let parts: Vec<String> = unp
            .iter()
            .enumerate()
            .map(|(i, c)| {
                format!(
                    "SELECT {o}, {i} AS \"__i\", {}{} AS {}, {} AS {} FROM {} WHERE {} IS NOT NULL",
                    prefix_keys,
                    ql(c),
                    qi(attr),
                    qi(c),
                    qi(valn),
                    qi(&t.name),
                    qi(c),
                    o = qi(ORD)
                )
            })
            .collect();
        if parts.is_empty() {
            return Err(MError::unsupported("There are no columns to unpivot."));
        }
        let outer: Vec<String> = keep_q.iter().cloned().chain([qi(attr), qi(valn)]).collect();
        let body = format!(
            "SELECT row_number() OVER (ORDER BY {o}, \"__i\") AS {o}, {} FROM ({}) AS u",
            outer.join(", "),
            parts.join(" UNION ALL "),
            o = qi(ORD)
        );
        Ok(Value::Table(self.derive(&[&t], body)?))
    }

    // ---------- append / merge ----------

    fn combine(&self, a: &[Value]) -> R<Value> {
        let Value::List(items) = arg(a, 0, "Table.Combine")? else {
            return Err(MError::expr("Table.Combine needs a list of tables."));
        };
        let mut rels = Vec::new();
        for i in items {
            match i {
                Value::Table(r) => {
                    self.no_nested(r)?;
                    rels.push(r.clone());
                }
                Value::Null => {}
                other => return Err(MError::expr(format!("Table.Combine needs tables, found {}.", other.type_name()))),
            }
        }
        if rels.is_empty() {
            return Err(MError::unsupported("Table.Combine of no tables is not supported."));
        }
        let refs: Vec<&Rel> = rels.iter().collect();
        let parts: Vec<String> = rels.iter().enumerate().map(|(i, r)| format!("SELECT {i} AS \"__src\", * FROM {}", qi(&r.name))).collect();
        let body = format!(
            "SELECT row_number() OVER (ORDER BY \"__src\", {o}) AS {o}, * EXCLUDE (\"__src\", {o}) FROM ({}) AS c",
            parts.join(" UNION ALL BY NAME "),
            o = qi(ORD)
        );
        Ok(Value::Table(self.derive(&refs, body)?))
    }

    fn join_kind(&self, v: Option<&Value>, default: i32) -> R<i32> {
        match v {
            None | Some(Value::Null) => Ok(default),
            Some(Value::Num(n)) if (0.0..=5.0).contains(n) => Ok(*n as i32),
            Some(Value::Num(_)) | Some(_) => Err(MError::expr("The join kind must be JoinKind.Inner, LeftOuter, RightOuter, FullOuter, LeftAnti or RightAnti.")),
        }
    }

    fn nested_join(&self, a: &[Value]) -> R<Value> {
        let l = table_arg(a, 0, "Table.NestedJoin")?;
        self.no_nested(&l)?;
        let lk = text_list(arg(a, 1, "Table.NestedJoin")?, "The left key columns")?;
        let r = table_arg(a, 2, "Table.NestedJoin")?;
        self.no_nested(&r)?;
        let rk = text_list(arg(a, 3, "Table.NestedJoin")?, "The right key columns")?;
        let Value::Text(name) = arg(a, 4, "Table.NestedJoin")? else {
            return Err(MError::expr("The new column name must be text."));
        };
        let kind = self.join_kind(a.get(5), 1)?;
        if lk.len() != rk.len() || lk.is_empty() {
            return Err(MError::expr("The number of key columns must be the same on both sides (and at least one)."));
        }
        self.need(&l, &lk)?;
        self.need(&r, &rk)?;
        if l.col(name).is_some() {
            return Err(MError::expr(format!("The column '{name}' of the table already exists.")));
        }
        let mut out = l.clone();
        out.cols.push(Col { name: name.clone(), ty: NESTED_TY.into() });
        out.nested.push(Nested { name: name.clone(), right: r, left_keys: lk, right_keys: rk, kind });
        Ok(Value::Table(out))
    }

    fn expand_table_column(&self, a: &[Value]) -> R<Value> {
        let t = table_arg(a, 0, "Table.ExpandTableColumn")?;
        let Value::Text(col) = arg(a, 1, "Table.ExpandTableColumn")? else {
            return Err(MError::expr("The column to expand must be given as text."));
        };
        let names = text_list(arg(a, 2, "Table.ExpandTableColumn")?, "The column names")?;
        let new_names = match a.get(3) {
            None | Some(Value::Null) => names.clone(),
            Some(v) => text_list(v, "The new column names")?,
        };
        if names.len() != new_names.len() {
            return Err(MError::expr("The lists of old and new column names must have the same length."));
        }
        let Some(n) = t.nested.iter().find(|n| n.name == *col).cloned() else {
            return Err(if t.col(col).is_some() {
                MError::unsupported("Only a column made by Table.NestedJoin can be expanded.")
            } else {
                missing_col(col)
            });
        };
        if t.nested.len() > 1 {
            return Err(MError::unsupported("Expanding one of several nested columns is not supported."));
        }
        self.need(&n.right, &names)?;
        let left_cols: Vec<&Col> = t.plain_cols().collect();
        for nn in &new_names {
            if left_cols.iter().any(|c| c.name == *nn) {
                return Err(MError::expr(format!("The column '{nn}' of the table already exists.")));
            }
        }
        let lq = |c: &str| format!("l.{}", qi(c));
        let on: Vec<String> = n.left_keys.iter().zip(&n.right_keys).map(|(a, b)| format!("{} IS NOT DISTINCT FROM r.{}", lq(a), qi(b))).collect();
        let on = on.join(" AND ");
        let left_sel: Vec<String> = left_cols.iter().map(|c| format!("l.{} AS {}", qi(&c.name), qi(&c.name))).collect();
        let body = match n.kind {
            4 => {
                let right_sel: Vec<String> = new_names.iter().map(|nn| format!("NULL AS {}", qi(nn))).collect();
                format!(
                    "SELECT l.{o}, {}, {} FROM {} AS l WHERE NOT EXISTS (SELECT 1 FROM {} AS r WHERE {})",
                    left_sel.join(", "),
                    right_sel.join(", "),
                    qi(&t.name),
                    qi(&n.right.name),
                    on,
                    o = qi(ORD)
                )
            }
            5 => return Err(MError::unsupported("JoinKind.RightAnti is not supported.")),
            k => {
                let jt = match k {
                    0 => "JOIN",
                    1 => "LEFT JOIN",
                    2 => "RIGHT JOIN",
                    _ => "FULL JOIN",
                };
                let right_sel: Vec<String> = names.iter().zip(&new_names).map(|(o, nn)| format!("r.{} AS {}", qi(o), qi(nn))).collect();
                let right_keys_for_full: Vec<String> = if k == 2 || k == 3 {
                    // rows that exist only on the right still need their key values on the left side
                    vec![]
                } else {
                    vec![]
                };
                let _ = right_keys_for_full;
                let left_sel2: Vec<String> = if k == 2 || k == 3 {
                    left_cols
                        .iter()
                        .map(|c| match n.left_keys.iter().position(|lk| *lk == c.name) {
                            Some(i) => format!("COALESCE(l.{}, r.{}) AS {}", qi(&c.name), qi(&n.right_keys[i]), qi(&c.name)),
                            None => format!("l.{} AS {}", qi(&c.name), qi(&c.name)),
                        })
                        .collect()
                } else {
                    left_sel.clone()
                };
                format!(
                    "SELECT row_number() OVER (ORDER BY l.{o} NULLS LAST, r.{o} NULLS LAST) AS {o}, {}, {} FROM {} AS l {} {} AS r ON {}",
                    left_sel2.join(", "),
                    right_sel.join(", "),
                    qi(&t.name),
                    jt,
                    qi(&n.right.name),
                    on,
                    o = qi(ORD)
                )
            }
        };
        Ok(Value::Table(self.derive(&[&t, &n.right], body)?))
    }

    fn join(&self, a: &[Value]) -> R<Value> {
        let l = table_arg(a, 0, "Table.Join")?;
        self.no_nested(&l)?;
        let lk = text_list(arg(a, 1, "Table.Join")?, "The left key columns")?;
        let r = table_arg(a, 2, "Table.Join")?;
        self.no_nested(&r)?;
        let rk = text_list(arg(a, 3, "Table.Join")?, "The right key columns")?;
        let kind = self.join_kind(a.get(4), 0)?;
        for c in r.plain_cols() {
            if l.col(&c.name).is_some() {
                return Err(MError::expr(format!("The column '{}' is in both tables; rename it first (Table.Join needs distinct column names).", c.name)));
            }
        }
        let names: Vec<String> = r.plain_cols().map(|c| c.name.clone()).collect();
        let nj = self.nested_join(&[
            Value::Table(l),
            Value::List(lk.into_iter().map(Value::Text).collect()),
            Value::Table(r),
            Value::List(rk.into_iter().map(Value::Text).collect()),
            Value::Text("__join".into()),
            Value::Num(kind as f64),
        ])?;
        self.expand_table_column(&[nj, Value::Text("__join".into()), Value::List(names.into_iter().map(Value::Text).collect())])
    }
}

fn regex_escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
