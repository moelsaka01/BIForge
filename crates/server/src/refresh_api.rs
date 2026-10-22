//! Scheduled refresh on the server ("runs on: BIForge server").
//!
//! The publisher sends a *refresh bundle* (the same signed package format GitHub refresh uses: the pruned project, a
//! small config and copies of the source files). On a schedule, or when asked, the server reloads the sources into an
//! engine, exports the published tables and, when the data changed, keeps the result as a *data overlay* that the
//! report's queries use from then on. The published package itself is never changed: it stays exactly what the
//! publisher signed. A new version uploaded by the publisher replaces the overlay.
//!
//! Sources are read from the bundle's copies, except that a file with the same name in the report's source folder
//! (`<data>/workspaces/<ws>/reports/<report>/refresh/sources/`) wins: that is where a nightly export is dropped, or
//! where an editor uploads a new file from the app. Files on the publisher's PC are not reachable from the server.
//! Every attempt is written to the report's refresh history with where it ran; one run at a time per report.

use super::*;
use biforge_publish::refresh::{RefreshConfig, CONFIG_PATH};
use biforge_publish::schedule::{run_job, JobResult, JobStore, Plan, RunRecord, RunsOn, Trigger};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub plan: Plan,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: false, plan: Plan::default() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayTable {
    table: String,
    file: String,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Overlay {
    refreshed_at: String,
    tables: Vec<OverlayTable>,
}

fn safe_name(name: &str) -> Option<String> {
    let n: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ')).collect();
    let n = n.trim().to_string();
    if n.is_empty() || n.starts_with('.') || n != name.trim() || n.len() > 120 {
        None
    } else {
        Some(n)
    }
}

impl App {
    pub(crate) fn refresh_dir(&self, wid: &str, rid: &str) -> PathBuf {
        self.report_dir(wid, rid).join("refresh")
    }

    fn refresh_settings(&self, wid: &str, rid: &str) -> Settings {
        fs::read(self.refresh_dir(wid, rid).join("settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn save_refresh_settings(&self, wid: &str, rid: &str, s: &Settings) -> ApiResult<()> {
        let dir = self.refresh_dir(wid, rid);
        fs::create_dir_all(&dir).map_err(internal)?;
        fs::write(dir.join("settings.json"), serde_json::to_vec_pretty(s).map_err(internal)?).map_err(internal)
    }

    fn overlay_of(&self, wid: &str, rid: &str) -> Option<Overlay> {
        fs::read(self.refresh_dir(wid, rid).join("overlay").join("overlay.json")).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    /// The refreshed data replaces the tables of the published package in the engine a report is queried with.
    pub(crate) fn apply_overlay(&self, wid: &str, rid: &str, engine: &biforge_engine::Engine) {
        let Some(o) = self.overlay_of(wid, rid) else { return };
        let creds = MemoryCredentialStore::default();
        for t in &o.tables {
            let path = self.refresh_dir(wid, rid).join("overlay").join(&t.file);
            let _ = engine.import(&t.table, &SourceSpec::Parquet { path: path.to_string_lossy().into_owned() }, &creds);
        }
    }

    pub(crate) fn drop_overlay(&self, wid: &str, rid: &str) {
        let _ = fs::remove_dir_all(self.refresh_dir(wid, rid).join("overlay"));
    }

    /// One attempt: reload the sources, export the published tables, keep them when they differ from what is served.
    fn refresh_attempt(&self, wid: &str, rid: &str) -> Result<JobResult, String> {
        let dir = self.refresh_dir(wid, rid);
        let meta = self.read_meta(wid, rid).map_err(|e| e.1)?;
        let bundle_bytes = fs::read(dir.join("bundle.bin")).map_err(|_| "This report has no refresh bundle. Turn on scheduled refresh from the publisher's Publish & Share.".to_string())?;
        let bundle = package::open(&bundle_bytes, &OpenOptions { access_key: None, expected_publisher: Some(meta.publisher_key.clone()) }).map_err(|e| format!("The refresh bundle cannot be opened: {e}"))?;
        let config: RefreshConfig = serde_json::from_slice(bundle.files.get(CONFIG_PATH).ok_or("The refresh bundle has no data/refresh.json")?).map_err(|e| format!("data/refresh.json: {e}"))?;

        // sources: the bundle's copies, replaced by same-named files in the server's source folder
        let work = tempfile::tempdir().map_err(|e| e.to_string())?;
        for (name, bytes) in bundle.files.iter().filter(|(n, _)| n.starts_with("data/src/")) {
            let dest = work.path().join(name);
            fs::create_dir_all(dest.parent().expect("a file has a parent")).map_err(|e| e.to_string())?;
            fs::write(&dest, bytes).map_err(|e| e.to_string())?;
            if let Some(base) = Path::new(name).file_name() {
                let over = dir.join("sources").join(base);
                if over.is_file() {
                    fs::copy(&over, &dest).map_err(|e| format!("Could not read {}: {e}", over.display()))?;
                }
            }
        }
        let engine = biforge_engine::Engine::in_memory().map_err(|e| e.to_string())?;
        let creds = MemoryCredentialStore::default();
        for s in &config.sources {
            let mut v = s.spec.clone();
            // The bundle is signed by an editor of the workspace, not by the server's owner: it may name only the files
            // it carries, and no network or database source (the server would read other files or connect for it).
            let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            if !["csv", "excel", "json", "parquet", "sqlite"].contains(&kind) {
                return Err(format!("The source of table \"{}\" ({kind}) is not a file; a server refreshes only files.", s.table));
            }
            let p = v.get("path").and_then(|p| p.as_str()).map(str::to_string).ok_or_else(|| format!("The source of table \"{}\" has no file.", s.table))?;
            if !p.starts_with("data/src/") || biforge_publish::package::check_path(&p).is_err() {
                return Err(format!("The source of table \"{}\" names a file outside the bundle.", s.table));
            }
            v["path"] = serde_json::Value::String(work.path().join(&p).display().to_string());
            let spec: SourceSpec = serde_json::from_value(v).map_err(|e| format!("A source in the bundle is not valid: {e}"))?;
            engine.import(&s.table, &spec, &creds).map_err(|e| format!("Could not reload table \"{}\" from {}: {e}", s.table, s.original))?;
        }

        // export what the report publishes
        let mut exported: Vec<(OverlayTable, Vec<u8>)> = Vec::new();
        let mut used = std::collections::BTreeSet::new();
        for t in &config.included {
            let mut base = biforge_model::project::sanitize_file_name(&t.table);
            while !used.insert(base.to_lowercase()) {
                base.push('_');
            }
            let out = work.path().join(format!("{base}.parquet.out"));
            engine.export_parquet(&t.table, &t.columns, &out).map_err(|e| format!("Could not export table \"{}\": {e}", t.table))?;
            let bytes = fs::read(&out).map_err(|e| e.to_string())?;
            exported.push((OverlayTable { table: t.table.clone(), file: format!("{base}.parquet"), sha256: hex(&Sha256::digest(&bytes)) }, bytes));
        }
        // what is served now: the overlay, or the published package
        let served: BTreeMap<String, String> = match self.overlay_of(wid, rid) {
            Some(o) => o.tables.iter().map(|t| (t.table.clone(), t.sha256.clone())).collect(),
            None => {
                let pkg_bytes = fs::read(self.report_dir(wid, rid).join("package.bin")).map_err(|e| e.to_string())?;
                let pkg = package::open(&pkg_bytes, &OpenOptions { access_key: None, expected_publisher: Some(meta.publisher_key.clone()) }).map_err(|e| e.to_string())?;
                pkg.manifest.included.iter().filter_map(|t| pkg.files.get(&t.data_file).map(|b| (t.table.clone(), hex(&Sha256::digest(b))))).collect()
            }
        };
        let same = exported.iter().all(|(t, _)| served.get(&t.table).map(|h| h == &t.sha256).unwrap_or(false)) && exported.len() == served.len();
        if same {
            return Ok(JobResult { changed: false, message: format!("The sources gave the same data as before ({} tables).", exported.len()), version: None });
        }
        let tmp = dir.join("overlay.tmp");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        for (t, bytes) in &exported {
            fs::write(tmp.join(&t.file), bytes).map_err(|e| e.to_string())?;
        }
        let o = Overlay { refreshed_at: rfc3339(now_secs() as i64), tables: exported.iter().map(|(t, _)| t.clone()).collect() };
        fs::write(tmp.join("overlay.json"), serde_json::to_vec_pretty(&o).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let live = dir.join("overlay");
        let _ = fs::remove_dir_all(&live);
        fs::rename(&tmp, &live).map_err(|e| e.to_string())?;
        self.forget_report(wid, rid);
        Ok(JobResult { changed: true, message: format!("Reloaded {} tables; the report now answers with the new data.", o.tables.len()), version: None })
    }

    /// Runs the refresh of one report under its lock, with the plan's retries, and records every attempt.
    pub(crate) fn refresh_run(&self, wid: &str, rid: &str, trigger: Trigger, retries: bool) -> RunRecord {
        let settings = self.refresh_settings(wid, rid);
        let mut plan = settings.plan.clamped();
        if !retries {
            plan.retries = 0;
        }
        let store = JobStore::new(self.refresh_dir(wid, rid));
        let now = || now_secs();
        let sleep = |s: u64| std::thread::sleep(std::time::Duration::from_secs(s));
        run_job(&store, RunsOn::Server, trigger, &plan, &now, &sleep, &mut |_| self.refresh_attempt(wid, rid))
    }

    /// Starts every scheduled refresh that is due at `now`; returns how many jobs ran.
    pub fn refresh_tick(self: &Arc<Self>, now: u64) -> usize {
        let mut due = Vec::new();
        let ids: Vec<String> = self.workspaces.lock().unwrap().keys().cloned().collect();
        for wid in ids {
            let Ok(rd) = fs::read_dir(self.ws_dir(&wid).join("reports")) else { continue };
            for e in rd.flatten() {
                let rid = e.file_name().to_string_lossy().to_string();
                let s = self.refresh_settings(&wid, &rid);
                if !s.enabled || !self.refresh_dir(&wid, &rid).join("bundle.bin").exists() {
                    continue;
                }
                let store = JobStore::new(self.refresh_dir(&wid, &rid));
                if !store.running(now) && s.plan.clamped().is_due(store.last_scheduled_start(), now) {
                    due.push((wid.clone(), rid));
                }
            }
        }
        let n = due.len();
        let handles: Vec<_> = due
            .into_iter()
            .map(|(wid, rid)| {
                let app = self.clone();
                std::thread::spawn(move || {
                    let rec = app.refresh_run(&wid, &rid, Trigger::Scheduled, true);
                    app.audit(&wid, "scheduled refresh", "refresh", &format!("{rid}: {:?} ({})", rec.status, rec.message.chars().take(120).collect::<String>()));
                })
            })
            .collect();
        for h in handles {
            let _ = h.join();
        }
        n
    }
}

// ------------------------------------------------------------------------------------------------ handlers

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshInfo {
    enabled: bool,
    plan: Plan,
    /// Where it runs, in words.
    runs_on: String,
    needs: String,
    has_bundle: bool,
    running: bool,
    /// The folder on the server where same-named files replace the bundle's copies.
    source_folder: String,
    sources: Vec<String>,
    history: Vec<RunRecord>,
    refreshed_at: Option<String>,
}

fn info_of(app: &App, wid: &str, rid: &str) -> RefreshInfo {
    let dir = app.refresh_dir(wid, rid);
    let s = app.refresh_settings(wid, rid);
    let store = JobStore::new(&dir);
    let mut sources: Vec<String> = fs::read_dir(dir.join("sources")).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    sources.sort();
    RefreshInfo {
        enabled: s.enabled,
        plan: s.plan,
        runs_on: RunsOn::Server.label().into(),
        needs: RunsOn::Server.needs().into(),
        has_bundle: dir.join("bundle.bin").exists(),
        running: store.running(now_secs()),
        source_folder: dir.join("sources").display().to_string(),
        sources,
        history: store.history(30),
        refreshed_at: app.overlay_of(wid, rid).map(|o| o.refreshed_at),
    }
}

pub(crate) async fn get_refresh(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>) -> ApiResult<Json<RefreshInfo>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "see the refresh settings")?;
    app.read_meta(&wid, &rid)?;
    Ok(Json(info_of(&app, &wid, &rid)))
}

pub(crate) async fn put_refresh(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>, Json(s): Json<Settings>) -> ApiResult<Json<RefreshInfo>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "change the refresh schedule")?;
    app.read_meta(&wid, &rid)?;
    if s.enabled && !app.refresh_dir(&wid, &rid).join("bundle.bin").exists() {
        return err(StatusCode::CONFLICT, "Send the refresh bundle first (the publisher turns on scheduled refresh in Publish & Share).");
    }
    let s = Settings { enabled: s.enabled, plan: s.plan.clamped() };
    app.save_refresh_settings(&wid, &rid, &s)?;
    app.audit(&wid, &p.actor(), "refresh-schedule", &format!("{rid}: {} {:?}", if s.enabled { "on" } else { "off" }, s.plan.frequency));
    Ok(Json(info_of(&app, &wid, &rid)))
}

pub(crate) async fn put_bundle(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>, body: Bytes) -> ApiResult<Json<RefreshInfo>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "send a refresh bundle")?;
    let meta = app.read_meta(&wid, &rid)?;
    let bytes = body.to_vec();
    let pin = meta.publisher_key.clone();
    let bundle = tokio::task::spawn_blocking(move || package::open(&bytes, &OpenOptions { access_key: None, expected_publisher: Some(pin) })).await.map_err(internal)?.map_err(|e| bad(format!("The refresh bundle is not valid or not from this report's publisher: {e}")))?;
    if bundle.envelope.encrypted {
        return err(StatusCode::BAD_REQUEST, "The server must read the sources, so it cannot use an encrypted bundle.");
    }
    let cfg: RefreshConfig = serde_json::from_slice(bundle.files.get(CONFIG_PATH).ok_or_else(|| bad("The bundle has no data/refresh.json"))?).map_err(bad)?;
    let published = fs::read(app.report_dir(&wid, &rid).join("package.bin")).ok().and_then(|b| package::open(&b, &OpenOptions { access_key: None, expected_publisher: None }).ok());
    if published.map(|p| p.envelope.package_id != cfg.package_id).unwrap_or(true) {
        return err(StatusCode::CONFLICT, "The refresh bundle belongs to a different report than the one on the server.");
    }
    let dir = app.refresh_dir(&wid, &rid);
    fs::create_dir_all(&dir).map_err(internal)?;
    fs::write(dir.join("bundle.bin"), body.as_ref()).map_err(internal)?;
    app.audit(&wid, &p.actor(), "refresh-bundle", &format!("{rid}: {} source(s)", cfg.sources.len()));
    Ok(Json(info_of(&app, &wid, &rid)))
}

