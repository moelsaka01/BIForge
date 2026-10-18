//! BIForge server (method D of docs/ONLINE_PLAN.md).
//!
//! * Workspaces with members. A member joins by redeeming a single-use, expiring invite; the invite fixes the role
//!   (viewer / editor / admin) and the identity (what `USERPRINCIPALNAME()` returns) so a member cannot pick a
//!   different person's rows.
//! * Authorization is checked on the server for every request. Tokens are random 256-bit values; only their
//!   SHA-256 is stored.
//! * Reports arrive as signed packages (unencrypted: the server has to read the data). The first upload pins the
//!   publisher key; later versions must carry the same key and a higher version.
//! * Row-level security: report roles (a DAX filter per table, see `biforge_dax::security`) are assigned to
//!   members. Viewers are always restricted: a viewer with no role on a report that has roles gets nothing.
//!   Editors and admins see everything (they can read the source data anyway). Queries run on an engine built
//!   from the visible rows only, and never use the unrestricted DuckDB tables.
//! * Audit log (append-only JSON lines per workspace): invites, joins, role changes, revocations, uploads,
//!   deletions, role definitions, queries, refused actions.
//! * Limits of this version (also in docs/COVERAGE.md): plain HTTP (no TLS; use a trusted network, a VPN or a
//!   tunnel), no rate limiting on joins (tokens are 256-bit), state is kept in JSON files, one process.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write as _;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use biforge_dax::editor::result_dto;
use biforge_dax::security::{Role, TableFilter};
use biforge_dax::Model;
use biforge_engine::{MemoryCredentialStore, SourceSpec};
use biforge_publish::backend::*;
use biforge_publish::keys::{hex, random_bytes};
use biforge_publish::package::{self, OpenOptions};
use biforge_publish::time::rfc3339;

const MAX_UPLOAD: usize = 512 * 1024 * 1024;

// ------------------------------------------------------------------------------------------------ storage types

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMember {
    info: MemberInfo,
    token_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredInvite {
    id: String,
    token_hash: String,
    role: WsRole,
    identity: String,
    rls_roles: Vec<String>,
    expires_unix: u64,
    used_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    name: String,
    created_at: String,
    members: Vec<StoredMember>,
    invites: Vec<StoredInvite>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportMeta {
    id: String,
    name: String,
    version: u64,
    publisher_key: String,
    publisher_key_id: String,
    uploaded_by: String,
    updated_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerFile {
    admin_token_hash: String,
}

/// A report loaded for queries: its model, its project files (no data) and the data in an in-memory DuckDB.
struct Loaded {
    version: u64,
    model: Model,
    project: Vec<(String, Vec<u8>)>,
    source: Mutex<biforge_engine::Engine>,
}

pub struct App {
    dir: PathBuf,
    admin_hash: String,
    workspaces: Mutex<BTreeMap<String, Workspace>>,
    loaded: Mutex<HashMap<String, Arc<Loaded>>>,
    secured: Mutex<HashMap<String, Arc<biforge_dax::Engine>>>,
    public_url: Mutex<String>,
}

// ------------------------------------------------------------------------------------------------ errors

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"message": self.1}))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn err<T>(code: StatusCode, msg: impl Into<String>) -> ApiResult<T> {
    Err(ApiError(code, msg.into()))
}
fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}
fn bad(e: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, e.to_string())
}

fn sha(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}
fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
fn token(prefix: &str) -> String {
    format!("{prefix}{}", hex(&random_bytes::<32>()))
}
fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", hex(&random_bytes::<5>()))
}
fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ------------------------------------------------------------------------------------------------ principals

enum Principal {
    Admin,
    Member { wid: String, member: StoredMember },
}

impl Principal {
    fn actor(&self) -> String {
        match self {
            Principal::Admin => "server admin".into(),
            Principal::Member { member, .. } => format!("{} ({})", member.info.name, member.info.id),
        }
    }
}

