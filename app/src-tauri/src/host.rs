//! Method D in the app: "Host from this PC" (the server of crates/server running inside BIForge) and the guest side
//! (joining a server with an invite link, listing and opening its reports in viewing mode, asking it DAX queries).
//!
//! Tokens (the host's admin token, each guest's member token) live only in the Windows Credential Manager under
//! `biforge.server.<connection id>`; the connection list in `server-connections.json` holds no secrets.
//! `BIFORGE_APP_DIR` (a test seam, also usable for a portable install) replaces `%LOCALAPPDATA%\BIForge`.

use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use biforge_publish::backend::*;
use biforge_publish::deeplink::{self, Link};
use biforge_publish::http::{Http, ReqwestHttp};
use biforge_publish::keys::KeyStore;
use biforge_publish::package::check_path;
use biforge_publish::server::token_key;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::publish::CredKeys;

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub const HOST_CONNECTION: &str = "host";
const HOST_ADMIN_KEY: &str = "biforge.host.admin";
pub const DEFAULT_PORT: u16 = 7878;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub label: String,
    pub url: String,
    /// Empty for the host's own connection (the admin token reaches every workspace).
    pub workspace_id: String,
    pub workspace_name: String,
    pub role: WsRole,
    pub identity: String,
    pub is_host: bool,
    /// SHA-256 fingerprint of the server's self-signed certificate (from the invitation link or the host itself).
    #[serde(default)]
    pub pin: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub running: bool,
    pub url: String,
    /// The certificate fingerprint when the host speaks HTTPS.
    pub fingerprint: Option<String>,
    /// Shown once, when the host was started for the first time (it is also kept in the Credential Manager).
    pub admin_token: Option<String>,
    pub lan: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedServerReport {
    pub root: String,
    pub pbip_path: String,
    pub connection_id: String,
    pub workspace_id: String,
    pub report_id: String,
    pub report_name: String,
    pub version: u64,
    pub role: WsRole,
    pub identity: String,
    pub server_label: String,
}

struct Inner {
    keys: Arc<CredKeys>,
    http: Arc<dyn Http>,
    app_dir: PathBuf,
    running: Mutex<Option<(biforge_server::Running, bool)>>,
}

#[derive(Clone)]
pub struct HostService(Arc<Inner>);

fn new_id() -> String {
    format!("c_{}", biforge_publish::keys::hex(&biforge_publish::keys::random_bytes::<5>()))
}

impl HostService {
    pub fn new(keys: Arc<CredKeys>, app_dir: PathBuf) -> Self {
        let http: Arc<dyn Http> = match ReqwestHttp::new() {
            Ok(h) => Arc::new(h),
            Err(_) => Arc::new(biforge_publish::http::FakeHttp::new(vec![])),
        };
        Self(Arc::new(Inner { keys, http, app_dir, running: Mutex::new(None) }))
    }

    pub fn system() -> Self {
        let app_dir = crate::publish::app_dir_default();
        Self::new(Arc::new(CredKeys(Arc::new(biforge_engine::SystemCredentialStore))), app_dir)
    }

    fn conn_path(&self) -> PathBuf {
        self.0.app_dir.join("server-connections.json")
    }

