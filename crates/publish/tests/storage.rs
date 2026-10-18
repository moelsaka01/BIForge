//! Personal storage (Google Drive, OneDrive, Dropbox) against fakes: no account and no network.
//!
//! Two levels. (1) The generic adapter and the Publisher on top of an in-memory provider (`MemoryCloud`) that behaves
//! like the real ones where it matters: revisions that change on every write, conditional writes, version history.
//! (2) Each provider's REST calls against scripted answers: the request shapes (URLs, headers, bodies) and how the
//! answers are read. The real services are the live tests that wait for the owner's client ids (docs/PROGRESS.md).

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use biforge_publish::adapter::*;
use biforge_publish::http::{FakeHttp, Http, Response};
use biforge_publish::keys::{KeyStore, MemoryKeyStore};
use biforge_publish::manifest::*;
use biforge_publish::oauth::{self, Tokens};
use biforge_publish::package::{self, OpenOptions, PackageFile};
use biforge_publish::publisher::*;
use biforge_publish::storage::{Cloud, Remote, StorageAdapter};
use biforge_publish::targets::*;
use biforge_publish::Error;
use serde_json::json;

// ------------------------------------------------------------------------------------------------ in-memory provider

#[derive(Default)]
struct State {
    files: BTreeMap<String, (Vec<u8>, u64)>, // name -> (bytes, revision number)
    history: BTreeMap<String, Vec<(u64, usize)>>,
    next: u64,
    shared_with: Vec<(String, bool)>,
    public_links: usize,
}

#[derive(Clone, Default)]
struct MemoryCloud(Arc<Mutex<State>>);

impl MemoryCloud {
    fn remote(name: &str, f: &(Vec<u8>, u64)) -> Remote {
        Remote { id: format!("id-{name}"), rev: format!("r{}", f.1), size: f.0.len() as u64, modified: format!("2026-10-18T10:00:{:02}Z", f.1 % 60), web_url: Some(format!("https://files.example/{name}")) }
    }
    fn name_of(file: &Remote) -> String {
        file.id.trim_start_matches("id-").to_string()
    }
    /// Someone else writes the file.
    fn other_writes(&self, name: &str, bytes: &[u8]) {
        let mut s = self.0.lock().unwrap();
        s.next += 1;
        let n = s.next;
        s.files.insert(name.into(), (bytes.to_vec(), n));
        s.history.entry(name.into()).or_default().push((n, bytes.len()));
    }
}

impl Cloud for MemoryCloud {
    fn whoami(&self, _: &dyn Http, _: &str) -> biforge_publish::Result<String> {
        Ok("ann@example.com".into())
    }
    fn find(&self, _: &dyn Http, _: &str, name: &str) -> biforge_publish::Result<Option<Remote>> {
        Ok(self.0.lock().unwrap().files.get(name).map(|f| Self::remote(name, f)))
    }
    fn upload(&self, _: &dyn Http, tok: &str, name: &str, bytes: &[u8], existing: Option<&Remote>, if_rev: Option<&str>) -> biforge_publish::Result<Remote> {
        assert_eq!(tok, "access-1", "the stored access token is used");
        let mut s = self.0.lock().unwrap();
        if let (Some(want), Some(cur)) = (if_rev, s.files.get(name)) {
            if format!("r{}", cur.1) != want {
                return Err(Error::Conflict("conditional write failed".into()));
            }
        }
        assert_eq!(existing.is_some(), s.files.contains_key(name), "the adapter looked the file up first");
        s.next += 1;
        let n = s.next;
        s.files.insert(name.into(), (bytes.to_vec(), n));
        s.history.entry(name.into()).or_default().push((n, bytes.len()));
        Ok(Self::remote(name, &s.files[name]))
    }
    fn download(&self, _: &dyn Http, _: &str, file: &Remote) -> biforge_publish::Result<Vec<u8>> {
        Ok(self.0.lock().unwrap().files[&Self::name_of(file)].0.clone())
    }
    fn share_link(&self, _: &dyn Http, _: &str, file: &Remote) -> biforge_publish::Result<String> {
        self.0.lock().unwrap().public_links += 1;
        Ok(format!("https://share.example/{}", file.id))
    }
    fn share_with(&self, _: &dyn Http, _: &str, _: &Remote, email: &str, can_edit: bool) -> biforge_publish::Result<()> {
        self.0.lock().unwrap().shared_with.push((email.into(), can_edit));
        Ok(())
    }
    fn versions(&self, _: &dyn Http, _: &str, file: &Remote) -> biforge_publish::Result<Vec<VersionInfo>> {
        let s = self.0.lock().unwrap();
        let mut v: Vec<VersionInfo> = s.history[&Self::name_of(file)].iter().map(|(n, size)| VersionInfo { id: format!("r{n}"), modified: format!("2026-10-18T10:00:{:02}Z", n % 60), size: *size as u64 }).collect();
        v.reverse();
        Ok(v)
    }
    fn delete(&self, _: &dyn Http, _: &str, file: &Remote) -> biforge_publish::Result<()> {
        self.0.lock().unwrap().files.remove(&Self::name_of(file));
        Ok(())
    }
}

