//! The publish engine's server adapter against a real server: the same Publisher path the app uses.

use std::sync::Arc;

use biforge_engine::{MemoryCredentialStore, SourceSpec};
use biforge_publish::adapter::{Context, Registry};
use biforge_publish::backend::*;
use biforge_publish::http::ReqwestHttp;
use biforge_publish::keys::{KeyStore, MemoryKeyStore};
use biforge_publish::manifest::{AccessLevel, IncludedTable};
use biforge_publish::package::PackageFile;
use biforge_publish::publisher::{PublishRequest, Publisher};
use biforge_publish::server::{token_key, HOST_ID};
use biforge_publish::targets::{Target, TargetStore};
use biforge_server::{start, Config};

fn files() -> (Vec<PackageFile>, Vec<IncludedTable>) {
    let tmp = tempfile::tempdir().unwrap();
    let engine = biforge_engine::Engine::in_memory().unwrap();
    let p = tmp.path().join("t.csv");
    std::fs::write(&p, "Id,Qty\n1,5\n2,7\n").unwrap();
    engine.import("T", &SourceSpec::Csv { path: p.to_string_lossy().into_owned(), delimiter: None, header: None }, &MemoryCredentialStore::default()).unwrap();
    let out = tmp.path().join("T.parquet");
    engine.export_parquet("T", &["Id".to_string(), "Qty".to_string()], &out).unwrap();
    let model = "table T\n\tcolumn Id\n\t\tdataType: int64\n\tcolumn Qty\n\t\tdataType: int64\n\tmeasure Total = SUM(T[Qty])\n";
    (
        vec![
            PackageFile { path: "project/D.SemanticModel/definition/tables/T.tmdl".into(), bytes: model.as_bytes().to_vec() },
            PackageFile { path: "data/T.parquet".into(), bytes: std::fs::read(&out).unwrap() },
        ],
        vec![IncludedTable { table: "T".into(), columns: vec!["Id".into(), "Qty".into()], data_file: "data/T.parquet".into() }],
    )
}

#[test]
fn publishing_to_a_server_through_the_publisher() {
    let dir = tempfile::tempdir().unwrap();
    let srv = start(Config { data_dir: dir.path().join("srv"), bind: "127.0.0.1:0".parse().unwrap(), admin_token: Some("bfa_t".into()), public_url: None, tls: false }).unwrap();
    let http = Arc::new(ReqwestHttp::new().unwrap());
    let admin = Client::new(http.as_ref(), &srv.url(), "bfa_t");
    let ws = admin.create_workspace("W").unwrap().id;

    let keys = Arc::new(MemoryKeyStore::default());
    keys.set(&token_key("c1"), "bfa_t").unwrap();
    let reg = Registry::standard_with(Context { keys: keys.clone(), http: http.clone() });
    let proj = dir.path().join("proj");
    let store = TargetStore::for_project(&proj);
    let mut t = Target::new("t1", HOST_ID, "My PC", AccessLevel::Public);
    t.settings.insert("url".into(), srv.url());
    t.settings.insert("workspace".into(), ws.clone());
    t.settings.insert("report".into(), "demo".into());
    t.settings.insert("connection".into(), "c1".into());
    store.put(t).unwrap();
    let p = Publisher { registry: &reg, keys: keys.as_ref(), store: &store };
    let (f, inc) = files();
    let req = PublishRequest { target_id: "t1".into(), report_name: "Demo".into(), publisher_name: "Me".into(), included: inc.clone(), confirmed: inc, permissions: vec![], files: f };

    let out = p.publish(&req).unwrap();
    assert_eq!(out.state.version, 1);
    assert_eq!(p.publish(&req).unwrap().state.version, 2);
    assert_eq!(p.status("t1").unwrap().unwrap().version, 2);
    let v = admin.query(&ws, "demo", "EVALUATE ROW(\"t\", [Total])").unwrap();
    assert_eq!(v["results"][0]["rows"][0][0]["v"], "12");
    assert!(admin.reports(&ws).unwrap()[0].has_roles == false);

    // a private target is refused before anything is sent
    let mut t = store.get("t1").unwrap();
    t.access = AccessLevel::Private;
    store.put(t).unwrap();
    assert!(p.publish(&req).is_err());

    p.unpublish("t1").unwrap();
    assert!(admin.reports(&ws).unwrap().is_empty());
    p.disconnect("t1").unwrap();
    assert!(keys.get(&token_key("c1")).unwrap().is_none());
}

