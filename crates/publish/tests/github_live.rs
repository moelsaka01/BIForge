//! Real GitHub: publish, update, key rotation and unpublish against a dedicated test repository, then delete it.
//! Runs only when BIFORGE_TEST_GITHUB_TOKEN is set (a token of the account that owns the test repository), so the
//! normal test run never touches the network:
//!
//!   $env:BIFORGE_TEST_GITHUB_TOKEN = (gh auth token); cargo test -p biforge-publish --test github_live -- --nocapture
//!
//! The repository is named biforge-o2-test-<random> and is deleted at the end (needs the delete_repo scope; if the
//! token lacks it the test prints the repository so it can be deleted by hand).

use std::sync::Arc;
use std::time::{Duration, Instant};

use biforge_publish::adapter::{Context, Registry};
use biforge_publish::github::{self, GitHubAdapter};
use biforge_publish::http::{Http, ReqwestHttp, Request};
use biforge_publish::keys::{new_package_id, KeyStore, MemoryKeyStore};
use biforge_publish::manifest::{AccessLevel, IncludedTable};
use biforge_publish::package::{self, OpenOptions, PackageFile};
use biforge_publish::publisher::{PublishRequest, Publisher};
use biforge_publish::subscribe;
use biforge_publish::targets::{Target, TargetStore};

fn request(target: &str, note: &str) -> PublishRequest {
    let t = vec![IncludedTable { table: "Sales".into(), columns: vec!["Id".into()], data_file: "data/Sales.parquet".into() }];
    PublishRequest {
        target_id: target.into(),
        report_name: "O2 live test".into(),
        publisher_name: "BIForge test".into(),
        included: t.clone(),
        confirmed: t,
        permissions: vec![],
        files: vec![PackageFile { path: "project/Demo.pbip".into(), bytes: b"{}".to_vec() }, PackageFile { path: "data/Sales.parquet".into(), bytes: note.as_bytes().to_vec() }],
    }
}

fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_secs(5));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn publish_update_rotate_unpublish_on_real_github() {
    let Ok(token) = std::env::var("BIFORGE_TEST_GITHUB_TOKEN") else {
        eprintln!("skipped: BIFORGE_TEST_GITHUB_TOKEN is not set");
        return;
    };
    let http: Arc<dyn Http> = Arc::new(ReqwestHttp::new().unwrap());
    let keys = Arc::new(MemoryKeyStore::default());
    keys.set(github::TOKEN_KEY, &token).unwrap();
    let reg = Registry::standard_with(Context { keys: keys.clone(), http: http.clone() });
    let dir = tempfile::tempdir().unwrap();
    let store = TargetStore::for_project(dir.path());

    let repo = format!("biforge-o2-test-{}", &new_package_id()[..8]);
    let mut t = Target::new("live", github::ID, "live test", AccessLevel::Private);
    t.settings.insert("repo".into(), repo.clone());
    let gh = GitHubAdapter::new(Context { keys: keys.clone(), http: http.clone() });
    let mut t2 = t.clone();
    biforge_publish::adapter::Adapter::authenticate(&gh, &mut t2).unwrap();
    let login = t2.account.clone().unwrap();
    t.account = Some(login.clone());
    store.put(t).unwrap();
    eprintln!("test repository: {login}/{repo}");

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let p = Publisher { registry: &reg, keys: keys.as_ref(), store: &store };
        let out = p.publish(&request("live", "one")).unwrap();
        let key = out.new_access_key.unwrap();
        let link = p.share_link("live").unwrap();
        let Ok(biforge_publish::deeplink::Link::Url { url }) = biforge_publish::deeplink::parse(&link) else { panic!("bad link {link}") };
        eprintln!("feed: {url}");
        wait_for("GitHub Pages to serve version 1", 600, || subscribe::fetch_feed(http.as_ref(), &url).map(|f| f.version == 1).unwrap_or(false));
        let f = subscribe::fetch_feed(http.as_ref(), &url).unwrap();
        let bytes = subscribe::fetch_package(http.as_ref(), &url, &f).unwrap();
        let pkg = package::open(&bytes, &OpenOptions { access_key: Some(key.clone()), expected_publisher: None }).unwrap();
        assert_eq!(pkg.files["data/Sales.parquet"], b"one");
        let landing = http.send(&Request::new("GET", url.trim_end_matches("feed.json"))).unwrap();
        assert!(landing.ok() && String::from_utf8_lossy(&landing.body).contains("biforge://open?src=url"));

        p.publish(&request("live", "two")).unwrap();
        wait_for("version 2", 300, || subscribe::fetch_feed(http.as_ref(), &url).map(|f| f.version == 2).unwrap_or(false));

        let rotated = p.rotate_key(&request("live", "three")).unwrap().new_access_key.unwrap();
        wait_for("version 3", 300, || subscribe::fetch_feed(http.as_ref(), &url).map(|f| f.version == 3).unwrap_or(false));
        let f3 = subscribe::fetch_feed(http.as_ref(), &url).unwrap();
        let b3 = subscribe::fetch_package(http.as_ref(), &url, &f3).unwrap();
        assert!(package::open(&b3, &OpenOptions { access_key: Some(key), expected_publisher: None }).is_err(), "the old key must not open version 3");
        assert!(package::open(&b3, &OpenOptions { access_key: Some(rotated), expected_publisher: None }).is_ok());

        // the repository's history is the version history: README + 3 publishes
        let commits = http
            .send(&Request::new("GET", &format!("https://api.github.com/repos/{login}/{repo}/commits?per_page=10")).bearer(&token).header("Accept", "application/vnd.github+json"))
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(commits.as_array().unwrap().len(), 4);

        p.unpublish("live").unwrap();
        wait_for("the site to stop serving the feed", 300, || subscribe::fetch_feed(http.as_ref(), &url).is_err());
        assert!(p.status("live").unwrap().is_none());
    }));

    // clean up: delete the test repository
    let del = http.send(&Request::new("DELETE", &format!("https://api.github.com/repos/{login}/{repo}")).bearer(&token).header("Accept", "application/vnd.github+json")).unwrap();
    if del.status == 204 {
        eprintln!("deleted {login}/{repo}");
    } else {
        eprintln!("COULD NOT DELETE {login}/{repo}: {} (the token needs the delete_repo scope; delete it by hand)", del.describe());
    }
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}