pub(crate) async fn delete_bundle(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>) -> ApiResult<Json<RefreshInfo>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "turn off scheduled refresh")?;
    app.read_meta(&wid, &rid)?;
    let _ = fs::remove_file(app.refresh_dir(&wid, &rid).join("bundle.bin"));
    app.save_refresh_settings(&wid, &rid, &Settings::default())?;
    app.drop_overlay(&wid, &rid);
    app.forget_report(&wid, &rid);
    app.audit(&wid, &p.actor(), "refresh-off", &rid);
    Ok(Json(info_of(&app, &wid, &rid)))
}

pub(crate) async fn put_source(State(app): St, h: HeaderMap, UrlPath((wid, rid, name)): UrlPath<(String, String, String)>, body: Bytes) -> ApiResult<Json<RefreshInfo>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "upload a source file")?;
    app.read_meta(&wid, &rid)?;
    let Some(name) = safe_name(&name) else { return err(StatusCode::BAD_REQUEST, "The file name may use letters, digits, spaces, dots, - and _.") };
    let dir = app.refresh_dir(&wid, &rid).join("sources");
    fs::create_dir_all(&dir).map_err(internal)?;
    fs::write(dir.join(&name), body.as_ref()).map_err(internal)?;
    app.audit(&wid, &p.actor(), "refresh-source", &format!("{rid}: {name} ({} bytes)", body.len()));
    Ok(Json(info_of(&app, &wid, &rid)))
}

pub(crate) async fn run_now(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>) -> ApiResult<Json<RunRecord>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "start a refresh")?;
    app.read_meta(&wid, &rid)?;
    let a = app.clone();
    let (w2, r2) = (wid.clone(), rid.clone());
    let rec = tokio::task::spawn_blocking(move || a.refresh_run(&w2, &r2, Trigger::Manual, false)).await.map_err(internal)?;
    app.audit(&wid, &p.actor(), "refresh-run", &format!("{rid}: {:?}", rec.status));
    Ok(Json(rec))
}
