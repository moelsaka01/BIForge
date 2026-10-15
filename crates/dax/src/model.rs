//! Semantic model as the DAX engine sees it: tables, columns, measures and relationships, with
//! case-insensitive name lookup. Built directly or from the project's TMDL documents.

use biforge_model::tmdl::{Document, Node};
use std::collections::HashMap;

pub type TableId = usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ColId {
    pub table: TableId,
    pub col: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataType {
    Int64,
    Double,
    Decimal,
    Boolean,
    DateTime,
    String,
    Binary,
    /// Unknown / not declared (calculated columns before evaluation).
    Variant,
}

impl DataType {
    pub fn from_tmdl(s: &str) -> DataType {
        match s.to_ascii_lowercase().as_str() {
            "int64" => DataType::Int64,
            "double" => DataType::Double,
            "decimal" => DataType::Decimal,
            "boolean" => DataType::Boolean,
            "datetime" => DataType::DateTime,
            "string" => DataType::String,
            "binary" => DataType::Binary,
            _ => DataType::Variant,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Column {
    pub name: String,
    pub data_type: DataType,
    /// DAX expression for a calculated column.
    pub expression: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Table {
    pub name: String,
    pub columns: Vec<Column>,
}

#[derive(Debug, Clone)]
pub struct Measure {
    pub table: TableId,
    pub name: String,
    pub expression: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrossFilter {
    /// The one side filters the many side.
    Single,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cardinality {
    ManyToOne,
    OneToOne,
    ManyToMany,
}

/// `from` is the many side (for many-to-one), `to` the one side.
#[derive(Debug, Clone)]
pub struct Relationship {
    pub name: String,
    pub from: ColId,
    pub to: ColId,
    pub cardinality: Cardinality,
    pub cross_filter: CrossFilter,
    pub active: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Model {
    pub tables: Vec<Table>,
    pub measures: Vec<Measure>,
    pub relationships: Vec<Relationship>,
    /// Key columns of tables marked as date tables ("Mark as date table"). A CALCULATE filter on such a column
    /// replaces every filter on that table, not only the filters on the column.
    pub date_tables: Vec<ColId>,
    table_index: HashMap<String, TableId>,
    measure_index: HashMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{0}")]
pub struct ModelError(pub String);

fn norm(s: &str) -> String {
    s.to_lowercase()
}

impl Model {
    pub fn new() -> Model {
        Model::default()
    }

    pub fn add_table(&mut self, name: &str, columns: &[(&str, DataType)]) -> Result<TableId, ModelError> {
        if self.table_index.contains_key(&norm(name)) {
            return Err(ModelError(format!("Table '{name}' already exists.")));
        }
        let id = self.tables.len();
        self.tables.push(Table {
            name: name.to_string(),
            columns: columns.iter().map(|(n, t)| Column { name: n.to_string(), data_type: *t, expression: None }).collect(),
        });
        self.table_index.insert(norm(name), id);
        Ok(id)
    }

    /// Marks a table as a date table through its date key column.
    pub fn mark_date_table(&mut self, table: &str, column: &str) -> Result<ColId, ModelError> {
        let t = self.table_id(table).ok_or_else(|| ModelError(format!("Table '{table}' does not exist.")))?;
        let c = self.column_id(t, column).ok_or_else(|| ModelError(format!("Column '{table}'[{column}] does not exist.")))?;
        if self.column(c).data_type != DataType::DateTime {
            return Err(ModelError(format!("The date table key '{table}'[{column}] must be a date column.")));
        }
        self.date_tables.retain(|x| x.table != t);
        self.date_tables.push(c);
        Ok(c)
    }

    pub fn add_calculated_column(&mut self, table: &str, name: &str, expression: &str) -> Result<ColId, ModelError> {
        let t = self.table_id(table).ok_or_else(|| ModelError(format!("Table '{table}' does not exist.")))?;
        if self.column_id(t, name).is_some() || self.measure(name).is_some() {
            return Err(ModelError(format!("The name '{name}' is already used in table '{table}'.")));
        }
        self.tables[t].columns.push(Column { name: name.into(), data_type: DataType::Variant, expression: Some(expression.into()) });
        Ok(ColId { table: t, col: self.tables[t].columns.len() - 1 })
    }

    pub fn add_measure(&mut self, table: &str, name: &str, expression: &str) -> Result<usize, ModelError> {
        let t = self.table_id(table).ok_or_else(|| ModelError(format!("Table '{table}' does not exist.")))?;
        if self.measure_index.contains_key(&norm(name)) {
            return Err(ModelError(format!("Measure '{name}' already exists.")));
        }
        self.measures.push(Measure { table: t, name: name.into(), expression: expression.into() });
        self.measure_index.insert(norm(name), self.measures.len() - 1);
        Ok(self.measures.len() - 1)
    }

    /// Adds a relationship from `from_table[from_col]` (many side) to `to_table[to_col]` (one side).
    pub fn add_relationship(&mut self, from: (&str, &str), to: (&str, &str), cross: CrossFilter, active: bool) -> Result<usize, ModelError> {
        self.add_relationship_ex(from, to, Cardinality::ManyToOne, cross, active)
    }

    pub fn add_relationship_ex(&mut self, from: (&str, &str), to: (&str, &str), cardinality: Cardinality, cross: CrossFilter, active: bool) -> Result<usize, ModelError> {
        let f = self.resolve_column(from.0, from.1)?;
        let t = self.resolve_column(to.0, to.1)?;
        if f.table == t.table {
            return Err(ModelError("A relationship must connect two different tables.".into()));
        }
        let name = format!("{}[{}] -> {}[{}]", from.0, from.1, to.0, to.1);
        self.relationships.push(Relationship { name, from: f, to: t, cardinality, cross_filter: cross, active });
        Ok(self.relationships.len() - 1)
    }

    fn resolve_column(&self, table: &str, col: &str) -> Result<ColId, ModelError> {
        let t = self.table_id(table).ok_or_else(|| ModelError(format!("Table '{table}' does not exist.")))?;
        self.column_id(t, col).ok_or_else(|| ModelError(format!("Column '{table}'[{col}] does not exist.")))
    }

    pub fn table_id(&self, name: &str) -> Option<TableId> {
        self.table_index.get(&norm(name)).copied()
    }
    pub fn column_id(&self, table: TableId, name: &str) -> Option<ColId> {
        let n = norm(name);
        self.tables[table].columns.iter().position(|c| norm(&c.name) == n).map(|col| ColId { table, col })
    }
    pub fn measure(&self, name: &str) -> Option<usize> {
        self.measure_index.get(&norm(name)).copied()
    }
    pub fn column(&self, c: ColId) -> &Column {
        &self.tables[c.table].columns[c.col]
    }
    pub fn column_name(&self, c: ColId) -> String {
        format!("{}[{}]", quote_table(&self.tables[c.table].name), self.tables[c.table].columns[c.col].name)
    }
    pub fn columns_of(&self, t: TableId) -> impl Iterator<Item = ColId> + '_ {
        (0..self.tables[t].columns.len()).map(move |col| ColId { table: t, col })
    }

    /// Builds the model from TMDL documents (`tables/*.tmdl`, `relationships.tmdl`, ...). Columns with an
    /// expression are calculated columns; `measure` nodes become measures.
    pub fn from_tmdl<'a>(docs: impl IntoIterator<Item = &'a Document>) -> Result<Model, ModelError> {
        let docs: Vec<&Document> = docs.into_iter().collect();
        let mut m = Model::new();
        let mut pending_measures = Vec::new();
        for d in &docs {
            for n in d.nodes.iter().filter(|n| n.kind == "table") {
                let name = n.name.clone().unwrap_or_default();
                let mut cols = Vec::new();
                let mut calcs = Vec::new();
                for c in n.children.iter().filter(|c| c.kind == "column") {
                    let cname = c.name.clone().unwrap_or_default();
                    let dt = DataType::from_tmdl(c.text_prop("dataType").unwrap_or(""));
                    match &c.default {
                        Some(e) => calcs.push((cname, dt, e.text.clone())),
                        None => cols.push((cname, dt)),
                    }
                }
                let refs: Vec<(&str, DataType)> = cols.iter().map(|(n, t)| (n.as_str(), *t)).collect();
                m.add_table(&name, &refs)?;
                for (cn, dt, e) in calcs {
                    let id = m.add_calculated_column(&name, &cn, &e)?;
                    m.tables[id.table].columns[id.col].data_type = dt;
                }
                if n.text_prop("dataCategory").is_some_and(|v| v.eq_ignore_ascii_case("time")) {
                    if let Some(k) = n.children.iter().find(|c| c.kind == "column" && c.has_flag("isKey")) {
                        // a key column that is not a date column cannot mark the table; the table stays unmarked
                        let _ = m.mark_date_table(&name, k.name.as_deref().unwrap_or(""));
                    }
                }
                for me in n.children.iter().filter(|c| c.kind == "measure") {
                    pending_measures.push((name.clone(), me.name.clone().unwrap_or_default(), me.default.as_ref().map(|e| e.text.clone()).unwrap_or_default()));
                }
            }
        }
        for (t, n, e) in pending_measures {
            m.add_measure(&t, &n, &e)?;
        }
        for d in &docs {
            for n in d.nodes.iter().filter(|n| n.kind == "relationship") {
                m.add_tmdl_relationship(n)?;
            }
        }
        Ok(m)
    }

    fn add_tmdl_relationship(&mut self, n: &Node) -> Result<(), ModelError> {
        let col = |key: &str| -> Result<(String, String), ModelError> {
            let v = n.text_prop(key).ok_or_else(|| ModelError(format!("relationship {} has no {key}", n.name.clone().unwrap_or_default())))?;
            split_tmdl_column_ref(v).ok_or_else(|| ModelError(format!("relationship {key} '{v}' is not Table.Column")))
        };
        let (ft, fc) = col("fromColumn")?;
        let (tt, tc) = col("toColumn")?;
        let from_card = n.text_prop("fromCardinality").unwrap_or("many");
        let to_card = n.text_prop("toCardinality").unwrap_or("one");
        let cardinality = match (from_card, to_card) {
            ("one", "one") => Cardinality::OneToOne,
            ("many", "many") => Cardinality::ManyToMany,
            _ => Cardinality::ManyToOne,
        };
        let cross = if n.text_prop("crossFilteringBehavior") == Some("bothDirections") { CrossFilter::Both } else { CrossFilter::Single };
        let active = n.text_prop("isActive") != Some("false");
        // a one-to-many written from the one side is stored many-to-one
        let (from, to) = if from_card == "one" && to_card == "many" { ((tt, tc), (ft, fc)) } else { ((ft, fc), (tt, tc)) };
        let id = self.add_relationship_ex((&from.0, &from.1), (&to.0, &to.1), cardinality, cross, active)?;
        if let Some(name) = &n.name {
            self.relationships[id].name = name.clone();
        }
        Ok(())
    }
}

/// `'Sales Table'.'Net Amount'` or `Sales.Amount` -> (table, column).
pub fn split_tmdl_column_ref(s: &str) -> Option<(String, String)> {
    let s = s.trim();
    let (table, rest) = if let Some(r) = s.strip_prefix('\'') {
        let mut out = String::new();
        let mut it = r.char_indices().peekable();
        let mut end = None;
        while let Some((i, ch)) = it.next() {
            if ch == '\'' {
                if it.peek().map(|p| p.1) == Some('\'') {
                    out.push('\'');
                    it.next();
                    continue;
                }
                end = Some(i);
                break;
            }
            out.push(ch);
        }
        let end = end?;
        (out, r[end + 1..].strip_prefix('.')?.to_string())
    } else {
        let (t, c) = s.split_once('.')?;
        (t.to_string(), c.to_string())
    };
    let col = rest.trim();
    let col = if let Some(c) = col.strip_prefix('\'').and_then(|c| c.strip_suffix('\'')) { c.replace("''", "'") } else { col.to_string() };
    Some((table, col))
}

pub fn quote_table(name: &str) -> String {
    if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') && !name.starts_with(|c: char| c.is_ascii_digit()) {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_from_tmdl_with_calc_columns_measures_and_relationships() {
        let sales = biforge_model::tmdl::parse(
            "table Sales\n\tcolumn ProductKey\n\t\tdataType: int64\n\tcolumn Amount\n\t\tdataType: double\n\tcolumn Double = Sales[Amount] * 2\n\t\tdataType: double\n\tmeasure Total = SUM(Sales[Amount])\n",
        )
        .unwrap();
        let product = biforge_model::tmdl::parse("table 'Product Table'\n\tcolumn ProductKey\n\t\tdataType: int64\n").unwrap();
        let rels = biforge_model::tmdl::parse(
            "relationship r1\n\tfromColumn: Sales.ProductKey\n\ttoColumn: 'Product Table'.ProductKey\n\tcrossFilteringBehavior: bothDirections\n\tisActive: false\n",
        )
        .unwrap();
        let m = Model::from_tmdl([&sales, &product, &rels]).unwrap();
        let s = m.table_id("sales").unwrap();
        assert_eq!(m.tables[s].columns.len(), 3);
        assert_eq!(m.tables[s].columns[2].expression.as_deref(), Some("Sales[Amount] * 2"));
        assert_eq!(m.measure("TOTAL"), Some(0));
        let r = &m.relationships[0];
        assert_eq!(r.name, "r1");
        assert_eq!((r.from.table, r.to.table), (s, m.table_id("Product Table").unwrap()));
        assert_eq!(r.cross_filter, CrossFilter::Both);
        assert!(!r.active);
    }

    #[test]
    fn tmdl_column_refs() {
        assert_eq!(split_tmdl_column_ref("Sales.Amount"), Some(("Sales".into(), "Amount".into())));
        assert_eq!(split_tmdl_column_ref("'My ''T'''.'Net Amt'"), Some(("My 'T'".into(), "Net Amt".into())));
        assert_eq!(split_tmdl_column_ref("nodot"), None);
    }
}
