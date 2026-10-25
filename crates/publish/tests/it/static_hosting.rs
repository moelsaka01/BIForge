//! The GitHub and Cloudflare adapters against in-memory fakes of the two services (the real GitHub is exercised by
//! tests/github_live.rs, gated on a token). The fakes enforce the rules the real services enforce for the calls the
//! adapters make, so a wrong request fails here.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use biforge_publish::adapter::{Context, Registry};
use biforge_publish::cloudflare::{self, asset_hash, CloudflareAdapter};
use biforge_publish::github::{self, GitHubAdapter};
use biforge_publish::http::{Http, Request, Response};
use biforge_publish::keys::{KeyStore, MemoryKeyStore};
use biforge_publish::manifest::{AccessLevel, IncludedTable};
use biforge_publish::package::{self, OpenOptions, PackageFile};
use biforge_publish::publisher::{PublishRequest, Publisher, RefreshRequest};
use biforge_publish::refresh::{RefreshSource, Schedule};
use biforge_publish::subscribe;
use biforge_publish::targets::{Target, TargetStatus, TargetStore};
use serde_json::{json, Value};

fn ok(v: Value) -> Response {
    Response { status: 200, body: serde_json::to_vec(&v).unwrap() }
}
fn status(s: u16, v: Value) -> Response {
    Response { status: s, body: serde_json::to_vec(&v).unwrap() }
}

// ---------------------------------------------------------------- GitHub

#[derive(Default)]
struct GhState {
    repo_exists: bool,
    private: bool,
    pages: bool,
    /// path -> bytes (the branch tip)
    files: BTreeMap<String, Vec<u8>>,
    blobs: BTreeMap<String, Vec<u8>>,
    trees: BTreeMap<String, BTreeMap<String, Vec<u8>>>,
    commits: Vec<String>,
    head: String,
    log: Vec<String>,
    secrets: BTreeMap<String, String>,
    vars: BTreeMap<String, String>,
    dispatched: u32,
}

struct FakeGitHub {
    s: Mutex<GhState>,
    /// GitHub's repository secret key pair: secrets arrive sealed for its public half.
    sk: crypto_box::SecretKey,
}

impl FakeGitHub {
    fn new() -> Arc<Self> {
        let s = GhState { head: "c0".into(), ..GhState::default() };
        Arc::new(Self { s: Mutex::new(s), sk: crypto_box::SecretKey::generate(&mut crypto_box::aead::OsRng) })
    }
}

