//! Co-editing and comments of a report on the server.
//!
//! * `collab/sync`: editors (and admins) exchange Yjs updates with the report's shared document. The server only
//!   merges opaque updates; the first editor seeds the document from the project and a seed is accepted only while
//!   the document is empty. Every push is logged with the authenticated author and a summary the editor's app wrote.
//! * Comments: written through the server, which stamps the author from the token (a member cannot sign as someone
//!   else) and finds the mentions among the workspace members. Everyone in the workspace may read and write them.
//! * A new uploaded version of the report starts the shared document afresh (it is seeded from the new version).

use super::*;
use biforge_collab::{Anchor, Comment, CommentStore, Person, SharedDoc, SyncRequest};

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn unb64(s: &str) -> ApiResult<Vec<u8>> {
    b64().decode(s).map_err(|_| ApiError(StatusCode::BAD_REQUEST, "The request holds data that is not valid.".into()))
}

fn actor_identity(p: &Principal) -> (String, String) {
    match p {
        Principal::Admin => ("server admin".into(), "server admin".into()),
        Principal::Member { member, .. } => (member.info.name.clone(), member.info.identity.clone()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub time: String,
    pub actor: String,
    pub summary: String,
}

impl App {
    fn collab_dir(&self, wid: &str, rid: &str) -> PathBuf {
        self.report_dir(wid, rid).join("collab")
    }

    /// The shared document of a report (restored from disk on first use).
    fn shared_doc(&self, wid: &str, rid: &str) -> ApiResult<Arc<SharedDoc>> {
        let key = format!("{wid}/{rid}");
        let mut all = self.collab.lock().unwrap();
        if let Some(d) = all.get(&key) {
            return Ok(d.clone());
        }
        let doc = match fs::read(self.collab_dir(wid, rid).join("state.bin")) {
            Ok(bytes) => SharedDoc::from_state(&bytes).unwrap_or_default(),
            Err(_) => SharedDoc::new(),
        };
        let doc = Arc::new(doc);
        all.insert(key, doc.clone());
        Ok(doc)
    }

    pub(crate) fn reset_collab(&self, wid: &str, rid: &str) {
        self.collab.lock().unwrap().remove(&format!("{wid}/{rid}"));
        let _ = fs::remove_file(self.collab_dir(wid, rid).join("state.bin"));
    }

    fn people(&self, wid: &str) -> Vec<Person> {
        self.workspaces.lock().unwrap().get(wid).map(|w| w.members.iter().filter(|m| !m.info.revoked).map(|m| Person { identity: m.info.identity.clone(), name: m.info.name.clone() }).collect()).unwrap_or_default()
    }

    fn comments_path(&self, wid: &str, rid: &str) -> PathBuf {
        self.report_dir(wid, rid).join("comments.json")
    }

    fn read_comments(&self, wid: &str, rid: &str) -> CommentStore {
        fs::read(self.comments_path(wid, rid)).map(|b| CommentStore::from_json(&b)).unwrap_or_default()
    }

    fn write_comments(&self, wid: &str, rid: &str, s: &CommentStore) -> ApiResult<()> {
        let path = self.comments_path(wid, rid);
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, s.to_json()).map_err(internal)?;
        fs::rename(&tmp, path).map_err(internal)
    }

    fn require_report(&self, wid: &str, rid: &str) -> ApiResult<()> {
        self.read_meta(wid, rid).map(|_| ())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncBody {
    #[serde(default)]
    state_vector: String,
    #[serde(default)]
    update: String,
    #[serde(default)]
    seed: bool,
    #[serde(default)]
    summary: String,
}

pub(crate) async fn collab_sync(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>, Json(b): Json<SyncBody>) -> ApiResult<Json<Value>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Editor, "edit this report together with others")?;
    app.require_report(&wid, &rid)?;
    let doc = app.shared_doc(&wid, &rid)?;
    let (sv, update) = (unb64(&b.state_vector)?, unb64(&b.update)?);
    let had_update = !update.is_empty();
    let reply = {
        // updates of one report are applied one after another and stored together with the state they produce
        let _guard = app.collab_io.lock().unwrap();
        let reply = doc.sync(&SyncRequest { state_vector: sv, update, seed: b.seed }).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
        if had_update && (!b.seed || reply.seeded) {
            let dir = app.collab_dir(&wid, &rid);
            fs::create_dir_all(&dir).map_err(internal)?;
            fs::write(dir.join("state.bin"), doc.full_state()).map_err(internal)?;
            let summary: String = b.summary.chars().filter(|c| !c.is_control()).take(200).collect();
            let entry = ChangeEntry { time: rfc3339(now_secs() as i64), actor: p.actor(), summary: if summary.is_empty() { if reply.seeded { "started co-editing".into() } else { "changed the report".into() } } else { summary } };
            if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("changes.jsonl")) {
                let _ = writeln!(f, "{}", serde_json::to_string(&entry).unwrap_or_default());
            }
        }
        reply
    };
    Ok(Json(json!({"update": b64().encode(&reply.update), "stateVector": b64().encode(&reply.state_vector), "seeded": reply.seeded, "empty": reply.empty})))
}