fn tokens(keys: &MemoryKeyStore, access: &str, expires_in: i64) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    oauth::store_tokens(keys, "google-drive", &Tokens { access: access.into(), refresh: Some("refresh-1".into()), expires_at: (now + expires_in) as u64 }).unwrap();
}

struct Env {
    _tmp: tempfile::TempDir,
    cloud: MemoryCloud,
    keys: Arc<MemoryKeyStore>,
    http: Arc<FakeHttp>,
    registry: Registry,
    store: TargetStore,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let cloud = MemoryCloud::default();
    let keys = Arc::new(MemoryKeyStore::default());
    tokens(&keys, "access-1", 3600);
    let http = Arc::new(FakeHttp::new(vec![]));
    let ctx = Context { keys: keys.clone(), http: http.clone() };
    let adapter = StorageAdapter::new(ctx, oauth::GOOGLE, Box::new(cloud.clone()), &["Shares the editable project snapshot"], &["Free account"]).with_client_id("client-1");
    let store = TargetStore::for_project(&tmp.path().join("proj"));
    let mut t = Target::new("t1", "google-drive", "Sales report", AccessLevel::Public);
    t.account = Some("ann@example.com".into());
    store.put(t).unwrap();
    Env { _tmp: tmp, cloud, keys, http, registry: Registry::new(vec![Box::new(adapter)]), store }
}

fn included() -> Vec<IncludedTable> {
    vec![IncludedTable { table: "Sales".into(), columns: vec!["Amount".into()], data_file: String::new() }]
}

fn request(marker: &str) -> PublishRequest {
    PublishRequest {
        target_id: "t1".into(),
        report_name: "Sales".into(),
        publisher_name: "Ann".into(),
        included: included(),
        confirmed: included(),
        permissions: vec![],
        files: vec![PackageFile { path: "project/Sales.pbip".into(), bytes: format!("{{\"v\":\"{marker}\"}}").into_bytes() }, PackageFile { path: "data/Sales.parquet".into(), bytes: marker.as_bytes().repeat(50) }],
    }
}

fn publisher(e: &Env) -> Publisher<'_> {
    Publisher { registry: &e.registry, keys: e.keys.as_ref(), store: &e.store }
}

#[test]
fn publish_update_sync_history_sharing_unpublish_and_disconnect() {
    let e = env();
    let p = publisher(&e);
    assert!(e.registry.get("google-drive").unwrap().info().capabilities.version_history);

    let out = p.publish(&request("one")).unwrap();
    assert_eq!(out.state.version, 1);
    assert_eq!(e.store.get("t1").unwrap().settings["rev"], "r1", "the revision we wrote is remembered");
    assert!(e.cloud.0.lock().unwrap().files.contains_key("Sales-report.biforge"));

    // update: the revision moves on
    assert_eq!(p.publish(&request("two")).unwrap().state.version, 2);
    assert_eq!(e.store.get("t1").unwrap().settings["rev"], "r2");
    assert_eq!(p.status("t1").unwrap().unwrap().version, 2);

    // a viewer syncs: gets the package only when it is newer than what it has
    let t = e.store.get("t1").unwrap();
    let a = e.registry.get("google-drive").unwrap();
    assert!(a.sync(&t, Some(2)).unwrap().is_none());
    let bytes = a.sync(&t, Some(1)).unwrap().expect("version 2 is newer");
    assert_eq!(package::open(&bytes, &OpenOptions::default()).unwrap().manifest.version, 2);
    assert!(a.sync(&t, None).unwrap().is_some());

    // version history of the provider, newest first
    let v = p.versions("t1").unwrap();
    assert_eq!(v.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["r2", "r1"]);

    // provider sharing: a link anyone can open, and a person by e-mail address
    assert_eq!(p.share_link("t1").unwrap(), "https://share.example/id-Sales-report.biforge");
    p.share_with("t1", "bob@example.com", false).unwrap();
    assert!(p.share_with("t1", "not an address", false).is_err());
    assert_eq!(e.cloud.0.lock().unwrap().shared_with, vec![("bob@example.com".to_string(), false)]);
    let log = biforge_publish::audit::read_all(&e.store).unwrap();
    assert!(log.iter().any(|x| x.event == "share-with" && x.detail.contains("bob@example.com")));

    // unpublish removes the file; disconnect forgets the tokens and leaves the account's data alone
    p.unpublish("t1").unwrap();
    assert!(e.cloud.0.lock().unwrap().files.is_empty());
    p.disconnect("t1").unwrap();
    assert!(oauth::load_tokens(e.keys.as_ref(), "google-drive").unwrap().is_none());
    assert!(e.store.get("t1").unwrap().account.is_none());
    assert!(a.validate(&e.store.get("t1").unwrap()).iter().any(|i| i.severity == Severity::Error && i.message.contains("not connected")));
    assert!(p.publish(&request("three")).is_err(), "nothing is sent without a connection");
}