impl Http for FakeGitHub {
    fn send(&self, r: &Request) -> biforge_publish::Result<Response> {
        let mut s = self.s.lock().unwrap();
        s.log.push(format!("{} {}", r.method, r.url));
        let auth = r.headers.iter().find(|(k, _)| k == "Authorization").map(|(_, v)| v.as_str());
        let path = r.url.strip_prefix("https://api.github.com").map(str::to_string);
        let body: Value = if r.body.is_empty() { Value::Null } else { serde_json::from_slice(&r.body).unwrap_or(Value::Null) };
        // the public site
        if path.is_none() {
            let rel = r.url.strip_prefix("https://ann.github.io/site/").unwrap_or("");
            return Ok(match s.files.get(rel) {
                Some(b) if s.pages => Response { status: 200, body: b.clone() },
                _ => status(404, json!({})),
            });
        }
        if auth != Some("Bearer tok") {
            return Ok(status(401, json!({"message": "Bad credentials"})));
        }
        let p = path.unwrap();
        let m = r.method.as_str();
        Ok(match (m, p.as_str()) {
            ("GET", "/user") => ok(json!({"login": "ann"})),
            ("GET", "/repos/ann/site") if s.repo_exists => ok(json!({"private": s.private, "default_branch": "main"})),
            ("GET", "/repos/ann/site") => status(404, json!({"message": "Not Found"})),
            ("POST", "/user/repos") => {
                assert_eq!(body["private"], json!(false), "the site repository must be public");
                assert_eq!(body["auto_init"], json!(true));
                s.repo_exists = true;
                s.files.insert("README.md".into(), b"x".to_vec());
                status(201, json!({"default_branch": "main"}))
            }
            ("GET", "/repos/ann/site/contents/.biforge-site.json") => match s.files.get(".biforge-site.json") {
                Some(b) => ok(json!({"content": B64.encode(b)})),
                None => status(404, json!({})),
            },
            ("GET", q) if q.starts_with("/repos/ann/site/contents/") => match s.files.get(&q["/repos/ann/site/contents/".len()..]) {
                Some(b) => ok(json!({"content": B64.encode(b)})),
                None => status(404, json!({})),
            },
            ("GET", "/repos/ann/site/actions/secrets/public-key") => ok(json!({"key_id": "k1", "key": B64.encode(self.sk.public_key().as_bytes())})),
            ("PUT", q) if q.starts_with("/repos/ann/site/actions/secrets/") => {
                assert_eq!(body["key_id"], json!("k1"));
                let sealed = B64.decode(body["encrypted_value"].as_str().unwrap()).unwrap();
                let plain = self.sk.unseal(&sealed).expect("the secret is a valid sealed box for the repository key");
                s.secrets.insert(q.rsplit('/').next().unwrap().to_string(), String::from_utf8(plain).unwrap());
                status(201, json!({}))
            }
            ("DELETE", q) if q.starts_with("/repos/ann/site/actions/secrets/") => {
                s.secrets.remove(q.rsplit('/').next().unwrap());
                status(204, json!({}))
            }
            ("POST", "/repos/ann/site/actions/variables") => {
                s.vars.insert(body["name"].as_str().unwrap().into(), body["value"].as_str().unwrap().into());
                status(201, json!({}))
            }
            ("POST", "/repos/ann/site/actions/workflows/biforge-refresh.yml/dispatches") => {
                assert!(s.files.contains_key(".github/workflows/biforge-refresh.yml"), "the workflow exists before it is started");
                s.dispatched += 1;
                status(204, json!({}))
            }
            ("GET", "/repos/ann/site/pages") if s.pages => ok(json!({"html_url": "https://ann.github.io/site"})),
            ("GET", "/repos/ann/site/pages") => status(404, json!({})),
            ("POST", "/repos/ann/site/pages") => {
                assert_eq!(body["source"]["branch"], json!("main"));
                s.pages = true;
                status(201, json!({"html_url": "https://ann.github.io/site/"}))
            }
            ("GET", "/repos/ann/site/git/ref/heads/main") => ok(json!({"object": {"sha": s.head}})),
            ("GET", q) if q.starts_with("/repos/ann/site/git/commits/") => ok(json!({"tree": {"sha": format!("t-{}", s.head)}})),
            ("POST", "/repos/ann/site/git/blobs") => {
                assert_eq!(body["encoding"], json!("base64"));
                let bytes = B64.decode(body["content"].as_str().unwrap()).unwrap();
                let sha = format!("b{}", s.blobs.len());
                s.blobs.insert(sha.clone(), bytes);
                status(201, json!({"sha": sha}))
            }
            ("POST", "/repos/ann/site/git/trees") => {
                let mut tree: BTreeMap<String, Vec<u8>> = s.files.clone();
                for e in body["tree"].as_array().unwrap() {
                    let path = e["path"].as_str().unwrap().to_string();
                    if e["sha"].is_null() {
                        assert!(tree.remove(&path).is_some(), "deleting a file that is not there: {path}");
                    } else {
                        tree.insert(path, s.blobs[e["sha"].as_str().unwrap()].clone());
                    }
                }
                let sha = format!("t{}", s.trees.len());
                s.trees.insert(sha.clone(), tree);
                status(201, json!({"sha": sha}))
            }
            ("POST", "/repos/ann/site/git/commits") => {
                assert_eq!(body["parents"], json!([s.head]));
                let sha = format!("c{}", s.commits.len() + 1);
                s.commits.push(body["message"].as_str().unwrap().to_string());
                let t = body["tree"].as_str().unwrap().to_string();
                s.files = s.trees[&t].clone();
                status(201, json!({"sha": sha}))
            }
            ("PATCH", "/repos/ann/site/git/refs/heads/main") => {
                s.head = body["sha"].as_str().unwrap().to_string();
                ok(json!({}))
            }
            _ => status(404, json!({"message": format!("unexpected {m} {p}")})),
        })
    }
}

