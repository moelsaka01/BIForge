//! Reading, listing and previewing the sources that are not plain files read by DuckDB.
use super::*;
use crate::creds::CredentialStore;
use crate::error::EngineError;
use crate::types::{ColumnInfo, RowPage, SourceSpec};

/// A small RFC 4180 reader for CSV that arrives over HTTP: quotes, doubled quotes, line breaks inside quotes; the
/// delimiter is the most frequent of , ; tab | in the first line. The first row is the header.
pub fn parse_csv(bytes: &[u8]) -> RawTable {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start_matches('\u{feff}');
    let first = text.lines().next().unwrap_or("");
    let delim = [',', ';', '\t', '|'].into_iter().max_by_key(|d| first.matches(*d).count()).unwrap_or(',');
    let mut rows: Vec<Vec<String>> = vec![vec![]];
    let (mut cur, mut quoted) = (String::new(), false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, quoted) {
            ('"', true) if chars.peek() == Some(&'"') => {
                chars.next();
                cur.push('"');
            }
            ('"', _) => quoted = !quoted,
            (c, false) if c == delim => rows.last_mut().unwrap().push(std::mem::take(&mut cur)),
            ('\r', false) => {}
            ('\n', false) => {
                rows.last_mut().unwrap().push(std::mem::take(&mut cur));
                rows.push(vec![]);
            }
            (c, _) => cur.push(c),
        }
    }
    if !cur.is_empty() || !rows.last().unwrap().is_empty() {
        rows.last_mut().unwrap().push(cur);
    }
    rows.retain(|r| !(r.is_empty() || r.len() == 1 && r[0].is_empty()));
    if rows.is_empty() {
        return RawTable { columns: vec![], rows: vec![] };
    }
    let header = rows.remove(0);
    let width = header.len();
    let data = rows.into_iter().map(|r| (0..width).map(|i| r.get(i).map_or(Cell::Null, |s| Cell::Text(s.clone()))).collect()).collect();
    textinfer::infer(RawTable { columns: clean_names(header), rows: data })
}

/// Text with columns at fixed character positions.
pub fn parse_fixed(text: &str, widths: &[usize], header: bool) -> Result<RawTable> {
    if widths.is_empty() || widths.contains(&0) {
        return Err(EngineError::Source("Give the width of each column (all greater than 0).".into()));
    }
    let mut lines = text.trim_start_matches('\u{feff}').lines().filter(|l| !l.trim().is_empty());
    let split = |l: &str| -> Vec<String> {
        let chars: Vec<char> = l.chars().collect();
        let mut at = 0;
        widths
            .iter()
            .map(|w| {
                let s: String = chars.iter().skip(at).take(*w).collect();
                at += w;
                s.trim().to_string()
            })
            .collect()
    };
    let names = if header { lines.next().map(split).unwrap_or_default() } else { (1..=widths.len()).map(|i| format!("Column{i}")).collect() };
    let rows = lines.map(|l| split(l).into_iter().map(|s| if s.is_empty() { Cell::Null } else { Cell::Text(s) }).collect()).collect();
    Ok(textinfer::infer(RawTable { columns: clean_names(names), rows }))
}

/// Typed rows from the Enter data grid. A cell that does not fit its column type is an error that names the cell.
pub fn parse_inline(columns: &[crate::types::InlineColumn], rows: &[Vec<Option<String>>]) -> Result<RawTable> {
    if columns.is_empty() {
        return Err(EngineError::Source("Add at least one column.".into()));
    }
    let names = clean_names(columns.iter().map(|c| c.name.clone()).collect());
    let mut out = Vec::with_capacity(rows.len());
    for (ri, r) in rows.iter().enumerate() {
        let mut row = Vec::with_capacity(columns.len());
        for (ci, c) in columns.iter().enumerate() {
            let bad = |what: &str| EngineError::Source(format!("Row {}, column \"{}\": \"{}\" is not {what}.", ri + 1, names[ci], r.get(ci).cloned().flatten().unwrap_or_default()));
            let raw = r.get(ci).cloned().flatten();
            let t = raw.as_deref().map(str::trim).filter(|t| !t.is_empty());
            row.push(match (c.ty.as_str(), t) {
                (_, None) => if c.ty == "text" { raw.map_or(Cell::Null, Cell::Text) } else { Cell::Null },
                ("text", Some(_)) => Cell::Text(raw.unwrap()),
                ("whole", Some(t)) => Cell::Int(t.parse().map_err(|_| bad("a whole number"))?),
                ("decimal", Some(t)) => Cell::Float(t.replace(',', ".").parse().map_err(|_| bad("a number"))?),
                ("logical", Some(t)) => match t.to_ascii_lowercase().as_str() {
                    "true" | "yes" | "1" => Cell::Bool(true),
                    "false" | "no" | "0" => Cell::Bool(false),
                    _ => return Err(bad("true or false")),
                },
                ("date", Some(t)) => Cell::Timestamp(chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d").map_err(|_| bad("a date (yyyy-mm-dd)"))?.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_micros()),
                ("datetime", Some(t)) => Cell::Timestamp(
                    chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S").or_else(|_| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S")).or_else(|_| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M")).map_err(|_| bad("a date and time (yyyy-mm-dd hh:mm:ss)"))?.and_utc().timestamp_micros(),
                ),
                (other, _) => return Err(EngineError::Source(format!("Unknown column type \"{other}\"."))),
            });
        }
        out.push(row);
    }
    Ok(RawTable { columns: names, rows: out })
}