impl App {
    fn ws_dir(&self, wid: &str) -> PathBuf {
        if !valid_id(wid) {
            return self.dir.join("no-such-workspace");
        }
        self.dir.join("workspaces").join(wid)
    }

    fn save_ws(&self, ws: &Workspace) -> ApiResult<()> {
        let dir = self.ws_dir(&ws.id);
        fs::create_dir_all(&dir).map_err(internal)?;
        let tmp = dir.join("workspace.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(ws).map_err(internal)?).map_err(internal)?;
        fs::rename(&tmp, dir.join("workspace.json")).map_err(internal)
    }

    fn audit(&self, wid: &str, actor: &str, event: &str, detail: &str) {
        let dir = self.ws_dir(wid);
        let _ = fs::create_dir_all(&dir);
        let line = serde_json::to_string(&AuditEntry { time: rfc3339(now_secs() as i64), actor: actor.into(), event: event.into(), detail: detail.chars().take(300).collect() }).unwrap_or_default();
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("audit.jsonl")) {
            let _ = writeln!(f, "{line}");
        }
    }

    fn principal(&self, headers: &HeaderMap) -> ApiResult<Principal> {
        let t = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "A token is required.".into()))?;
        let h = sha(t);
        if h == self.admin_hash {
            return Ok(Principal::Admin);
        }
        let all = self.workspaces.lock().unwrap();
        for ws in all.values() {
            if let Some(m) = ws.members.iter().find(|m| m.token_hash == h) {
                if m.info.revoked {
                    return err(StatusCode::UNAUTHORIZED, "This access was revoked.");
                }
                return Ok(Principal::Member { wid: ws.id.clone(), member: m.clone() });
            }
        }
        err(StatusCode::UNAUTHORIZED, "The token is not valid.")
    }

    /// The principal's role in a workspace, or 403/404.
    fn role_in(&self, p: &Principal, wid: &str) -> ApiResult<WsRole> {
        if !self.workspaces.lock().unwrap().contains_key(wid) {
            return err(StatusCode::NOT_FOUND, "No such workspace.");
        }
        match p {
            Principal::Admin => Ok(WsRole::Admin),
            Principal::Member { wid: w, member } if w == wid => Ok(member.info.role),
            _ => err(StatusCode::FORBIDDEN, "You are not a member of this workspace."),
        }
    }

    fn require(&self, p: &Principal, wid: &str, min: WsRole, what: &str) -> ApiResult<WsRole> {
        let r = self.role_in(p, wid)?;
        if r < min {
            self.audit(wid, &p.actor(), "refused", what);
            return err(StatusCode::FORBIDDEN, format!("Your role ({r:?}) does not allow this: {what}."));
        }
        Ok(r)
    }

    // -------------------------------------------------------------------------------------------- reports

    /// The folder of one report. A report id from a request is checked here, in the one place that builds the path:
    /// an id with a slash or dots ("../../other-workspace/reports/x") must never reach another folder.
    fn report_dir(&self, wid: &str, rid: &str) -> PathBuf {
        if !valid_id(rid) || !valid_id(wid) {
            return self.dir.join("no-such-report");
        }
        self.ws_dir(wid).join("reports").join(rid)
    }

    fn read_meta(&self, wid: &str, rid: &str) -> ApiResult<ReportMeta> {
        let b = fs::read(self.report_dir(wid, rid).join("meta.json")).map_err(|_| ApiError(StatusCode::NOT_FOUND, "No such report.".into()))?;
        serde_json::from_slice(&b).map_err(internal)
    }

    fn read_roles(&self, wid: &str, rid: &str) -> Vec<RlsRole> {
        fs::read(self.report_dir(wid, rid).join("roles.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn info_of(&self, wid: &str, m: &ReportMeta) -> ReportInfo {
        ReportInfo { id: m.id.clone(), name: m.name.clone(), version: m.version, publisher_key_id: m.publisher_key_id.clone(), uploaded_by: m.uploaded_by.clone(), updated_at: m.updated_at.clone(), has_roles: !self.read_roles(wid, &m.id).is_empty() }
    }

    fn build_loaded(bytes: &[u8], expected_publisher: Option<&str>) -> ApiResult<(Loaded, package::Package)> {
        let pkg = package::open(bytes, &OpenOptions { access_key: None, expected_publisher: expected_publisher.map(str::to_string) }).map_err(bad)?;
        let mut docs = Vec::new();
        let mut project = Vec::new();
        for (path, data) in &pkg.files {
            if let Some(rel) = path.strip_prefix("project/") {
                if rel.ends_with(".tmdl") {
                    let text = String::from_utf8_lossy(data);
                    docs.push(biforge_model::tmdl::parse(&text).map_err(|e| bad(format!("{path}: {e}")))?);
                }
                project.push((path.clone(), data.clone()));
            }
        }
        let model = Model::from_tmdl(docs.iter()).map_err(|e| bad(format!("The model is not valid: {e}")))?;
        let engine = biforge_engine::Engine::in_memory().map_err(internal)?;
        let tmp = tempfile::tempdir().map_err(internal)?;
        let creds = MemoryCredentialStore::default();
        for t in &pkg.manifest.included {
            let data = pkg.files.get(&t.data_file).ok_or_else(|| bad(format!("The data of table {} is missing.", t.table)))?;
            let file = tmp.path().join(format!("{}.parquet", hex(&Sha256::digest(t.table.as_bytes())[..8])));
            fs::write(&file, data).map_err(internal)?;
            engine.import(&t.table, &SourceSpec::Parquet { path: file.to_string_lossy().into_owned() }, &creds).map_err(|e| bad(format!("Table {}: {e}", t.table)))?;
        }
        Ok((Loaded { version: pkg.envelope.version, model, project, source: Mutex::new(engine) }, pkg))
    }

    fn loaded(&self, wid: &str, rid: &str) -> ApiResult<Arc<Loaded>> {
        let key = format!("{wid}/{rid}");
        let meta = self.read_meta(wid, rid)?;
        if let Some(l) = self.loaded.lock().unwrap().get(&key) {
            if l.version == meta.version {
                return Ok(l.clone());
            }
        }
        let bytes = fs::read(self.report_dir(wid, rid).join("package.bin")).map_err(internal)?;
        let (l, _) = Self::build_loaded(&bytes, Some(&meta.publisher_key))?;
        let l = Arc::new(l);
        self.loaded.lock().unwrap().insert(key, l.clone());
        Ok(l)
    }

    fn to_dax_roles(roles: &[RlsRole]) -> Vec<Role> {
        roles.iter().map(|r| Role { name: r.name.clone(), filters: r.filters.iter().map(|f| TableFilter { table: f.table.clone(), expression: f.expression.clone() }).collect() }).collect()
    }

    /// The engine this principal queries: unrestricted for admins and editors, restricted for viewers.
    fn engine_for(&self, p: &Principal, wid: &str, rid: &str) -> ApiResult<Arc<biforge_dax::Engine>> {
        let loaded = self.loaded(wid, rid)?;
        let defined = self.read_roles(wid, rid);
        let (identity, role_names, restricted) = match p {
            Principal::Admin => ("server admin".to_string(), vec![], false),
            Principal::Member { member, .. } => (member.info.identity.clone(), member.info.rls_roles.clone(), member.info.role == WsRole::Viewer),
        };
        let applies: Vec<RlsRole> = if restricted { defined.iter().filter(|r| role_names.contains(&r.name)).cloned().collect() } else { vec![] };
        if restricted && !defined.is_empty() && applies.is_empty() {
            return err(StatusCode::FORBIDDEN, "No data role is assigned to you for this report. Ask an admin to assign one.");
        }
        let sig = sha(&format!("{}|{}|{}|{}", loaded.version, identity, serde_json::to_string(&applies).unwrap_or_default(), restricted));
        let key = format!("{wid}/{rid}/{sig}");
        if let Some(e) = self.secured.lock().unwrap().get(&key) {
            return Ok(e.clone());
        }
        let dax_roles = Self::to_dax_roles(&applies);
        let refs: Vec<&Role> = dax_roles.iter().collect();
        let source = loaded.source.lock().unwrap();
        let engine = biforge_dax::Engine::new_secured(loaded.model.clone(), &*source, &refs, &identity).map_err(|e| ApiError(StatusCode::UNPROCESSABLE_ENTITY, format!("The data roles could not be applied: {e}")))?;
        let engine = Arc::new(engine);
        self.secured.lock().unwrap().insert(key, engine.clone());
        Ok(engine)
    }

    fn forget_report(&self, wid: &str, rid: &str) {
        let prefix = format!("{wid}/{rid}");
        self.loaded.lock().unwrap().retain(|k, _| *k != prefix);
        self.secured.lock().unwrap().retain(|k, _| !k.starts_with(&format!("{prefix}/")));
    }
}

// ------------------------------------------------------------------------------------------------ handlers

type St = State<Arc<App>>;

async fn info(State(app): St) -> Json<Value> {
    Json(json!({"name": "biforge-server", "version": env!("CARGO_PKG_VERSION"), "apiVersion": API_VERSION, "url": app.public_url.lock().unwrap().clone()}))
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

async fn create_workspace(State(app): St, h: HeaderMap, Json(b): Json<NameBody>) -> ApiResult<Json<WorkspaceInfo>> {
    if !matches!(app.principal(&h)?, Principal::Admin) {
        return err(StatusCode::FORBIDDEN, "Only the server admin can create workspaces.");
    }
    let name = b.name.trim().to_string();
    if name.is_empty() || name.len() > 100 {
        return err(StatusCode::BAD_REQUEST, "Give the workspace a name (up to 100 characters).");
    }
    let ws = Workspace { id: new_id("w_"), name: name.clone(), created_at: rfc3339(now_secs() as i64), members: vec![], invites: vec![] };
    app.save_ws(&ws)?;
    app.audit(&ws.id, "server admin", "workspace-create", &name);
    let out = WorkspaceInfo { id: ws.id.clone(), name };
    app.workspaces.lock().unwrap().insert(ws.id.clone(), ws);
    Ok(Json(out))
}

async fn list_workspaces(State(app): St, h: HeaderMap) -> ApiResult<Json<Vec<WorkspaceInfo>>> {
    let p = app.principal(&h)?;
    let all = app.workspaces.lock().unwrap();
    Ok(Json(
        all.values()
            .filter(|w| match &p {
                Principal::Admin => true,
                Principal::Member { wid, .. } => *wid == w.id,
            })
            .map(|w| WorkspaceInfo { id: w.id.clone(), name: w.name.clone() })
            .collect(),
    ))
}

async fn create_invite(State(app): St, h: HeaderMap, UrlPath(wid): UrlPath<String>, Json(b): Json<InviteRequest>) -> ApiResult<Json<InviteInfo>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Admin, "create an invitation")?;
    if b.identity.trim().is_empty() || b.identity.len() > 200 {
        return err(StatusCode::BAD_REQUEST, "The invitation needs the identity of the person (an e-mail address or a name).");
    }
    if b.expires_minutes == 0 || b.expires_minutes > 60 * 24 * 30 {
        return err(StatusCode::BAD_REQUEST, "An invitation must expire within 30 days.");
    }
    let tok = token("bfi_");
    let expires = now_secs() + b.expires_minutes * 60;
    let inv = StoredInvite { id: new_id("i_"), token_hash: sha(&tok), role: b.role, identity: b.identity.trim().to_string(), rls_roles: b.rls_roles.clone(), expires_unix: expires, used_by: None };
    let link = build_link(&app.public_url.lock().unwrap().clone(), &tok);
    let info = InviteInfo { id: inv.id.clone(), token: tok, link, expires_at: rfc3339(expires as i64) };
    {
        let mut all = app.workspaces.lock().unwrap();
        let ws = all.get_mut(&wid).unwrap();
        ws.invites.retain(|i| i.used_by.is_none() && i.expires_unix > now_secs());
        ws.invites.push(inv);
        app.save_ws(ws)?;
    }
    app.audit(&wid, &p.actor(), "invite-create", &format!("{:?} for {}, expires {}", b.role, b.identity.trim(), info.expires_at));
    Ok(Json(info))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinBody {
    invite: String,
    display_name: String,
}

async fn join(State(app): St, Json(b): Json<JoinBody>) -> ApiResult<Json<JoinResponse>> {
    let h = sha(&b.invite);
    let name = b.display_name.trim().to_string();
    if name.is_empty() || name.len() > 100 {
        return err(StatusCode::BAD_REQUEST, "Enter your name (up to 100 characters).");
    }
    let mut all = app.workspaces.lock().unwrap();
    let Some(ws) = all.values_mut().find(|w| w.invites.iter().any(|i| i.token_hash == h)) else {
        return err(StatusCode::NOT_FOUND, "This invitation is not valid.");
    };
    let inv = ws.invites.iter_mut().find(|i| i.token_hash == h).unwrap();
    if inv.used_by.is_some() {
        return err(StatusCode::GONE, "This invitation was already used.");
    }
    if inv.expires_unix < now_secs() {
        return err(StatusCode::GONE, "This invitation has expired. Ask for a new one.");
    }
    let tok = token("bfm_");
    let member = MemberInfo { id: new_id("m_"), name: name.clone(), identity: inv.identity.clone(), role: inv.role, rls_roles: inv.rls_roles.clone(), created_at: rfc3339(now_secs() as i64), revoked: false };
    inv.used_by = Some(member.id.clone());
    let out = JoinResponse { workspace_id: ws.id.clone(), workspace_name: ws.name.clone(), member_id: member.id.clone(), token: tok.clone(), role: member.role, identity: member.identity.clone() };
    let (wid, mid, role) = (ws.id.clone(), member.id.clone(), member.role);
    ws.members.push(StoredMember { info: member, token_hash: sha(&tok) });
    app.save_ws(ws)?;
    drop(all);
    app.audit(&wid, &format!("{name} ({mid})"), "join", &format!("joined as {role:?}"));
    Ok(Json(out))
}

async fn members(State(app): St, h: HeaderMap, UrlPath(wid): UrlPath<String>) -> ApiResult<Json<Vec<MemberInfo>>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Admin, "list members")?;
    Ok(Json(app.workspaces.lock().unwrap()[&wid].members.iter().map(|m| m.info.clone()).collect()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchMember {
    role: Option<WsRole>,
    rls_roles: Option<Vec<String>>,
}

async fn patch_member(State(app): St, h: HeaderMap, UrlPath((wid, mid)): UrlPath<(String, String)>, Json(b): Json<PatchMember>) -> ApiResult<Json<MemberInfo>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Admin, "change a member")?;
    let out = {
        let mut all = app.workspaces.lock().unwrap();
        let ws = all.get_mut(&wid).unwrap();
        let Some(m) = ws.members.iter_mut().find(|m| m.info.id == mid) else { return err(StatusCode::NOT_FOUND, "No such member.") };
        if let Some(r) = b.role {
            m.info.role = r;
        }
        if let Some(r) = b.rls_roles.clone() {
            m.info.rls_roles = r;
        }
        let out = m.info.clone();
        app.save_ws(ws)?;
        out
    };
    app.audit(&wid, &p.actor(), "member-change", &format!("{mid}: role {:?}, data roles {:?}", out.role, out.rls_roles));
    Ok(Json(out))
}