struct Rig {
    reg: Registry,
    keys: Arc<MemoryKeyStore>,
    store: TargetStore,
    _dir: tempfile::TempDir,
}

fn rig(http: Arc<dyn Http>, github_base: Option<&str>) -> Rig {
    let keys = Arc::new(MemoryKeyStore::default());
    keys.set(github::TOKEN_KEY, "tok").unwrap();
    keys.set(cloudflare::TOKEN_KEY, "cf-tok").unwrap();
    let ctx = Context { keys: keys.clone(), http };
    let _ = github_base;
    let reg = Registry::standard_with(ctx);
    let dir = tempfile::tempdir().unwrap();
    let store = TargetStore::for_project(dir.path());
    Rig { reg, keys, store, _dir: dir }
}

fn tables() -> Vec<IncludedTable> {
    vec![IncludedTable { table: "Sales".into(), columns: vec!["Id".into()], data_file: "data/Sales.parquet".into() }]
}

fn request(target: &str, version_note: &str) -> PublishRequest {
    PublishRequest {
        target_id: target.into(),
        report_name: format!("Demo {version_note}"),
        publisher_name: "Ann".into(),
        included: tables(),
        confirmed: tables(),
        permissions: vec![],
        files: vec![
            PackageFile { path: "project/Demo.pbip".into(), bytes: b"{}".to_vec() },
            PackageFile { path: "data/Sales.parquet".into(), bytes: version_note.as_bytes().to_vec() },
        ],
    }
}

