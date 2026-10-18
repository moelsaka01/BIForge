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
    let srv = start(Config { data_dir: dir.path().join("srv"), bind: "127.0.0.1:0".parse().unwrap(), admin_token: Some("bfa_t".into()), public_url: None }).unwrap();
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