#[test]
fn a_change_made_by_someone_else_is_detected_and_never_overwritten_silently() {
    let e = env();
    let p = publisher(&e);
    p.publish(&request("one")).unwrap();
    e.cloud.other_writes("Sales-report.biforge", b"edited by Bob");
    let err = p.publish(&request("two")).unwrap_err();
    assert!(matches!(err, Error::Conflict(_)), "{err}");
    assert!(err.to_string().contains("changed by someone else"));
    assert_eq!(e.cloud.0.lock().unwrap().files["Sales-report.biforge"].0, b"edited by Bob", "their file is untouched");
    assert_eq!(e.store.get("t1").unwrap().last_version, Some(1), "the target still says version 1");
    // the user chooses Overwrite: the next publish replaces it, once
    p.allow_overwrite("t1").unwrap();
    assert_eq!(p.publish(&request("two")).unwrap().state.version, 2);
    assert!(!e.store.get("t1").unwrap().settings.contains_key("overwrite"), "overwrite is a one-time permission");
    assert_ne!(e.cloud.0.lock().unwrap().files["Sales-report.biforge"].0, b"edited by Bob");
    // a file with the same name that this report never uploaded is not replaced either
    e.cloud.other_writes("Sales-report.biforge", b"someone else again");
    let mut t = e.store.get("t1").unwrap();
    t.settings.remove("rev");
    t.status = TargetStatus::NeverPublished;
    t.last_version = None;
    e.store.put(t).unwrap();
    assert!(matches!(p.publish(&request("fresh")).unwrap_err(), Error::Conflict(m) if m.contains("did not upload")));
}

#[test]
fn private_reports_are_stored_encrypted_and_the_key_stays_out_of_the_account() {
    let e = env();
    let mut t = e.store.get("t1").unwrap();
    t.access = AccessLevel::Private;
    e.store.put(t).unwrap();
    let p = publisher(&e);
    let out = p.publish(&request("secret-marker")).unwrap();
    let key = out.new_access_key.expect("first private publish creates an access key");
    let stored = e.cloud.0.lock().unwrap().files["Sales-report.biforge"].0.clone();
    assert!(!String::from_utf8_lossy(&stored).contains("secret-marker"));
    assert!(!String::from_utf8_lossy(&stored).contains(&key));
    assert!(package::open(&stored, &OpenOptions::default()).is_err());
    assert_eq!(package::open(&stored, &OpenOptions { access_key: Some(key), ..Default::default() }).unwrap().manifest.version, 1);
    // revoking access = key rotation: the new version cannot be opened with the old key
    let old = p.access_key("t1").unwrap().unwrap();
    let rot = p.rotate_key(&request("secret-marker")).unwrap();
    let stored2 = e.cloud.0.lock().unwrap().files["Sales-report.biforge"].0.clone();
    assert!(package::open(&stored2, &OpenOptions { access_key: Some(old), ..Default::default() }).is_err());
    assert!(package::open(&stored2, &OpenOptions { access_key: rot.new_access_key, ..Default::default() }).is_ok());
}

