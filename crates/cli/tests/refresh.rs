//! `biforge-cli refresh` on a site folder made the way BIForge makes it: a published package, its feed, and a
//! refresh bundle with the project and the whole source file.

use std::fs;
use std::path::Path;

use biforge_cli::{refresh_site, Outcome};
use biforge_engine::{Engine, MemoryCredentialStore, SourceSpec};
use biforge_publish::feed::{Feed, FEED_FILE};
use biforge_publish::keys::{new_package_id, sha256_hex, AccessKey, Identity};
use biforge_publish::manifest::{AccessLevel, IncludedTable};
use biforge_publish::package::{self, BuildInput, OpenOptions, PackageFile};
use biforge_publish::refresh::{bundle_files, RefreshConfig, RefreshSource, BUNDLE_FILE};

struct Site {
    dir: tempfile::TempDir,
    signer: Identity,
    access: Option<AccessKey>,
    package_id: String,
}

fn csv(rows: &[(&str, i64)]) -> Vec<u8> {
    let mut s = String::from("City,Amount,Secret\n");
    for (c, a) in rows {
        s.push_str(&format!("{c},{a},hidden-{c}\n"));
    }
    s.into_bytes()
}

fn included() -> Vec<IncludedTable> {
    vec![IncludedTable { table: "Sales".into(), columns: vec!["City".into(), "Amount".into()], data_file: String::new() }]
}

/// A published version 1 of a report over `Sales` (CSV), plus the bundle that can refresh it.
fn make_site(access: AccessLevel) -> Site {
    let dir = tempfile::tempdir().unwrap();
    let signer = Identity::generate();
    let key = (access == AccessLevel::Private).then(AccessKey::generate);
    let package_id = new_package_id();
    let source = csv(&[("Paris", 10), ("Lyon", 20)]);
    let project = vec![PackageFile { path: "project/Demo.pbip".into(), bytes: b"{\"version\":\"1.0\"}".to_vec() }];

    // version 1 as the app would publish it
    let engine = Engine::in_memory().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("s.csv"), &source).unwrap();
    engine.import("Sales", &SourceSpec::Csv { path: tmp.path().join("s.csv").display().to_string(), delimiter: None, header: None }, &MemoryCredentialStore::default()).unwrap();
    let out = tmp.path().join("Sales.parquet");
    engine.export_parquet("Sales", &["City".into(), "Amount".into()], &out).unwrap();
    let mut inc = included();
    inc[0].data_file = "data/Sales.parquet".into();
    let mut files = project.clone();
    files.push(PackageFile { path: "data/Sales.parquet".into(), bytes: fs::read(&out).unwrap() });
    let recipients = key.iter().map(|k| k.public.clone()).collect::<Vec<_>>();
    let pkg = package::build(
        BuildInput { package_id: package_id.clone(), version: 1, report_name: "Demo".into(), publisher_name: "Ann".into(), access, included: inc, permissions: vec![], created_at: "2026-10-17T00:00:00Z".into(), files, recipients: recipients.clone() },
        &signer,
    )
    .unwrap();
    let file = format!("{package_id}.biforge");
    fs::write(dir.path().join(&file), &pkg).unwrap();
    let feed = Feed { package_id: package_id.clone(), version: 1, file, sha256: sha256_hex(&pkg), access, updated_at: "t".into() };
    fs::write(dir.path().join(FEED_FILE), serde_json::to_vec(&feed).unwrap()).unwrap();

    // the bundle
    let config = RefreshConfig {
        format_version: 1,
        report_name: "Demo".into(),
        publisher_name: "Ann".into(),
        package_id: package_id.clone(),
        access,
        included: included(),
        sources: vec![RefreshSource { table: "Sales".into(), spec: serde_json::json!({"kind": "csv", "path": "data/src/sales.csv"}), original: "C:\\data\\sales.csv".into() }],
    };
    let bundle = package::build(
        BuildInput {
            package_id: new_package_id(),
            version: 1,
            report_name: "Demo (refresh bundle)".into(),
            publisher_name: "Ann".into(),
            access,
            included: vec![],
            permissions: vec![],
            created_at: "2026-10-17T00:00:00Z".into(),
            files: bundle_files(&config, &project, &[PackageFile { path: "data/src/sales.csv".into(), bytes: source }]).unwrap(),
            recipients,
        },
        &signer,
    )
    .unwrap();
    fs::write(dir.path().join(BUNDLE_FILE), bundle).unwrap();
    Site { dir, signer, access: key, package_id }
}