async fn revoke(State(app): St, h: HeaderMap, UrlPath((wid, mid)): UrlPath<(String, String)>) -> ApiResult<Json<Value>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Admin, "revoke a member")?;
    {
        let mut all = app.workspaces.lock().unwrap();
        let ws = all.get_mut(&wid).unwrap();
        let Some(m) = ws.members.iter_mut().find(|m| m.info.id == mid) else { return err(StatusCode::NOT_FOUND, "No such member.") };
        m.info.revoked = true;
        app.save_ws(ws)?;
    }
    app.audit(&wid, &p.actor(), "revoke", &mid);
    Ok(Json(json!({"ok": true})))
}

async fn audit_log(State(app): St, h: HeaderMap, UrlPath(wid): UrlPath<String>) -> ApiResult<Json<Vec<AuditEntry>>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Admin, "read the audit log")?;
    let text = fs::read_to_string(app.ws_dir(&wid).join("audit.jsonl")).unwrap_or_default();
    Ok(Json(text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()))
}

async fn list_reports(State(app): St, h: HeaderMap, UrlPath(wid): UrlPath<String>) -> ApiResult<Json<Vec<ReportInfo>>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Viewer, "list reports")?;
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(app.ws_dir(&wid).join("reports")) {
        for e in rd.flatten() {
            if let Ok(m) = app.read_meta(&wid, &e.file_name().to_string_lossy()) {
                out.push(app.info_of(&wid, &m));
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(out))
}

async fn upload_report(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>, body: Bytes) -> ApiResult<Json<ReportInfo>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "upload a report")?;
    if !valid_id(&rid) {
        return err(StatusCode::BAD_REQUEST, "The report id may use letters, digits, - and _ (up to 64).");
    }
    let existing = app.read_meta(&wid, &rid).ok();
    let app2 = app.clone();
    let bytes = body.to_vec();
    let pin = existing.as_ref().map(|m| m.publisher_key.clone());
    let (loaded, pkg) = tokio::task::spawn_blocking(move || App::build_loaded(&bytes, pin.as_deref())).await.map_err(internal)??;
    if pkg.envelope.encrypted {
        return err(StatusCode::BAD_REQUEST, "The server must read the data to answer queries, so it cannot host an encrypted package. Publish this report as Public to the server (access is controlled by the invitations and the data roles).");
    }
    if let Some(m) = &existing {
        if pkg.envelope.version <= m.version {
            return err(StatusCode::CONFLICT, format!("The server already has version {}. Upload a newer version.", m.version));
        }
    }
    let meta = ReportMeta {
        id: rid.clone(),
        name: pkg.manifest.report_name.clone(),
        version: pkg.envelope.version,
        publisher_key: pkg.envelope.publisher_public_key.clone(),
        publisher_key_id: pkg.manifest.publisher.key_id.clone(),
        uploaded_by: p.actor(),
        updated_at: rfc3339(now_secs() as i64),
    };
    let dir = app2.report_dir(&wid, &rid);
    fs::create_dir_all(&dir).map_err(internal)?;
    fs::write(dir.join("package.bin"), body.as_ref()).map_err(internal)?;
    fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&meta).map_err(internal)?).map_err(internal)?;
    app2.forget_report(&wid, &rid);
    app2.loaded.lock().unwrap().insert(format!("{wid}/{rid}"), Arc::new(loaded));
    app2.audit(&wid, &p.actor(), "report-upload", &format!("{} ({rid}) version {}", meta.name, meta.version));
    Ok(Json(app2.info_of(&wid, &meta)))
}