#[test]
fn an_expired_token_is_refreshed_and_a_refused_refresh_asks_for_a_new_sign_in() {
    let e = env();
    tokens(&e.keys, "old-access", -10);
    // the refresh answer
    let http = Arc::new(FakeHttp::new(vec![FakeHttp::json(200, json!({"access_token": "access-1", "expires_in": 3600}))]));
    let ctx = Context { keys: e.keys.clone(), http: http.clone() };
    let adapter = StorageAdapter::new(ctx, oauth::GOOGLE, Box::new(e.cloud.clone()), &[], &[]).with_client_id("client-1");
    let reg = Registry::new(vec![Box::new(adapter)]);
    let p = Publisher { registry: &reg, keys: e.keys.as_ref(), store: &e.store };
    p.publish(&request("one")).unwrap();
    let reqs = http.requests();
    assert_eq!(reqs.len(), 1);
    let body = String::from_utf8_lossy(&reqs[0].body).to_string();
    assert!(reqs[0].url.starts_with("https://oauth2.googleapis.com/token") && body.contains("grant_type=refresh_token") && body.contains("refresh_token=refresh-1") && body.contains("client_id=client-1"), "{body}");
    assert!(!body.contains("client_secret") || std::env::var("BIFORGE_GOOGLE_CLIENT_SECRET").is_ok());
    let stored = oauth::load_tokens(e.keys.as_ref(), "google-drive").unwrap().unwrap();
    assert_eq!((stored.access.as_str(), stored.refresh.as_deref()), ("access-1", Some("refresh-1")), "the refresh token is kept when the provider sends no new one");

    tokens(&e.keys, "old-access", -10);
    let http = Arc::new(FakeHttp::new(vec![FakeHttp::json(400, json!({"error": "invalid_grant", "error_description": "Token has been revoked"}))]));
    let adapter = StorageAdapter::new(Context { keys: e.keys.clone(), http }, oauth::GOOGLE, Box::new(e.cloud.clone()), &[], &[]).with_client_id("client-1");
    let reg = Registry::new(vec![Box::new(adapter)]);
    let err = Publisher { registry: &reg, keys: e.keys.as_ref(), store: &e.store }.publish(&request("two")).unwrap_err().to_string();
    assert!(err.contains("Connect Google Drive again"), "{err}");
}

// ------------------------------------------------------------------------------------------------ sign-in (PKCE, loopback)