/// A JSON file: an array of records, one record, an object holding arrays (the first is used), or JSON lines.
/// Nested records are expanded into dotted columns. Files over 100 MB are left to DuckDB (no nested expansion there).
pub fn read_json_file(path: &str, table: Option<&str>) -> Result<Option<RawTable>> {
    let meta = std::fs::metadata(path).map_err(|_| EngineError::FileNotFound(path.into()))?;
    if meta.len() > 100 * 1024 * 1024 {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&read_file(path)?).to_string();
    let text = text.trim_start_matches('﻿');
    let doc: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            // JSON lines: every non-empty line is a value
            let lines: std::result::Result<Vec<serde_json::Value>, _> = text.lines().filter(|l| !l.trim().is_empty()).map(serde_json::from_str).collect();
            match lines {
                Ok(v) if !v.is_empty() => serde_json::Value::Array(v),
                _ => return Err(EngineError::Source(format!("Could not read JSON file \"{path}\": {e}"))),
            }
        }
    };
    let tables = web_src::json_tables(&doc);
    let items = match table.filter(|t| !t.is_empty()) {
        Some(t) => tables.into_iter().find(|(n, _)| n == t).map(|(_, a)| a).ok_or_else(|| EngineError::Source(format!("The JSON file has no list named \"{t}\".")))?,
        None => tables.into_iter().next().map(|(_, a)| a).unwrap_or_default(),
    };
    Ok(Some(web_src::json_rows_with(&items, true)))
}

fn read_file(path: &str) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|_| EngineError::FileNotFound(path.into()))
}

