//! The additional connectors, end to end through Engine::import: local HTTP server for Web/OData, files for XML/PDF/fixed width,
//! a real Access database through the ODBC driver when the machine has one, and MySQL / SQL Server when the environment names a server.
use biforge_engine::{source_choices, source_preview, BiType, Engine, MemoryCredentialStore, SourceSpec};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

type Routes = Vec<(&'static str, &'static str, String)>; // path prefix, content type, body

/// A tiny HTTP server on localhost. Returns its base address and the request log (path, Authorization header).
fn serve(routes: Routes) -> (String, Arc<Mutex<Vec<(String, Option<String>)>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let log2 = log.clone();
    let base2 = base.clone();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(mut s) = s else { continue };
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let auth = req.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization:")).map(|l| l[14..].trim().to_string());
            log2.lock().unwrap().push((path.clone(), auth));
            let hit = routes.iter().filter(|(p, _, _)| path.starts_with(p)).max_by_key(|(p, _, _)| p.len());
            let (status, ct, body) = match hit {
                Some((_, ct, b)) => ("200 OK", *ct, b.replace("{base}", &base2)),
                None => ("404 Not Found", "text/plain", "no".to_string()),
            };
            let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        }
    });
    (base, log)
}

fn creds() -> MemoryCredentialStore {
    MemoryCredentialStore::default()
}

fn web(url: String, format: Option<&str>, table: Option<&str>) -> SourceSpec {
    SourceSpec::Web { url, format: format.map(String::from), table: table.map(String::from), user: None }
}