#[test]
fn scheduled_refresh_on_a_server_is_turned_on_run_and_off_through_the_publisher() {
    use biforge_publish::publisher::RefreshRequest;
    use biforge_publish::refresh::{RefreshSource, Schedule};
    let dir = tempfile::tempdir().unwrap();
    let srv = start(Config { data_dir: dir.path().join("srv"), bind: "127.0.0.1:0".parse().unwrap(), admin_token: Some("bfa_t".into()), public_url: None, tls: false }).unwrap();
    let http = Arc::new(ReqwestHttp::new().unwrap());
    let admin = Client::new(http.as_ref(), &srv.url(), "bfa_t");
    let ws = admin.create_workspace("W").unwrap().id;
    let keys = Arc::new(MemoryKeyStore::default());
    keys.set(&token_key("c1"), "bfa_t").unwrap();
    let reg = Registry::standard_with(Context { keys: keys.clone(), http: http.clone() });
    let proj = dir.path().join("proj");
    let store = TargetStore::for_project(&proj);
    let mut t = Target::new("t1", HOST_ID, "My PC", AccessLevel::Public);
    for (k, v) in [("url", srv.url()), ("workspace", ws.clone()), ("report", "demo".into()), ("connection", "c1".into())] {
        t.settings.insert(k.into(), v);
    }
    store.put(t).unwrap();
    let p = Publisher { registry: &reg, keys: keys.as_ref(), store: &store };
    let (f, inc) = files();
    let project_files: Vec<PackageFile> = f.iter().filter(|x| x.path.starts_with("project/")).cloned().collect();
    // refresh needs a published report first
    let req = |schedule| RefreshRequest {
        target_id: "t1".into(),
        report_name: "Demo".into(),
        publisher_name: "Me".into(),
        included: inc.clone(),
        schedule,
        plan: Some(biforge_publish::schedule::Plan { frequency: schedule, at_minute: 120, retries: 1, retry_delay_secs: 1 }),
        sources: vec![RefreshSource { table: "T".into(), spec: serde_json::json!({"kind": "csv", "path": "data/src/t.csv", "delimiter": null, "header": null}), original: "C:\\pc\\t.csv".into() }],
        confirmed_sources: vec!["C:\\pc\\t.csv".into()],
        project_files: project_files.clone(),
        source_files: vec![PackageFile { path: "data/src/t.csv".into(), bytes: b"Id,Qty\n1,5\n2,7\n3,100\n".to_vec() }],
    };
    assert!(p.enable_refresh(&req(Schedule::Daily)).unwrap_err().to_string().contains("Publish the report first"));
    let publish = PublishRequest { target_id: "t1".into(), report_name: "Demo".into(), publisher_name: "Me".into(), included: inc.clone(), confirmed: inc.clone(), permissions: vec![], files: f };
    p.publish(&publish).unwrap();
    assert_eq!(admin.query(&ws, "demo", "EVALUATE ROW(\"t\", [Total])").unwrap()["results"][0]["rows"][0][0]["v"], "12");

    p.enable_refresh(&req(Schedule::Daily)).unwrap();
    let t = store.get("t1").unwrap();
    assert_eq!((t.settings.get("refresh").map(String::as_str), t.settings.get("refreshOn").map(String::as_str)), (Some("daily"), Some("server")));
    let info = admin.refresh_info(&ws, "demo").unwrap();
    assert!(info.enabled && info.has_bundle && info.plan.retries == 1 && info.plan.at_minute == 120);
    // the signing key never leaves this PC
    assert!(!std::fs::read_dir(dir.path().join("srv")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("signing")));

    // Refresh now runs on the server and the report answers with the bundle's data (the source file had a new row)
    let msg = p.refresh_now("t1").unwrap();
    assert!(msg.contains("Refreshed"), "{msg}");
    assert_eq!(admin.query(&ws, "demo", "EVALUATE ROW(\"t\", [Total])").unwrap()["results"][0]["rows"][0][0]["v"], "112");
    assert!(admin.refresh_info(&ws, "demo").unwrap().history[0].message.contains("Reloaded"));

    p.disable_refresh("t1").unwrap();
    let t = store.get("t1").unwrap();
    assert!(!t.settings.contains_key("refresh") && !t.settings.contains_key("refreshOn"));
    assert!(!admin.refresh_info(&ws, "demo").unwrap().has_bundle);
    assert!(p.refresh_now("t1").is_err());
}
