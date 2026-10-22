//! Request/answer calls over a direct session, on a stream of their own so they never disturb package updates:
//! co-editing (the host keeps the shared document and merges what editors send), comments with mentions, and the
//! list of recent changes. The host is the authority: it stamps the author of a comment or change from its own
//! record of the guest (name and endpoint id), never from the request.

use super::*;
use biforge_collab::{Anchor, CommentStore, Person, SharedDoc, SyncRequest};

#[derive(Serialize, Deserialize, Debug)]
struct RpcRequest {
    op: String,
    #[serde(default)]
    args: serde_json::Value,
    blob: u64,
}

#[derive(Serialize, Deserialize, Debug)]
struct RpcReply {
    ok: bool,
    #[serde(default)]
    error: String,
    #[serde(default)]
    meta: serde_json::Value,
    blob: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub time: String,
    pub actor: String,
    pub summary: String,
}

/// What the host keeps for co-editing and comments during a session.
pub(crate) struct CollabState {
    pub doc: SharedDoc,
    pub comments: Mutex<CommentStore>,
    pub changes: Mutex<Vec<Change>>,
    pub host_name: String,
    pub io: Mutex<()>,
}

impl CollabState {
    pub fn new(host_name: String) -> Self {
        Self { doc: SharedDoc::new(), comments: Mutex::new(CommentStore::default()), changes: Mutex::new(Vec::new()), host_name, io: Mutex::new(()) }
    }
}

fn stamp() -> String {
    biforge_publish::time::rfc3339(now() as i64)
}

impl HostShared {
    fn people(&self) -> Vec<Person> {
        let st = self.st.lock().unwrap();
        let mut v = vec![Person { identity: "host".into(), name: self.collab.host_name.clone() }];
        v.extend(st.peers.iter().filter(|(_, p)| !p.revoked).map(|(id, p)| Person { identity: id.clone(), name: p.name.clone() }));
        v
    }

    /// (display name, identity, may co-edit) of a caller; None is the host itself.
    fn caller(&self, peer: Option<&str>) -> Result<(String, String, bool), P2pError> {
        match peer {
            None => Ok((self.collab.host_name.clone(), "host".into(), true)),
            Some(id) => {
                let st = self.st.lock().unwrap();
                match st.peers.get(id) {
                    Some(p) if !p.revoked && !st.stopped => Ok((p.name.clone(), id.to_string(), p.role == Role::Edit)),
                    _ => err("Your access has ended."),
                }
            }
        }
    }

    pub(crate) fn rpc(&self, peer: Option<&str>, op: &str, args: &serde_json::Value, blob: &[u8]) -> Result<(serde_json::Value, Vec<u8>), P2pError> {
        let (name, identity, can_edit) = self.caller(peer)?;
        let c = &self.collab;
        let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        match op {
            "collab.sync" => {
                if !can_edit {
                    return err("You have the read-only role: you cannot edit together with the others.");
                }
                let sv_len = args.get("svLen").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                if sv_len > blob.len() {
                    return err("Bad request.");
                }
                let seed = args.get("seed").and_then(|v| v.as_bool()).unwrap_or(false);
                let _g = c.io.lock().unwrap();
                let had_update = blob.len() > sv_len;
                let reply = c.doc.sync(&SyncRequest { state_vector: blob[..sv_len].to_vec(), update: blob[sv_len..].to_vec(), seed }).map_err(e)?;
                if had_update && (!seed || reply.seeded) {
                    let summary: String = s("summary").chars().filter(|ch| !ch.is_control()).take(200).collect();
                    let summary = if summary.is_empty() { if reply.seeded { "started co-editing".to_string() } else { "changed the report".to_string() } } else { summary };
                    let mut log = c.changes.lock().unwrap();
                    log.push(Change { time: stamp(), actor: name, summary });
                    let n = log.len();
                    if n > 500 {
                        log.drain(0..n - 500);
                    }
                }
                let mut out = reply.state_vector.clone();
                out.extend_from_slice(&reply.update);
                Ok((serde_json::json!({"seeded": reply.seeded, "empty": reply.empty, "svLen": reply.state_vector.len()}), out))
            }
            "collab.changes" => {
                let mut v = c.changes.lock().unwrap().clone();
                v.reverse();
                Ok((serde_json::to_value(v).map_err(e)?, vec![]))
            }
            "comments.list" => Ok((serde_json::to_value(c.comments.lock().unwrap().list()).map_err(e)?, vec![])),
            "comments.add" => {
                let anchor: Anchor = serde_json::from_value(args.get("anchor").cloned().unwrap_or_default()).unwrap_or_default();
                let parent = args.get("parent").and_then(|v| v.as_str()).map(str::to_string);
                let people = self.people();
                let created = c.comments.lock().unwrap().add(&name, &identity, &s("text"), anchor, parent.as_deref(), &people, &stamp()).map_err(e)?;
                Ok((serde_json::to_value(created).map_err(e)?, vec![]))
            }
            "comments.resolve" => {
                let resolved = args.get("resolved").and_then(|v| v.as_bool()).unwrap_or(true);
                c.comments.lock().unwrap().set_resolved(&s("id"), resolved, &identity).map_err(e)?;
                Ok((serde_json::json!({"ok": true}), vec![]))
            }
            "comments.delete" => {
                // the host acts as the administrator of its own session
                c.comments.lock().unwrap().delete(&s("id"), &identity, identity == "host").map_err(e)?;
                Ok((serde_json::json!({"ok": true}), vec![]))
            }
            "comments.mentions" => Ok((serde_json::to_value(c.comments.lock().unwrap().mentioning(&identity)).map_err(e)?, vec![])),
            other => err(format!("Unknown request \"{other}\".")),
        }
    }
}