/// Reads the sources that are not handled by DuckDB or by the older row-wise modules.
pub fn read_other(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<RawTable> {
    read_other_n(spec, creds, None)
}

fn read_other_n(spec: &SourceSpec, creds: &dyn CredentialStore, limit: Option<usize>) -> Result<RawTable> {
    match spec {
        SourceSpec::MySql { .. } => mysql_src::read_n(spec, creds, limit),
        SourceSpec::Odbc { .. } => match limit {
            Some(n) => odbc_src::preview(spec, creds, n),
            None => odbc_src::read(spec, creds),
        },
        SourceSpec::Xml { path, table } => xml_src::read(&String::from_utf8_lossy(&read_file(path)?), table.as_deref()),
        SourceSpec::Pdf { path, table } => {
            read_file(path)?;
            pdf_src::read(path, table.as_deref())
        }
        SourceSpec::Inline { columns, rows } => parse_inline(columns, rows),
        SourceSpec::FixedWidth { path, widths, header } => parse_fixed(&String::from_utf8_lossy(&read_file(path)?), widths, *header),
        SourceSpec::Web { .. } | SourceSpec::OData { .. } => {
            let f = web_src::load(spec, creds)?;
            match &f.csv {
                Some(b) => Ok(parse_csv(b)),
                None => web_src::pick(spec, f),
            }
        }
        _ => Err(EngineError::Source("not one of the additional sources".into())),
    }
}

/// Tables, sheets or entities offered by a source.
pub fn choices(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Vec<String>> {
    match spec {
        SourceSpec::Excel { path, .. } => excel::sheet_names(path),
        SourceSpec::Sqlite { path, .. } => sqlite_src::list_tables(path),
        SourceSpec::Postgres { .. } => postgres_src::list_tables(spec, creds),
        SourceSpec::SqlServer { .. } => sqlserver_src::list_tables(spec, creds),
        SourceSpec::MySql { .. } => mysql_src::list_tables(spec, creds),
        SourceSpec::Odbc { .. } => odbc_src::list_tables(spec, creds),
        SourceSpec::Xml { path, .. } => xml_src::tables_of(&String::from_utf8_lossy(&read_file(path)?)),
        SourceSpec::Pdf { path, .. } => {
            read_file(path)?;
            pdf_src::choices(path)
        }
        SourceSpec::Web { .. } | SourceSpec::OData { .. } => web_src::choices(spec, creds),
        _ => Ok(vec![]),
    }
}

/// The first `limit` rows of a source as text (for the navigator preview).
pub fn preview_page(spec: &SourceSpec, creds: &dyn CredentialStore, limit: usize) -> Result<RowPage> {
    let mut raw = match spec {
        SourceSpec::Excel { path, sheet, header } => excel::read(path, sheet.as_deref(), *header)?,
        SourceSpec::Sqlite { path, table } => sqlite_src::read(path, table)?,
        SourceSpec::Postgres { .. } => postgres_src::read_n(spec, creds, Some(limit))?,
        SourceSpec::SqlServer { .. } => sqlserver_src::read_n(spec, creds, Some(limit))?,
        SourceSpec::MySql { .. }
        | SourceSpec::Odbc { .. }
        | SourceSpec::Xml { .. }
        | SourceSpec::Pdf { .. }
        | SourceSpec::FixedWidth { .. }
        | SourceSpec::Inline { .. }
        | SourceSpec::Web { .. }
        | SourceSpec::OData { .. } => read_other_n(spec, creds, Some(limit))?,
        _ => return Err(EngineError::Source("Preview is available for database, workbook and web sources; files are previewed after import.".into())),
    };
    raw.rows.truncate(limit);
    let types: Vec<&str> = (0..raw.columns.len()).map(|i| column_type(&raw.rows, i)).collect();
    let columns = raw
        .columns
        .iter()
        .zip(&types)
        .map(|(n, t)| ColumnInfo { name: n.clone(), bi_type: crate::types::BiType::from_duckdb(t), duckdb_type: (*t).into() })
        .collect();
    let rows = raw.rows.iter().map(|r| r.iter().map(to_text).collect()).collect();
    Ok(RowPage { columns, rows, total: raw.rows.len() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_from_the_web_handles_quotes_delimiters_and_types() {
        let t = parse_csv("\u{feff}id;name;note\r\n1;\"Smith; J\";\"line\nbreak\"\r\n2;\"say \"\"hi\"\"\";\r\n".as_bytes());
        assert_eq!(t.columns, vec!["id", "name", "note"]);
        assert_eq!(t.rows[0], vec![Cell::Int(1), Cell::Text("Smith; J".into()), Cell::Text("line\nbreak".into())]);
        assert_eq!(t.rows[1][1], Cell::Text("say \"hi\"".into()));
        assert_eq!(t.rows[1][2], Cell::Text(String::new()));
        assert!(parse_csv(b"").columns.is_empty());
    }

    #[test]
    fn typed_in_data_is_converted_by_column_type_and_bad_cells_are_named() {
        use crate::types::InlineColumn as C;
        let cols = vec![C { name: "Name".into(), ty: "text".into() }, C { name: "Qty".into(), ty: "whole".into() }, C { name: "Price".into(), ty: "decimal".into() }, C { name: "Ok".into(), ty: "logical".into() }, C { name: "Day".into(), ty: "date".into() }];
        let rows = vec![vec![Some("a".into()), Some("2".into()), Some("1,5".into()), Some("yes".into()), Some("2024-01-02".into())], vec![Some("".into()), None, None, None, None]];
        let t = parse_inline(&cols, &rows).unwrap();
        assert_eq!(t.rows[0][..4], [Cell::Text("a".into()), Cell::Int(2), Cell::Float(1.5), Cell::Bool(true)]);
        assert!(matches!(t.rows[0][4], Cell::Timestamp(_)));
        assert_eq!(t.rows[1], vec![Cell::Text(String::new()), Cell::Null, Cell::Null, Cell::Null, Cell::Null]);
        let bad = vec![vec![Some("a".into()), Some("x".into()), None, None, None]];
        assert_eq!(parse_inline(&cols, &bad).unwrap_err().to_string(), "Row 1, column \"Qty\": \"x\" is not a whole number.");
        assert!(parse_inline(&[], &[]).is_err());
    }

    #[test]
    fn fixed_width_text_is_cut_at_the_given_widths() {
        let text = "ID  NAME      QTY\n1   Ann        5\n2   Bo        12\n\n";
        let t = parse_fixed(text, &[4, 10, 3], true).unwrap();
        assert_eq!(t.columns, vec!["ID", "NAME", "QTY"]);
        assert_eq!(t.rows[1], vec![Cell::Int(2), Cell::Text("Bo".into()), Cell::Int(12)]);
        let h = parse_fixed(text, &[4, 10, 3], false).unwrap();
        assert_eq!(h.columns[0], "Column1");
        assert_eq!(h.rows.len(), 3);
        assert!(parse_fixed(text, &[], true).is_err());
        assert!(parse_fixed(text, &[3, 0], true).is_err());
    }
}