async fn delete_report(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>) -> ApiResult<Json<Value>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Admin, "delete a report")?;
    if !valid_id(&rid) || app.read_meta(&wid, &rid).is_err() {
        return err(StatusCode::NOT_FOUND, "No such report.");
    }
    fs::remove_dir_all(app.report_dir(&wid, &rid)).map_err(internal)?;
    app.forget_report(&wid, &rid);
    app.audit(&wid, &p.actor(), "report-delete", &rid);
    Ok(Json(json!({"ok": true})))
}

async fn get_roles(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>) -> ApiResult<Json<Vec<RlsRole>>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "read data roles")?;
    app.read_meta(&wid, &rid)?;
    Ok(Json(app.read_roles(&wid, &rid)))
}

async fn set_roles(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>, Json(roles): Json<Vec<RlsRole>>) -> ApiResult<Json<Value>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "define data roles")?;
    app.read_meta(&wid, &rid)?;
    let mut names = std::collections::HashSet::new();
    for r in &roles {
        if r.name.trim().is_empty() || !names.insert(r.name.to_lowercase()) {
            return err(StatusCode::BAD_REQUEST, "Every data role needs a unique name.");
        }
    }
    // each role must work against the model: it is applied once for a probe identity (fails on unknown tables,
    // columns, syntax errors and expressions that fail on a row)
    let loaded = app.loaded(&wid, &rid)?;
    let dax_roles = App::to_dax_roles(&roles);
    let probe = tokio::task::spawn_blocking(move || {
        let source = loaded.source.lock().unwrap();
        for r in &dax_roles {
            biforge_dax::Engine::new_secured(loaded.model.clone(), &*source, &[r], "probe@invalid").map_err(|e| format!("Role \"{}\": {e}", r.name))?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(internal)?;
    probe.map_err(bad)?;
    fs::write(app.report_dir(&wid, &rid).join("roles.json"), serde_json::to_vec_pretty(&roles).map_err(internal)?).map_err(internal)?;
    app.forget_report(&wid, &rid);
    app.audit(&wid, &p.actor(), "roles-set", &format!("{rid}: {}", roles.iter().map(|r| r.name.clone()).collect::<Vec<_>>().join(", ")));
    Ok(Json(json!({"ok": true})))
}

async fn project(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>) -> ApiResult<Json<Value>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Viewer, "open a report")?;
    let l = app.loaded(&wid, &rid)?;
    let files: Vec<Value> = l.project.iter().map(|(path, data)| json!({"path": path, "data": base64::engine::general_purpose::STANDARD.encode(data)})).collect();
    Ok(Json(json!({"version": l.version, "files": files})))
}