#[test]
fn github_publish_update_status_link_unpublish_and_key_rotation() {
    let gh = FakeGitHub::new();
    let r = rig(gh.clone(), None);
    let mut t = Target::new("t1", github::ID, "site", AccessLevel::Private);
    t.settings.insert("repo".into(), "site".into());
    r.store.put(t).unwrap();
    let p = Publisher { registry: &r.reg, keys: r.keys.as_ref(), store: &r.store };

    // publish: repository, Pages, one commit with the package + feed + page + marker
    let out = p.publish(&request("t1", "one")).unwrap();
    let key = out.new_access_key.expect("a private report gets an access key");
    assert_eq!(out.state.version, 1);
    assert_eq!(out.state.location, "https://ann.github.io/site/feed.json");
    {
        let s = gh.s.lock().unwrap();
        assert!(s.repo_exists && s.pages);
        assert_eq!(s.commits, ["BIForge: publish version 1"]);
        for f in ["feed.json", "index.html", ".nojekyll", ".biforge-site.json"] {
            assert!(s.files.contains_key(f), "{f} missing");
        }
        let page = String::from_utf8_lossy(&s.files["index.html"]).to_string();
        assert!(page.contains("biforge://open?src=url") && !page.contains("Demo"), "a private report's name is not on the page");
        assert!(s.files.keys().filter(|k| k.ends_with(".biforge")).count() == 1);
    }
    assert!(p.status("t1").unwrap().is_some_and(|s| s.version == 1));

    // a viewer follows the share link's feed address without any account and opens the package with the key
    let link = p.share_link("t1").unwrap();
    let Ok(biforge_publish::deeplink::Link::Url { url }) = biforge_publish::deeplink::parse(&link) else { panic!("not a feed link: {link}") };
    assert_eq!(url, "https://ann.github.io/site/feed.json");
    let feed = subscribe::fetch_feed(gh.as_ref(), &url).unwrap();
    let bytes = subscribe::fetch_package(gh.as_ref(), &url, &feed).unwrap();
    let pkg = package::open(&bytes, &OpenOptions { access_key: Some(key.clone()), expected_publisher: None }).unwrap();
    assert_eq!(pkg.files["data/Sales.parquet"], b"one");
    let pinned = pkg.envelope.publisher_public_key.clone();

    // update: version 2, same repository, same key; the viewer sees it as newer
    p.publish(&request("t1", "two")).unwrap();
    let newer = subscribe::newer(gh.as_ref(), &url, 1).unwrap().expect("version 2 is newer");
    let pkg2 = package::open(&subscribe::fetch_package(gh.as_ref(), &url, &newer).unwrap(), &OpenOptions { access_key: Some(key.clone()), expected_publisher: Some(pinned.clone()) }).unwrap();
    assert_eq!((pkg2.manifest.version, pkg2.files["data/Sales.parquet"].clone()), (2, b"two".to_vec()));
    assert!(subscribe::newer(gh.as_ref(), &url, 2).unwrap().is_none());

    // key rotation: the old key no longer opens version 3, the new key does, the pinned publisher still matches
    let rotated = p.rotate_key(&request("t1", "three")).unwrap();
    let new_key = rotated.new_access_key.unwrap();
    assert_ne!(new_key, key);
    let f3 = subscribe::fetch_feed(gh.as_ref(), &url).unwrap();
    let b3 = subscribe::fetch_package(gh.as_ref(), &url, &f3).unwrap();
    assert!(package::open(&b3, &OpenOptions { access_key: Some(key), expected_publisher: Some(pinned.clone()) }).is_err());
    assert!(package::open(&b3, &OpenOptions { access_key: Some(new_key), expected_publisher: Some(pinned) }).is_ok());
    assert_eq!(gh.s.lock().unwrap().commits.len(), 3, "every version is one commit: the history is the version history");

    // unpublish: package, feed and page are gone, the marker stays, the target can publish again
    p.unpublish("t1").unwrap();
    {
        let s = gh.s.lock().unwrap();
        assert!(!s.files.contains_key("feed.json") && !s.files.contains_key("index.html"));
        assert!(!s.files.keys().any(|k| k.ends_with(".biforge")));
        assert!(s.files.contains_key(".biforge-site.json"));
    }
    assert!(p.status("t1").unwrap().is_none());
    assert_eq!(r.store.get("t1").unwrap().status, TargetStatus::Unpublished);
    assert!(subscribe::fetch_feed(gh.as_ref(), &url).unwrap_err().to_string().contains("Nothing is published"));
    p.publish(&request("t1", "four")).unwrap();
    assert!(p.status("t1").unwrap().is_some());
}

fn refresh_request(schedule: Schedule, project_files: Vec<PackageFile>) -> RefreshRequest {
    RefreshRequest {
        target_id: "t1".into(),
        report_name: "Demo".into(),
        publisher_name: "Ann".into(),
        included: tables(),
        schedule,
        plan: None,
        sources: vec![RefreshSource { table: "Sales".into(), spec: json!({"kind": "csv", "path": "data/src/sales.csv"}), original: "C:\\data\\sales.csv".into() }],
        confirmed_sources: vec!["C:\\data\\sales.csv".into()],
        project_files,
        source_files: vec![PackageFile { path: "data/src/sales.csv".into(), bytes: b"City,Amount\nParis,1\n".to_vec() }],
    }
}