/// Scheduled refresh on real GitHub: the workflow runs on a real runner, downloads the command line from a release of
/// the test repository, reloads the bundled source and publishes version 2. Needs BIFORGE_TEST_CLI_EXE (path of a
/// built biforge-cli.exe) as well as the token.
#[test]
fn scheduled_refresh_runs_on_a_real_runner() {
    use biforge_engine::{Engine, MemoryCredentialStore, SourceSpec};
    use biforge_publish::refresh::{RefreshSource, Schedule};
    use biforge_publish::publisher::RefreshRequest;
    use serde_json::json;

    let (Ok(token), Ok(cli)) = (std::env::var("BIFORGE_TEST_GITHUB_TOKEN"), std::env::var("BIFORGE_TEST_CLI_EXE")) else {
        eprintln!("skipped: BIFORGE_TEST_GITHUB_TOKEN and BIFORGE_TEST_CLI_EXE are not both set");
        return;
    };
    let http: Arc<dyn Http> = Arc::new(ReqwestHttp::new().unwrap());
    let keys = Arc::new(MemoryKeyStore::default());
    keys.set(github::TOKEN_KEY, &token).unwrap();
    let reg = Registry::standard_with(Context { keys: keys.clone(), http: http.clone() });
    let dir = tempfile::tempdir().unwrap();
    let store = TargetStore::for_project(dir.path());
    let gh = |method: &str, url: &str| Request::new(method, url).bearer(&token).header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28");

    let repo = format!("biforge-o2-test-{}", &new_package_id()[..8]);
    let mut t = Target::new("live", github::ID, "refresh test", AccessLevel::Private);
    t.settings.insert("repo".into(), repo.clone());
    let adapter = GitHubAdapter::new(Context { keys: keys.clone(), http: http.clone() });
    let mut probe = t.clone();
    biforge_publish::adapter::Adapter::authenticate(&adapter, &mut probe).unwrap();
    let login = probe.account.clone().unwrap();
    t.account = Some(login.clone());
    store.put(t).unwrap();
    eprintln!("test repository: {login}/{repo}");

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let p = Publisher { registry: &reg, keys: keys.as_ref(), store: &store };
        // version 1: two rows. The bundle carries a source with three rows, so the refresh must produce version 2.
        let work = tempfile::tempdir().unwrap();
        let engine = Engine::in_memory().unwrap();
        let src = work.path().join("sales.csv");
        std::fs::write(&src, "City,Amount\nParis,1\nLyon,2\n").unwrap();
        engine.import("Sales", &SourceSpec::Csv { path: src.display().to_string(), delimiter: None, header: None }, &MemoryCredentialStore::default()).unwrap();
        let pq = work.path().join("v1.parquet");
        engine.export_parquet("Sales", &["City".into(), "Amount".into()], &pq).unwrap();
        let included = vec![IncludedTable { table: "Sales".into(), columns: vec!["City".into(), "Amount".into()], data_file: "data/Sales.parquet".into() }];
        let project = vec![PackageFile { path: "project/Demo.pbip".into(), bytes: b"{}".to_vec() }];
        let mut files = project.clone();
        files.push(PackageFile { path: "data/Sales.parquet".into(), bytes: std::fs::read(&pq).unwrap() });
        let out = p
            .publish(&PublishRequest { target_id: "live".into(), report_name: "Refresh test".into(), publisher_name: "BIForge test".into(), included: included.clone(), confirmed: included.clone(), permissions: vec![], files })
            .unwrap();
        let key = out.new_access_key.unwrap();
        let link = p.share_link("live").unwrap();
        let Ok(biforge_publish::deeplink::Link::Url { url }) = biforge_publish::deeplink::parse(&link) else { panic!("bad link") };
        wait_for("version 1 to be served", 600, || subscribe::fetch_feed(http.as_ref(), &url).map(|f| f.version == 1).unwrap_or(false));

        // a release of the test repository carries the command line (a real BIForge would use its own release)
        let rel = http.send(&gh("POST", &format!("https://api.github.com/repos/{login}/{repo}/releases")).json(&json!({"tag_name": "cli", "name": "cli"}))).unwrap();
        assert!(rel.ok(), "{}", rel.describe());
        let rid = rel.json().unwrap()["id"].as_u64().unwrap();
        let up = http.send(&gh("POST", &format!("https://uploads.github.com/repos/{login}/{repo}/releases/{rid}/assets?name=biforge-cli.exe")).bytes("application/octet-stream", std::fs::read(&cli).unwrap())).unwrap();
        assert!(up.ok(), "{}", up.describe());
        let cli_url = format!("https://github.com/{login}/{repo}/releases/download/cli/biforge-cli.exe");

        let mut tgt = store.get("live").unwrap();
        tgt.settings.insert("cliUrl".into(), cli_url);
        store.put(tgt).unwrap();
        p.enable_refresh(&RefreshRequest {
            target_id: "live".into(),
            report_name: "Refresh test".into(),
            publisher_name: "BIForge test".into(),
            included,
            schedule: Schedule::Manual,
            plan: None,
            sources: vec![RefreshSource { table: "Sales".into(), spec: json!({"kind": "csv", "path": "data/src/sales.csv"}), original: "sales.csv".into() }],
            confirmed_sources: vec!["sales.csv".into()],
            project_files: project,
            source_files: vec![PackageFile { path: "data/src/sales.csv".into(), bytes: b"City,Amount\nParis,1\nLyon,2\nNice,3\n".to_vec() }],
        })
        .unwrap();
        let watch = p.refresh_now("live").unwrap();
        eprintln!("refresh started: {watch}");

        // wait for the run, then for the site
        wait_for("the workflow run to finish", 1200, || {
            let r = http.send(&gh("GET", &format!("https://api.github.com/repos/{login}/{repo}/actions/runs?per_page=5"))).unwrap();
            let v = r.json().unwrap();
            let runs = v["workflow_runs"].as_array().cloned().unwrap_or_default();
            let mine = runs.iter().find(|x| x["name"] == "BIForge refresh");
            match mine {
                Some(run) if run["status"] == "completed" => {
                    assert_eq!(run["conclusion"], "success", "the refresh run did not succeed: {}", run["html_url"]);
                    true
                }
                _ => false,
            }
        });
        wait_for("version 2 to be served", 600, || subscribe::fetch_feed(http.as_ref(), &url).map(|f| f.version == 2).unwrap_or(false));
        let f2 = subscribe::fetch_feed(http.as_ref(), &url).unwrap();
        let pkg = package::open(&subscribe::fetch_package(http.as_ref(), &url, &f2).unwrap(), &OpenOptions { access_key: Some(key), expected_publisher: None }).unwrap();
        let tmp = work.path().join("v2.parquet");
        std::fs::write(&tmp, &pkg.files["data/Sales.parquet"]).unwrap();
        let e2 = Engine::in_memory().unwrap();
        e2.import("Sales", &SourceSpec::Parquet { path: tmp.display().to_string() }, &MemoryCredentialStore::default()).unwrap();
        assert_eq!(e2.table_info("Sales").unwrap().row_count, 3, "the runner reloaded the three-row source");
        p.disable_refresh("live").unwrap();
        p.unpublish("live").unwrap();
    }));

    let del = http.send(&gh("DELETE", &format!("https://api.github.com/repos/{login}/{repo}"))).unwrap();
    if del.status == 204 {
        eprintln!("deleted {login}/{repo}");
    } else {
        eprintln!("COULD NOT DELETE {login}/{repo}: {} (delete it by hand)", del.describe());
    }
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}