#[derive(Deserialize)]
struct QueryBody {
    query: String,
}

async fn query(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>, Json(b): Json<QueryBody>) -> ApiResult<Json<Value>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Viewer, "query a report")?;
    let a = app.clone();
    let q = b.query.clone();
    let (w2, r2) = (wid.clone(), rid.clone());
    let started = Instant::now();
    let result = tokio::task::spawn_blocking(move || -> ApiResult<Value> {
        let engine = a.engine_for(&p, &w2, &r2)?;
        // never given the unrestricted DuckDB store: aggregations run in the DAX engine over the visible rows
        let tables = engine.query_with(&q, None).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.message))?;
        Ok(json!({"results": tables.iter().map(result_dto).collect::<Vec<_>>(), "elapsedMs": started.elapsed().as_millis() as u64}))
    })
    .await
    .map_err(internal)?;
    // recorded for allowed and refused queries alike
    let p2 = app.principal(&h)?;
    app.audit(&wid, &p2.actor(), if result.is_ok() { "query" } else { "query-failed" }, &format!("{rid}: {}", b.query));
    Ok(Json(result?))
}

// ------------------------------------------------------------------------------------------------ server

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/info", get(info))
        .route("/api/join", post(join))
        .route("/api/workspaces", post(create_workspace).get(list_workspaces))
        .route("/api/workspaces/{w}/invites", post(create_invite))
        .route("/api/workspaces/{w}/members", get(members))
        .route("/api/workspaces/{w}/members/{m}", axum::routing::patch(patch_member).delete(revoke))
        .route("/api/workspaces/{w}/audit", get(audit_log))
        .route("/api/workspaces/{w}/reports", get(list_reports))
        .route("/api/workspaces/{w}/reports/{r}", put(upload_report).delete(delete_report))
        .route("/api/workspaces/{w}/reports/{r}/roles", get(get_roles).put(set_roles))
        .route("/api/workspaces/{w}/reports/{r}/project", get(project))
        .route("/api/workspaces/{w}/reports/{r}/query", post(query))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD))
        .with_state(app)
}