pub(crate) async fn collab_changes(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>) -> ApiResult<Json<Vec<ChangeEntry>>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Viewer, "see the changes")?;
    app.require_report(&wid, &rid)?;
    let text = fs::read_to_string(app.collab_dir(&wid, &rid).join("changes.jsonl")).unwrap_or_default();
    let mut all: Vec<ChangeEntry> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let n = all.len();
    if n > 200 {
        all.drain(0..n - 200);
    }
    all.reverse();
    Ok(Json(all))
}

pub(crate) async fn list_comments(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>) -> ApiResult<Json<Vec<Comment>>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Viewer, "read comments")?;
    app.require_report(&wid, &rid)?;
    Ok(Json(app.read_comments(&wid, &rid).list()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewComment {
    text: String,
    #[serde(default)]
    anchor: Anchor,
    #[serde(default)]
    parent: Option<String>,
}

pub(crate) async fn add_comment(State(app): St, h: HeaderMap, UrlPath((wid, rid)): UrlPath<(String, String)>, Json(b): Json<NewComment>) -> ApiResult<Json<Comment>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Viewer, "write a comment")?;
    app.require_report(&wid, &rid)?;
    let (name, identity) = actor_identity(&p);
    let people = app.people(&wid);
    let _guard = app.collab_io.lock().unwrap();
    let mut store = app.read_comments(&wid, &rid);
    let c = store.add(&name, &identity, &b.text, b.anchor, b.parent.as_deref(), &people, &rfc3339(now_secs() as i64)).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    app.write_comments(&wid, &rid, &store)?;
    drop(_guard);
    app.audit(&wid, &p.actor(), "comment", &format!("{rid}: {}", c.text.chars().take(80).collect::<String>()));
    Ok(Json(c))
}

#[derive(Deserialize)]
pub(crate) struct ResolveBody {
    resolved: bool,
}

pub(crate) async fn resolve_comment(State(app): St, h: HeaderMap, UrlPath((wid, rid, cid)): UrlPath<(String, String, String)>, Json(b): Json<ResolveBody>) -> ApiResult<Json<Value>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Viewer, "resolve a comment")?;
    app.require_report(&wid, &rid)?;
    let (_, identity) = actor_identity(&p);
    let _guard = app.collab_io.lock().unwrap();
    let mut store = app.read_comments(&wid, &rid);
    store.set_resolved(&cid, b.resolved, &identity).map_err(|e| ApiError(StatusCode::NOT_FOUND, e.to_string()))?;
    app.write_comments(&wid, &rid, &store)?;
    Ok(Json(json!({"ok": true})))
}

pub(crate) async fn delete_comment(State(app): St, h: HeaderMap, UrlPath((wid, rid, cid)): UrlPath<(String, String, String)>) -> ApiResult<Json<Value>> {
    let p = app.principal(&h)?;
    let role = app.require(&p, &wid, WsRole::Viewer, "delete a comment")?;
    app.require_report(&wid, &rid)?;
    let (_, identity) = actor_identity(&p);
    let _guard = app.collab_io.lock().unwrap();
    let mut store = app.read_comments(&wid, &rid);
    store.delete(&cid, &identity, role == WsRole::Admin).map_err(|e| ApiError(StatusCode::FORBIDDEN, e.to_string()))?;
    app.write_comments(&wid, &rid, &store)?;
    Ok(Json(json!({"ok": true})))
}

/// Unresolved comments by others that mention the caller, in every report of the workspace.
pub(crate) async fn my_mentions(State(app): St, h: HeaderMap, UrlPath(wid): UrlPath<String>) -> ApiResult<Json<Vec<Value>>> {
    let p = app.principal(&h)?;
    app.require(&p, &wid, WsRole::Viewer, "read mentions")?;
    let (_, identity) = actor_identity(&p);
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(app.ws_dir(&wid).join("reports")) {
        for e in rd.flatten() {
            let rid = e.file_name().to_string_lossy().to_string();
            if app.read_meta(&wid, &rid).is_err() {
                continue;
            }
            for c in app.read_comments(&wid, &rid).mentioning(&identity) {
                out.push(json!({"report": rid, "comment": c}));
            }
        }
    }
    Ok(Json(out))
}
