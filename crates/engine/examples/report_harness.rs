//! Development harness for the report UI: serves the DAX fixture project and the real DAX engine over HTTP, so the
//! React report views can be run and looked at in a browser without the Tauri window.
//!
//!     cargo run -p biforge-engine --example report_harness [port]      (default 1431)
//!
//! GET  /project  -> the fixture Project (model with measures and relationships, one empty report page)
//! POST /dax      -> body {"documents": [...TMDL documents...], "query": "..."} answered like the Tauri command dax_query
//! Not part of the product: it listens on 127.0.0.1 only and exists for manual checks and screenshots.

use biforge_dax::editor::result_dto;
use biforge_engine::dax_bridge::DaxCache;
use biforge_engine::{Engine, MemoryCredentialStore, SourceSpec};
use biforge_model::project::Project;
use biforge_model::tmdl::{self, Document};
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Instant;

const TABLES: &[(&str, &[(&str, &str)])] = &[
    ("Date", &[("Date", "dateTime"), ("Year", "int64"), ("Quarter", "string"), ("MonthNumber", "int64"), ("Month", "string"), ("YearMonth", "int64"), ("DayOfWeek", "int64"), ("IsWeekend", "boolean")]),
    ("Customer", &[("CustomerKey", "int64"), ("Customer", "string"), ("City", "string"), ("Country", "string"), ("Segment", "string"), ("BirthDate", "dateTime")]),
    ("Product", &[("ProductKey", "int64"), ("Product", "string"), ("Category", "string"), ("Subcategory", "string"), ("Color", "string"), ("ListPrice", "double"), ("Cost", "double")]),
    ("Promotion", &[("PromotionKey", "int64"), ("Promotion", "string"), ("DiscountPct", "double")]),
    ("Sales", &[("SalesKey", "int64"), ("OrderDate", "dateTime"), ("ShipDate", "dateTime"), ("CustomerKey", "int64"), ("ProductKey", "int64"), ("PromotionKey", "int64"), ("Quantity", "int64"), ("UnitPrice", "double"), ("Discount", "double"), ("Channel", "string")]),
];

fn tmdl_table(name: &str, cols: &[(&str, &str)]) -> String {
    let mut s = format!("table {name}\n");
    if name == "Date" {
        s.push_str("\tdataCategory: Time\n");
    }
    for (c, t) in cols {
        s.push_str(&format!("\tcolumn {c}\n\t\tdataType: {t}\n"));
        if name == "Date" && *c == "Date" {
            s.push_str("\t\tisKey\n");
        }
        if *c == "Month" {
            s.push_str("\t\tsortByColumn: MonthNumber\n");
        }
    }
    if name == "Sales" {
        s.push_str("\tmeasure 'Total Quantity' = SUM(Sales[Quantity])\n\t\tformatString: #,0\n");
        s.push_str("\tmeasure 'Sales Amount' = SUMX(Sales, Sales[Quantity] * Sales[UnitPrice] * (1 - Sales[Discount]))\n\t\tformatString: $#,0\n");
        s.push_str("\tmeasure 'Average Price' = AVERAGE(Sales[UnitPrice])\n\t\tformatString: $#,0.00\n");
        s.push_str("\tmeasure 'Orders' = COUNTROWS(Sales)\n\t\tformatString: #,0\n");
        s.push_str("\tmeasure 'Quantity YTD' = TOTALYTD(SUM(Sales[Quantity]), 'Date'[Date])\n\t\tformatString: #,0\n");
        s.push_str("\tmeasure 'Quantity PY' = CALCULATE(SUM(Sales[Quantity]), SAMEPERIODLASTYEAR('Date'[Date]))\n\t\tformatString: #,0\n");
    }
    s
}

fn fixture_project() -> Project {
    let mut p = Project::new("Fixture");
    for (t, cols) in TABLES {
        p.model.tmdl.insert(format!("tables/{t}.tmdl"), tmdl::parse(&tmdl_table(t, cols)).expect("generated TMDL"));
    }
    let rel = "relationship r_order_date\n\tfromColumn: Sales.OrderDate\n\ttoColumn: Date.Date\nrelationship r_ship_date\n\tfromColumn: Sales.ShipDate\n\ttoColumn: Date.Date\n\tisActive: false\nrelationship r_customer\n\tfromColumn: Sales.CustomerKey\n\ttoColumn: Customer.CustomerKey\nrelationship r_product\n\tfromColumn: Sales.ProductKey\n\ttoColumn: Product.ProductKey\nrelationship r_promotion\n\tfromColumn: Sales.PromotionKey\n\ttoColumn: Promotion.PromotionKey\n\tcrossFilteringBehavior: bothDirections\n";
    p.model.tmdl.insert("relationships.tmdl".into(), tmdl::parse(rel).expect("relationships"));
    p
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/dax/fixtures")
}

fn respond(mut s: TcpStream, status: &str, body: &str) {
    let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(1431);
    let store = Engine::in_memory().expect("in-memory store");
    let creds = MemoryCredentialStore::default();
    for (t, _) in TABLES {
        let path = fixtures().join(format!("{t}.csv")).to_string_lossy().into_owned();
        let info = store.import(t, &SourceSpec::Csv { path, delimiter: None, header: None }, &creds).expect("import fixture CSV");
        // Power BI loads an empty text field as an empty string
        for c in info.columns.iter().filter(|c| c.bi_type == biforge_engine::BiType::String) {
            store.connection().execute(&format!("UPDATE \"{t}\" SET \"{}\" = '' WHERE \"{}\" IS NULL", c.name, c.name), []).unwrap();
        }
    }
    let cache = DaxCache::default();
    let project = serde_json::to_string(&fixture_project()).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    println!("report harness listening on http://127.0.0.1:{port} (GET /project, POST /dax)");
    for stream in listener.incoming().flatten() {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            continue;
        }
        let mut len = 0usize;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                break;
            }
            if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0u8; len];
        let _ = reader.read_exact(&mut body);
        let (method, path) = {
            let mut it = line.split_whitespace();
            (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_string())
        };
        match (method.as_str(), path.as_str()) {
            ("OPTIONS", _) => respond(stream, "204 No Content", ""),
            ("GET", "/project") => respond(stream, "200 OK", &project),
            ("POST", "/dax") => {
                let out = (|| -> Result<String, String> {
                    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
                    let docs: Vec<Document> = serde_json::from_value(v["documents"].clone()).map_err(|e| e.to_string())?;
                    let query = v["query"].as_str().ok_or("no query")?;
                    let started = Instant::now();
                    let key = {
                        use std::hash::{Hash, Hasher};
                        let mut h = std::collections::hash_map::DefaultHasher::new();
                        docs.iter().for_each(|d| tmdl::print(d).hash(&mut h));
                        h.finish()
                    };
                    let engine = cache.get(key, &store, || biforge_dax::Model::from_tmdl(docs.iter()).map_err(|e| e.to_string()))?;
                    let tables = engine.query_with(query, Some(&store)).map_err(|e| e.message)?;
                    let results: Vec<_> = tables.iter().map(result_dto).collect();
                    Ok(json!({"results": results, "elapsedMs": started.elapsed().as_millis() as u64}).to_string())
                })();
                match out {
                    Ok(b) => respond(stream, "200 OK", &b),
                    Err(e) => respond(stream, "400 Bad Request", &json!({"error": e}).to_string()),
                }
            }
            _ => respond(stream, "404 Not Found", "{}"),
        }
    }
}
