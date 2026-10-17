use biforge_publish::adapter::*;
use biforge_publish::audit;
use biforge_publish::keys::MemoryKeyStore;
use biforge_publish::local::{self, LocalFolderAdapter};
use biforge_publish::manifest::*;
use biforge_publish::package::{self, OpenOptions, PackageFile};
use biforge_publish::publisher::*;
use biforge_publish::targets::*;
use biforge_publish::Error;

struct Env {
    _tmp: tempfile::TempDir,
    project: std::path::PathBuf,
    share: std::path::PathBuf,
    registry: Registry,
    keys: MemoryKeyStore,
    store: TargetStore,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("proj");
    let share = tmp.path().join("share");
    std::fs::create_dir_all(&project).unwrap();
    let store = TargetStore::for_project(&project);
    Env { _tmp: tmp, project, share, registry: Registry::standard(), keys: MemoryKeyStore::default(), store }
}

fn target(e: &Env, id: &str, access: AccessLevel) -> Target {
    let mut t = Target::new(id, local::ID, "Team share", access);
    t.settings.insert("folder".into(), e.share.display().to_string());
    t
}

fn included() -> Vec<IncludedTable> {
    vec![IncludedTable { table: "Sales".into(), columns: vec!["Amount".into(), "Date".into()], data_file: String::new() }]
}

fn request(target_id: &str, marker: &str) -> PublishRequest {
    PublishRequest {
        target_id: target_id.into(),
        report_name: "Sales".into(),
        publisher_name: "Ann".into(),
        included: included(),
        confirmed: included(),
        permissions: vec![],
        files: vec![
            PackageFile { path: "project/Sales.pbip".into(), bytes: format!("{{\"v\":\"{marker}\"}}").into_bytes() },
            PackageFile { path: "data/Sales.parquet".into(), bytes: marker.as_bytes().repeat(100) },
        ],
    }
}

fn publisher(e: &Env) -> Publisher<'_> {
    Publisher { registry: &e.registry, keys: &e.keys, store: &e.store }
}

fn read_back(_e: &Env, t: &Target, key: Option<String>) -> Result<package::Package, Error> {
    let bytes = LocalFolderAdapter.sync(t, None)?.expect("a published package");
    package::open(&bytes, &OpenOptions { access_key: key, ..Default::default() })
}

