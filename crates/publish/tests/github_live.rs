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