#[test]
fn the_sign_in_uses_pkce_checks_the_state_and_stores_the_tokens_only_in_the_key_store() {
    // the PKCE pair
    let p = oauth::Pkce::generate();
    assert_eq!(p.challenge, oauth::Pkce::challenge_of(&p.verifier));
    assert!(p.verifier.len() >= 43);
    // RFC 7636 appendix B
    assert_eq!(oauth::Pkce::challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");

    let url = oauth::authorize_url(&oauth::MICROSOFT, "client 1", "st", "ch");
    assert!(url.starts_with("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"));
    for needle in ["client_id=client%201", "response_type=code", "redirect_uri=http%3A%2F%2Flocalhost%3A53682%2Fcallback", "state=st", "code_challenge=ch", "code_challenge_method=S256", "scope=Files.ReadWrite.AppFolder%20offline_access%20User.Read"] {
        assert!(url.contains(needle), "{needle} in {url}");
    }
    assert!(oauth::authorize_url(&oauth::DROPBOX, "k", "s", "c").contains("token_access_type=offline"));
    assert!(!oauth::authorize_url(&oauth::DROPBOX, "k", "s", "c").contains("scope="));
    assert!(oauth::authorize_url(&oauth::GOOGLE, "k", "s", "c").contains("access_type=offline"));
    assert!(!url.contains("client_secret"), "no secret in the address");

    // the whole flow with a browser that answers on the loopback address
    let keys = Arc::new(MemoryKeyStore::default());
    let http = Arc::new(FakeHttp::new(vec![FakeHttp::json(200, json!({"access_token": "A", "refresh_token": "R", "expires_in": 3600}))]));
    let cloud = MemoryCloud::default();
    let adapter = StorageAdapter::new(Context { keys: keys.clone(), http: http.clone() }, oauth::DROPBOX, Box::new(cloud), &[], &[]).with_client_id("app-key");
    let pending = adapter.begin_connect().unwrap();
    assert!(pending.url.contains(&format!("state={}", pending.state)));
    let state = pending.state.clone();
    let browser = std::thread::spawn(move || {
        // a stray request is ignored, a wrong state is refused, the right one completes
        let get = |q: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", oauth::REDIRECT_PORT)).unwrap();
            write!(s, "GET {q} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        };
        assert!(get("/favicon.ico").starts_with("HTTP/1.1 404"));
        get(&format!("/callback?code=CODE&state={state}"))
    });
    let who = adapter.finish_connect(&pending, std::time::Duration::from_secs(10)).unwrap();
    assert!(browser.join().unwrap().contains("You are connected"));
    assert_eq!(who, "ann@example.com");
    let reqs = http.requests();
    let body = String::from_utf8_lossy(&reqs[0].body).to_string();
    assert!(reqs[0].url == "https://api.dropboxapi.com/oauth2/token" && body.contains("grant_type=authorization_code") && body.contains("code=CODE") && body.contains(&format!("code_verifier={}", pending.verifier)) && !body.contains("client_secret"), "{body}");
    let t = oauth::load_tokens(keys.as_ref(), "dropbox").unwrap().unwrap();
    assert_eq!((t.access.as_str(), t.refresh.as_deref()), ("A", Some("R")));
    drop(pending);

    // a wrong state value connects nothing
    let adapter = StorageAdapter::new(Context { keys: Arc::new(MemoryKeyStore::default()), http: Arc::new(FakeHttp::new(vec![])) }, oauth::DROPBOX, Box::new(MemoryCloud::default()), &[], &[]).with_client_id("app-key");
    let pending = adapter.begin_connect().unwrap();
    let browser = std::thread::spawn(|| {
        let mut s = TcpStream::connect(("127.0.0.1", oauth::REDIRECT_PORT)).unwrap();
        write!(s, "GET /callback?code=CODE&state=forged HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
    });
    let err = adapter.finish_connect(&pending, std::time::Duration::from_secs(10)).unwrap_err().to_string();
    browser.join().unwrap();
    assert!(err.contains("wrong state"), "{err}");
    assert!(!adapter.is_connected());
    // no client id: a plain message, nothing else
    let none = StorageAdapter::new(Context::offline(), oauth::MICROSOFT, Box::new(MemoryCloud::default()), &[], &[]);
    if std::env::var("BIFORGE_ONEDRIVE_CLIENT_ID").is_err() {
        let m = none.begin_connect().err().map(|e| e.to_string());
        assert!(m.is_none_or(|m| m.contains("client id")));
    }
}

// ------------------------------------------------------------------------------------------------ the providers' REST calls

fn provider_env(id: &'static str, answers: Vec<Response>) -> (Registry, Arc<FakeHttp>, Arc<MemoryKeyStore>, TargetStore, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let keys = Arc::new(MemoryKeyStore::default());
    oauth::store_tokens(keys.as_ref(), id, &Tokens { access: "tok".into(), refresh: None, expires_at: u64::MAX / 2 }).unwrap();
    let http = Arc::new(FakeHttp::new(answers));
    let ctx = Context { keys: keys.clone(), http: http.clone() };
    let adapter = match id {
        "google-drive" => StorageAdapter::google_drive(ctx),
        "onedrive" => StorageAdapter::onedrive(ctx),
        _ => StorageAdapter::dropbox(ctx),
    };
    let store = TargetStore::for_project(&tmp.path().join("proj"));
    let mut t = Target::new("t1", id, "Sales", AccessLevel::Public);
    t.settings.insert("rev".into(), "known".into());
    store.put(t).unwrap();
    (Registry::new(vec![Box::new(adapter)]), http, keys, store, tmp)
}

fn meta() -> PackageMeta {
    PackageMeta { package_id: "p1".into(), report_name: "Sales".into(), version: 2, access: AccessLevel::Public, sha256: "abc".into(), time: "2026-10-18T10:00:00Z".into() }
}

fn json_ok(v: serde_json::Value) -> Response {
    FakeHttp::json(200, v)
}

#[test]
fn google_drive_calls() {
    let file = json!({"id": "F1", "size": "5", "modifiedTime": "2026-10-18T10:00:00Z", "headRevisionId": "known", "webViewLink": "https://drive.google.com/file/d/F1/view"});
    // update path: folder lookup, file lookup (found), patch
    let (reg, http, keys, store, _t) = provider_env(
        "google-drive",
        vec![json_ok(json!({"files": [{"id": "FOLDER"}]})), json_ok(json!({"files": [file.clone()]})), json_ok(json!({"id": "F1", "size": "5", "modifiedTime": "t", "headRevisionId": "new", "webViewLink": "w"}))],
    );
    let t = store.get("t1").unwrap();
    let st = reg.get("google-drive").unwrap().update(&t, b"hello", &meta()).unwrap();
    assert_eq!(st.rev.as_deref(), Some("new"));
    let r = http.requests();
    assert!(r[0].url.starts_with("https://www.googleapis.com/drive/v3/files?q=") && r[0].url.contains("BIForge") && r[0].url.contains("trashed"));
    assert!(r[1].url.contains("%27FOLDER%27%20in%20parents") && r[1].url.contains("Sales.biforge"));
    assert_eq!((r[2].method.as_str(), r[2].url.as_str()), ("PATCH", "https://www.googleapis.com/upload/drive/v3/files/F1?uploadType=media&fields=id,size,modifiedTime,headRevisionId,webViewLink"));
    assert_eq!(r[2].body, b"hello");
    assert!(r.iter().all(|x| x.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer tok")));
    drop(keys);

    // create path: folder missing -> created; file missing -> multipart/related upload with the folder as parent
    let (reg, http, _k, store, _t) = provider_env("google-drive", vec![json_ok(json!({"files": []})), json_ok(json!({"id": "FOLDER"})), json_ok(json!({"files": []})), json_ok(json!({"id": "F2", "size": "5", "headRevisionId": "r1"}))]);
    let mut t = store.get("t1").unwrap();
    t.settings.remove("rev");
    let st = reg.get("google-drive").unwrap().publish(&t, b"hello", &meta()).unwrap();
    assert_eq!(st.rev.as_deref(), Some("r1"));
    let r = http.requests();
    assert_eq!((r[1].method.as_str(), r[1].url.as_str()), ("POST", "https://www.googleapis.com/drive/v3/files?fields=id"));
    assert!(String::from_utf8_lossy(&r[1].body).contains("application/vnd.google-apps.folder"));
    let ct = &r[3].headers.iter().find(|(k, _)| k == "Content-Type").unwrap().1;
    assert!(ct.starts_with("multipart/related; boundary="), "{ct}");
    let body = String::from_utf8_lossy(&r[3].body).to_string();
    assert!(body.contains("\"parents\":[\"FOLDER\"]") && body.contains("\"name\":\"Sales.biforge\"") && body.ends_with("--"), "{body}");

    // sharing, versions, delete, download, unauthorized
    let (reg, http, _k, store, _t) = provider_env(
        "google-drive",
        vec![
            json_ok(json!({"files": [{"id": "FOLDER"}]})),
            json_ok(json!({"files": [file.clone()]})),
            json_ok(json!({})),
            json_ok(json!({"webViewLink": "https://drive.google.com/file/d/F1/view?usp=sharing"})),
            json_ok(json!({"files": [file.clone()]})),
            json_ok(json!({})),
            json_ok(json!({"files": [file.clone()]})),
            json_ok(json!({"revisions": [{"id": "1", "modifiedTime": "2026-10-17T00:00:00Z", "size": "4"}, {"id": "2", "modifiedTime": "2026-10-18T00:00:00Z", "size": "5"}]})),
            json_ok(json!({"files": [file.clone()]})),
            Response { status: 204, body: vec![] },
        ],
    );
    let a = reg.get("google-drive").unwrap();
    let t = store.get("t1").unwrap();
    assert_eq!(a.share_link(&t).unwrap(), "https://drive.google.com/file/d/F1/view?usp=sharing");
    a.share_with(&t, "bob@example.com", true).unwrap();
    assert_eq!(a.versions(&t).unwrap().iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), ["2", "1"]);
    a.unpublish(&t).unwrap();
    let r = http.requests();
    assert!(String::from_utf8_lossy(&r[2].body).contains("\"type\":\"anyone\""));
    assert!(r[5].url.contains("/permissions?sendNotificationEmail=true") && String::from_utf8_lossy(&r[5].body).contains("\"role\":\"writer\"") && String::from_utf8_lossy(&r[5].body).contains("bob@example.com"));
    assert!(r[7].url.contains("/files/F1/revisions"));
    assert_eq!((r[9].method.as_str(), r[9].url.as_str()), ("DELETE", "https://www.googleapis.com/drive/v3/files/F1"));

    let (reg, _h, _k, store, _t) = provider_env("google-drive", vec![FakeHttp::json(401, json!({"error": {"message": "Invalid Credentials"}}))]);
    let err = reg.get("google-drive").unwrap().status(&store.get("t1").unwrap()).unwrap_err().to_string();
    assert!(err.contains("Connect Google Drive again"), "{err}");
}

#[test]
fn onedrive_calls() {
    let item = json!({"id": "I1", "eTag": "\"etag-1\"", "size": 5, "lastModifiedDateTime": "2026-10-18T10:00:00Z", "webUrl": "https://1drv.ms/x"});
    // update with a precondition: the stored eTag goes in If-Match
    let (reg, http, _k, store, _t) = provider_env("onedrive", vec![json_ok(item.clone()), json_ok(json!({"id": "I1", "eTag": "\"etag-2\"", "size": 5}))]);
    let mut t = store.get("t1").unwrap();
    t.settings.insert("rev".into(), "\"etag-1\"".into());
    let st = reg.get("onedrive").unwrap().update(&t, b"hello", &meta()).unwrap();
    assert_eq!(st.rev.as_deref(), Some("\"etag-2\""));
    let r = http.requests();
    assert_eq!(r[0].url, "https://graph.microsoft.com/v1.0/me/drive/special/approot:/Sales.biforge");
    assert_eq!((r[1].method.as_str(), r[1].url.as_str()), ("PUT", "https://graph.microsoft.com/v1.0/me/drive/special/approot:/Sales.biforge:/content"));
    assert!(r[1].headers.iter().any(|(k, v)| k == "If-Match" && v == "\"etag-1\""));

    // the file is gone -> created; a 412 means someone changed it
    let (reg, http, _k, store, _t) = provider_env("onedrive", vec![Response { status: 404, body: br#"{"error":{"code":"itemNotFound"}}"#.to_vec() }, json_ok(json!({"id": "I2", "eTag": "e1"}))]);
    let mut t = store.get("t1").unwrap();
    t.settings.remove("rev");
    reg.get("onedrive").unwrap().publish(&t, b"hello", &meta()).unwrap();
    assert!(http.requests()[1].headers.iter().all(|(k, _)| k != "If-Match"));
    let (reg, _h, _k, store, _t) = provider_env("onedrive", vec![json_ok(json!({"id": "I1", "eTag": "\"other\""})), Response { status: 412, body: b"{}".to_vec() }]);
    let mut t = store.get("t1").unwrap();
    t.settings.insert("overwrite".into(), "0".into());
    t.settings.insert("rev".into(), "\"other\"".into());
    assert!(matches!(reg.get("onedrive").unwrap().update(&t, b"hello", &meta()).unwrap_err(), Error::Conflict(_)));

    // a large file uses an upload session in chunks
    let big = vec![7u8; 4_500_000];
    let (reg, http, _k, store, _t) = provider_env(
        "onedrive",
        vec![Response { status: 404, body: b"{}".to_vec() }, json_ok(json!({"uploadUrl": "https://upload.example/session1"})), Response { status: 202, body: b"{}".to_vec() }, json_ok(json!({"id": "I3", "eTag": "e9"}))],
    );
    let mut t = store.get("t1").unwrap();
    t.settings.remove("rev");
    let st = reg.get("onedrive").unwrap().publish(&t, &big, &meta()).unwrap();
    assert_eq!(st.rev.as_deref(), Some("e9"));
    let r = http.requests();
    assert!(r[1].url.ends_with(":/createUploadSession"));
    assert_eq!(r[2].url, "https://upload.example/session1");
    assert!(r[2].headers.iter().any(|(k, v)| k == "Content-Range" && v == "bytes 0-3276799/4500000"));
    assert!(r[3].headers.iter().any(|(k, v)| k == "Content-Range" && v == "bytes 3276800-4499999/4500000"));
    assert!(r[2].headers.iter().all(|(k, _)| k != "Authorization"), "the session address carries its own authorization");

    // sharing, versions, delete
    let (reg, http, _k, store, _t) = provider_env(
        "onedrive",
        vec![
            json_ok(item.clone()),
            json_ok(json!({"link": {"webUrl": "https://1drv.ms/link"}})),
            json_ok(item.clone()),
            json_ok(json!({"value": []})),
            json_ok(item.clone()),
            json_ok(json!({"value": [{"id": "1.0", "lastModifiedDateTime": "2026-10-17T00:00:00Z", "size": 3}, {"id": "2.0", "lastModifiedDateTime": "2026-10-18T00:00:00Z", "size": 5}]})),
            json_ok(item.clone()),
            Response { status: 204, body: vec![] },
        ],
    );
    let a = reg.get("onedrive").unwrap();
    let t = store.get("t1").unwrap();
    assert_eq!(a.share_link(&t).unwrap(), "https://1drv.ms/link");
    a.share_with(&t, "bob@example.com", false).unwrap();
    assert_eq!(a.versions(&t).unwrap()[0].id, "2.0");
    a.unpublish(&t).unwrap();
    let r = http.requests();
    assert!(String::from_utf8_lossy(&r[1].body).contains("\"scope\":\"anonymous\""));
    assert!(r[3].url.ends_with("/items/I1/invite") && String::from_utf8_lossy(&r[3].body).contains("\"roles\":[\"read\"]"));
    assert_eq!((r[7].method.as_str(), r[7].url.as_str()), ("DELETE", "https://graph.microsoft.com/v1.0/me/drive/items/I1"));
}

#[test]
fn dropbox_calls() {
    let meta_json = json!({".tag": "file", "id": "id:AAA", "rev": "rev1", "size": 5, "server_modified": "2026-10-18T10:00:00Z"});
    // update: the stored rev makes the write conditional
    let (reg, http, _k, store, _t) = provider_env("dropbox", vec![json_ok(meta_json.clone()), json_ok(json!({".tag": "file", "id": "id:AAA", "rev": "rev2", "size": 5}))]);
    let mut t = store.get("t1").unwrap();
    t.settings.insert("rev".into(), "rev1".into());
    let st = reg.get("dropbox").unwrap().update(&t, b"hello", &meta()).unwrap();
    assert_eq!(st.rev.as_deref(), Some("rev2"));
    let r = http.requests();
    assert_eq!(r[0].url, "https://api.dropboxapi.com/2/files/get_metadata");
    assert_eq!(String::from_utf8_lossy(&r[0].body), "{\"path\":\"/Sales.biforge\"}");
    assert_eq!(r[1].url, "https://content.dropboxapi.com/2/files/upload");
    let arg = &r[1].headers.iter().find(|(k, _)| k == "Dropbox-API-Arg").unwrap().1;
    assert!(arg.contains("\"update\":\"rev1\"") && arg.contains("\"autorename\":false"), "{arg}");

    // not found -> add; a conflict answer -> Conflict
    let (reg, http, _k, store, _t) = provider_env("dropbox", vec![Response { status: 409, body: br#"{"error_summary":"path/not_found/.."}"#.to_vec() }, json_ok(json!({".tag": "file", "id": "id:BBB", "rev": "r1"}))]);
    let mut t = store.get("t1").unwrap();
    t.settings.remove("rev");
    reg.get("dropbox").unwrap().publish(&t, b"hello", &meta()).unwrap();
    assert!(http.requests()[1].headers.iter().any(|(k, v)| k == "Dropbox-API-Arg" && v.contains("\"add\"")));
    let (reg, _h, _k, store, _t) = provider_env("dropbox", vec![json_ok(meta_json.clone()), Response { status: 409, body: br#"{"error_summary":"path/conflict/file/.."}"#.to_vec() }]);
    let mut t = store.get("t1").unwrap();
    t.settings.insert("rev".into(), "rev1".into());
    assert!(matches!(reg.get("dropbox").unwrap().update(&t, b"hello", &meta()).unwrap_err(), Error::Conflict(_)));
    // more than 150 MB is refused before anything is sent
    let (reg, http, _k, store, _t) = provider_env("dropbox", vec![Response { status: 409, body: br#"{"error_summary":"path/not_found/"}"#.to_vec() }]);
    let mut t = store.get("t1").unwrap();
    t.settings.remove("rev");
    let huge = vec![0u8; 151 * 1024 * 1024];
    assert!(reg.get("dropbox").unwrap().publish(&t, &huge, &meta()).unwrap_err().to_string().contains("150 MB"));
    assert_eq!(http.requests().len(), 1);

    // sharing (a link that already exists is read back), versions, delete
    let (reg, http, _k, store, _t) = provider_env(
        "dropbox",
        vec![
            json_ok(meta_json.clone()),
            Response { status: 409, body: br#"{"error_summary":"shared_link_already_exists/.."}"#.to_vec() },
            json_ok(json!({"links": [{"url": "https://www.dropbox.com/s/abc/Sales.biforge?dl=0"}]})),
            json_ok(meta_json.clone()),
            json_ok(json!({})),
            json_ok(meta_json.clone()),
            json_ok(json!({"entries": [{"rev": "a", "server_modified": "2026-10-17T00:00:00Z", "size": 3}, {"rev": "b", "server_modified": "2026-10-18T00:00:00Z", "size": 5}]})),
            json_ok(meta_json.clone()),
            json_ok(json!({})),
        ],
    );
    let a = reg.get("dropbox").unwrap();
    let t = store.get("t1").unwrap();
    assert_eq!(a.share_link(&t).unwrap(), "https://www.dropbox.com/s/abc/Sales.biforge?dl=0");
    a.share_with(&t, "bob@example.com", true).unwrap();
    assert_eq!(a.versions(&t).unwrap()[0].id, "b");
    a.unpublish(&t).unwrap();
    let r = http.requests();
    assert!(r[4].url.ends_with("/sharing/add_file_member") && String::from_utf8_lossy(&r[4].body).contains("\"editor\""));
    assert!(r[8].url.ends_with("/files/delete_v2"));
}

#[test]
fn the_registry_lists_the_three_providers_as_built_with_their_limits() {
    let infos = Registry::standard().infos();
    for id in ["google-drive", "onedrive", "dropbox"] {
        let i = infos.iter().find(|i| i.id == id).unwrap();
        assert!(i.capabilities.implemented && i.capabilities.private_access && i.capabilities.version_history && i.capabilities.needs_account, "{id}");
        assert!(!i.capabilities.row_level_security && i.method == Method::PersonalStorage);
        assert!(i.limitations.iter().any(|l| l.contains("not a live dashboard")) && !i.free_tier.is_empty());
    }
    // the app-wide default (offline context) refuses to do anything without a connection
    let reg = Registry::standard();
    let tmp = tempfile::tempdir().unwrap();
    let store = TargetStore::for_project(tmp.path());
    store.put(Target::new("t", "dropbox", "x", AccessLevel::Public)).unwrap();
    let keys = MemoryKeyStore::default();
    let mut req = request("a");
    req.target_id = "t".into();
    let err = Publisher { registry: &reg, keys: &keys, store: &store }.publish(&req).unwrap_err().to_string();
    assert!(err.contains("not connected"), "{err}");
    assert!(keys.get("x").unwrap().is_none());
}