    fn read_connections(&self) -> Vec<Connection> {
        fs::read(self.conn_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn write_connections(&self, list: &[Connection]) -> Result<(), String> {
        fs::create_dir_all(&self.0.app_dir).map_err(msg)?;
        fs::write(self.conn_path(), serde_json::to_vec_pretty(list).map_err(msg)?).map_err(msg)
    }

    fn connection(&self, id: &str) -> Result<Connection, String> {
        self.read_connections().into_iter().find(|c| c.id == id).ok_or_else(|| "This server connection no longer exists. Join the server again.".to_string())
    }

    fn token(&self, id: &str) -> Result<String, String> {
        self.0.keys.get(&token_key(id)).map_err(msg)?.ok_or_else(|| "You are not signed in to this server any more. Join it again with an invitation.".to_string())
    }

    // ---- hosting ----

    pub fn status(&self) -> HostStatus {
        match &*self.0.running.lock().unwrap() {
            Some((r, lan)) => HostStatus { running: true, url: r.url(), fingerprint: r.fingerprint.clone(), admin_token: None, lan: *lan },
            None => HostStatus { running: false, url: String::new(), fingerprint: None, admin_token: None, lan: false },
        }
    }

    /// Starts the server inside the app. `lan`: listen on all network interfaces (other computers can connect);
    /// otherwise only this PC can (the safe default). `public_url` is the address other computers use (goes into
    /// invite links); without it the link carries this PC's loopback address.
    pub fn start(&self, lan: bool, port: Option<u16>, public_url: Option<String>, tls: bool) -> Result<HostStatus, String> {
        let mut g = self.0.running.lock().unwrap();
        if g.is_some() {
            return Err("Hosting is already on.".into());
        }
        let stored = self.0.keys.get(HOST_ADMIN_KEY).map_err(msg)?;
        let token = match stored {
            Some(t) => t,
            None => format!("bfa_{}", biforge_publish::keys::hex(&biforge_publish::keys::random_bytes::<32>())),
        };
        let bind: SocketAddr = format!("{}:{}", if lan { "0.0.0.0" } else { "127.0.0.1" }, port.unwrap_or(DEFAULT_PORT)).parse().map_err(msg)?;
        let public = public_url.filter(|u| !u.trim().is_empty()).map(|u| u.trim().trim_end_matches('/').to_string());
        let running = biforge_server::start(biforge_server::Config { data_dir: self.0.app_dir.join("host"), bind, admin_token: Some(token.clone()), public_url: public, tls })?;
        self.0.keys.set(HOST_ADMIN_KEY, &token).map_err(msg)?;
        self.0.keys.set(&token_key(HOST_CONNECTION), &token).map_err(msg)?;
        let url = running.url();
        let fingerprint = running.fingerprint.clone();
        if let Some(fp) = &fingerprint {
            biforge_publish::pin::apply(self.0.http.as_ref(), &url, fp);
        }
        *g = Some((running, lan));
        // the host's own connection
        let mut list = self.read_connections();
        list.retain(|c| c.id != HOST_CONNECTION);
        list.insert(0, Connection { id: HOST_CONNECTION.into(), label: "This PC (host)".into(), url: url.clone(), workspace_id: String::new(), workspace_name: String::new(), role: WsRole::Admin, identity: "server admin".into(), is_host: true, pin: fingerprint.clone() });
        self.write_connections(&list)?;
        Ok(HostStatus { running: true, url, fingerprint, admin_token: None, lan })
    }

    pub fn stop(&self) -> Result<(), String> {
        let taken = self.0.running.lock().unwrap().take();
        match taken {
            Some((r, _)) => {
                r.stop();
                Ok(())
            }
            None => Err("Hosting is not on.".into()),
        }
    }

    // ---- guests ----

    /// Joins a server with an invite link (`biforge://open?src=server...`) or with a server address and an invite code.
    pub fn join(&self, link_or_url: &str, invite: Option<String>, display_name: &str, pin: Option<String>) -> Result<Connection, String> {
        let pin_arg = match pin.filter(|p| !p.trim().is_empty()) {
            Some(p) => Some(biforge_publish::pin::normalize(&p).map_err(msg)?),
            None => None,
        };
        let (url, invite, pin) = match deeplink::parse(link_or_url.trim()) {
            Ok(Link::Server { url, invite, pin }) => (url, invite, pin),
            Ok(_) => return Err("This link is not an invitation to a server.".into()),
            Err(_) => {
                let url = link_or_url.trim().trim_end_matches('/').to_string();
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err("Paste the invitation link, or the server address (http://...) together with the invitation code.".into());
                }
                (url, invite.filter(|i| !i.trim().is_empty()).ok_or("Enter the invitation code.")?.trim().to_string(), pin_arg)
            }
        };
        if let Some(p) = &pin {
            biforge_publish::pin::apply(self.0.http.as_ref(), &url, p);
        }
        let j = Client::join(self.0.http.as_ref(), &url, &invite, display_name).map_err(msg)?;
        let id = new_id();
        self.0.keys.set(&token_key(&id), &j.token).map_err(msg)?;
        let conn = Connection { id, label: format!("{} on {}", j.workspace_name, url), url, workspace_id: j.workspace_id, workspace_name: j.workspace_name, role: j.role, identity: j.identity, is_host: false, pin };
        let mut list = self.read_connections();
        list.push(conn.clone());
        self.write_connections(&list)?;
        Ok(conn)
    }

    /// Connects to a standalone server as its administrator with the admin token it printed (kept in the Credential
    /// Manager). `pin` is the certificate fingerprint it printed (needed for https servers).
    pub fn connect_admin(&self, url: &str, admin_token: &str, pin: Option<String>) -> Result<Connection, String> {
        let url = url.trim().trim_end_matches('/').to_string();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("Enter the server address (https://... or http://...).".into());
        }
        let pin = match pin.filter(|p| !p.trim().is_empty()) {
            Some(p) => Some(biforge_publish::pin::normalize(&p).map_err(msg)?),
            None => None,
        };
        if let Some(p) = &pin {
            biforge_publish::pin::apply(self.0.http.as_ref(), &url, p);
        }
        let token = admin_token.trim();
        Client::new(self.0.http.as_ref(), &url, token).workspaces().map_err(|e| format!("Could not sign in as the server administrator: {e}"))?;
        let id = new_id();
        self.0.keys.set(&token_key(&id), token).map_err(msg)?;
        let conn = Connection { id, label: format!("Admin of {url}"), url, workspace_id: String::new(), workspace_name: String::new(), role: WsRole::Admin, identity: "server admin".into(), is_host: false, pin };
        let mut list = self.read_connections();
        list.push(conn.clone());
        self.write_connections(&list)?;
        Ok(conn)
    }

