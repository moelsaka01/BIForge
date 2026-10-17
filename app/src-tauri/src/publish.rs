//! Publish & Share and viewing mode on the Rust side. `PublishService` holds the logic (testable without a window);
//! the `#[tauri::command]` wrappers below are thin.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use biforge_engine::{CredentialStore, Engine, SystemCredentialStore};
use biforge_model::project::{sanitize_file_name, Project};
use biforge_publish::adapter::{AdapterInfo, Context, Issue, Registry, RemoteState};
use biforge_publish::http::{Http, ReqwestHttp};
use biforge_publish::subscribe::{self, Subscription, SubscriptionStore};
use biforge_publish::{cloudflare, github};
use biforge_publish::audit::{self, AuditEvent};
use biforge_publish::deeplink::{self, Link};
use biforge_publish::keys::KeyStore;
use biforge_publish::manifest::{Envelope, IncludedTable, Manifest, Permission};
use biforge_publish::package::{self, OpenOptions, PackageFile};
use biforge_publish::publisher::{PublishRequest, Publisher};
use biforge_publish::targets::{Target, TargetStore};
use serde::{Deserialize, Serialize};

use crate::data::DataService;

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The Windows Credential Manager behind the publishing engine's key store (same store as database passwords).
pub struct CredKeys(pub Arc<dyn CredentialStore>);

