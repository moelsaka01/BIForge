//! Web, web API and OData sources. reqwest (blocking, MIT/Apache-2.0) fetches; scraper (ISC) finds HTML tables; JSON is
//! flattened one level (nested values become compact JSON text); OData follows @odata.nextLink.
use super::{clean_names, textinfer, xml_src, Cell, RawTable};
use crate::creds::CredentialStore;
use crate::error::{EngineError, Result};
use crate::types::SourceSpec;
use serde_json::Value;

fn err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Source(format!("Web error: {e}"))
}

/// The only URL schemes that are fetched. Other schemes (file:, ftp:, data:) are refused.
pub fn check_url(url: &str) -> Result<()> {
    let low = url.trim().to_ascii_lowercase();
    if !(low.starts_with("http://") || low.starts_with("https://")) || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(EngineError::Source("Enter an http:// or https:// web address without spaces.".into()));
    }
    Ok(())
}

pub fn get(url: &str, auth: Option<(&str, String)>, accept: &str) -> Result<(Vec<u8>, String)> {
    check_url(url)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("BIForge")
        .build()
        .map_err(err)?;
    let mut rq = client.get(url.trim()).header("Accept", accept);
    if let Some((u, p)) = auth {
        rq = rq.basic_auth(u, Some(p));
    }
    let resp = rq.send().map_err(|e| err(format!("{e:?}")))?;
    let status = resp.status();
    let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if !status.is_success() {
        return Err(EngineError::Source(format!("Web error: the server answered {status} for {url}")));
    }
    if resp.content_length().is_some_and(|n| n > 200 * 1024 * 1024) {
        return Err(EngineError::Source("Web error: the response is larger than 200 MB".into()));
    }
    Ok((resp.bytes().map_err(err)?.to_vec(), ctype))
}

fn auth_of(spec: &SourceSpec, creds: &dyn CredentialStore) -> Option<(String, String)> {
    let user = match spec {
        SourceSpec::Web { user: Some(u), .. } | SourceSpec::OData { user: Some(u), .. } if !u.trim().is_empty() => u.clone(),
        _ => return None,
    };
    let pw = spec.credential_key().and_then(|k| creds.get(&k).ok().flatten()).unwrap_or_default();
    Some((user, pw))
}

fn fetch(spec: &SourceSpec, url: &str, creds: &dyn CredentialStore, accept: &str) -> Result<(Vec<u8>, String)> {
    let a = auth_of(spec, creds);
    get(url, a.as_ref().map(|(u, p)| (u.as_str(), p.clone())), accept)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Html,
    Json,
    Csv,
    Xml,
}

pub fn detect(declared: Option<&str>, url: &str, ctype: &str, body: &[u8]) -> Format {
    match declared.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "html" => return Format::Html,
        "json" => return Format::Json,
        "csv" => return Format::Csv,
        "xml" => return Format::Xml,
        _ => {}
    }
    let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if ctype.contains("json") || path.ends_with(".json") {
        return Format::Json;
    }
    if ctype.contains("csv") || path.ends_with(".csv") {
        return Format::Csv;
    }
    if ctype.contains("xml") && !ctype.contains("html") || path.ends_with(".xml") {
        return Format::Xml;
    }
    if ctype.contains("html") || path.ends_with(".html") || path.ends_with(".htm") {
        return Format::Html;
    }
    match body.iter().find(|b| !b.is_ascii_whitespace()) {
        Some(b'{') | Some(b'[') => Format::Json,
        Some(b'<') => {
            if String::from_utf8_lossy(&body[..body.len().min(400)]).to_ascii_lowercase().contains("<html") { Format::Html } else { Format::Xml }
        }
        _ => Format::Csv,
    }
}

// ---- HTML ----

pub fn html_tables(html: &str) -> Vec<(String, RawTable)> {
    use scraper::{Html, Selector};
    let doc = Html::parse_document(html);
    let (t, tr, cells, cap) = (Selector::parse("table").unwrap(), Selector::parse("tr").unwrap(), Selector::parse("th, td").unwrap(), Selector::parse("caption").unwrap());
    let mut out = Vec::new();
    for (i, table) in doc.select(&t).enumerate() {
        // rows of this table only (a nested table's rows belong to it)
        let rows: Vec<Vec<String>> = table
            .select(&tr)
            .filter(|r| r.ancestors().filter_map(scraper::ElementRef::wrap).find(|a| a.value().name() == "table").map(|a| a.id()) == Some(table.id()))
            .map(|r| r.select(&cells).map(|c| c.text().collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" ")).collect())
            .filter(|r: &Vec<String>| !r.is_empty())
            .collect();
        if rows.len() < 2 {
            continue;
        }
        let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let header = rows[0].clone();
        let columns = clean_names((0..width).map(|c| header.get(c).cloned().unwrap_or_default()).collect());
        let data = rows[1..].iter().map(|r| (0..width).map(|c| r.get(c).map_or(Cell::Null, |s| Cell::Text(s.clone()))).collect()).collect();
        let name = table.select(&cap).next().map(|c| c.text().collect::<String>().trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("Table {}", i + 1));
        out.push((name, textinfer::infer(RawTable { columns, rows: data })));
    }
    out
}