#[test]
fn github_scheduled_refresh_writes_the_workflow_and_bundle_seals_the_secrets_and_can_be_turned_off() {
    let gh = FakeGitHub::new();
    let r = rig(gh.clone(), None);
    let mut t = Target::new("t1", github::ID, "site", AccessLevel::Private);
    t.settings.insert("repo".into(), "site".into());
    t.settings.insert("cliUrl".into(), "https://example.com/biforge-cli.exe".into());
    r.store.put(t).unwrap();
    let p = Publisher { registry: &r.reg, keys: r.keys.as_ref(), store: &r.store };
    let project = vec![PackageFile { path: "project/Demo.pbip".into(), bytes: b"{}".to_vec() }];

    // not published yet / not confirmed / not supported by the folder adapter
    assert!(p.enable_refresh(&refresh_request(Schedule::Daily, project.clone())).unwrap_err().to_string().contains("Publish the report first"));
    let out = p.publish(&request("t1", "one")).unwrap();
    let key = out.new_access_key.unwrap();
    let mut unconfirmed = refresh_request(Schedule::Daily, project.clone());
    unconfirmed.confirmed_sources = vec![];
    assert!(matches!(p.enable_refresh(&unconfirmed), Err(biforge_publish::Error::NotConfirmed)));
    assert!(gh.s.lock().unwrap().secrets.is_empty(), "nothing was stored before the confirmation matched");

    p.enable_refresh(&refresh_request(Schedule::Daily, project.clone())).unwrap();
    {
        let s = gh.s.lock().unwrap();
        let yml = String::from_utf8(s.files[".github/workflows/biforge-refresh.yml"].clone()).unwrap();
        assert!(yml.contains("cron: \"17 5 * * *\"") && yml.contains("secrets.BIFORGE_ACCESS_KEY"));
        assert!(s.files[".gitignore"].starts_with(b"# BIForge refresh"));
        // the secrets arrived through a real sealed box: the signing key is the publisher's, the access key is the report's
        assert_eq!(s.secrets["BIFORGE_ACCESS_KEY"], key);
        let signing = s.secrets["BIFORGE_SIGNING_KEY"].clone();
        assert_eq!(biforge_publish::keys::Identity::from_secret(&signing).unwrap().public_key(), package::peek(&s.files[&format!("{}.biforge", r.store.get("t1").unwrap().package_id.unwrap())], None).unwrap().publisher_public_key);
        assert_eq!(s.vars["BIFORGE_CLI_URL"], "https://example.com/biforge-cli.exe");
        // the bundle is an encrypted package: the source file and the project are not readable without the key
        let bundle = &s.files["refresh.bundle"];
        assert!(!String::from_utf8_lossy(bundle).contains("Paris"));
        assert!(package::open(bundle, &OpenOptions::default()).is_err());
        let opened = package::open(bundle, &OpenOptions { access_key: Some(key.clone()), expected_publisher: None }).unwrap();
        assert!(opened.files.contains_key("data/refresh.json") && opened.files.contains_key("data/src/sales.csv") && opened.files.contains_key("project/Demo.pbip"));
    }
    assert_eq!(r.store.get("t1").unwrap().settings["refresh"], "daily");

    // revoking is refused while the runner holds the old key; a manual publish continues after the runner's versions
    assert!(p.rotate_key(&request("t1", "x")).unwrap_err().to_string().contains("Turn off scheduled refresh"));
    {
        // the runner published version 5 meanwhile
        let mut s = gh.s.lock().unwrap();
        let mut f: biforge_publish::feed::Feed = serde_json::from_slice(&s.files["feed.json"]).unwrap();
        f.version = 5;
        s.files.insert("feed.json".into(), serde_json::to_vec(&f).unwrap());
    }
    assert_eq!(p.publish(&request("t1", "two")).unwrap().state.version, 6, "the next manual version follows the runner's");

    assert!(p.refresh_now("t1").unwrap().ends_with("/actions"));
    assert_eq!(gh.s.lock().unwrap().dispatched, 1);

    p.disable_refresh("t1").unwrap();
    {
        let s = gh.s.lock().unwrap();
        assert!(s.secrets.is_empty());
        assert!(!s.files.contains_key(".github/workflows/biforge-refresh.yml") && !s.files.contains_key("refresh.bundle"));
        assert!(s.files.contains_key("feed.json"), "the published report stays");
    }
    assert!(r.store.get("t1").unwrap().settings.get("refresh").is_none());
    assert!(p.refresh_now("t1").is_err());
    // key rotation works again
    assert!(p.rotate_key(&request("t1", "three")).is_ok());
}

