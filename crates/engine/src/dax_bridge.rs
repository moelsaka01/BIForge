//! Connects the DuckDB store to the DAX engine: loads model tables as DAX values and runs the SQL the DAX
//! engine compiles for aggregations.

use crate::sources::q;
use crate::types::BiType;
use crate::Engine;
use biforge_dax::model::{DataType, Model, TableId};
use biforge_dax::sql::SqlExecutor;
use biforge_dax::value::{micros_to_serial, Value, CURRENCY_SCALE};
use duckdb::types::ValueRef;

/// The DAX data type used for a column imported with this type.
pub fn dax_type(t: BiType) -> DataType {
    match t {
        BiType::Int64 => DataType::Int64,
        BiType::Double => DataType::Double,
        BiType::Decimal => DataType::Decimal,
        BiType::Boolean => DataType::Boolean,
        BiType::DateTime => DataType::DateTime,
        BiType::String => DataType::String,
        BiType::Binary => DataType::Binary,
    }
}

fn to_value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Blank,
        ValueRef::Boolean(b) => Value::Bool(b),
        ValueRef::TinyInt(x) => Value::Int(x as i64),
        ValueRef::SmallInt(x) => Value::Int(x as i64),
        ValueRef::Int(x) => Value::Int(x as i64),
        ValueRef::BigInt(x) => Value::Int(x),
        ValueRef::HugeInt(x) => i64::try_from(x).map(Value::Int).unwrap_or(Value::Double(x as f64)),
        ValueRef::UHugeInt(x) => i64::try_from(x).map(Value::Int).unwrap_or(Value::Double(x as f64)),
        ValueRef::UTinyInt(x) => Value::Int(x as i64),
        ValueRef::USmallInt(x) => Value::Int(x as i64),
        ValueRef::UInt(x) => Value::Int(x as i64),
        ValueRef::UBigInt(x) => i64::try_from(x).map(Value::Int).unwrap_or(Value::Double(x as f64)),
        ValueRef::Float(x) => Value::Double(x as f64),
        ValueRef::Double(x) => Value::Double(x),
        ValueRef::Decimal(d) => {
            let f: f64 = d.to_string().parse().unwrap_or(f64::NAN);
            Value::Currency((f * CURRENCY_SCALE as f64).round() as i64)
        }
        ValueRef::Timestamp(unit, x) => Value::DateTime(micros_to_serial(unit.to_micros(x))),
        ValueRef::Date32(days) => Value::DateTime(days as f64 + 25569.0),
        ValueRef::Time64(unit, x) => Value::DateTime(unit.to_micros(x) as f64 / 86_400_000_000.0),
        ValueRef::Text(t) => Value::str(&String::from_utf8_lossy(t)),
        ValueRef::Blob(_) | ValueRef::Geometry(_) => Value::Blank,
        other => Value::str(&format!("{other:?}")),
    }
}

impl biforge_dax::DataSource for Engine {
    /// Reads the table's stored columns in model order. A model table with no data in the store loads empty.
    fn load_table(&self, model: &Model, table: TableId) -> Result<Vec<Vec<Value>>, String> {
        let t = &model.tables[table];
        let base: Vec<&str> = t.columns.iter().filter(|c| c.expression.is_none()).map(|c| c.name.as_str()).collect();
        if !self.has_table(&t.name).map_err(|e| e.to_string())? {
            return Ok(vec![Vec::new(); base.len()]);
        }
        let info = self.table_info(&t.name).map_err(|e| e.to_string())?;
        let mut select = Vec::with_capacity(base.len());
        for c in &base {
            let found = info.columns.iter().find(|x| x.name.eq_ignore_ascii_case(c)).ok_or_else(|| format!("Column '{}'[{c}] has no data in the store; refresh the table.", t.name))?;
            select.push(q(&found.name));
        }
        let sql = format!("SELECT {} FROM {} ORDER BY rowid", if select.is_empty() { "1".into() } else { select.join(", ") }, q(&info.name));
        let mut st = self.conn().prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = st.query([]).map_err(|e| e.to_string())?;
        let mut cols = vec![Vec::with_capacity(info.row_count as usize); base.len()];
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            for (i, col) in cols.iter_mut().enumerate() {
                col.push(to_value(r.get_ref(i).map_err(|e| e.to_string())?));
            }
        }
        Ok(cols)
    }
}

impl SqlExecutor for Engine {
    fn query_scalar(&self, sql: &str) -> Result<Value, String> {
        let mut st = self.conn().prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = st.query([]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(to_value(r.get_ref(0).map_err(|e| e.to_string())?)),
            None => Ok(Value::Blank),
        }
    }
}