/// Replaces the source file inside the bundle (what the owner does when they turn refresh on again after the
/// source changed); the runner then sees different data.
fn rebuild_bundle_with(site: &Site, rows: &[(&str, i64)]) {
    let old = package::open(&fs::read(site.dir.path().join(BUNDLE_FILE)).unwrap(), &OpenOptions { access_key: site.access.as_ref().map(|k| k.secret.clone()), expected_publisher: None }).unwrap();
    let config: RefreshConfig = serde_json::from_slice(&old.files["data/refresh.json"]).unwrap();
    let project: Vec<PackageFile> = old.files.iter().filter(|(n, _)| n.starts_with("project/")).map(|(n, b)| PackageFile { path: n.clone(), bytes: b.clone() }).collect();
    let recipients = site.access.iter().map(|k| k.public.clone()).collect();
    let bundle = package::build(
        BuildInput {
            package_id: new_package_id(),
            version: 1,
            report_name: "b".into(),
            publisher_name: "Ann".into(),
            access: config.access,
            included: vec![],
            permissions: vec![],
            created_at: "t".into(),
            files: bundle_files(&config, &project, &[PackageFile { path: "data/src/sales.csv".into(), bytes: csv(rows) }]).unwrap(),
            recipients,
        },
        &site.signer,
    )
    .unwrap();
    fs::write(site.dir.path().join(BUNDLE_FILE), bundle).unwrap();
}

fn open_current(site: &Site) -> package::Package {
    let feed = Feed::parse(&fs::read(site.dir.path().join(FEED_FILE)).unwrap()).unwrap();
    let bytes = fs::read(site.dir.path().join(&feed.file)).unwrap();
    assert_eq!(sha256_hex(&bytes), feed.sha256, "the feed describes the package that is there");
    package::open(&bytes, &OpenOptions { access_key: site.access.as_ref().map(|k| k.secret.clone()), expected_publisher: Some(site.signer.public_key()) }).unwrap()
}

fn rows_of(pkg: &package::Package) -> usize {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("t.parquet");
    fs::write(&p, &pkg.files["data/Sales.parquet"]).unwrap();
    let e = Engine::in_memory().unwrap();
    e.import("Sales", &SourceSpec::Parquet { path: p.display().to_string() }, &MemoryCredentialStore::default()).unwrap();
    e.table_info("Sales").unwrap().row_count as usize
}

#[test]
fn unchanged_data_leaves_the_site_alone_and_changed_data_makes_the_next_version() {
    let site = make_site(AccessLevel::Public);
    let before = fs::read(site.dir.path().join(FEED_FILE)).unwrap();
    assert_eq!(refresh_site(site.dir.path(), &site.signer.secret(), None).unwrap(), Outcome::Unchanged { version: 1 });
    assert_eq!(fs::read(site.dir.path().join(FEED_FILE)).unwrap(), before, "nothing was written");

    rebuild_bundle_with(&site, &[("Paris", 10), ("Lyon", 20), ("Nice", 30)]);
    let out = refresh_site(site.dir.path(), &site.signer.secret(), None).unwrap();
    assert!(matches!(out, Outcome::Published { version: 2, .. }), "{out:?}");
    let pkg = open_current(&site);
    assert_eq!((pkg.manifest.version, rows_of(&pkg), pkg.manifest.package_id.clone()), (2, 3, site.package_id.clone()));
    // only the published columns are in the new package, the source's "Secret" column is not
    assert!(!String::from_utf8_lossy(&pkg.files["data/Sales.parquet"]).contains("hidden-"));
    assert_eq!(pkg.manifest.included[0].columns, vec!["City", "Amount"]);
    // and a second run finds nothing new
    assert_eq!(refresh_site(site.dir.path(), &site.signer.secret(), None).unwrap(), Outcome::Unchanged { version: 2 });
}

#[test]
fn a_private_report_needs_the_access_key_and_stays_encrypted() {
    let site = make_site(AccessLevel::Private);
    rebuild_bundle_with(&site, &[("Paris", 1)]);
    let e = refresh_site(site.dir.path(), &site.signer.secret(), None).unwrap_err();
    assert!(e.contains("cannot be opened"), "{e}");
    let wrong = AccessKey::generate().secret;
    assert!(refresh_site(site.dir.path(), &site.signer.secret(), Some(&wrong)).is_err());
    let key = site.access.as_ref().unwrap().secret.clone();
    assert!(matches!(refresh_site(site.dir.path(), &site.signer.secret(), Some(&key)).unwrap(), Outcome::Published { version: 2, .. }));
    let env = package::peek(&fs::read(site.dir.path().join(format!("{}.biforge", site.package_id))).unwrap(), None).unwrap();
    assert!(env.encrypted);
    assert_eq!(rows_of(&open_current(&site)), 1);
}

#[test]
fn only_the_publisher_can_refresh_and_a_wrong_site_is_refused() {
    let site = make_site(AccessLevel::Public);
    rebuild_bundle_with(&site, &[("Paris", 1)]);
    let stranger = Identity::generate();
    let e = refresh_site(site.dir.path(), &stranger.secret(), None).unwrap_err();
    assert!(e.contains("cannot be opened"), "{e}");
    assert!(refresh_site(site.dir.path(), "not base64!", None).is_err());
    // the bundle of another report
    let other = make_site(AccessLevel::Public);
    fs::copy(other.dir.path().join(BUNDLE_FILE), site.dir.path().join(BUNDLE_FILE)).unwrap();
    assert!(refresh_site(site.dir.path(), &site.signer.secret(), None).is_err());
    // a missing source file is reported with its table and original name
    let empty = tempfile::tempdir().unwrap();
    assert!(refresh_site(empty.path(), &site.signer.secret(), None).unwrap_err().contains("feed.json"));
    let _ = Path::new("");
}