#[test]
fn the_folder_and_cloudflare_cannot_do_scheduled_refresh() {
    let r = rig(FakeGitHub::new(), None);
    let mut t = Target::new("t1", biforge_publish::local::ID, "f", AccessLevel::Public);
    t.settings.insert("folder".into(), "C:\\x".into());
    r.store.put(t).unwrap();
    let p = Publisher { registry: &r.reg, keys: r.keys.as_ref(), store: &r.store };
    assert!(matches!(p.enable_refresh(&refresh_request(Schedule::Daily, vec![])), Err(biforge_publish::Error::Unsupported { .. })));
    assert!(matches!(p.disable_refresh("t1"), Err(biforge_publish::Error::Unsupported { .. })));
}

#[test]
fn github_never_touches_a_repository_it_did_not_make() {
    let gh = FakeGitHub::new();
    gh.s.lock().unwrap().repo_exists = true;
    let r = rig(gh.clone(), None);
    let mut t = Target::new("t1", github::ID, "site", AccessLevel::Public);
    t.settings.insert("repo".into(), "site".into());
    r.store.put(t).unwrap();
    let p = Publisher { registry: &r.reg, keys: r.keys.as_ref(), store: &r.store };
    let e = p.publish(&request("t1", "one")).unwrap_err().to_string();
    assert!(e.contains("was not made by BIForge"), "{e}");
    let s = gh.s.lock().unwrap();
    assert!(s.commits.is_empty() && !s.pages, "nothing was written");
    assert!(!s.log.iter().any(|l| l.starts_with("POST") || l.starts_with("PATCH")), "no write call at all: {:?}", s.log);
}

#[test]
fn github_refuses_a_private_repository_and_a_missing_token() {
    let gh = FakeGitHub::new();
    {
        let mut s = gh.s.lock().unwrap();
        s.repo_exists = true;
        s.private = true;
    }
    let r = rig(gh.clone(), None);
    let mut t = Target::new("t1", github::ID, "site", AccessLevel::Public);
    t.settings.insert("repo".into(), "site".into());
    r.store.put(t).unwrap();
    let p = Publisher { registry: &r.reg, keys: r.keys.as_ref(), store: &r.store };
    assert!(p.publish(&request("t1", "one")).unwrap_err().to_string().contains("is private"));

    r.keys.delete(github::TOKEN_KEY).unwrap();
    // validate() reports it before anything is sent; publish stops on the same error
    let e = p.publish(&request("t1", "one")).unwrap_err().to_string();
    assert!(e.contains("not connected"), "{e}");
}

#[test]
fn github_checks_the_repository_name_and_the_unconfirmed_list() {
    let gh = FakeGitHub::new();
    let r = rig(gh, None);
    let mut t = Target::new("t1", github::ID, "site", AccessLevel::Public);
    t.settings.insert("repo".into(), "bad name/with slash".into());
    r.store.put(t).unwrap();
    let p = Publisher { registry: &r.reg, keys: r.keys.as_ref(), store: &r.store };
    assert!(p.publish(&request("t1", "one")).is_err());
    let mut req = request("t1", "one");
    req.confirmed[0].columns.push("Secret".into());
    assert!(matches!(p.publish(&req), Err(biforge_publish::Error::NotConfirmed)));
}

// ------------------------------------------------------------- Cloudflare

#[derive(Default)]
struct CfState {
    /// hash -> already known to Cloudflare
    known: Vec<String>,
    manifest: BTreeMap<String, (String, u64)>,
    uploaded: BTreeMap<String, Vec<u8>>,
    deployed: bool,
    script_form: Vec<u8>,
    deleted: bool,
    log: Vec<String>,
}

struct FakeCloudflare {
    s: Mutex<CfState>,
}

