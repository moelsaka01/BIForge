//! More table functions of the M standard library (a child module of fold.rs: it uses the evaluator's private helpers).
//! Functions that return a record, a list or a value read the rows from DuckDB; the ones that return a table build it from
//! the existing table steps. Cases: tests/m/stdlib/table*.json.
use super::*;
use crate::stdlib::values_equal;

pub const TABLE_EXT_FNS: &[&str] = &[
    "Table.ColumnCount", "Table.First", "Table.Last", "Table.Row", "Table.FirstValue", "Table.ToRecords", "Table.ToRows", "Table.ToColumns",
    "Table.Max", "Table.Min", "Table.Contains", "Table.ContainsAll", "Table.ContainsAny", "Table.HasColumns", "Table.IsDistinct",
    "Table.PositionOf", "Table.FromColumns", "Table.FromList", "Table.FromValue", "Table.PrefixColumns", "Table.Repeat",
    "Table.InsertRows", "Table.SplitAt",
];

fn cmp(x: &Value, y: &Value) -> std::cmp::Ordering {
    match (x, y) {
        (Value::Num(p), Value::Num(q)) => p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal),
        (Value::Text(p), Value::Text(q)) => p.cmp(q),
        (Value::Null, Value::Null) => std::cmp::Ordering::Equal,
        (Value::Null, _) => std::cmp::Ordering::Less,
        (_, Value::Null) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    }
}

impl<'a> Ev<'a> {
    /// Every row of `t` as a record (the table must have no pending nested columns).
    fn all_records(&self, t: &Rel) -> R<Vec<Vec<(String, Value)>>> {
        self.no_nested(t)?;
        let sql = format!("{}SELECT {} FROM {} ORDER BY {}", t.prefix(), Self::col_list_sql(t), qi(&t.name), qi(ORD));
        let rows = self.be.rows(&sql, 10_000_000).map_err(MError::expr)?;
        Ok(rows.into_iter().map(|r| t.plain_cols().zip(r).map(|(c, v)| (c.name.clone(), Self::cell_value(&c.ty, v))).collect()).collect())
    }

    fn row_matches(row: &[(String, Value)], wanted: &Value) -> R<bool> {
        let Value::Record(w) = wanted else {
            return Err(MError::expr("A row must be a record."));
        };
        Ok(w.iter().all(|(k, v)| row.iter().any(|(k2, v2)| k2 == k && values_equal(v2, v))))
    }