#[test]
fn web_pages_json_and_csv_import_as_typed_tables() {
    let (base, _) = serve(vec![
        ("/page", "text/html", "<html><table><caption>Sales</caption><tr><th>Region</th><th>Units</th></tr><tr><td>N</td><td>10</td></tr><tr><td>S</td><td>12</td></tr></table></html>".into()),
        ("/data.json", "application/json", r#"{"rows":[{"id":1,"price":2.5,"ok":true,"day":"2024-01-02"},{"id":2,"price":3,"ok":false,"day":"2024-01-03"}],"other":[1]}"#.into()),
        ("/data.csv", "text/csv", "id,name\n1,Ann\n2,Bo\n".into()),
        ("/odd", "application/octet-stream", "[{\"a\":1}]".into()),
    ]);
    let e = Engine::in_memory().unwrap();
    let c = creds();

    assert_eq!(source_choices(&web(format!("{base}/page"), None, None), &c).unwrap(), vec!["Sales"]);
    let t = e.import("Page", &web(format!("{base}/page"), None, None), &c).unwrap();
    assert_eq!((t.row_count, t.columns.iter().map(|x| (x.name.as_str(), x.bi_type)).collect::<Vec<_>>()), (2, vec![("Region", BiType::String), ("Units", BiType::Int64)]));

    assert_eq!(source_choices(&web(format!("{base}/data.json"), None, None), &c).unwrap(), vec!["rows", "other"]);
    let j = e.import("Json", &web(format!("{base}/data.json"), None, Some("rows")), &c).unwrap();
    let types: Vec<_> = j.columns.iter().map(|x| x.bi_type).collect();
    assert_eq!(types, vec![BiType::Int64, BiType::Double, BiType::Boolean, BiType::DateTime]);

    let csv = e.import("Csv", &web(format!("{base}/data.csv"), None, None), &c).unwrap();
    assert_eq!(csv.row_count, 2);
    // content sniffing and an explicit format
    assert_eq!(e.import("Odd", &web(format!("{base}/odd"), None, None), &c).unwrap().row_count, 1);
    assert_eq!(e.import("Odd2", &web(format!("{base}/odd"), Some("json"), None), &c).unwrap().row_count, 1);

    // preview shows rows without importing
    let p = source_preview(&web(format!("{base}/page"), None, None), &c, 1).unwrap();
    assert_eq!((p.rows.len(), p.rows[0][0].as_deref()), (1, Some("N")));
    assert!(!e.has_table("Preview").unwrap());

    // problems are readable and leave existing tables alone
    let before = e.table_info("Page").unwrap().row_count;
    let err = e.import("Page", &web(format!("{base}/missing"), None, None), &c).unwrap_err().to_string();
    assert!(err.contains("404"), "{err}");
    assert!(e.import("Page", &web("file:///c:/windows/win.ini".into(), None, None), &c).is_err());
    assert!(e.import("Page", &web(format!("{base}/data.json"), Some("html"), None), &c).is_err());
    assert_eq!(e.table_info("Page").unwrap().row_count, before);
}

#[test]
fn basic_authentication_uses_the_stored_secret_and_the_spec_holds_none() {
    let (base, log) = serve(vec![("/secure", "application/json", r#"[{"x":1}]"#.into())]);
    let spec = SourceSpec::Web { url: format!("{base}/secure"), format: None, table: None, user: Some("ann".into()) };
    let c = creds();
    use biforge_engine::CredentialStore;
    c.set(&spec.credential_key().unwrap(), "s3cret").unwrap();
    Engine::in_memory().unwrap().import("T", &spec, &c).unwrap();
    let auth = log.lock().unwrap().last().unwrap().1.clone().unwrap();
    assert_eq!(auth, "Basic YW5uOnMzY3JldA=="); // ann:s3cret
    assert!(!serde_json::to_string(&spec).unwrap().contains("s3cret"));
}

#[test]
fn odata_lists_entity_sets_follows_next_links_and_drops_annotations() {
    let (base, _) = serve(vec![
        ("/svc/Products", "application/json", r#"{"@odata.context":"x","value":[{"@odata.id":"a","ID":1,"Name":"Pen","Price":1.5},{"ID":2,"Name":"Ink","Price":2}],"@odata.nextLink":"{base}/svc/Products?page=2"}"#.into()),
        ("/svc/Products?page=2", "application/json", r#"{"value":[{"ID":3,"Name":"Pad","Price":3.25}]}"#.into()),
        ("/svc", "application/json", r#"{"value":[{"name":"Products","kind":"EntitySet","url":"Products"},{"name":"Top","kind":"FunctionImport","url":"Top"}]}"#.into()),
    ]);
    let spec = SourceSpec::OData { url: format!("{base}/svc"), entity: "Products".into(), user: None };
    let c = creds();
    assert_eq!(source_choices(&spec, &c).unwrap(), vec!["Products"]);
    let e = Engine::in_memory().unwrap();
    let t = e.import("Products", &spec, &c).unwrap();
    assert_eq!(t.row_count, 3);
    assert_eq!(t.columns.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["ID", "Name", "Price"]);
    assert_eq!(e.fetch_page("Products", 0, 10, None).unwrap().rows[2], vec![Some("3".into()), Some("Pad".into()), Some("3.25".into())]);
}

#[test]
fn xml_fixed_width_and_pdf_files_import() {
    let d = tempfile::tempdir().unwrap();
    let e = Engine::in_memory().unwrap();
    let c = creds();

    let xml = d.path().join("shop.xml");
    std::fs::write(&xml, r#"<shop><item id="1"><title>Pen</title><price>1.5</price></item><item id="2"><title>Ink</title><price>2</price></item></shop>"#).unwrap();
    let spec = SourceSpec::Xml { path: xml.to_string_lossy().into(), table: Some("item".into()) };
    assert_eq!(source_choices(&spec, &c).unwrap(), vec!["item"]);
    let t = e.import("Items", &spec, &c).unwrap();
    assert_eq!(t.columns.iter().map(|x| (x.name.as_str(), x.bi_type)).collect::<Vec<_>>(), vec![("id", BiType::Int64), ("title", BiType::String), ("price", BiType::Double)]);

    let fw = d.path().join("fw.txt");
    std::fs::write(&fw, "ID  NAME      QTY\n1   Ann        5\n2   Bo        12\n").unwrap();
    let t = e.import("Fixed", &SourceSpec::FixedWidth { path: fw.to_string_lossy().into(), widths: vec![4, 10, 3], header: true }, &c).unwrap();
    assert_eq!((t.row_count, t.columns[2].bi_type), (2, BiType::Int64));

    let pdf = d.path().join("t.pdf");
    biforge_engine::sources::pdf_src::testpdf::make(&pdf, &[(50, 650, "Region"), (200, 650, "Units"), (50, 636, "North"), (200, 636, "10"), (50, 622, "South"), (200, 622, "12")]);
    let t = e.import("Pdf", &SourceSpec::Pdf { path: pdf.to_string_lossy().into(), table: None }, &c).unwrap();
    assert_eq!((t.row_count, t.columns[1].bi_type), (2, BiType::Int64));

    assert!(matches!(e.import("Gone", &SourceSpec::Xml { path: "C:/nope/x.xml".into(), table: None }, &c), Err(biforge_engine::EngineError::FileNotFound(_))));
}

// ---- ODBC against a real Access database (needs the Access ODBC driver; it is on this machine, not on the CI runner) ----

fn access_driver() -> Option<String> {
    let env = odbc_api::Environment::new().ok()?;
    env.drivers().ok()?.into_iter().map(|d| d.description).find(|n| n.contains("*.accdb"))
}

#[test]
fn odbc_reads_an_access_database_with_typed_columns_custom_sql_and_a_table_list() {
    let Some(driver) = access_driver() else {
        eprintln!("SKIPPED: no Access ODBC driver on this machine");
        assert!(std::env::var("BIFORGE_REQUIRE_ACCESS").is_err(), "the Access driver is required here");
        return;
    };
    let d = tempfile::tempdir().unwrap();
    let db = d.path().join("shop.accdb");
    let script = format!("$c = New-Object -ComObject ADOX.Catalog; $null = $c.Create('Provider=Microsoft.ACE.OLEDB.12.0;Data Source={};')", db.display());
    let made = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &script]).status();
    if !made.map(|s| s.success()).unwrap_or(false) || !db.exists() {
        eprintln!("SKIPPED: could not create an Access database (no ACE OLE DB provider)");
        return;
    }
    let conn = format!("Driver={{{driver}}};Dbq={};", db.display());
    {
        let env = odbc_api::Environment::new().unwrap();
        let c = env.connect_with_connection_string(&conn, odbc_api::ConnectionOptions::default()).unwrap();
        for sql in [
            "CREATE TABLE People (Id LONG, [Full Name] TEXT(50), Score DOUBLE, Price CURRENCY, Born DATETIME, Active YESNO)",
            "INSERT INTO People VALUES (1, 'Ann', 1.5, 2.25, #2024-01-02#, -1)",
            "INSERT INTO People VALUES (2, 'Bob', NULL, NULL, NULL, 0)",
            "CREATE TABLE Other (a LONG)",
        ] {
            c.execute(sql, (), None).unwrap();
        }
    }
    let spec = |table: Option<&str>, query: Option<&str>| SourceSpec::Odbc { flavor: "access".into(), connection: conn.clone(), user: None, table: table.map(String::from), query: query.map(String::from) };
    let c = creds();
    let names = source_choices(&spec(None, None), &c).unwrap();
    assert_eq!(names, vec!["Other", "People"], "system tables are not offered");

    let e = Engine::in_memory().unwrap();
    let t = e.import("People", &spec(Some("People"), None), &c).unwrap();
    let cols: Vec<_> = t.columns.iter().map(|x| (x.name.as_str(), x.bi_type)).collect();
    assert_eq!(
        cols,
        vec![("Id", BiType::Int64), ("Full Name", BiType::String), ("Score", BiType::Double), ("Price", BiType::Double), ("Born", BiType::DateTime), ("Active", BiType::Boolean)]
    );
    let page = e.fetch_page("People", 0, 10, None).unwrap();
    assert_eq!(page.rows[0][..3], [Some("1".into()), Some("Ann".into()), Some("1.5".into())]);
    assert_eq!(page.rows[1][2], None);

    // custom SQL replaces the table; the preview is limited
    let q = e.import("Adults", &spec(None, Some("SELECT Id, [Full Name] AS N FROM People WHERE Id > 1")), &c).unwrap();
    assert_eq!((q.row_count, q.columns[1].name.as_str()), (1, "N"));
    assert_eq!(source_preview(&spec(Some("People"), None), &c, 1).unwrap().rows.len(), 1);

    // a password in the connection string is refused, a missing table is reported
    let bad = SourceSpec::Odbc { flavor: "access".into(), connection: format!("{conn}PWD=x;"), user: None, table: Some("People".into()), query: None };
    assert!(e.import("X", &bad, &c).unwrap_err().to_string().contains("password"));
    assert!(e.import("X", &spec(Some("Nope"), None), &c).is_err());
    assert!(!e.has_table("X").unwrap());
}

// ---- MySQL / MariaDB when BIFORGE_TEST_MYSQL=host:port:database:user:password:table names a server ----

#[test]
fn mysql_imports_with_typed_columns_and_custom_sql() {
    let Ok(v) = std::env::var("BIFORGE_TEST_MYSQL") else {
        eprintln!("SKIPPED: BIFORGE_TEST_MYSQL not set");
        assert!(std::env::var("BIFORGE_REQUIRE_MYSQL").is_err(), "a MySQL server is required here");
        return;
    };
    let p: Vec<&str> = v.splitn(6, ':').collect();
    let spec = |table: &str, query: Option<&str>| SourceSpec::MySql { host: p[0].into(), port: p[1].parse().unwrap(), database: p[2].into(), user: p[3].into(), table: table.into(), query: query.map(String::from) };
    let c = creds();
    use biforge_engine::CredentialStore;
    c.set(&spec("", None).credential_key().unwrap(), p[4]).unwrap();
    assert!(source_choices(&spec("", None), &c).unwrap().contains(&p[5].to_string()));
    let e = Engine::in_memory().unwrap();
    let t = e.import("My", &spec(p[5], None), &c).unwrap();
    let ty = |n: &str| t.columns.iter().find(|x| x.name == n).unwrap().bi_type;
    assert_eq!((ty("id"), ty("name"), ty("score"), ty("born"), ty("price")), (BiType::Int64, BiType::String, BiType::Double, BiType::DateTime, BiType::Double));
    assert_eq!(t.row_count, 2);
    let q = e.import("Q", &spec("", Some("SELECT id, UPPER(name) AS n FROM people WHERE id = 1")), &c).unwrap();
    assert_eq!(e.fetch_page("Q", 0, 5, None).unwrap().rows[0][1].as_deref(), Some("ANN"));
    assert_eq!(q.row_count, 1);
    assert_eq!(source_preview(&spec(p[5], None), &c, 1).unwrap().rows.len(), 1);
}