pub struct Config {
    pub data_dir: PathBuf,
    pub bind: SocketAddr,
    /// Use this admin token (its hash is stored). None: keep the stored one, or make a new one on the first run.
    pub admin_token: Option<String>,
    /// The address other computers use to reach this server (goes into invite links). Default: the bound address.
    pub public_url: Option<String>,
}

pub struct Running {
    pub addr: SocketAddr,
    /// Set when this start created or replaced the admin token (shown once; only its hash is stored).
    pub admin_token: Option<String>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Running {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
    pub fn stop(mut self) {
        self.halt();
    }
    fn halt(&mut self) {
        if let Some(s) = self.shutdown.take() {
            let _ = s.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.halt();
    }
}

fn load_workspaces(dir: &Path) -> BTreeMap<String, Workspace> {
    let mut out = BTreeMap::new();
    if let Ok(rd) = fs::read_dir(dir.join("workspaces")) {
        for e in rd.flatten() {
            if let Some(ws) = fs::read(e.path().join("workspace.json")).ok().and_then(|b| serde_json::from_slice::<Workspace>(&b).ok()) {
                out.insert(ws.id.clone(), ws);
            }
        }
    }
    out
}

/// Starts the server on its own thread and returns when it is listening.
pub fn start(cfg: Config) -> Result<Running, String> {
    fs::create_dir_all(&cfg.data_dir).map_err(|e| format!("Cannot use the data folder: {e}"))?;
    let file_path = cfg.data_dir.join("server.json");
    let stored: Option<ServerFile> = fs::read(&file_path).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let (admin_hash, new_token) = match (cfg.admin_token.clone(), stored) {
        (Some(t), _) => (sha(&t), Some(t)),
        (None, Some(s)) if !s.admin_token_hash.is_empty() => (s.admin_token_hash, None),
        _ => {
            let t = token("bfa_");
            (sha(&t), Some(t))
        }
    };
    fs::write(&file_path, serde_json::to_vec_pretty(&ServerFile { admin_token_hash: admin_hash.clone() }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let app = Arc::new(App {
        dir: cfg.data_dir.clone(),
        admin_hash,
        workspaces: Mutex::new(load_workspaces(&cfg.data_dir)),
        loaded: Mutex::new(HashMap::new()),
        secured: Mutex::new(HashMap::new()),
        public_url: Mutex::new(String::new()),
    });
    let (tx, rx) = std::sync::mpsc::channel::<Result<SocketAddr, String>>();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let bind = cfg.bind;
    let public = cfg.public_url.clone();
    let thread = std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
                return;
            }
        };
        rt.block_on(async move {
            let listener = match tokio::net::TcpListener::bind(bind).await {
                Ok(l) => l,
                Err(e) => {
                    let _ = tx.send(Err(format!("Cannot listen on {bind}: {e}")));
                    return;
                }
            };
            let addr = listener.local_addr().unwrap();
            *app.public_url.lock().unwrap() = public.unwrap_or_else(|| format!("http://{addr}"));
            let _ = tx.send(Ok(addr));
            let _ = axum::serve(listener, router(app)).with_graceful_shutdown(async move {
                let _ = stop_rx.await;
            })
            .await;
        });
    });
    let addr = rx.recv().map_err(|e| e.to_string())??;
    Ok(Running { addr, admin_token: new_token, shutdown: Some(stop_tx), thread: Some(thread) })
}