#[test]
fn publish_open_update_revoke_end_to_end_for_a_private_report() {
    let e = env();
    let t = target(&e, "t1", AccessLevel::Private);
    e.store.put(t.clone()).unwrap();
    let p = publisher(&e);

    // 1. publish: a new access key is returned once; the viewer opens the package with it
    let out = p.publish(&request("t1", "one")).unwrap();
    assert_eq!(out.state.version, 1);
    let key1 = out.new_access_key.expect("first private publish creates an access key");
    let pkg = read_back(&e, &t, Some(key1.clone())).unwrap();
    assert_eq!(pkg.manifest.version, 1);
    assert_eq!(pkg.files["project/Sales.pbip"], br#"{"v":"one"}"#);
    assert_eq!(p.access_key("t1").unwrap().as_deref(), Some(key1.as_str()));
    // the stored target has no secret in it
    let stored = std::fs::read_to_string(e.store.dir().join("targets.json")).unwrap();
    assert!(!stored.contains("AGE-SECRET-KEY") && !stored.contains(&key1));

    // 2. update: version 2, the same key still works, no new key is made
    let out = p.publish(&request("t1", "two")).unwrap();
    assert_eq!(out.state.version, 2);
    assert!(out.new_access_key.is_none());
    let pkg = read_back(&e, &t, Some(key1.clone())).unwrap();
    assert_eq!((pkg.manifest.version, pkg.files["project/Sales.pbip"].clone()), (2, br#"{"v":"two"}"#.to_vec()));
    assert_eq!(pkg.manifest.package_id, e.store.get("t1").unwrap().package_id.unwrap());

    // 3. revoke by key rotation: version 3 is encrypted for a new key; the old key no longer opens it
    let out = p.rotate_key(&request("t1", "three")).unwrap();
    let key2 = out.new_access_key.expect("rotation makes a new key");
    assert_ne!(key1, key2);
    assert!(matches!(read_back(&e, &t, Some(key1)), Err(Error::WrongKey)));
    let pkg = read_back(&e, &t, Some(key2)).unwrap();
    assert_eq!(pkg.manifest.version, 3);

    // 4. unpublish removes it from the destination
    p.unpublish("t1").unwrap();
    assert!(LocalFolderAdapter.sync(&t, None).unwrap().is_none());
    assert_eq!(e.store.get("t1").unwrap().status, TargetStatus::Unpublished);

    // 5. every step was audited, and no entry holds a key
    let log = audit::read_all(&e.store).unwrap();
    let kinds: Vec<&str> = log.iter().map(|x| x.event.as_str()).collect();
    assert_eq!(kinds, ["publish", "update", "rotate-key", "unpublish"]);
    let raw = std::fs::read_to_string(e.store.dir().join("audit.jsonl")).unwrap();
    assert!(!raw.contains("AGE-SECRET-KEY"));
    assert!(raw.contains("Sales(2)"), "the audit says which tables and how many columns left the machine");
}

#[test]
fn public_report_is_not_encrypted_and_needs_no_key() {
    let e = env();
    e.store.put(target(&e, "t", AccessLevel::Public)).unwrap();
    let p = publisher(&e);
    let out = p.publish(&request("t", "x")).unwrap();
    assert!(out.new_access_key.is_none());
    let t = e.store.get("t").unwrap();
    let pkg = read_back(&e, &t, None).unwrap();
    assert_eq!(pkg.manifest.access, AccessLevel::Public);
    // rotation makes no sense without encryption and is refused
    assert!(matches!(p.rotate_key(&request("t", "y")), Err(Error::Unsupported { .. })));
}

#[test]
fn publishing_needs_the_exact_confirmation() {
    let e = env();
    e.store.put(target(&e, "t", AccessLevel::Public)).unwrap();
    let mut r = request("t", "x");
    r.confirmed = vec![IncludedTable { table: "Sales".into(), columns: vec!["Amount".into()], data_file: String::new() }];
    assert!(matches!(publisher(&e).publish(&r), Err(Error::NotConfirmed)));
    r.confirmed = vec![];
    assert!(matches!(publisher(&e).publish(&r), Err(Error::NotConfirmed)));
    assert!(!e.share.exists(), "nothing was written before the confirmation matched");
    // order does not matter
    r.included = vec![IncludedTable { table: "Sales".into(), columns: vec!["Date".into(), "Amount".into()], data_file: String::new() }];
    r.confirmed = included();
    publisher(&e).publish(&r).unwrap();
}

#[test]
fn planned_adapters_refuse_everything() {
    let e = env();
    for info in e.registry.infos().into_iter().filter(|i| i.id != local::ID && i.id != "github-pages" && i.id != "cloudflare-pages") {
        assert!(!info.capabilities.implemented, "{} must be marked not implemented", info.id);
        assert_eq!(info.capabilities, Capabilities::default());
        let mut t = Target::new("p", &info.id, "x", AccessLevel::Public);
        t.settings.insert("folder".into(), "x".into());
        e.store.put(t).unwrap();
        let r = publisher(&e).publish(&request("p", "x"));
        assert!(matches!(r, Err(Error::Unsupported { .. })), "{}", info.id);
        assert!(publisher(&e).share_link("p").is_err());
    }
}

#[test]
fn rls_is_never_claimed_outside_the_backend_method() {
    for info in Registry::standard().infos() {
        if info.method != Method::Backend {
            assert!(!info.capabilities.row_level_security, "{} must not claim row-level security", info.id);
        }
    }
}

#[test]
fn every_adapter_states_its_limits_and_free_tier() {
    for info in Registry::standard().infos() {
        assert!(!info.limitations.is_empty(), "{}", info.id);
        assert!(!info.free_tier.is_empty(), "{}", info.id);
        assert!(!info.phase.is_empty());
    }
}

#[test]
fn a_target_can_be_shared_only_when_published_and_the_link_has_no_key() {
    let e = env();
    e.store.put(target(&e, "t", AccessLevel::Private)).unwrap();
    let p = publisher(&e);
    assert!(p.share_link("t").is_err(), "nothing to share yet");
    let key = p.publish(&request("t", "x")).unwrap().new_access_key.unwrap();
    let link = p.share_link("t").unwrap();
    assert!(link.starts_with("biforge://open?src=file&path="));
    assert!(!link.contains(&key) && !link.contains("AGE-SECRET"));
    match biforge_publish::deeplink::parse(&link).unwrap() {
        biforge_publish::deeplink::Link::File { path } => assert!(std::path::Path::new(&path).exists()),
        other => panic!("{other:?}"),
    }
    assert!(audit::read_all(&e.store).unwrap().iter().any(|x| x.event == "share-link"));
}

#[test]
fn several_targets_per_report_are_independent() {
    let e = env();
    let mut a = target(&e, "a", AccessLevel::Public);
    a.settings.insert("folder".into(), e.share.join("a").display().to_string());
    let mut b = target(&e, "b", AccessLevel::Private);
    b.settings.insert("folder".into(), e.share.join("b").display().to_string());
    e.store.put(a).unwrap();
    e.store.put(b).unwrap();
    let p = publisher(&e);
    p.publish(&request("a", "1")).unwrap();
    p.publish(&request("b", "1")).unwrap();
    p.publish(&request("b", "2")).unwrap();
    let all = e.store.list().unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(e.store.get("a").unwrap().last_version, Some(1));
    assert_eq!(e.store.get("b").unwrap().last_version, Some(2));
    assert_ne!(e.store.get("a").unwrap().package_id, e.store.get("b").unwrap().package_id);
    // survives a reload from disk
    let again = TargetStore::for_project(&e.project);
    assert_eq!(again.list().unwrap(), all);
    p.delete_target("a").unwrap();
    assert_eq!(e.store.list().unwrap().len(), 1);
}

#[test]
fn a_failed_publish_is_recorded_on_the_target() {
    let e = env();
    let mut t = target(&e, "t", AccessLevel::Public);
    t.settings.insert("folder".into(), "relative/path".into());
    e.store.put(t).unwrap();
    assert!(publisher(&e).publish(&request("t", "x")).is_err());
    let t = e.store.get("t").unwrap();
    assert_eq!(t.status, TargetStatus::NeverPublished, "validation errors do not touch the state");
    // an adapter error does
    let blocker = e.share.parent().unwrap().join("file.txt");
    std::fs::write(&blocker, "x").unwrap();
    let mut t = target(&e, "u", AccessLevel::Public);
    t.settings.insert("folder".into(), blocker.join("sub").display().to_string());
    e.store.put(t).unwrap();
    assert!(publisher(&e).publish(&request("u", "x")).is_err());
    let t = e.store.get("u").unwrap();
    assert_eq!(t.status, TargetStatus::Error);
    assert!(t.last_error.is_some());
}

#[test]
fn the_folder_refuses_to_mix_two_reports_and_old_versions() {
    let e = env();
    e.store.put(target(&e, "one", AccessLevel::Public)).unwrap();
    e.store.put(target(&e, "two", AccessLevel::Public)).unwrap(); // same folder, other report
    publisher(&e).publish(&request("one", "1")).unwrap();
    let r = publisher(&e).publish(&request("two", "1"));
    assert!(matches!(r, Err(Error::Adapter(m)) if m.contains("different published report")));
}

#[test]
fn viewer_sync_only_returns_newer_versions() {
    let e = env();
    let t = target(&e, "t", AccessLevel::Public);
    e.store.put(t.clone()).unwrap();
    publisher(&e).publish(&request("t", "1")).unwrap();
    assert!(LocalFolderAdapter.sync(&t, Some(1)).unwrap().is_none());
    publisher(&e).publish(&request("t", "2")).unwrap();
    assert!(LocalFolderAdapter.sync(&t, Some(1)).unwrap().is_some());
}