const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";

impl Http for FakeCloudflare {
    fn send(&self, r: &Request) -> biforge_publish::Result<Response> {
        let mut s = self.s.lock().unwrap();
        s.log.push(format!("{} {}", r.method, r.url));
        let auth = r.headers.iter().find(|(k, _)| k == "Authorization").map(|(_, v)| v.clone()).unwrap_or_default();
        let base = format!("https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}");
        let Some(p) = r.url.strip_prefix(&base) else {
            // the public site
            let rel = r.url.strip_prefix("https://site.ann.workers.dev/").unwrap_or("");
            return Ok(match (s.deployed, s.manifest.get(&format!("/{rel}"))) {
                (true, Some((hash, _))) if s.uploaded.contains_key(hash) => Response { status: 200, body: s.uploaded[hash].clone() },
                _ => status(404, json!({})),
            });
        };
        let ok_cf = |v: Value| ok(json!({"success": true, "errors": [], "result": v}));
        Ok(match (r.method.as_str(), p) {
            ("GET", "/workers/subdomain") => {
                assert_eq!(auth, "Bearer cf-tok");
                ok_cf(json!({"subdomain": "ann"}))
            }
            ("POST", "/workers/scripts/site/assets-upload-session") => {
                assert_eq!(auth, "Bearer cf-tok");
                let b: Value = serde_json::from_slice(&r.body).unwrap();
                s.manifest.clear();
                let mut need = Vec::new();
                for (path, e) in b["manifest"].as_object().unwrap() {
                    assert!(path.starts_with('/'));
                    let h = e["hash"].as_str().unwrap().to_string();
                    assert_eq!(h.len(), 32);
                    if !s.known.contains(&h) && !s.uploaded.contains_key(&h) {
                        need.push(json!(h));
                    }
                    s.manifest.insert(path.clone(), (h, e["size"].as_u64().unwrap()));
                }
                ok_cf(json!({"jwt": "session-jwt", "buckets": if need.is_empty() { json!([]) } else { json!([need]) }}))
            }
            ("POST", "/workers/assets/upload?base64=true") => {
                assert_eq!(auth, "Bearer session-jwt", "the upload uses the session token, not the API token");
                let ct = r.headers.iter().find(|(k, _)| k == "Content-Type").unwrap().1.clone();
                let boundary = ct.split("boundary=").nth(1).unwrap().to_string();
                let text = String::from_utf8_lossy(&r.body).to_string();
                for part in text.split(&format!("--{boundary}")).filter(|x| x.contains("Content-Disposition")) {
                    let name = part.split("name=\"").nth(1).unwrap().split('"').next().unwrap().to_string();
                    let content = part.split("\r\n\r\n").nth(1).unwrap().trim_end_matches("\r\n");
                    let bytes = B64.decode(content).unwrap();
                    let path = s.manifest.iter().find(|(_, (h, _))| *h == name).map(|(p, _)| p.clone()).expect("an uploaded hash that is in the manifest");
                    assert_eq!(asset_hash(&bytes, &path), name, "the hash is Cloudflare's formula");
                    s.uploaded.insert(name, bytes);
                }
                status(201, json!({"success": true, "result": {"jwt": "completion-jwt"}}))
            }
            ("PUT", "/workers/scripts/site") => {
                let text = String::from_utf8_lossy(&r.body).to_string();
                assert!(text.contains("completion-jwt") && text.contains("main_module"));
                assert!(s.manifest.keys().all(|p| s.uploaded.contains_key(&s.manifest[p].0) || s.known.contains(&s.manifest[p].0)), "every file of the manifest was uploaded before the deploy");
                s.deployed = true;
                s.script_form = r.body.clone();
                ok_cf(json!({}))
            }
            ("POST", "/workers/scripts/site/subdomain") => ok_cf(json!({})),
            ("DELETE", "/workers/scripts/site") => {
                s.deployed = false;
                s.deleted = true;
                ok_cf(json!({}))
            }
            (m, q) => status(404, json!({"success": false, "errors": [{"message": format!("unexpected {m} {q}")}]})),
        })
    }
}