/// Serves the extra streams a guest opens for calls, until the connection ends.
pub(crate) async fn serve_calls(sh: Arc<HostShared>, conn: Connection, peer: String) {
    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
        let (sh, peer) = (sh.clone(), peer.clone());
        tokio::spawn(async move {
            let _ = answer(&sh, &peer, &mut send, &mut recv).await;
            let _ = send.finish();
        });
    }
}

async fn answer(sh: &HostShared, peer: &str, send: &mut SendStream, recv: &mut RecvStream) -> Result<(), P2pError> {
    let req: RpcRequest = read_frame(recv).await?;
    let blob = read_blob(recv, req.blob).await?;
    let (reply, out) = match sh.rpc(Some(peer), &req.op, &req.args, &blob) {
        Ok((meta, out)) => (RpcReply { ok: true, error: String::new(), meta, blob: out.len() as u64 }, out),
        Err(x) => (RpcReply { ok: false, error: x.0, meta: serde_json::Value::Null, blob: 0 }, vec![]),
    };
    write_frame(send, &reply).await?;
    write_blob(send, &out).await
}

impl HostSession {
    /// A call made by the host app itself (the host edits and comments too). Same operations as a guest's.
    pub fn call(&self, op: &str, args: &serde_json::Value, blob: &[u8]) -> Result<(serde_json::Value, Vec<u8>), P2pError> {
        self.shared.rpc(None, op, args, blob)
    }
}

impl Guest {
    /// A call to the host: `op` names it, `args` are its parameters and `blob` its binary payload.
    pub async fn call(&self, op: &str, args: &serde_json::Value, blob: &[u8]) -> Result<(serde_json::Value, Vec<u8>), P2pError> {
        if !matches!(self.state(), GuestState::Approved) {
            return err("You are not connected to the host.");
        }
        let work = async {
            let (mut send, mut recv) = self.conn.open_bi().await.map_err(e)?;
            write_frame(&mut send, &RpcRequest { op: op.into(), args: args.clone(), blob: blob.len() as u64 }).await?;
            write_blob(&mut send, blob).await?;
            let _ = send.finish();
            let reply: RpcReply = read_frame(&mut recv).await?;
            let out = read_blob(&mut recv, reply.blob).await?;
            if !reply.ok {
                return err(reply.error);
            }
            Ok((reply.meta, out))
        };
        match tokio::time::timeout(Duration::from_secs(30), work).await {
            Ok(r) => r,
            Err(_) => err("The host did not answer in time."),
        }
    }
}