// ---- JSON ----

fn json_cell(v: &Value) -> Cell {
    match v {
        Value::Null => Cell::Null,
        Value::Bool(b) => Cell::Bool(*b),
        Value::Number(n) => n.as_i64().map(Cell::Int).unwrap_or_else(|| Cell::Float(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => Cell::Text(s.clone()),
        other => Cell::Text(other.to_string()),
    }
}

/// Rows of objects (or of scalars, in a column "Value") to a table.
pub fn json_rows(items: &[Value]) -> RawTable {
    let mut cols: Vec<String> = Vec::new();
    for it in items {
        if let Value::Object(m) = it {
            for k in m.keys() {
                if !cols.contains(k) {
                    cols.push(k.clone());
                }
            }
        }
    }
    if cols.is_empty() {
        return textinfer::infer(RawTable { columns: vec!["Value".into()], rows: items.iter().map(|v| vec![json_cell(v)]).collect() });
    }
    let rows = items.iter().map(|it| cols.iter().map(|c| it.get(c).map_or(Cell::Null, json_cell)).collect()).collect();
    // text columns that came from JSON strings keep their text: dates stay text unless every value is an ISO date
    textinfer::infer(RawTable { columns: clean_names(cols), rows })
}

/// The arrays of objects a JSON document offers: the root array, or each top-level key holding one.
pub fn json_tables(v: &Value) -> Vec<(String, Vec<Value>)> {
    match v {
        Value::Array(a) => vec![("List".into(), a.clone())],
        Value::Object(m) => {
            let arrays: Vec<(String, Vec<Value>)> = m.iter().filter_map(|(k, x)| x.as_array().map(|a| (k.clone(), a.clone()))).collect();
            if arrays.is_empty() { vec![("Record".into(), vec![v.clone()])] } else { arrays }
        }
        other => vec![("Value".into(), vec![other.clone()])],
    }
}

// ---- spec entry points ----

pub struct Fetched {
    pub tables: Vec<(String, RawTable)>,
    /// A CSV body that the engine reads through DuckDB (written to a temporary file by the caller).
    pub csv: Option<Vec<u8>>,
}

pub fn load(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Fetched> {
    match spec {
        SourceSpec::Web { url, format, .. } => {
            let (body, ctype) = fetch(spec, url, creds, "text/html, application/json, text/csv, application/xml;q=0.9, */*;q=0.5")?;
            match detect(format.as_deref(), url, &ctype, &body) {
                Format::Html => {
                    let tables = html_tables(&String::from_utf8_lossy(&body));
                    if tables.is_empty() {
                        return Err(EngineError::Source("Web error: the page has no tables".into()));
                    }
                    Ok(Fetched { tables, csv: None })
                }
                Format::Json => {
                    let v: Value = serde_json::from_slice(&body).map_err(|e| err(format!("the response is not valid JSON: {e}")))?;
                    Ok(Fetched { tables: json_tables(&v).into_iter().map(|(n, a)| (n, json_rows(&a))).collect(), csv: None })
                }
                Format::Xml => {
                    let text = String::from_utf8_lossy(&body).to_string();
                    let names = xml_src::tables_of(&text)?;
                    let mut tables = Vec::new();
                    for n in names {
                        tables.push((n.clone(), xml_src::read(&text, Some(&n))?));
                    }
                    Ok(Fetched { tables, csv: None })
                }
                Format::Csv => Ok(Fetched { tables: vec![], csv: Some(body) }),
            }
        }
        SourceSpec::OData { url, entity, .. } => {
            let mut items: Vec<Value> = Vec::new();
            let base = url.trim().trim_end_matches('/');
            let mut next = Some(format!("{base}/{}", entity.trim_matches('/')));
            let mut pages = 0;
            while let Some(u) = next.take() {
                pages += 1;
                if pages > 1000 {
                    return Err(EngineError::Source("OData error: more than 1000 pages; narrow the feed".into()));
                }
                let (body, _) = fetch(spec, &u, creds, "application/json")?;
                let v: Value = serde_json::from_slice(&body).map_err(|e| err(format!("the feed did not answer with JSON: {e}")))?;
                match v.get("value") {
                    Some(Value::Array(a)) => items.extend(a.iter().cloned()),
                    _ => return Err(EngineError::Source("OData error: the answer has no \"value\" list (only OData v4 JSON is supported)".into())),
                }
                next = v.get("@odata.nextLink").and_then(|n| n.as_str()).map(|n| if n.starts_with("http") { n.to_string() } else { format!("{base}/{}", n.trim_start_matches('/')) });
            }
            // @odata annotations are not data
            for it in items.iter_mut() {
                if let Value::Object(m) = it {
                    m.retain(|k, _| !k.starts_with('@') && !k.contains("@odata."));
                }
            }
            Ok(Fetched { tables: vec![(entity.clone(), json_rows(&items))], csv: None })
        }
        _ => Err(EngineError::Source("not a web source".into())),
    }
}

/// Names offered in the navigator: the tables of a page or document, or the entity sets of an OData service.
pub fn choices(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Vec<String>> {
    if let SourceSpec::OData { url, .. } = spec {
        let (body, _) = fetch(spec, url, creds, "application/json")?;
        if let Ok(v) = serde_json::from_slice::<Value>(&body) {
            if let Some(a) = v.get("value").and_then(|x| x.as_array()) {
                let mut n: Vec<String> = a.iter().filter(|e| e.get("kind").and_then(|k| k.as_str()).is_none_or(|k| k == "EntitySet")).filter_map(|e| e.get("name").and_then(|x| x.as_str()).map(String::from)).collect();
                n.sort();
                return Ok(n);
            }
        }
        // $metadata (XML): EntitySet elements
        let (meta, _) = fetch(spec, &format!("{}/$metadata", url.trim().trim_end_matches('/')), creds, "application/xml")?;
        let text = String::from_utf8_lossy(&meta);
        let mut names: Vec<String> = text
            .split("<EntitySet ")
            .skip(1)
            .filter_map(|s| s.split("Name=\"").nth(1).and_then(|x| x.split('"').next()).map(String::from))
            .collect();
        names.sort();
        return Ok(names);
    }
    let f = load(spec, creds)?;
    if f.csv.is_some() {
        return Ok(vec!["Table".into()]);
    }
    Ok(f.tables.into_iter().map(|(n, _)| n).collect())
}

/// The table chosen in the spec (the first when none), or the CSV body.
pub fn pick(spec: &SourceSpec, f: Fetched) -> Result<RawTable> {
    let want = match spec {
        SourceSpec::Web { table, .. } => table.as_deref().filter(|t| !t.is_empty()),
        _ => None,
    };
    match want {
        Some(t) => f.tables.into_iter().find(|(n, _)| n == t).map(|(_, r)| r).ok_or_else(|| EngineError::Source(format!("Web error: no table named \"{t}\" in the response"))),
        None => f.tables.into_iter().next().map(|(_, r)| r).ok_or_else(|| EngineError::Source("Web error: the response has no table".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_addresses_are_fetched() {
        assert!(check_url("https://example.com/a?b=c").is_ok());
        for bad in ["file:///c:/x", "ftp://h/x", "javascript:alert(1)", "https://a b", ""] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_format_comes_from_the_choice_then_the_header_then_the_address_then_the_content() {
        assert_eq!(detect(Some("csv"), "http://h/x.json", "application/json", b"{}"), Format::Csv);
        assert_eq!(detect(None, "http://h/x", "application/json; charset=utf-8", b""), Format::Json);
        assert_eq!(detect(None, "http://h/x.csv?a=1", "text/plain", b"a,b"), Format::Csv);
        assert_eq!(detect(None, "http://h/x", "text/html", b"<html>"), Format::Html);
        assert_eq!(detect(None, "http://h/x", "", b" [1]"), Format::Json);
        assert_eq!(detect(None, "http://h/x", "", b"<root/>"), Format::Xml);
        assert_eq!(detect(None, "http://h/x", "", b"<!doctype html><HTML>"), Format::Html);
    }

    #[test]
    fn html_tables_are_found_with_header_row_caption_and_typed_columns() {
        let html = r#"<html><body><table><caption>Sales</caption><tr><th>Region</th><th>Units</th></tr>
            <tr><td>North</td><td>10</td></tr><tr><td>South &amp; East</td><td>12</td></tr></table>
            <table><tr><td>only one row</td></tr></table>
            <table id="t2"><tr><td>a</td><td>b</td></tr><tr><td>1</td></tr></table></body></html>"#;
        let t = html_tables(html);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].0, "Sales");
        assert_eq!(t[0].1.columns, vec!["Region", "Units"]);
        assert_eq!(t[0].1.rows[1], vec![Cell::Text("South & East".into()), Cell::Int(12)]);
        assert_eq!(t[1].0, "Table 3");
        assert_eq!(t[1].1.rows[0], vec![Cell::Int(1), Cell::Null]);
    }

    #[test]
    fn json_becomes_rows_with_nested_values_as_text_and_missing_keys_as_null() {
        let v: Value = serde_json::from_str(r#"{"meta":1,"items":[{"id":1,"name":"a","tags":["x"]},{"id":2,"extra":true}],"other":[3,4]}"#).unwrap();
        let t = json_tables(&v);
        assert_eq!(t.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), vec!["items", "other"]);
        let r = json_rows(&t[0].1);
        assert_eq!(r.columns, vec!["id", "name", "tags", "extra"]);
        assert_eq!(r.rows[0], vec![Cell::Int(1), Cell::Text("a".into()), Cell::Text("[\"x\"]".into()), Cell::Null]);
        assert_eq!(r.rows[1][3], Cell::Bool(true));
        assert_eq!(json_rows(&t[1].1).columns, vec!["Value"]);
    }
}