#[test]
fn cloudflare_publish_update_unpublish_through_the_documented_upload_flow() {
    let cf = Arc::new(FakeCloudflare { s: Mutex::new(CfState::default()) });
    let r = rig(cf.clone(), None);
    let mut t = Target::new("c1", cloudflare::ID, "site", AccessLevel::Public);
    t.settings.insert("accountId".into(), ACCOUNT.into());
    t.settings.insert("name".into(), "site".into());
    r.store.put(t).unwrap();
    let p = Publisher { registry: &r.reg, keys: r.keys.as_ref(), store: &r.store };

    let out = p.publish(&request("c1", "one")).unwrap();
    assert_eq!(out.state.location, "https://site.ann.workers.dev/feed.json");
    assert!(out.new_access_key.is_none(), "a public report has no key");
    let link = p.share_link("c1").unwrap();
    let Ok(biforge_publish::deeplink::Link::Url { url }) = biforge_publish::deeplink::parse(&link) else { panic!() };
    let feed = subscribe::fetch_feed(cf.as_ref(), &url).unwrap();
    let pkg = package::open(&subscribe::fetch_package(cf.as_ref(), &url, &feed).unwrap(), &OpenOptions::default()).unwrap();
    assert_eq!(pkg.files["data/Sales.parquet"], b"one");
    assert!(p.status("c1").unwrap().is_some_and(|s| s.version == 1));

    // an update uploads only what Cloudflare does not have yet (the landing page is unchanged for a public report with the same name? it differs by name here, so assert only the flow)
    p.publish(&request("c1", "two")).unwrap();
    let feed2 = subscribe::fetch_feed(cf.as_ref(), &url).unwrap();
    assert_eq!(feed2.version, 2);

    p.unpublish("c1").unwrap();
    assert!(cf.s.lock().unwrap().deleted);
    assert!(p.status("c1").unwrap().is_none());
}

#[test]
fn cloudflare_needs_valid_settings_and_a_token() {
    let cf = Arc::new(FakeCloudflare { s: Mutex::new(CfState::default()) });
    let r = rig(cf, None);
    let mut t = Target::new("c1", cloudflare::ID, "site", AccessLevel::Public);
    t.settings.insert("accountId".into(), "short".into());
    t.settings.insert("name".into(), "site".into());
    r.store.put(t).unwrap();
    let p = Publisher { registry: &r.reg, keys: r.keys.as_ref(), store: &r.store };
    assert!(p.publish(&request("c1", "one")).unwrap_err().to_string().contains("account id"));
    let mut t = r.store.get("c1").unwrap();
    t.settings.insert("accountId".into(), ACCOUNT.into());
    t.settings.insert("name".into(), "-bad".into());
    r.store.put(t).unwrap();
    assert!(p.publish(&request("c1", "one")).unwrap_err().to_string().contains("site name"));
}

#[test]
fn the_asset_hash_follows_cloudflares_published_formula() {
    // sha256(base64(content) + extension)[..32]
    let h = asset_hash(b"hello", "/a/index.html");
    use sha2::{Digest, Sha256};
    let want = biforge_publish::keys::hex(&Sha256::digest(format!("{}html", B64.encode(b"hello")).as_bytes()))[..32].to_string();
    assert_eq!(h, want);
}

#[test]
fn the_registry_lists_both_hosts_as_implemented() {
    let reg = Registry::standard();
    for id in [github::ID, cloudflare::ID] {
        let info = reg.infos().into_iter().find(|i| i.id == id).unwrap();
        assert!(info.capabilities.implemented && info.capabilities.unpublish && info.capabilities.needs_account);
        assert!(!info.capabilities.row_level_security);
    }
    let _ = (GitHubAdapter::new(Context::offline()), CloudflareAdapter::new(Context::offline()));
}