    pub fn connections(&self) -> Vec<Connection> {
        let running = self.0.running.lock().unwrap().is_some();
        self.read_connections().into_iter().filter(|c| !c.is_host || running).collect()
    }

    /// Forgets a connection and its stored token (the server keeps the member until an admin revokes it).
    pub fn forget(&self, id: &str) -> Result<(), String> {
        if id == HOST_CONNECTION {
            return Err("Turn hosting off instead.".into());
        }
        let mut list = self.read_connections();
        list.retain(|c| c.id != id);
        self.write_connections(&list)?;
        self.0.keys.delete(&token_key(id)).map_err(msg)
    }

    fn client(&self, conn: &Connection) -> Result<Client<'_>, String> {
        if let Some(p) = &conn.pin {
            biforge_publish::pin::apply(self.0.http.as_ref(), &conn.url, p);
        }
        Ok(Client::new(self.0.http.as_ref(), &conn.url, &self.token(&conn.id)?))
    }

    /// One call to a connection's server. `op` names the call, `args` its parameters (JSON, camelCase).
    pub fn op(&self, connection: &str, op: &str, args: Value) -> Result<Value, String> {
        let conn = self.connection(connection)?;
        let c = self.client(&conn)?;
        let ws = |a: &Value| -> Result<String, String> {
            let w = a.get("workspace").and_then(|v| v.as_str()).map(str::to_string).unwrap_or_else(|| conn.workspace_id.clone());
            if w.is_empty() {
                return Err("Choose a workspace first.".into());
            }
            Ok(w)
        };
        let s = |a: &Value, k: &str| -> Result<String, String> { a.get(k).and_then(|v| v.as_str()).map(str::to_string).ok_or_else(|| format!("Missing {k}.")) };
        fn to<T: Serialize>(r: biforge_publish::Result<T>) -> Result<Value, String> {
            serde_json::to_value(r.map_err(msg)?).map_err(msg)
        }
        match op {
            "workspaces" => to(c.workspaces()),
            "createWorkspace" => to(c.create_workspace(&s(&args, "name")?)),
            "invite" => {
                let req: InviteRequest = serde_json::from_value(args.get("request").cloned().unwrap_or(Value::Null)).map_err(msg)?;
                to(c.invite(&ws(&args)?, &req))
            }
            "members" => to(c.members(&ws(&args)?)),
            "setMember" => {
                let role: Option<WsRole> = args.get("role").and_then(|r| serde_json::from_value(r.clone()).ok());
                let rls: Option<Vec<String>> = args.get("rlsRoles").and_then(|r| serde_json::from_value(r.clone()).ok());
                to(c.set_member(&ws(&args)?, &s(&args, "member")?, role, rls))
            }
            "revoke" => to(c.revoke(&ws(&args)?, &s(&args, "member")?)),
            "audit" => to(c.audit(&ws(&args)?)),
            "reports" => to(c.reports(&ws(&args)?)),
            "deleteReport" => to(c.delete_report(&ws(&args)?, &s(&args, "report")?)),
            "versions" => to(c.versions(&ws(&args)?, &s(&args, "report")?)),
            "refreshInfo" => to(c.refresh_info(&ws(&args)?, &s(&args, "report")?)),
            "refreshSet" => {
                let plan: biforge_publish::schedule::Plan = serde_json::from_value(args.get("plan").cloned().unwrap_or(Value::Null)).map_err(msg)?;
                let enabled = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                to(c.refresh_set(&ws(&args)?, &s(&args, "report")?, enabled, &plan))
            }
            "refreshRun" => to(c.refresh_run(&ws(&args)?, &s(&args, "report")?)),
            "refreshSource" => {
                let path = s(&args, "path")?;
                let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).ok_or("Choose a file.")?;
                let bytes = fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
                to(c.refresh_put_source(&ws(&args)?, &s(&args, "report")?, &name, bytes))
            }
            "collabSync" => {
                let b = base64::engine::general_purpose::STANDARD;
                let dec = |k: &str| -> Result<Vec<u8>, String> { b.decode(args.get(k).and_then(|v| v.as_str()).unwrap_or("")).map_err(msg) };
                let seed = args.get("seed").and_then(|v| v.as_bool()).unwrap_or(false);
                let summary = args.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                let r = c.collab_sync(&ws(&args)?, &s(&args, "report")?, &dec("stateVector")?, &dec("update")?, seed, summary).map_err(msg)?;
                Ok(serde_json::json!({"update": b.encode(&r.update), "stateVector": b.encode(&r.state_vector), "seeded": r.seeded, "empty": r.empty}))
            }
            "collabChanges" => to(c.collab_changes(&ws(&args)?, &s(&args, "report")?)),
            "comments" => to(c.comments(&ws(&args)?, &s(&args, "report")?)),
            "addComment" => {
                let anchor: biforge_collab::Anchor = serde_json::from_value(args.get("anchor").cloned().unwrap_or_default()).unwrap_or_default();
                let parent = args.get("parent").and_then(|v| v.as_str()).map(str::to_string);
                to(c.add_comment(&ws(&args)?, &s(&args, "report")?, &s(&args, "text")?, &anchor, parent.as_deref()))
            }
            "resolveComment" => to(c.resolve_comment(&ws(&args)?, &s(&args, "report")?, &s(&args, "id")?, args.get("resolved").and_then(|v| v.as_bool()).unwrap_or(true))),
            "deleteComment" => to(c.delete_comment(&ws(&args)?, &s(&args, "report")?, &s(&args, "id")?)),
            "mentions" => to(c.mentions(&ws(&args)?)),
            "restoreVersion" => {
                let v = args.get("version").and_then(|v| v.as_u64()).ok_or("Missing version.")?;
                to(c.restore_version(&ws(&args)?, &s(&args, "report")?, v))
            }
            "roles" => to(c.roles(&ws(&args)?, &s(&args, "report")?)),
            "setRoles" => {
                let roles: Vec<RlsRole> = serde_json::from_value(args.get("roles").cloned().unwrap_or(Value::Null)).map_err(msg)?;
                to(c.set_roles(&ws(&args)?, &s(&args, "report")?, &roles))
            }
            "query" => c.query(&ws(&args)?, &s(&args, "report")?, &s(&args, "query")?).map_err(msg),
            other => Err(format!("Unknown server operation \"{other}\".")),
        }
    }

    /// Downloads the project files (no data) of a server report into the viewing cache for viewing mode.
    pub fn open_report(&self, connection: &str, workspace: Option<String>, report: &str) -> Result<OpenedServerReport, String> {
        let conn = self.connection(connection)?;
        let ws = workspace.filter(|w| !w.is_empty()).unwrap_or_else(|| conn.workspace_id.clone());
        if ws.is_empty() {
            return Err("Choose a workspace first.".into());
        }
        let c = self.client(&conn)?;
        let info = c.reports(&ws).map_err(msg)?.into_iter().find(|r| r.id == report).ok_or("This report is not on the server (any more).")?;
        let files = c.project(&ws, report).map_err(msg)?;
        let root = self.0.app_dir.join("viewing").join(format!("server-{}-{}", conn.id, report));
        if root.exists() {
            fs::remove_dir_all(&root).map_err(|e| format!("Could not clear the previous copy: {e}"))?;
        }
        fs::create_dir_all(&root).map_err(msg)?;
        let mut pbip = None;
        for (name, bytes) in &files {
            check_path(name).map_err(msg)?;
            let rel = name.strip_prefix("project/").ok_or("The server sent a file outside the project.")?;
            let dest = root.join(rel);
            if let Some(dir) = dest.parent() {
                fs::create_dir_all(dir).map_err(msg)?;
            }
            fs::write(&dest, bytes).map_err(msg)?;
            if !rel.contains('/') && rel.ends_with(".pbip") {
                pbip = Some(dest);
            }
        }
        let pbip = pbip.ok_or("The report on the server has no .pbip project file.")?;
        let who = if conn.is_host { WsRole::Admin } else { conn.role };
        Ok(OpenedServerReport {
            root: root.display().to_string(),
            pbip_path: pbip.display().to_string(),
            connection_id: conn.id.clone(),
            workspace_id: ws,
            report_id: report.to_string(),
            report_name: info.name,
            version: info.version,
            role: who,
            identity: conn.identity.clone(),
            server_label: conn.label.clone(),
        })
    }

    pub fn app_dir(&self) -> &Path {
        &self.0.app_dir
    }
}