impl KeyStore for CredKeys {
    fn get(&self, name: &str) -> biforge_publish::Result<Option<String>> {
        // test seam, debug builds only: the real-window test supplies a GitHub token through the environment of the
        // process it starts instead of typing it anywhere. Release builds never read it.
        if cfg!(debug_assertions) && name == github::TOKEN_KEY {
            if let Ok(t) = std::env::var("BIFORGE_TEST_GITHUB_TOKEN") {
                if !t.trim().is_empty() {
                    return Ok(Some(t));
                }
            }
        }
        self.0.get(name).map_err(|e| biforge_publish::Error::KeyStore(e.to_string()))
    }
    fn set(&self, name: &str, secret: &str) -> biforge_publish::Result<()> {
        self.0.set(name, secret).map_err(|e| biforge_publish::Error::KeyStore(e.to_string()))
    }
    fn delete(&self, name: &str) -> biforge_publish::Result<()> {
        self.0.delete(name).map_err(|e| biforge_publish::Error::KeyStore(e.to_string()))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArgs {
    pub target_id: String,
    pub report_name: String,
    pub publisher_name: String,
    pub included: Vec<IncludedTable>,
    pub confirmed: Vec<IncludedTable>,
    #[serde(default)]
    pub permissions: Vec<Permission>,
    #[serde(default)]
    pub rotate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub state: RemoteState,
    pub new_access_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPackage {
    /// Folder the package was unpacked into (a cache folder, rebuilt on every open).
    pub root: String,
    pub pbip_path: String,
    pub manifest: Manifest,
    /// Parquet snapshots to load: (table name, file).
    pub data_files: Vec<(String, String)>,
}

pub struct PublishService {
    keys: Arc<CredKeys>,
    http: Arc<dyn Http>,
    cache_base: PathBuf,
}

impl PublishService {
    pub fn new(creds: Arc<dyn CredentialStore>, cache_base: PathBuf) -> Self {
        let http: Arc<dyn Http> = match ReqwestHttp::new() {
            Ok(h) => Arc::new(h),
            Err(_) => Arc::new(biforge_publish::http::FakeHttp::new(vec![])),
        };
        Self { keys: Arc::new(CredKeys(creds)), http, cache_base }
    }

    pub fn with_http(mut self, http: Arc<dyn Http>) -> Self {
        self.http = http;
        self
    }

    fn reg(&self) -> Registry {
        Registry::standard_with(Context { keys: self.keys.clone(), http: self.http.clone() })
    }

    /// `%LOCALAPPDATA%BIForge` (the folder above the viewing cache).
    fn app_dir(&self) -> PathBuf {
        self.cache_base.parent().map(Path::to_path_buf).unwrap_or_else(|| self.cache_base.clone())
    }

    fn subs(&self) -> SubscriptionStore {
        SubscriptionStore::new(self.app_dir().join("subscriptions.json"))
    }

    pub fn system() -> Self {
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("BIForge").join("viewing");
        Self::new(Arc::new(SystemCredentialStore), base)
    }

    pub fn adapters(&self) -> Vec<AdapterInfo> {
        self.reg().infos()
    }

    pub fn targets(&self, root: &str) -> Result<Vec<Target>, String> {
        TargetStore::for_project(Path::new(root)).list().map_err(msg)
    }

    pub fn put_target(&self, root: &str, target: Target) -> Result<(), String> {
        let reg = self.reg();
        reg.get(&target.adapter_id).map_err(msg)?;
        TargetStore::for_project(Path::new(root)).put(target).map_err(msg)
    }

    pub fn delete_target(&self, root: &str, id: &str) -> Result<(), String> {
        let store = TargetStore::for_project(Path::new(root));
        let reg = self.reg();
        Publisher { registry: &reg, keys: self.keys.as_ref(), store: &store }.delete_target(id).map_err(msg)
    }

    pub fn validate(&self, root: &str, id: &str) -> Result<Vec<Issue>, String> {
        let store = TargetStore::for_project(Path::new(root));
        let t = store.get(id).map_err(msg)?;
        let reg = self.reg();
        Ok(reg.get(&t.adapter_id).map_err(msg)?.validate(&t))
    }

    pub fn audit(&self, root: &str) -> Result<Vec<AuditEvent>, String> {
        audit::read_all(&TargetStore::for_project(Path::new(root))).map_err(msg)
    }

    pub fn unpublish(&self, root: &str, id: &str) -> Result<(), String> {
        let store = TargetStore::for_project(Path::new(root));
        let reg = self.reg();
        Publisher { registry: &reg, keys: self.keys.as_ref(), store: &store }.unpublish(id).map_err(msg)
    }

    pub fn share_link(&self, root: &str, id: &str) -> Result<String, String> {
        let store = TargetStore::for_project(Path::new(root));
        let reg = self.reg();
        Publisher { registry: &reg, keys: self.keys.as_ref(), store: &store }.share_link(id).map_err(msg)
    }

    pub fn access_key(&self, root: &str, id: &str) -> Result<Option<String>, String> {
        let store = TargetStore::for_project(Path::new(root));
        let reg = self.reg();
        Publisher { registry: &reg, keys: self.keys.as_ref(), store: &store }.access_key(id).map_err(msg)
    }

    pub fn status(&self, root: &str, id: &str) -> Result<Option<RemoteState>, String> {
        let store = TargetStore::for_project(Path::new(root));
        let reg = self.reg();
        Publisher { registry: &reg, keys: self.keys.as_ref(), store: &store }.status(id).map_err(msg)
    }

    /// Builds the files of a package: the (already pruned) project as it would be saved, and one Parquet snapshot
    /// per included table holding exactly the included columns.
    pub fn collect_files(&self, project: &Project, included: &mut [IncludedTable], engine: &Engine) -> Result<Vec<PackageFile>, String> {
        let tmp = tempfile::tempdir().map_err(msg)?;
        project.save(tmp.path()).map_err(msg)?;
        let mut files = Vec::new();
        read_tree(tmp.path(), tmp.path(), &mut files)?;
        for f in &mut files {
            f.path = format!("project/{}", f.path);
        }
        let mut used = std::collections::BTreeSet::new();
        for t in included.iter_mut() {
            let info = engine.table_info(&t.table).map_err(|e| format!("Table \"{}\": {e}", t.table))?;
            for c in &t.columns {
                if !info.columns.iter().any(|x| x.name == *c) {
                    return Err(format!("Column \"{c}\" does not exist in table \"{}\".", t.table));
                }
            }
            if t.columns.is_empty() {
                return Err(format!("Table \"{}\" has no columns selected.", t.table));
            }
            let mut base = sanitize_file_name(&t.table);
            while !used.insert(base.to_lowercase()) {
                base.push('_');
            }
            let rel = format!("data/{base}.parquet");
            let out = tmp.path().join(format!("{base}.parquet.out"));
            let cols = t.columns.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect::<Vec<_>>().join(", ");
            let sql = format!(
                "COPY (SELECT {cols} FROM \"{}\") TO '{}' (FORMAT PARQUET)",
                t.table.replace('"', "\"\""),
                out.display().to_string().replace('\\', "/").replace('\'', "''")
            );
            engine.connection().execute_batch(&sql).map_err(|e| format!("Could not export table \"{}\": {e}", t.table))?;
            files.push(PackageFile { path: rel.clone(), bytes: fs::read(&out).map_err(msg)? });
            t.data_file = rel;
        }
        Ok(files)
    }

    pub fn run(&self, root: &str, project: &Project, args: RunArgs, data: &DataService) -> Result<Outcome, String> {
        let mut included = args.included.clone();
        let files = data.with_store(|e| self.collect_files(project, &mut included, e))?;
        let store = TargetStore::for_project(Path::new(root));
        let reg = self.reg();
        let p = Publisher { registry: &reg, keys: self.keys.as_ref(), store: &store };
        let req = PublishRequest {
            target_id: args.target_id,
            report_name: args.report_name,
            publisher_name: args.publisher_name,
            included,
            confirmed: args.confirmed,
            permissions: args.permissions,
            files,
        };
        let out = if args.rotate { p.rotate_key(&req) } else { p.publish(&req) }.map_err(msg)?;
        Ok(Outcome { state: out.state, new_access_key: out.new_access_key })
    }

    pub fn peek(&self, path: &str) -> Result<Envelope, String> {
        package::peek(&fs::read(path).map_err(|e| format!("Could not read the file: {e}"))?, None).map_err(msg)
    }

    /// Verifies and unpacks a package for the viewing mode. Nothing is written until the signature, the hashes and
    /// the key have all been checked.
    pub fn open_package(&self, path: &str, access_key: Option<String>, expected_publisher: Option<String>) -> Result<OpenedPackage, String> {
        let bytes = fs::read(path).map_err(|e| format!("Could not read the file: {e}"))?;
        let pkg = package::open(&bytes, &OpenOptions { access_key, expected_publisher }).map_err(msg)?;
        let root = self.cache_base.join(&pkg.manifest.package_id);
        if root.exists() {
            fs::remove_dir_all(&root).map_err(|e| format!("Could not clear the previous copy: {e}"))?;
        }
        fs::create_dir_all(&root).map_err(msg)?;
        let mut pbip = None;
        for (name, bytes) in &pkg.files {
            // paths were checked by package::open (check_path); the join stays inside `root`
            let rel = name.strip_prefix("project/").unwrap_or(name);
            let dest = root.join(rel);
            if let Some(dir) = dest.parent() {
                fs::create_dir_all(dir).map_err(msg)?;
            }
            fs::write(&dest, bytes).map_err(msg)?;
            if name.starts_with("project/") && !rel.contains('/') && rel.ends_with(".pbip") {
                pbip = Some(dest);
            }
        }
        let pbip = pbip.ok_or("The package has no .pbip project file.")?;
        let data_files = pkg
            .manifest
            .included
            .iter()
            .map(|t| (t.table.clone(), root.join(&t.data_file).display().to_string()))
            .collect();
        let _ = audit_open(&self.cache_base, &pkg.manifest);
        Ok(OpenedPackage { root: root.display().to_string(), pbip_path: pbip.display().to_string(), manifest: pkg.manifest, data_files })
    }

    pub fn parse_link(&self, link: &str) -> Result<LinkDto, String> {
        Ok(match deeplink::parse(link).map_err(msg)? {
            Link::File { path } => LinkDto { src: "file".into(), path: Some(path), url: None, supported: true },
            Link::Url { url } => LinkDto { src: "url".into(), path: None, url: Some(url), supported: true },
            Link::Unsupported { src } => LinkDto { src, path: None, url: None, supported: false },
        })
    }

    // ---- accounts (tokens live in the credential store only) ----

    fn token_key(provider: &str) -> Result<&'static str, String> {
        match provider {
            "github" => Ok(github::TOKEN_KEY),
            "cloudflare" => Ok(cloudflare::TOKEN_KEY),
            other => Err(format!("Unknown provider \"{other}\".")),
        }
    }

    /// Whether a token is stored (never the token itself).
    pub fn account_connected(&self, provider: &str) -> Result<bool, String> {
        Ok(self.keys.get(Self::token_key(provider)?).map_err(msg)?.is_some())
    }

    /// Stores the token and checks it with the provider; a token the provider rejects is removed again.
    pub fn account_connect(&self, provider: &str, token: &str, account_id: Option<String>) -> Result<String, String> {
        let key = Self::token_key(provider)?;
        let token = token.trim();
        if token.is_empty() {
            return Err("Paste the token first.".into());
        }
        let previous = self.keys.get(key).map_err(msg)?;
        self.keys.set(key, token).map_err(msg)?;
        let checked = match provider {
            "github" => biforge_publish::github::GitHubAdapter::new(Context { keys: self.keys.clone(), http: self.http.clone() }).login().map_err(msg),
            _ => {
                let mut t = Target::new("check", cloudflare::ID, "check", biforge_publish::manifest::AccessLevel::Public);
                t.settings.insert("accountId".into(), account_id.unwrap_or_default());
                t.settings.insert("name".into(), "check".into());
                self.reg().get(cloudflare::ID).map_err(msg).and_then(|a| a.authenticate(&mut t).map_err(msg)).map(|_| t.account.unwrap_or_default())
            }
        };
        match checked {
            Ok(name) => Ok(name),
            Err(e) => {
                match previous {
                    Some(p) => {
                        let _ = self.keys.set(key, &p);
                    }
                    None => {
                        let _ = self.keys.delete(key);
                    }
                }
                Err(e)
            }
        }
    }

    pub fn account_disconnect(&self, provider: &str) -> Result<(), String> {
        self.keys.delete(Self::token_key(provider)?).map_err(msg)
    }

    /// Checks the destination's account and records the account name on the target.
    pub fn authenticate(&self, root: &str, id: &str) -> Result<Target, String> {
        let store = TargetStore::for_project(Path::new(root));
        let mut t = store.get(id).map_err(msg)?;
        self.reg().get(&t.adapter_id).map_err(msg)?.authenticate(&mut t).map_err(msg)?;
        store.put(t.clone()).map_err(msg)?;
        Ok(t)
    }

    // ---- subscriptions (viewer side of static hosting) ----

    fn download(&self, feed_url: &str, pinned: Option<&str>) -> Result<Linked, String> {
        let feed = subscribe::fetch_feed(self.http.as_ref(), feed_url).map_err(msg)?;
        let bytes = subscribe::fetch_package(self.http.as_ref(), feed_url, &feed).map_err(msg)?;
        let env = package::peek(&bytes, pinned).map_err(msg)?;
        if env.package_id != feed.package_id || env.version != feed.version {
            return Err("The downloaded package does not match its feed.".into());
        }
        let dir = self.app_dir().join("downloads");
        fs::create_dir_all(&dir).map_err(msg)?;
        let path = dir.join(format!("{}.biforge", feed.package_id));
        fs::write(&path, &bytes).map_err(msg)?;
        let existing_pin = self.subs().list().map_err(msg)?.into_iter().find(|s| s.package_id == feed.package_id).map(|s| s.pinned_publisher);
        Ok(Linked { path: path.display().to_string(), envelope: env, existing_pin })
    }

    /// Downloads the package a feed points at into the download folder and reads its envelope.
    pub fn linked_fetch(&self, feed_url: &str) -> Result<Linked, String> {
        self.download(feed_url, None)
    }

    /// Remembers the report: the publisher key it was signed with is pinned (trust on first use).
    pub fn subscription_accept(&self, feed_url: &str, path: &str, report_name: &str, access_key: Option<String>) -> Result<Subscription, String> {
        let env = package::peek(&fs::read(path).map_err(msg)?, None).map_err(msg)?;
        if let Some(k) = access_key.filter(|k| !k.trim().is_empty()) {
            self.keys.set(&viewer_key_name(&env.package_id), k.trim()).map_err(msg)?;
        }
        let sub = Subscription {
            package_id: env.package_id,
            feed_url: feed_url.into(),
            report_name: report_name.into(),
            pinned_publisher: env.publisher_public_key,
            have_version: env.version,
            last_check: Some(biforge_publish::time::now_rfc3339()),
            last_error: None,
            package_path: path.into(),
        };
        self.subs().put(sub.clone()).map_err(msg)?;
        Ok(sub)
    }

    pub fn subscriptions(&self) -> Result<Vec<Subscription>, String> {
        self.subs().list().map_err(msg)
    }

    pub fn subscription_remove(&self, package_id: &str) -> Result<(), String> {
        let _ = self.keys.delete(&viewer_key_name(package_id));
        self.subs().remove(package_id).map_err(msg)
    }

    /// Looks for a newer version. When there is one it is downloaded and checked against the pinned publisher;
    /// the caller opens it. A package signed by someone else is refused and the subscription records why.
    pub fn subscription_check(&self, package_id: &str) -> Result<Option<Linked>, String> {
        let store = self.subs();
        let mut sub = store.list().map_err(msg)?.into_iter().find(|s| s.package_id == package_id).ok_or("This report is not subscribed.")?;
        sub.last_check = Some(biforge_publish::time::now_rfc3339());
        let outcome = (|| -> Result<Option<Linked>, String> {
            if subscribe::newer(self.http.as_ref(), &sub.feed_url, sub.have_version).map_err(msg)?.is_none() {
                return Ok(None);
            }
            Ok(Some(self.download(&sub.feed_url, Some(&sub.pinned_publisher))?))
        })();
        sub.last_error = outcome.as_ref().err().cloned();
        let _ = store.put(sub);
        outcome
    }

    /// Records that the viewer now has `version` of the report.
    pub fn subscription_opened(&self, package_id: &str, version: u64, path: &str) -> Result<(), String> {
        let store = self.subs();
        if let Some(mut s) = store.list().map_err(msg)?.into_iter().find(|s| s.package_id == package_id) {
            s.have_version = version;
            s.package_path = path.into();
            s.last_error = None;
            store.put(s).map_err(msg)?;
        }
        Ok(())
    }

    pub fn viewer_key(&self, package_id: &str) -> Result<Option<String>, String> {
        self.keys.get(&viewer_key_name(package_id)).map_err(msg)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    pub path: String,
    pub envelope: Envelope,
    /// The publisher key pinned by an earlier subscription to the same report.
    pub existing_pin: Option<String>,
}

fn viewer_key_name(package_id: &str) -> String {
    format!("biforge.viewer.access.{package_id}")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDto {
    pub src: String,
    pub path: Option<String>,
    pub url: Option<String>,
    pub supported: bool,
}

/// Viewing opens are recorded next to the cache, not in any project (a viewer has no project).
fn audit_open(cache_base: &Path, m: &Manifest) -> std::io::Result<()> {
    use std::io::Write;
    fs::create_dir_all(cache_base)?;
    let ev = AuditEvent {
        time: biforge_publish::time::now_rfc3339(),
        event: "open-package".into(),
        target_id: String::new(),
        adapter_id: String::new(),
        detail: format!("{} v{} by {} ({})", m.report_name, m.version, m.publisher.name, m.publisher.key_id),
    };
    let mut f = fs::OpenOptions::new().create(true).append(true).open(cache_base.join("opened.jsonl"))?;
    writeln!(f, "{}", serde_json::to_string(&ev).unwrap_or_default())
}

fn read_tree(base: &Path, dir: &Path, out: &mut Vec<PackageFile>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(msg)? {
        let p = entry.map_err(msg)?.path();
        if p.is_dir() {
            if p.file_name().map(|n| n == ".biforge").unwrap_or(false) {
                continue;
            }
            read_tree(base, &p, out)?;
        } else {
            let rel = p.strip_prefix(base).map_err(msg)?.to_string_lossy().replace('\\', "/");
            out.push(PackageFile { path: rel, bytes: fs::read(&p).map_err(msg)? });
        }
    }
    Ok(())
}

// ---- Tauri commands ----

#[tauri::command]
pub fn publish_adapters(s: tauri::State<PublishService>) -> Vec<AdapterInfo> {
    s.adapters()
}
#[tauri::command]
pub fn publish_targets(s: tauri::State<PublishService>, root: String) -> Result<Vec<Target>, String> {
    s.targets(&root)
}
#[tauri::command]
pub fn publish_put_target(s: tauri::State<PublishService>, root: String, target: Target) -> Result<(), String> {
    s.put_target(&root, target)
}
#[tauri::command]
pub fn publish_delete_target(s: tauri::State<PublishService>, root: String, target_id: String) -> Result<(), String> {
    s.delete_target(&root, &target_id)
}
#[tauri::command]
pub fn publish_validate(s: tauri::State<PublishService>, root: String, target_id: String) -> Result<Vec<Issue>, String> {
    s.validate(&root, &target_id)
}
#[tauri::command]
pub fn publish_run(s: tauri::State<PublishService>, data: tauri::State<DataService>, root: String, project: Project, args: RunArgs) -> Result<Outcome, String> {
    s.run(&root, &project, args, &data)
}
#[tauri::command]
pub fn publish_unpublish(s: tauri::State<PublishService>, root: String, target_id: String) -> Result<(), String> {
    s.unpublish(&root, &target_id)
}
#[tauri::command]
pub fn publish_share_link(s: tauri::State<PublishService>, root: String, target_id: String) -> Result<String, String> {
    s.share_link(&root, &target_id)
}
#[tauri::command]
pub fn publish_access_key(s: tauri::State<PublishService>, root: String, target_id: String) -> Result<Option<String>, String> {
    s.access_key(&root, &target_id)
}
#[tauri::command]
pub fn publish_status(s: tauri::State<PublishService>, root: String, target_id: String) -> Result<Option<RemoteState>, String> {
    s.status(&root, &target_id)
}
#[tauri::command]
pub fn publish_audit(s: tauri::State<PublishService>, root: String) -> Result<Vec<AuditEvent>, String> {
    s.audit(&root)
}
#[tauri::command]
pub fn package_peek(s: tauri::State<PublishService>, path: String) -> Result<Envelope, String> {
    s.peek(&path)
}
#[tauri::command]
pub fn package_open(s: tauri::State<PublishService>, path: String, access_key: Option<String>, expected_publisher: Option<String>) -> Result<OpenedPackage, String> {
    s.open_package(&path, access_key, expected_publisher)
}
#[tauri::command]
pub fn deep_link_parse(s: tauri::State<PublishService>, link: String) -> Result<LinkDto, String> {
    s.parse_link(&link)
}
#[tauri::command]
pub fn account_connected(s: tauri::State<PublishService>, provider: String) -> Result<bool, String> {
    s.account_connected(&provider)
}
#[tauri::command]
pub fn account_connect(s: tauri::State<PublishService>, provider: String, token: String, account_id: Option<String>) -> Result<String, String> {
    s.account_connect(&provider, &token, account_id)
}
#[tauri::command]
pub fn account_disconnect(s: tauri::State<PublishService>, provider: String) -> Result<(), String> {
    s.account_disconnect(&provider)
}
#[tauri::command]
pub fn publish_authenticate(s: tauri::State<PublishService>, root: String, target_id: String) -> Result<Target, String> {
    s.authenticate(&root, &target_id)
}
#[tauri::command]
pub fn linked_fetch(s: tauri::State<PublishService>, feed_url: String) -> Result<Linked, String> {
    s.linked_fetch(&feed_url)
}
#[tauri::command]
pub fn subscription_accept(s: tauri::State<PublishService>, feed_url: String, path: String, report_name: String, access_key: Option<String>) -> Result<Subscription, String> {
    s.subscription_accept(&feed_url, &path, &report_name, access_key)
}
#[tauri::command]
pub fn subscriptions(s: tauri::State<PublishService>) -> Result<Vec<Subscription>, String> {
    s.subscriptions()
}
#[tauri::command]
pub fn subscription_remove(s: tauri::State<PublishService>, package_id: String) -> Result<(), String> {
    s.subscription_remove(&package_id)
}
#[tauri::command]
pub fn subscription_check(s: tauri::State<PublishService>, package_id: String) -> Result<Option<Linked>, String> {
    s.subscription_check(&package_id)
}
#[tauri::command]
pub fn subscription_opened(s: tauri::State<PublishService>, package_id: String, version: u64, path: String) -> Result<(), String> {
    s.subscription_opened(&package_id, version, &path)
}
#[tauri::command]
pub fn viewer_key(s: tauri::State<PublishService>, package_id: String) -> Result<Option<String>, String> {
    s.viewer_key(&package_id)
}
/// A biforge:// link or a .biforge file given on the command line when the app was started.
#[tauri::command]
pub fn startup_open() -> Option<String> {
    std::env::args().skip(1).find(|a| a.starts_with("biforge://") || a.to_ascii_lowercase().ends_with(".biforge"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use biforge_engine::Engine;
    use biforge_publish::keys::MemoryKeyStore;
    use biforge_publish::local;

    struct Mem(MemoryKeyStore);
    impl biforge_engine::CredentialStore for Mem {
        fn get(&self, k: &str) -> biforge_engine::Result<Option<String>> {
            Ok(self.0.get(k).unwrap())
        }
        fn set(&self, k: &str, s: &str) -> biforge_engine::Result<()> {
            Ok(self.0.set(k, s).unwrap())
        }
        fn delete(&self, k: &str) -> biforge_engine::Result<()> {
            Ok(self.0.delete(k).unwrap())
        }
    }

    #[test]
    fn publish_then_open_in_a_fresh_engine_gives_the_same_rows_and_only_the_chosen_columns() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        let share = tmp.path().join("share");
        fs::create_dir_all(&root).unwrap();
        let svc = PublishService::new(Arc::new(Mem(MemoryKeyStore::default())), tmp.path().join("cache"));

        let engine = Engine::in_memory().unwrap();
        engine.import_select("Sales", "SELECT i AS \"Id\", i * 10 AS \"Amount\", 'secret-' || i AS \"Note\" FROM range(1, 51) t(i)").unwrap();
        let project = Project::new("Demo");

        let mut t = Target::new("t1", local::ID, "share", biforge_publish::manifest::AccessLevel::Private);
        t.settings.insert("folder".into(), share.display().to_string());
        svc.put_target(root.to_str().unwrap(), t).unwrap();

        let mut included = vec![IncludedTable { table: "Sales".into(), columns: vec!["Id".into(), "Amount".into()], data_file: String::new() }];
        let files = svc.collect_files(&project, &mut included, &engine).unwrap();
        assert_eq!(included[0].data_file, "data/Sales.parquet");
        assert!(files.iter().any(|f| f.path == "project/Demo.pbip"));
        assert!(files.iter().all(|f| !f.path.contains(".biforge")));

        let store = TargetStore::for_project(&root);
        let reg = svc.reg();
        let p = Publisher { registry: &reg, keys: svc.keys.as_ref(), store: &store };
        let out = p
            .publish(&PublishRequest {
                target_id: "t1".into(),
                report_name: "Demo".into(),
                publisher_name: "Ann".into(),
                included: included.clone(),
                confirmed: included.clone(),
                permissions: vec![],
                files,
            })
            .unwrap();
        let key = out.new_access_key.unwrap();

        // the viewer: no key -> refused; right key -> unpacked
        let pkg_path = std::fs::read_dir(&share).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.extension().map(|x| x == "biforge").unwrap_or(false)).unwrap();
        let pkg = pkg_path.to_str().unwrap();
        assert!(svc.open_package(pkg, None, None).unwrap_err().contains("access key"));
        let opened = svc.open_package(pkg, Some(key), None).unwrap();
        assert!(Path::new(&opened.pbip_path).exists());
        assert_eq!(opened.manifest.included[0].columns, vec!["Id", "Amount"]);

        let viewer = Engine::in_memory().unwrap();
        let (table, file) = &opened.data_files[0];
        viewer.import(table, &biforge_engine::SourceSpec::Parquet { path: file.clone() }, &SystemCredentialStore).unwrap();
        let info = viewer.table_info("Sales").unwrap();
        assert_eq!(info.row_count, 50);
        assert_eq!(info.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Id", "Amount"], "the column that was not chosen never left the machine");
        let raw = std::fs::read(file).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("secret-"));
    }

    #[test]
    fn unknown_columns_and_empty_selections_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = PublishService::new(Arc::new(Mem(MemoryKeyStore::default())), tmp.path().join("c"));
        let engine = Engine::in_memory().unwrap();
        engine.import_select("T", "SELECT 1 AS a").unwrap();
        let project = Project::new("D");
        let mut bad = vec![IncludedTable { table: "T".into(), columns: vec!["zzz".into()], data_file: String::new() }];
        assert!(svc.collect_files(&project, &mut bad, &engine).unwrap_err().contains("does not exist"));
        let mut empty = vec![IncludedTable { table: "T".into(), columns: vec![], data_file: String::new() }];
        assert!(svc.collect_files(&project, &mut empty, &engine).is_err());
    }

    #[test]
    fn deep_links_are_parsed_by_the_rust_parser() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = PublishService::new(Arc::new(Mem(MemoryKeyStore::default())), tmp.path().to_path_buf());
        let l = svc.parse_link(&biforge_publish::deeplink::build_file(r"C:\x y\a.biforge")).unwrap();
        assert!(l.supported && l.path.as_deref() == Some(r"C:\x y\a.biforge"));
        assert!(!svc.parse_link("biforge://open?src=p2p&ticket=1").unwrap().supported);
        assert!(svc.parse_link("https://example.com").is_err());
    }
    fn pkg(id: &str, version: u64, signer: &biforge_publish::keys::Identity) -> (Vec<u8>, biforge_publish::feed::Feed) {
        use biforge_publish::manifest::AccessLevel;
        let bytes = package::build(
            package::BuildInput {
                package_id: id.into(),
                version,
                report_name: "Demo".into(),
                publisher_name: "Ann".into(),
                access: AccessLevel::Public,
                included: vec![],
                permissions: vec![],
                created_at: "2026-10-17T00:00:00Z".into(),
                files: vec![PackageFile { path: "project/Demo.pbip".into(), bytes: b"{}".to_vec() }],
                recipients: vec![],
            },
            signer,
        )
        .unwrap();
        let feed = biforge_publish::feed::Feed { package_id: id.into(), version, file: format!("{id}.biforge"), sha256: biforge_publish::keys::sha256_hex(&bytes), access: AccessLevel::Public, updated_at: "t".into() };
        (bytes, feed)
    }

    #[test]
    fn a_feed_link_is_downloaded_pinned_and_later_versions_must_come_from_the_same_publisher() {
        use biforge_publish::http::{FakeHttp, Response};
        let tmp = tempfile::tempdir().unwrap();
        let signer = biforge_publish::keys::Identity::generate();
        let id = "0123456789abcdef0123456789abcdef";
        let url = "https://ann.github.io/site/feed.json";
        let (b1, f1) = pkg(id, 1, &signer);
        let (b2, f2) = pkg(id, 2, &signer);
        let mallory = biforge_publish::keys::Identity::generate();
        let (b3, f3) = pkg(id, 3, &mallory);
        let j = |f: &biforge_publish::feed::Feed| Response { status: 200, body: serde_json::to_vec(f).unwrap() };
        let ok = |b: Vec<u8>| Response { status: 200, body: b };
        let http = Arc::new(FakeHttp::new(vec![
            j(&f1), ok(b1.clone()), // first open
            j(&f1),                 // check: nothing newer
            j(&f2), j(&f2), ok(b2), // check: version 2
            j(&f3), j(&f3), ok(b3), // check: version 3 from another publisher
        ]));
        let svc = PublishService::new(Arc::new(Mem(MemoryKeyStore::default())), tmp.path().join("viewing")).with_http(http);

        let linked = svc.linked_fetch(url).unwrap();
        assert!(linked.existing_pin.is_none());
        assert_eq!(linked.envelope.version, 1);
        let sub = svc.subscription_accept(url, &linked.path, "Demo", None).unwrap();
        assert_eq!(sub.pinned_publisher, signer.public_key());
        assert!(svc.subscription_check(id).unwrap().is_none());
        let up = svc.subscription_check(id).unwrap().expect("version 2 is newer");
        assert_eq!(up.envelope.version, 2);
        svc.subscription_opened(id, 2, &up.path).unwrap();
        assert_eq!(svc.subscriptions().unwrap()[0].have_version, 2);
        let err = svc.subscription_check(id).unwrap_err();
        assert!(err.contains("different publisher"), "{err}");
        assert!(svc.subscriptions().unwrap()[0].last_error.is_some(), "the refusal is recorded");
        assert_eq!(svc.subscriptions().unwrap()[0].have_version, 2, "the forged version is not taken");
    }

    #[test]
    fn tokens_are_checked_stored_and_removed_when_the_provider_rejects_them() {
        use biforge_publish::http::{FakeHttp, Response};
        let tmp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::new(vec![Response { status: 401, body: b"{\"message\":\"Bad credentials\"}".to_vec() }, Response { status: 200, body: b"{\"login\":\"ann\"}".to_vec() }]));
        let svc = PublishService::new(Arc::new(Mem(MemoryKeyStore::default())), tmp.path().join("viewing")).with_http(http);
        assert!(!svc.account_connected("github").unwrap());
        assert!(svc.account_connect("github", "bad", None).is_err());
        assert!(!svc.account_connected("github").unwrap(), "a rejected token is not kept");
        assert_eq!(svc.account_connect("github", "good", None).unwrap(), "ann");
        assert!(svc.account_connected("github").unwrap());
        svc.account_disconnect("github").unwrap();
        assert!(!svc.account_connected("github").unwrap());
        assert!(svc.account_connect("nope", "x", None).is_err());
    }

}
