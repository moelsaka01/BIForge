use biforge_engine::*;
use std::path::Path;

fn creds() -> MemoryCredentialStore {
    MemoryCredentialStore::default()
}

fn p(dir: &Path, name: &str) -> String {
    dir.join(name).to_string_lossy().into_owned()
}

fn col<'a>(t: &'a TableInfo, n: &str) -> &'a ColumnInfo {
    t.columns.iter().find(|c| c.name == n).unwrap_or_else(|| panic!("no column {n}: {t:?}"))
}

fn csv_spec(path: String) -> SourceSpec {
    SourceSpec::Csv { path, delimiter: None, header: None }
}

#[test]
fn csv_import_infers_types_and_reads_rows() {
    let d = tempfile::tempdir().unwrap();
    let f = p(d.path(), "sales.csv");
    std::fs::write(&f, "id,name,amount,when,ok\n1,Ann,10.5,2024-01-02,true\n2,\"Bob, Jr\",,2024-02-03,false\n3,Cy,7,2024-03-04,true\n")
        .unwrap();
    let e = Engine::in_memory().unwrap();
    let t = e.import("Sales", &csv_spec(f), &creds()).unwrap();
    assert_eq!(t.row_count, 3);
    assert_eq!(col(&t, "id").bi_type, BiType::Int64);
    assert_eq!(col(&t, "amount").bi_type, BiType::Double);
    assert_eq!(col(&t, "when").bi_type, BiType::DateTime);
    assert_eq!(col(&t, "ok").bi_type, BiType::Boolean);
    assert_eq!(col(&t, "name").bi_type, BiType::String);
    let page = e.fetch_page("Sales", 0, 10, None).unwrap();
    assert_eq!(page.rows[1][1].as_deref(), Some("Bob, Jr"));
    assert_eq!(page.rows[1][2], None, "empty CSV field is NULL");
}

#[test]
fn csv_custom_delimiter_and_no_header() {
    let d = tempfile::tempdir().unwrap();
    let f = p(d.path(), "x.txt");
    std::fs::write(&f, "1;a\n2;b\n").unwrap();
    let e = Engine::in_memory().unwrap();
    let t = e
        .import("X", &SourceSpec::Csv { path: f, delimiter: Some(";".into()), header: Some(false) }, &creds())
        .unwrap();
    assert_eq!(t.row_count, 2);
    assert_eq!(t.columns.len(), 2);
}

