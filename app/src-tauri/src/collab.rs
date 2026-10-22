//! One entry point for co-editing and comments, whatever carries them: a BIForge server, the host or a guest of a
//! direct session, or this PC alone (comments only). The web side sends `{ctx, op, args, blob}`; the blob (base64)
//! holds binary data for `collab.sync` (state vector followed by update, `svLen` in the arguments) and comes back
//! the same way (state vector followed by the missing update, `svLen` in `meta`).

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use biforge_collab::{Anchor, CommentStore, Person};
use biforge_publish::time::rfc3339;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::host::HostService;
use crate::p2p::P2pService;

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Ctx {
    #[serde(rename_all = "camelCase")]
    Server { connection: String, workspace: String, report: String },
    #[serde(rename_all = "camelCase")]
    P2pHost { target: String },
    #[serde(rename_all = "camelCase")]
    P2pGuest { guest: String },
    /// Comments kept next to a project on this PC.
    #[serde(rename_all = "camelCase")]
    Local { root: String },
}

#[derive(Debug, Serialize)]
pub struct Answer {
    pub meta: Value,
    /// base64
    pub blob: String,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn local_file(root: &str) -> PathBuf {
    PathBuf::from(root).join(".biforge").join("comments.json")
}

fn s(a: &Value, k: &str) -> String {
    a.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Comments of a project on this PC: the author is "You"; nothing leaves the computer.
fn local_call(root: &str, op: &str, args: &Value) -> Result<Value, String> {
    let path = local_file(root);
    let mut store = fs::read(&path).map(|b| CommentStore::from_json(&b)).unwrap_or_default();
    let me = Person { identity: "me".into(), name: "You".into() };
    let save = |st: &CommentStore| -> Result<(), String> {
        fs::create_dir_all(path.parent().unwrap()).map_err(msg)?;
        fs::write(&path, st.to_json()).map_err(msg)
    };
    match op {
        "comments.list" => serde_json::to_value(store.list()).map_err(msg),
        "comments.add" => {
            let anchor: Anchor = serde_json::from_value(args.get("anchor").cloned().unwrap_or_default()).unwrap_or_default();
            let parent = args.get("parent").and_then(|v| v.as_str()).map(str::to_string);
            let c = store.add(&me.name, &me.identity, &s(args, "text"), anchor, parent.as_deref(), &[me.clone()], &rfc3339(now())).map_err(msg)?;
            save(&store)?;
            serde_json::to_value(c).map_err(msg)
        }
        "comments.resolve" => {
            store.set_resolved(&s(args, "id"), args.get("resolved").and_then(|v| v.as_bool()).unwrap_or(true), "me").map_err(msg)?;
            save(&store)?;
            Ok(json!({"ok": true}))
        }
        "comments.delete" => {
            store.delete(&s(args, "id"), "me", true).map_err(msg)?;
            save(&store)?;
            Ok(json!({"ok": true}))
        }
        "comments.mentions" => Ok(json!([])),
        "collab.changes" => Ok(json!([])),
        other => Err(format!("\"{other}\" needs a shared report (a server or a direct session).")),
    }
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn server_call(host: &HostService, connection: &str, workspace: &str, report: &str, op: &str, args: &Value, blob: &[u8]) -> Result<Answer, String> {
    let mut a = args.clone();
    a["workspace"] = json!(workspace);
    a["report"] = json!(report);
    let plain = |v: Value| Answer { meta: v, blob: String::new() };
    match op {
        "collab.sync" => {
            let sv_len = args.get("svLen").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            if sv_len > blob.len() {
                return Err("Bad request.".into());
            }
            a["stateVector"] = json!(b64().encode(&blob[..sv_len]));
            a["update"] = json!(b64().encode(&blob[sv_len..]));
            let r = host.op(connection, "collabSync", a)?;
            let get = |k: &str| b64().decode(r.get(k).and_then(|x| x.as_str()).unwrap_or("")).unwrap_or_default();
            let (sv, up) = (get("stateVector"), get("update"));
            let mut out = sv.clone();
            out.extend_from_slice(&up);
            Ok(Answer { meta: json!({"seeded": r["seeded"], "empty": r["empty"], "svLen": sv.len()}), blob: b64().encode(out) })
        }
        "collab.changes" => host.op(connection, "collabChanges", a).map(plain),
        "comments.list" => host.op(connection, "comments", a).map(plain),
        "comments.add" => host.op(connection, "addComment", a).map(plain),
        "comments.resolve" => host.op(connection, "resolveComment", a).map(plain),
        "comments.delete" => host.op(connection, "deleteComment", a).map(plain),
        "comments.mentions" => host.op(connection, "mentions", a).map(|v| {
            // the server answers {report, comment}; the web side wants comments with their report
            plain(v)
        }),
        other => Err(format!("Unknown request \"{other}\".")),
    }
}

pub struct CollabService {
    pub host: HostService,
    pub p2p: Arc<P2pService>,
}

impl CollabService {
    pub async fn call(&self, ctx: Ctx, op: String, args: Value, blob_b64: Option<String>) -> Result<Answer, String> {
        let blob = match blob_b64.filter(|b| !b.is_empty()) {
            Some(b) => b64().decode(b).map_err(msg)?,
            None => Vec::new(),
        };
        match ctx {
            Ctx::Local { root } => Ok(Answer { meta: local_call(&root, &op, &args)?, blob: String::new() }),
            Ctx::Server { connection, workspace, report } => {
                let host = self.host.clone();
                tauri::async_runtime::spawn_blocking(move || server_call(&host, &connection, &workspace, &report, &op, &args, &blob)).await.map_err(msg)?
            }
            Ctx::P2pHost { target } => {
                let (meta, out) = self.p2p.call_host(&target, &op, &args, &blob)?;
                Ok(Answer { meta, blob: b64().encode(out) })
            }
            Ctx::P2pGuest { guest } => {
                let (meta, out) = self.p2p.call_guest(&guest, &op, &args, &blob).await?;
                Ok(Answer { meta, blob: b64().encode(out) })
            }
        }
    }
}

#[tauri::command]
pub async fn collab_call(s: tauri::State<'_, Arc<CollabService>>, ctx: Ctx, op: String, args: Value, blob: Option<String>) -> Result<Answer, String> {
    s.call(ctx, op, args, blob).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_comments_are_kept_next_to_the_project_and_never_leave_the_pc() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let c = local_call(&root, "comments.add", &json!({"text": "check this @you", "anchor": {"page": "p1"}})).unwrap();
        assert_eq!(c["author"], "You");
        let reply = local_call(&root, "comments.add", &json!({"text": "done", "parent": c["id"]})).unwrap();
        assert_eq!(reply["parent"], c["id"]);
        assert_eq!(local_call(&root, "comments.list", &json!({})).unwrap().as_array().unwrap().len(), 2);
        local_call(&root, "comments.resolve", &json!({"id": c["id"], "resolved": true})).unwrap();
        assert_eq!(local_call(&root, "comments.list", &json!({})).unwrap()[0]["resolved"], true);
        // the file lives in the project's own (ignored) .biforge folder
        assert!(dir.path().join(".biforge").join("comments.json").exists());
        assert!(local_call(&root, "collab.sync", &json!({})).unwrap_err().contains("shared report"));
        local_call(&root, "comments.delete", &json!({"id": c["id"]})).unwrap();
        assert!(local_call(&root, "comments.list", &json!({})).unwrap().as_array().unwrap().is_empty());
    }
}