// ---- Tauri commands (thin wrappers; blocking work runs off the UI thread) ----

type St<'a> = tauri::State<'a, HostService>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(msg)?
}

#[tauri::command]
pub async fn host_status(s: St<'_>) -> Result<HostStatus, String> {
    Ok(s.status())
}
#[tauri::command]
pub async fn host_start(s: St<'_>, lan: bool, port: Option<u16>, public_url: Option<String>, tls: Option<bool>) -> Result<HostStatus, String> {
    let s = s.inner().clone();
    blocking(move || s.start(lan, port, public_url, tls.unwrap_or(true))).await
}
#[tauri::command]
pub async fn host_stop(s: St<'_>) -> Result<(), String> {
    let s = s.inner().clone();
    blocking(move || s.stop()).await
}
#[tauri::command]
pub async fn server_join(s: St<'_>, link_or_url: String, invite: Option<String>, display_name: String, pin: Option<String>) -> Result<Connection, String> {
    let s = s.inner().clone();
    blocking(move || s.join(&link_or_url, invite, &display_name, pin)).await
}
#[tauri::command]
pub async fn server_connect_admin(s: St<'_>, url: String, admin_token: String, pin: Option<String>) -> Result<Connection, String> {
    let s = s.inner().clone();
    blocking(move || s.connect_admin(&url, &admin_token, pin)).await
}
#[tauri::command]
pub async fn server_connections(s: St<'_>) -> Result<Vec<Connection>, String> {
    Ok(s.connections())
}
#[tauri::command]
pub async fn server_forget(s: St<'_>, id: String) -> Result<(), String> {
    let s = s.inner().clone();
    blocking(move || s.forget(&id)).await
}
#[tauri::command]
pub async fn server_op(s: St<'_>, connection: String, op: String, args: Value) -> Result<Value, String> {
    let s = s.inner().clone();
    blocking(move || s.op(&connection, &op, args)).await
}
#[tauri::command]
pub async fn server_open_report(s: St<'_>, connection: String, workspace: Option<String>, report: String) -> Result<OpenedServerReport, String> {
    let s = s.inner().clone();
    blocking(move || s.open_report(&connection, workspace, &report)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use biforge_engine::MemoryCredentialStore;
    use serde_json::json;

    fn svc(dir: &Path) -> HostService {
        HostService::new(Arc::new(CredKeys(Arc::new(MemoryCredentialStore::default()))), dir.to_path_buf())
    }

    #[test]
    fn host_invite_join_and_roles_through_the_app_layer() {
        let host_dir = tempfile::tempdir().unwrap();
        let guest_dir = tempfile::tempdir().unwrap();
        let host = svc(host_dir.path());
        let guest = svc(guest_dir.path());
        assert!(!host.status().running);
        let st = host.start(false, Some(0), None, false).unwrap();
        assert!(st.running && st.url.starts_with("http://127.0.0.1:") && st.fingerprint.is_none());
        assert!(host.start(false, Some(0), None, false).is_err(), "starting twice is refused");

        let ws = host.op(HOST_CONNECTION, "createWorkspace", json!({"name": "Team"})).unwrap();
        let wid = ws["id"].as_str().unwrap().to_string();
        let inv = host.op(HOST_CONNECTION, "invite", json!({"workspace": wid, "request": {"role": "viewer", "identity": "g@x.com", "rlsRoles": [], "expiresMinutes": 30}})).unwrap();
        let link = inv["link"].as_str().unwrap().to_string();

        // the guest is a second instance with its own data folder
        assert!(guest.join("not a link", None, "Guest", None).is_err());
        let conn = guest.join(&link, None, "Guest", None).unwrap();
        assert_eq!((conn.role, conn.identity.as_str(), conn.workspace_id.as_str()), (WsRole::Viewer, "g@x.com", wid.as_str()));
        assert_eq!(guest.connections().len(), 1);
        assert!(guest.join(&link, None, "Again", None).unwrap_err().contains("already used"));
        // a guest cannot do admin things; the host can
        assert!(guest.op(&conn.id, "members", json!({})).is_err());
        let members = host.op(HOST_CONNECTION, "members", json!({"workspace": wid})).unwrap();
        assert_eq!(members.as_array().unwrap().len(), 1);
        host.op(HOST_CONNECTION, "revoke", json!({"workspace": wid, "member": members[0]["id"]})).unwrap();
        assert!(guest.op(&conn.id, "reports", json!({})).unwrap_err().contains("revoked"));
        guest.forget(&conn.id).unwrap();
        assert!(guest.connections().is_empty());

        host.stop().unwrap();
        assert!(!host.status().running && host.stop().is_err());
        // hosting again keeps the admin token (workspaces survive)
        host.start(false, Some(0), None, false).unwrap();
        assert_eq!(host.op(HOST_CONNECTION, "workspaces", json!({})).unwrap().as_array().unwrap().len(), 1);
        host.stop().unwrap();
    }

    #[test]
    fn the_same_flow_over_tls_with_the_certificate_pinned_by_the_link() {
        let (host_dir, guest_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (host, guest) = (svc(host_dir.path()), svc(guest_dir.path()));
        let st = host.start(false, Some(0), None, true).unwrap();
        assert!(st.url.starts_with("https://127.0.0.1:"));
        let fp = st.fingerprint.clone().expect("a fingerprint");
        let wid = host.op(HOST_CONNECTION, "createWorkspace", json!({"name": "Team"})).unwrap()["id"].as_str().unwrap().to_string();
        let invite = |who: &str| host.op(HOST_CONNECTION, "invite", json!({"workspace": wid, "request": {"role": "editor", "identity": who, "rlsRoles": [], "expiresMinutes": 30}})).unwrap();
        let link = invite("a@x.com")["link"].as_str().unwrap().to_string();
        assert!(link.contains(&format!("pin={fp}")), "{link}");
        // the same link without its pin cannot be used: the certificate is not from a public authority
        let unpinned = link.split("&pin=").next().unwrap().to_string();
        assert!(guest.join(&unpinned, None, "Eve", None).is_err());
        // a wrong pin is refused as well
        let wrong = format!("{unpinned}&pin={}", "ab".repeat(32));
        let e = guest.join(&wrong, None, "Eve", None).unwrap_err();
        assert!(!e.is_empty());
        let conn = guest.join(&link, None, "Ann", None).unwrap();
        assert_eq!(conn.pin.as_deref(), Some(fp.as_str()));
        assert!(guest.op(&conn.id, "reports", json!({})).is_ok());
        // an admin of the same server by token and pin (the standalone-server path)
        let admin_token = host.0.keys.get(HOST_ADMIN_KEY).unwrap().unwrap();
        let g2 = svc(tempfile::tempdir().unwrap().path());
        assert!(g2.connect_admin(&st.url, &admin_token, None).is_err(), "https without a pin is refused");
        let adm = g2.connect_admin(&st.url, &admin_token, Some(fp)).unwrap();
        assert_eq!(g2.op(&adm.id, "workspaces", json!({})).unwrap().as_array().unwrap().len(), 1);
        host.stop().unwrap();
    }
}