#[test]
fn json_and_parquet_import() {
    let d = tempfile::tempdir().unwrap();
    let j = p(d.path(), "d.json");
    std::fs::write(&j, r#"[{"a":1,"b":"x"},{"a":2,"b":null},{"a":3,"b":"z"}]"#).unwrap();
    let e = Engine::in_memory().unwrap();
    let t = e.import("J", &SourceSpec::Json { path: j }, &creds()).unwrap();
    assert_eq!(t.row_count, 3);
    assert_eq!(col(&t, "a").bi_type, BiType::Int64);

    // Parquet: produce a file with DuckDB itself, then import it into a second table.
    let pq = p(d.path(), "d.parquet");
    e.connection()
        .execute_batch(&format!("COPY (SELECT i AS k, CAST(i * 1.5 AS DOUBLE) AS v FROM range(5) t(i)) TO '{}' (FORMAT PARQUET)", pq.replace('\\', "/")))
        .unwrap();
    let t = e.import("P", &SourceSpec::Parquet { path: pq }, &creds()).unwrap();
    assert_eq!(t.row_count, 5);
    assert_eq!(col(&t, "k").bi_type, BiType::Int64);
    assert_eq!(col(&t, "v").bi_type, BiType::Double);
}

#[test]
fn excel_import_with_sheets_dates_and_duplicate_headers() {
    use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
    let d = tempfile::tempdir().unwrap();
    let f = p(d.path(), "b.xlsx");
    let mut wb = Workbook::new();
    let s = wb.add_worksheet().set_name("Orders").unwrap();
    s.write_string(0, 0, "Id").unwrap();
    s.write_string(0, 1, "Price").unwrap();
    s.write_string(0, 2, "Day").unwrap();
    s.write_string(0, 3, "Price").unwrap();
    for i in 0..3u32 {
        s.write_number(i + 1, 0, (i + 1) as f64).unwrap();
        s.write_number(i + 1, 1, 1.25 * (i + 1) as f64).unwrap();
        let dt = ExcelDateTime::from_ymd(2024, 1, (i + 1) as u8).unwrap();
        s.write_datetime_with_format(i + 1, 2, &dt, &Format::new().set_num_format("yyyy-mm-dd")).unwrap();
    }
    wb.add_worksheet().set_name("Other").unwrap().write_string(0, 0, "Z").unwrap();
    wb.save(&f).unwrap();

    assert_eq!(excel_sheets(&f).unwrap(), vec!["Orders", "Other"]);
    let e = Engine::in_memory().unwrap();
    let t = e
        .import("Orders", &SourceSpec::Excel { path: f.clone(), sheet: Some("Orders".into()), header: true }, &creds())
        .unwrap();
    assert_eq!(t.row_count, 3);
    assert_eq!(col(&t, "Id").bi_type, BiType::Int64);
    assert_eq!(col(&t, "Price").bi_type, BiType::Double);
    assert_eq!(col(&t, "Day").bi_type, BiType::DateTime);
    assert_eq!(col(&t, "Price.1").bi_type, BiType::String, "duplicate header renamed, all-empty column is text");
    let page = e.fetch_page("Orders", 0, 1, None).unwrap();
    assert!(page.rows[0][2].as_deref().unwrap().starts_with("2024-01-01"), "{:?}", page.rows[0]);

    let err = e
        .import("Bad", &SourceSpec::Excel { path: f, sheet: Some("Nope".into()), header: true }, &creds())
        .unwrap_err()
        .to_string();
    assert!(err.contains("Nope"), "{err}");
}

#[test]
fn sqlite_import() {
    let d = tempfile::tempdir().unwrap();
    let f = p(d.path(), "s.db");
    {
        let c = rusqlite::Connection::open(&f).unwrap();
        c.execute_batch("CREATE TABLE cust(id INTEGER, name TEXT, score REAL); INSERT INTO cust VALUES (1,'A',1.5),(2,'B',NULL);")
            .unwrap();
    }
    assert_eq!(sqlite_tables(&f).unwrap(), vec!["cust"]);
    let e = Engine::in_memory().unwrap();
    let t = e.import("Cust", &SourceSpec::Sqlite { path: f, table: "cust".into() }, &creds()).unwrap();
    assert_eq!(t.row_count, 2);
    assert_eq!(col(&t, "id").bi_type, BiType::Int64);
    assert_eq!(col(&t, "score").bi_type, BiType::Double);
}

#[test]
fn refresh_replaces_data_and_failure_keeps_old_data() {
    let d = tempfile::tempdir().unwrap();
    let f = p(d.path(), "r.csv");
    std::fs::write(&f, "a,b\n1,x\n2,y\n").unwrap();
    let e = Engine::in_memory().unwrap();
    let spec = csv_spec(f.clone());
    assert_eq!(e.import("R", &spec, &creds()).unwrap().row_count, 2);

    std::fs::write(&f, "a,b,c\n1,x,1\n2,y,2\n3,z,3\n").unwrap();
    let t = e.import("R", &spec, &creds()).unwrap();
    assert_eq!((t.row_count, t.columns.len()), (3, 3), "refresh picks up new rows and columns");

    std::fs::remove_file(&f).unwrap();
    let err = e.import("R", &spec, &creds()).unwrap_err();
    assert!(matches!(err, EngineError::FileNotFound(_)));
    assert_eq!(e.table_info("R").unwrap().row_count, 3, "old data survives a failed refresh");

    std::fs::write(&f, "\"unterminated\n1,2,3,4,5\n").unwrap();
    let r = e.import("R", &spec, &creds());
    if r.is_err() {
        assert_eq!(e.table_info("R").unwrap().row_count, 3);
    }
    assert!(!e.table_names().unwrap().iter().any(|n| n.starts_with("__")), "no staging table left behind");
}

#[test]
fn invalid_table_names_and_missing_tables_are_readable_errors() {
    let e = Engine::in_memory().unwrap();
    let err = e.import("  ", &csv_spec("x.csv".into()), &creds()).unwrap_err();
    assert!(matches!(err, EngineError::InvalidName(_)));
    assert!(e.fetch_page("Nope", 0, 5, None).unwrap_err().to_string().contains("Nope"));
}

#[test]
fn sorting_paging_and_names_with_quotes() {
    let d = tempfile::tempdir().unwrap();
    let f = p(d.path(), "t.csv");
    std::fs::write(&f, "k,\"we\"\"ird\"\n3,c\n1,\n2,b\n").unwrap();
    let e = Engine::in_memory().unwrap();
    e.import("My \"T\"", &csv_spec(f), &creds()).unwrap();
    let asc = e.fetch_page("My \"T\"", 0, 10, Some(&SortSpec { column: "k".into(), descending: false })).unwrap();
    let ks: Vec<_> = asc.rows.iter().map(|r| r[0].clone().unwrap()).collect();
    assert_eq!(ks, ["1", "2", "3"]);
    let desc = e.fetch_page("My \"T\"", 0, 2, Some(&SortSpec { column: "k".into(), descending: true })).unwrap();
    assert_eq!(desc.rows.len(), 2);
    assert_eq!(desc.rows[0][0].as_deref(), Some("3"));
    assert_eq!(desc.total, 3);
    let second = e.fetch_page("My \"T\"", 2, 5, None).unwrap();
    assert_eq!(second.rows.len(), 1);
    // The empty field is "" (Power Query behavior), which sorts first; real NULLs would sort last.
    let by_text = e.fetch_page("My \"T\"", 0, 10, Some(&SortSpec { column: "we\"ird".into(), descending: false })).unwrap();
    assert_eq!(by_text.rows[0][1].as_deref(), Some(""));
    assert_eq!(by_text.rows.last().unwrap()[1].as_deref(), Some("c"));
    assert!(e.fetch_page("My \"T\"", 0, 1, Some(&SortSpec { column: "zzz".into(), descending: false })).is_err());
}

#[test]
fn relationship_hints_from_data() {
    let d = tempfile::tempdir().unwrap();
    let dim = p(d.path(), "dim.csv");
    let fact = p(d.path(), "fact.csv");
    std::fs::write(&dim, "id,name\n1,a\n2,b\n3,c\n").unwrap();
    std::fs::write(&fact, "cust,amt\n1,5\n1,6\n2,7\n").unwrap();
    let e = Engine::in_memory().unwrap();
    e.import("Dim", &csv_spec(dim), &creds()).unwrap();
    e.import("Fact", &csv_spec(fact), &creds()).unwrap();
    let h = e.suggest_relationship(("Fact", "cust"), ("Dim", "id")).unwrap();
    assert_eq!(h.cardinality, Cardinality::ManyToOne);
    let h = e.suggest_relationship(("Dim", "id"), ("Fact", "cust")).unwrap();
    assert_eq!(h.cardinality, Cardinality::OneToMany);
    let h = e.suggest_relationship(("Dim", "id"), ("Dim", "id")).unwrap();
    assert_eq!(h.cardinality, Cardinality::OneToOne);
    let h = e.suggest_relationship(("Fact", "cust"), ("Fact", "cust")).unwrap();
    assert_eq!(h.cardinality, Cardinality::ManyToMany);
}

#[test]
fn data_survives_reopening_the_project_database() {
    let d = tempfile::tempdir().unwrap();
    let f = p(d.path(), "a.csv");
    std::fs::write(&f, "a\n1\n2\n").unwrap();
    let db = d.path().join(".biforge").join("data.duckdb");
    {
        let e = Engine::open(&db).unwrap();
        e.import("A", &csv_spec(f), &creds()).unwrap();
    }
    let e = Engine::open(&db).unwrap();
    assert_eq!(e.table_info("A").unwrap().row_count, 2);
}

#[test]
fn source_spec_json_round_trips_and_has_no_secret() {
    let s = SourceSpec::Postgres {
        host: "h".into(),
        port: 5432,
        database: "d".into(),
        user: "u".into(),
        schema: "public".into(),
        table: "t".into(),
        query: None,
    };
    let j = serde_json::to_string(&s).unwrap();
    assert!(!j.to_lowercase().contains("password"));
    assert_eq!(serde_json::from_str::<SourceSpec>(&j).unwrap(), s);
    assert_eq!(s.credential_key().unwrap(), "postgres:u@h:5432/d");
}

#[test]
fn credential_store_round_trip_in_windows_credential_manager() {
    let store = SystemCredentialStore;
    let key = format!("test:biforge-{}", std::process::id());
    assert_eq!(store.get(&key).unwrap(), None);
    store.set(&key, "s3cret").unwrap();
    assert_eq!(store.get(&key).unwrap().as_deref(), Some("s3cret"));
    store.delete(&key).unwrap();
    assert_eq!(store.get(&key).unwrap(), None);
}

/// Needs a real server: set BIFORGE_TEST_PG="host:port:database:user:password:schema.table" (a table with an
/// integer column and a text column). Skipped (and reported as skipped) when the variable is absent.
#[test]
fn postgres_import_against_a_real_server() {
    let Ok(v) = std::env::var("BIFORGE_TEST_PG") else {
        // CI sets BIFORGE_REQUIRE_PG so that a missing server fails instead of silently skipping.
        assert!(std::env::var("BIFORGE_REQUIRE_PG").is_err(), "BIFORGE_REQUIRE_PG is set but BIFORGE_TEST_PG is not");
        eprintln!("SKIPPED: BIFORGE_TEST_PG not set");
        return;
    };
    let parts: Vec<&str> = v.splitn(6, ':').collect();
    let (schema, table) = parts[5].split_once('.').unwrap();
    let spec = SourceSpec::Postgres {
        host: parts[0].into(),
        port: parts[1].parse().unwrap(),
        database: parts[2].into(),
        user: parts[3].into(),
        schema: schema.into(),
        table: table.into(),
        query: None,
    };
    let c = MemoryCredentialStore::default();
    c.set(&spec.credential_key().unwrap(), parts[4]).unwrap();
    assert!(postgres_tables(&spec, &c).unwrap().contains(&table.to_string()));
    let e = Engine::in_memory().unwrap();
    let t = e.import("PgT", &spec, &c).unwrap();
    assert!(t.row_count > 0);
    assert!(t.columns.iter().any(|c| c.bi_type == BiType::Int64));
    for (name, ty) in [("score", BiType::Double), ("born", BiType::DateTime), ("ok", BiType::Boolean), ("name", BiType::String)] {
        if let Some(c) = t.columns.iter().find(|c| c.name == name) {
            assert_eq!(c.bi_type, ty, "{name}");
        }
    }
    let bad = MemoryCredentialStore::default();
    bad.set(&spec.credential_key().unwrap(), "wrong-password").unwrap();
    assert!(e.import("PgT2", &spec, &bad).is_err());
}

/// Needs a real SQL Server: set BIFORGE_TEST_MSSQL="server:port:database:user:password:schema.table" (a table with an
/// integer and a text column; an empty user means Windows authentication). Skipped when the variable is absent.
/// The machine this was written on has no SQL Server, so this path has not been run against one yet.
#[test]
fn sqlserver_import_against_a_real_server() {
    let Ok(v) = std::env::var("BIFORGE_TEST_MSSQL") else {
        assert!(std::env::var("BIFORGE_REQUIRE_MSSQL").is_err(), "BIFORGE_REQUIRE_MSSQL is set but BIFORGE_TEST_MSSQL is not");
        eprintln!("SKIPPED: BIFORGE_TEST_MSSQL not set");
        return;
    };
    let parts: Vec<&str> = v.splitn(6, ':').collect();
    let (schema, table) = parts[5].split_once('.').unwrap();
    let spec = SourceSpec::SqlServer {
        server: parts[0].into(),
        port: parts[1].parse().ok(),
        database: parts[2].into(),
        user: if parts[3].is_empty() { None } else { Some(parts[3].into()) },
        schema: schema.into(),
        table: table.into(),
        query: None,
        trust_certificate: std::env::var("BIFORGE_TEST_MSSQL_TRUST").is_ok(),
    };
    let c = MemoryCredentialStore::default();
    if let Some(k) = spec.credential_key() {
        c.set(&k, parts[4]).unwrap();
    }
    assert!(sqlserver_tables(&spec, &c).unwrap().contains(&table.to_string()));
    let e = Engine::in_memory().unwrap();
    let t = e.import("MsT", &spec, &c).unwrap();
    assert!(t.row_count > 0);
    assert!(t.columns.iter().any(|c| c.bi_type == BiType::Int64));
    // the CI seed (dbo.people): every SQL Server type family maps to the expected model type
    if std::env::var("BIFORGE_REQUIRE_MSSQL").is_ok() {
        let ty = |n: &str| t.columns.iter().find(|x| x.name == n).unwrap().bi_type;
        assert_eq!((ty("id"), ty("name"), ty("score"), ty("born"), ty("ok"), ty("big")), (BiType::Int64, BiType::String, BiType::Double, BiType::DateTime, BiType::Boolean, BiType::Int64));
        let page = e.fetch_page("MsT", 0, 10, None).unwrap();
        assert_eq!(page.rows[0][..3], [Some("1".into()), Some("Ann".into()), Some("1.5".into())]);
        assert_eq!(page.rows[1][2], None);
        // custom SQL replaces the table
        let mut q = spec.clone();
        if let SourceSpec::SqlServer { query, .. } = &mut q {
            *query = Some("SELECT id, UPPER(name) AS n FROM dbo.people WHERE id = 1;".into());
        }
        let t2 = e.import("MsQ", &q, &c).unwrap();
        assert_eq!((t2.row_count, t2.columns[1].name.as_str()), (1, "n"));
        assert_eq!(e.fetch_page("MsQ", 0, 5, None).unwrap().rows[0][1].as_deref(), Some("ANN"));
        assert_eq!(biforge_engine::source_preview(&spec, &c, 1).unwrap().rows.len(), 1);
        assert_eq!(biforge_engine::source_choices(&spec, &c).unwrap(), sqlserver_tables(&spec, &c).unwrap());
    }
}

#[test]
fn csv_empty_text_fields_load_as_empty_string_like_power_query() {
    let d = tempfile::tempdir().unwrap();
    let f = p(d.path(), "t.csv");
    std::fs::write(&f, "id,name,amount,when\n1,Ann,1.5,2024-01-02\n2,,,\n3,Cy,2,2024-03-04\n").unwrap();
    let e = Engine::in_memory().unwrap();
    e.import("T", &csv_spec(f), &creds()).unwrap();
    let page = e.fetch_page("T", 0, 10, None).unwrap();
    assert_eq!(page.rows[1][1].as_deref(), Some(""), "text field: empty string");
    assert_eq!(page.rows[1][2], None, "number field stays blank");
    assert_eq!(page.rows[1][3], None, "date field stays blank");
    let (rows, nonnull, _) = e.column_stats("T", "name").unwrap();
    assert_eq!((rows, nonnull), (3, 3));
}
