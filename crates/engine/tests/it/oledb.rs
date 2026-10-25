//! OLE DB through Windows PowerShell and System.Data.OleDb, against a real Access database made with the ACE provider
//! when this machine has it (skipped otherwise: the CI runner has no Access provider). Analysis Services needs a
//! server and the MSOLAP provider and is covered by the unit tests of the connection and command text only.
#![cfg(windows)]

use biforge_engine::{source_choices, source_preview, BiType, Engine, MemoryCredentialStore, SourceSpec};
use std::process::Command;

fn make_database(path: &std::path::Path) -> bool {
    let create = format!("$c = New-Object -ComObject ADOX.Catalog; $null = $c.Create('Provider=Microsoft.ACE.OLEDB.12.0;Data Source={};')", path.display());
    let ok = Command::new("powershell").args(["-NoProfile", "-Command", &create]).output().map(|o| o.status.success()).unwrap_or(false);
    if !ok || !path.exists() {
        return false;
    }
    let fill = format!(
        "$c = New-Object -ComObject ADODB.Connection; $c.Open('Provider=Microsoft.ACE.OLEDB.12.0;Data Source={}'); \
         $null = $c.Execute('CREATE TABLE Parts (Id LONG, PartName TEXT(40), Born DATETIME, Ok YESNO, Price DOUBLE)'); \
         $null = $c.Execute(\"INSERT INTO Parts VALUES (1, 'Bolt, \"\"big\"\"', #2024-01-02 03:04:05#, 1, 2.5)\"); \
         $null = $c.Execute(\"INSERT INTO Parts (Id, PartName) VALUES (2, 'Nut')\"); \
         $null = $c.Execute('CREATE TABLE [Order Details] (Qty LONG)'); $null = $c.Execute('INSERT INTO [Order Details] VALUES (7)'); $c.Close()",
        path.display()
    );
    Command::new("powershell").args(["-NoProfile", "-Command", &fill]).output().map(|o| o.status.success()).unwrap_or(false)
}

fn spec(db: &std::path::Path, table: Option<&str>, query: Option<&str>) -> SourceSpec {
    SourceSpec::OleDb { connection: format!("Provider=Microsoft.ACE.OLEDB.12.0;Data Source={}", db.display()), user: None, table: table.map(String::from), query: query.map(String::from) }
}

#[test]
fn ole_db_reads_tables_and_queries_with_types_and_nulls() {
    let d = tempfile::tempdir().unwrap();
    let db = d.path().join("shop.accdb");
    if !make_database(&db) {
        println!("SKIPPED: no Microsoft.ACE.OLEDB.12.0 provider on this machine");
        return;
    }
    let c = MemoryCredentialStore::default();
    let e = Engine::in_memory().unwrap();
    let tables = source_choices(&spec(&db, None, None), &c).unwrap();
    assert!(tables.contains(&"Parts".to_string()) && tables.contains(&"Order Details".to_string()), "{tables:?}");

    let t = e.import("Parts", &spec(&db, Some("Parts"), None), &c).unwrap();
    assert_eq!(t.row_count, 2);
    let cols: Vec<_> = t.columns.iter().map(|x| (x.name.as_str(), x.bi_type)).collect();
    assert_eq!(cols, [("Id", BiType::Int64), ("PartName", BiType::String), ("Born", BiType::DateTime), ("Ok", BiType::Boolean), ("Price", BiType::Double)]);
    let page = e.fetch_page("Parts", 0, 10, None).unwrap();
    assert_eq!(page.rows[0][1].as_deref(), Some("Bolt, \"big\""), "commas and quotes survive");
    assert_eq!(page.rows[1][2], None, "an empty date is null");
    assert_eq!(page.rows[1][4], None);

    // a table name with a space, a query, and the preview limit
    assert_eq!(e.import("Details", &spec(&db, Some("Order Details"), None), &c).unwrap().row_count, 1);
    assert_eq!(e.import("Q", &spec(&db, None, Some("SELECT PartName FROM Parts WHERE Id = 2")), &c).unwrap().row_count, 1);
    assert_eq!(source_preview(&spec(&db, Some("Parts"), None), &c, 1).unwrap().rows.len(), 1);

    // problems are readable and leave existing tables alone
    let err = e.import("Parts", &spec(&db, Some("Missing"), None), &c).unwrap_err().to_string();
    assert!(err.contains("OLE DB error") && err.to_lowercase().contains("missing"), "{err}");
    let bad = SourceSpec::OleDb { connection: "Provider=No.Such.Provider.9;Data Source=x".into(), user: None, table: Some("T".into()), query: None };
    let err = e.import("Parts", &bad, &c).unwrap_err().to_string();
    assert!(err.contains("not registered") && err.contains("Install the provider"), "{err}");
    assert_eq!(e.table_info("Parts").unwrap().row_count, 2);
}