    pub(crate) fn table_ext(&self, name: &str, a: &[Value]) -> R<Option<Value>> {
        if !TABLE_EXT_FNS.contains(&name) {
            return Ok(None);
        }
        let v = match name {
            "Table.ColumnCount" => Value::Num(table_arg(a, 0, name)?.plain_cols().count() as f64),
            "Table.First" | "Table.Last" | "Table.Row" => {
                let t = table_arg(a, 0, name)?;
                let count = self.all_records(&t)?.len();
                let idx = match name {
                    "Table.First" => Some(0usize),
                    "Table.Last" => count.checked_sub(1),
                    _ => Some(num_arg(arg(a, 1, name)?, "The row index")? as usize),
                };
                match idx.filter(|i| *i < count) {
                    Some(i) => self.table_row(&t, i, false)?,
                    None if name == "Table.Row" => return Err(MError::expr("There weren't enough elements in the enumeration to complete the operation.")),
                    None => a.get(1).cloned().unwrap_or(Value::Null),
                }
            }
            "Table.FirstValue" => {
                let t = table_arg(a, 0, name)?;
                match self.all_records(&t)?.into_iter().next() {
                    Some(r) => r.into_iter().next().map(|(_, v)| v).unwrap_or(Value::Null),
                    None => a.get(1).cloned().unwrap_or(Value::Null),
                }
            }
            "Table.ToRecords" => Value::List(self.all_records(&table_arg(a, 0, name)?)?.into_iter().map(Value::Record).collect()),
            "Table.ToRows" => Value::List(self.all_records(&table_arg(a, 0, name)?)?.into_iter().map(|r| Value::List(r.into_iter().map(|(_, v)| v).collect())).collect()),
            "Table.ToColumns" => {
                let t = table_arg(a, 0, name)?;
                let rows = self.all_records(&t)?;
                Value::List((0..t.plain_cols().count()).map(|j| Value::List(rows.iter().map(|r| r[j].1.clone()).collect())).collect())
            }
            "Table.Max" | "Table.Min" => {
                let t = table_arg(a, 0, name)?;
                let col = match arg(a, 1, name)? {
                    Value::Text(c) => c.clone(),
                    Value::List(l) => match l.first() {
                        Some(Value::Text(c)) => c.clone(),
                        _ => return Err(MError::expr("The comparison criteria must name a column.")),
                    },
                    _ => return Err(MError::expr("The comparison criteria must name a column.")),
                };
                if t.col(&col).is_none() {
                    return Err(missing_col(&col));
                }
                let rows = self.all_records(&t)?;
                let key = |r: &Vec<(String, Value)>| r.iter().find(|(k, _)| *k == col).map(|(_, v)| v.clone()).unwrap_or(Value::Null);
                let best = if name == "Table.Max" {
                    rows.into_iter().filter(|r| !matches!(key(r), Value::Null)).reduce(|x, y| if cmp(&key(&y), &key(&x)) == std::cmp::Ordering::Greater { y } else { x })
                } else {
                    rows.into_iter().filter(|r| !matches!(key(r), Value::Null)).reduce(|x, y| if cmp(&key(&y), &key(&x)) == std::cmp::Ordering::Less { y } else { x })
                };
                match best {
                    Some(r) => Value::Record(r),
                    None => a.get(2).cloned().unwrap_or(Value::Null),
                }
            }
            "Table.Contains" => {
                let rows = self.all_records(&table_arg(a, 0, name)?)?;
                let w = arg(a, 1, name)?;
                let mut hit = false;
                for r in &rows {
                    if Self::row_matches(r, w)? {
                        hit = true;
                        break;
                    }
                }
                Value::Bool(hit)
            }
            "Table.ContainsAll" | "Table.ContainsAny" => {
                let rows = self.all_records(&table_arg(a, 0, name)?)?;
                let Value::List(wanted) = arg(a, 1, name)? else {
                    return Err(MError::expr("A list of rows was expected."));
                };
                let mut found = Vec::new();
                for w in wanted {
                    let mut hit = false;
                    for r in &rows {
                        if Self::row_matches(r, w)? {
                            hit = true;
                            break;
                        }
                    }
                    found.push(hit);
                }
                Value::Bool(if name == "Table.ContainsAll" { found.iter().all(|b| *b) } else { found.iter().any(|b| *b) })
            }
            "Table.HasColumns" => {
                let t = table_arg(a, 0, name)?;
                let wanted = text_list(arg(a, 1, name)?, "The column names")?;
                Value::Bool(wanted.iter().all(|n| t.plain_cols().any(|c| &c.name == n)))
            }
            "Table.IsDistinct" => {
                let rows = self.all_records(&table_arg(a, 0, name)?)?;
                let mut distinct = true;
                for (i, r) in rows.iter().enumerate() {
                    if rows[..i].iter().any(|p| values_equal(&Value::Record(p.clone()), &Value::Record(r.clone()))) {
                        distinct = false;
                        break;
                    }
                }
                Value::Bool(distinct)
            }
            "Table.PositionOf" => {
                let rows = self.all_records(&table_arg(a, 0, name)?)?;
                let w = arg(a, 1, name)?;
                let mut found = Vec::new();
                for (i, r) in rows.iter().enumerate() {
                    if Self::row_matches(r, w)? {
                        found.push(i);
                    }
                }
                match a.get(2) {
                    Some(Value::Num(o)) if *o == 2.0 => Value::List(found.into_iter().map(|i| Value::Num(i as f64)).collect()),
                    Some(Value::Num(o)) if *o == 1.0 => Value::Num(found.last().map(|i| *i as f64).unwrap_or(-1.0)),
                    _ => Value::Num(found.first().map(|i| *i as f64).unwrap_or(-1.0)),
                }
            }
            "Table.FromColumns" => {
                let Value::List(cols) = arg(a, 0, name)? else {
                    return Err(MError::expr("Table.FromColumns needs a list of lists."));
                };
                let lists: Vec<&Vec<Value>> = cols.iter().map(|c| if let Value::List(l) = c { Ok(l) } else { Err(MError::expr("Table.FromColumns needs a list of lists.")) }).collect::<R<_>>()?;
                let n = lists.iter().map(|l| l.len()).max().unwrap_or(0);
                let rows: Vec<Value> = (0..n).map(|i| Value::List(lists.iter().map(|l| l.get(i).cloned().unwrap_or(Value::Null)).collect())).collect();
                let names = match a.get(1) {
                    Some(v) if !matches!(v, Value::Null) => v.clone(),
                    _ => Value::Num(lists.len() as f64),
                };
                self.table_literal("#table", &[names, Value::List(rows)])?
            }
            "Table.FromList" => {
                let Value::List(items) = arg(a, 0, name)? else {
                    return Err(MError::expr("Table.FromList needs a list."));
                };
                if matches!(a.get(1), Some(Value::Builtin(_) | Value::Native(..) | Value::Func(_))) {
                    return Err(MError::unsupported("Table.FromList with a splitter is not supported; the list items become one column."));
                }
                let names = match a.get(2) {
                    Some(v @ (Value::List(_) | Value::Text(_))) => v.clone(),
                    _ => Value::List(vec![Value::Text("Column1".into())]),
                };
                let rows: Vec<Value> = items.iter().map(|i| Value::List(vec![i.clone()])).collect();
                self.table_literal("#table", &[names, Value::List(rows)])?
            }
            "Table.FromValue" => {
                let rows: Vec<Value> = match arg(a, 0, name)? {
                    Value::List(items) => items.iter().map(|i| Value::List(vec![i.clone()])).collect(),
                    other => vec![Value::List(vec![other.clone()])],
                };
                self.table_literal("#table", &[Value::List(vec![Value::Text("Value".into())]), Value::List(rows)])?
            }
            "Table.PrefixColumns" => {
                let t = table_arg(a, 0, name)?;
                let Value::Text(prefix) = arg(a, 1, name)? else {
                    return Err(MError::expr("The prefix must be text."));
                };
                let pairs: Vec<Value> = t.plain_cols().map(|c| Value::List(vec![Value::Text(c.name.clone()), Value::Text(format!("{prefix}.{}", c.name))])).collect();
                self.rename_columns(&[Value::Table(t), Value::List(pairs)])?
            }
            "Table.Repeat" => {
                let t = table_arg(a, 0, name)?;
                let n = num_arg(arg(a, 1, name)?, "The repeat count")? as usize;
                if n == 0 {
                    return self.row_window("Table.FirstN", &[Value::Table(t), Value::Num(0.0)]).map(Some);
                }
                self.combine(&[Value::List((0..n).map(|_| Value::Table(t.clone())).collect())])?
            }
            "Table.InsertRows" => {
                let t = table_arg(a, 0, name)?;
                let off = num_arg(arg(a, 1, name)?, "The offset")?;
                let Value::List(records) = arg(a, 2, name)? else {
                    return Err(MError::expr("Table.InsertRows needs a list of records."));
                };
                let names: Vec<String> = t.plain_cols().map(|c| c.name.clone()).collect();
                let rows: Vec<Value> = records
                    .iter()
                    .map(|r| match r {
                        Value::Record(f) => Ok(Value::List(names.iter().map(|n| f.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()).unwrap_or(Value::Null)).collect())),
                        _ => Err(MError::expr("Table.InsertRows needs a list of records.")),
                    })
                    .collect::<R<_>>()?;
                let new = self.table_literal("#table", &[Value::List(names.iter().cloned().map(Value::Text).collect()), Value::List(rows)])?;
                let head = self.row_window("Table.FirstN", &[Value::Table(t.clone()), Value::Num(off)])?;
                let tail = self.row_window("Table.Skip", &[Value::Table(t), Value::Num(off)])?;
                self.combine(&[Value::List(vec![head, new, tail])])?
            }
            "Table.SplitAt" => {
                let t = table_arg(a, 0, name)?;
                let n = arg(a, 1, name)?.clone();
                Value::List(vec![self.row_window("Table.FirstN", &[Value::Table(t.clone()), n.clone()])?, self.row_window("Table.Skip", &[Value::Table(t), n])?])
            }
            _ => return Ok(None),
        };
        Ok(Some(v))
    }
}
