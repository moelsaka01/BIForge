//! Direct sharing (method C) in the app: host sessions per publication target, guest sessions, and the bridge the
//! publishing engine uses to start or update a session. The network code is `crates/p2p` (iroh); this file only
//! keeps the sessions and moves package bytes to and from files.
//!
//! `BIFORGE_P2P_LOCAL=1` (a test seam, also useful on a LAN without internet) uses direct addresses only: no relay
//! servers and no DNS lookup, and the pairing code shown is the long form that carries the host's addresses.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use biforge_p2p::{Guest, GuestOptions, GuestState, HostOptions, HostSession, JoinRequest, Network, PeerInfo, PushInfo, Role};
use biforge_publish::p2p::P2pBridge;
use serde::Serialize;

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn network() -> Network {
    if std::env::var("BIFORGE_P2P_LOCAL").map(|v| v == "1").unwrap_or(false) {
        Network::Local
    } else {
        Network::Internet
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub running: bool,
    /// The code to give to the guest (the long form when only direct addresses work).
    pub code: String,
    /// The long form (also works on a network without internet).
    pub ticket: String,
    pub expires_at: u64,
    pub version: u64,
    pub pending: Vec<JoinRequest>,
    pub peers: Vec<PeerInfo>,
    pub pushes: Vec<PushInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPackage {
    pub version: u64,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestView {
    /// waiting, approved, denied or ended
    pub state: String,
    pub reason: String,
    pub role: String,
    pub host_id: String,
    pub new_package: Option<NewPackage>,
    pub message: Option<String>,
}

struct Inner {
    app_dir: PathBuf,
    hosts: Mutex<HashMap<String, HostSession>>,
    guests: Mutex<HashMap<String, Guest>>,
}

pub struct P2pService(Arc<Inner>);

impl P2pService {
    pub fn new(app_dir: PathBuf) -> Self {
        Self(Arc::new(Inner { app_dir, hosts: Mutex::new(HashMap::new()), guests: Mutex::new(HashMap::new()) }))
    }

    pub fn system() -> Self {
        Self::new(crate::publish::app_dir_default())
    }

    fn code_of(s: &HostSession) -> String {
        if network() == Network::Local {
            s.pairing().ticket()
        } else {
            s.pairing().short()
        }
    }

    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    // ---- host ----

    pub fn host_view(&self, target: &str) -> HostView {
        let g = self.0.hosts.lock().unwrap();
        match g.get(target).filter(|s| s.expires_at() > Self::now()) {
            Some(s) => HostView { running: true, code: Self::code_of(s), ticket: s.pairing().ticket(), expires_at: s.expires_at(), version: s.version(), pending: s.pending(), peers: s.peers(), pushes: s.pushes() },
            None => HostView { running: false, code: String::new(), ticket: String::new(), expires_at: 0, version: 0, pending: vec![], peers: vec![], pushes: vec![] },
        }
    }

    fn with_host<T>(&self, target: &str, f: impl FnOnce(&HostSession) -> Result<T, biforge_p2p::P2pError>) -> Result<T, String> {
        let g = self.0.hosts.lock().unwrap();
        let s = g.get(target).ok_or("The direct session is not running. Publish again to start it.")?;
        f(s).map_err(msg)
    }

    pub fn approve(&self, target: &str, request: u64, role: &str) -> Result<(), String> {
        let role = match role {
            "readOnly" => Role::ReadOnly,
            "edit" => Role::Edit,
            other => return Err(format!("Unknown role \"{other}\".")),
        };
        self.with_host(target, |s| s.approve(request, role))
    }
    pub fn deny(&self, target: &str, request: u64) -> Result<(), String> {
        self.with_host(target, |s| s.deny(request))
    }
    pub fn revoke(&self, target: &str, endpoint: &str) -> Result<(), String> {
        self.with_host(target, |s| s.revoke(endpoint))
    }

    /// Saves a changed copy a guest sent as a file and returns its path. The host opens it like any shared report.
    pub fn take_push(&self, target: &str, push: u64) -> Result<String, String> {
        let (bytes, name) = {
            let g = self.0.hosts.lock().unwrap();
            let s = g.get(target).ok_or("The direct session is not running.")?;
            let name = s.pushes().into_iter().find(|p| p.id == push).map(|p| p.name).unwrap_or_else(|| "guest".into());
            (s.take_push(push).map_err(msg)?, name)
        };
        let dir = self.0.app_dir.join("p2p-incoming");
        fs::create_dir_all(&dir).map_err(msg)?;
        let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        let path = dir.join(format!("{safe}-{push}.biforge"));
        fs::write(&path, bytes).map_err(msg)?;
        Ok(path.display().to_string())
    }

    // ---- guest ----

    pub async fn join(&self, code: &str, name: &str) -> Result<String, String> {
        let guest = Guest::connect(code, name, GuestOptions { network: network(), ..GuestOptions::default() }).await.map_err(msg)?;
        let id = format!("g_{}", biforge_publish::keys::hex(&biforge_publish::keys::random_bytes::<5>()));
        self.0.guests.lock().unwrap().insert(id.clone(), guest);
        Ok(id)
    }

    pub fn guest_view(&self, id: &str) -> Result<GuestView, String> {
        let g = self.0.guests.lock().unwrap();
        let guest = g.get(id).ok_or("This direct session is closed.")?;
        let (state, reason) = match guest.state() {
            GuestState::Waiting => ("waiting", String::new()),
            GuestState::Approved => ("approved", String::new()),
            GuestState::Denied { reason } => ("denied", reason),
            GuestState::Ended { reason } => ("ended", reason),
        };
        let mut new_package = None;
        if state == "approved" || state == "ended" {
            if let Some((version, bytes)) = guest.take_new() {
                let dir = self.0.app_dir.join("p2p-guest");
                fs::create_dir_all(&dir).map_err(msg)?;
                let path = dir.join(format!("{id}-v{version}.biforge"));
                fs::write(&path, bytes).map_err(msg)?;
                new_package = Some(NewPackage { version, path: path.display().to_string() });
            }
        }
        Ok(GuestView { state: state.into(), reason, role: if guest.role() == Role::Edit { "edit".into() } else { "readOnly".into() }, host_id: guest.host_id().to_string(), new_package, message: guest.take_push_message() })
    }

    pub fn push(&self, id: &str, path: &str) -> Result<(), String> {
        let bytes = fs::read(path).map_err(|e| format!("Could not read the file: {e}"))?;
        if !path.to_ascii_lowercase().ends_with(".biforge") {
            return Err("Choose a .biforge package.".into());
        }
        let g = self.0.guests.lock().unwrap();
        g.get(id).ok_or("This direct session is closed.")?.push(bytes).map_err(msg)
    }

    pub async fn leave(&self, id: &str) -> Result<(), String> {
        let guest = self.0.guests.lock().unwrap().remove(id);
        if let Some(g) = guest {
            g.leave().await;
        }
        Ok(())
    }

    pub async fn stop_host(&self, target: &str) -> Result<(), String> {
        let s = self.0.hosts.lock().unwrap().remove(target);
        if let Some(s) = s {
            s.stop().await;
        }
        Ok(())
    }
}

impl P2pBridge for P2pService {
    fn publish(&self, target_id: &str, package: &[u8], version: u64, expires_minutes: u64) -> biforge_publish::Result<String> {
        {
            let g = self.0.hosts.lock().unwrap();
            if let Some(s) = g.get(target_id).filter(|s| s.expires_at() > Self::now()) {
                s.publish(package.to_vec(), version);
                return Ok(Self::code_of(s));
            }
        }
        // a session that expired is replaced by a fresh one (new code)
        let old = self.0.hosts.lock().unwrap().remove(target_id);
        let package = package.to_vec();
        let net = network();
        let session = tauri::async_runtime::block_on(async move {
            if let Some(o) = old {
                o.stop().await;
            }
            HostSession::start(package, version, HostOptions { network: net, expires_in: Duration::from_secs(expires_minutes * 60), secret_key: None, host_name: "Host".into() }).await
        })
        .map_err(|e| biforge_publish::Error::Adapter(e.0))?;
        let code = Self::code_of(&session);
        self.0.hosts.lock().unwrap().insert(target_id.to_string(), session);
        Ok(code)
    }

    fn status(&self, target_id: &str) -> Option<(u64, String)> {
        let g = self.0.hosts.lock().unwrap();
        g.get(target_id).filter(|s| s.expires_at() > Self::now()).map(|s| (s.version(), Self::code_of(s)))
    }

    fn stop(&self, target_id: &str) -> biforge_publish::Result<()> {
        let s = self.0.hosts.lock().unwrap().remove(target_id);
        if let Some(s) = s {
            tauri::async_runtime::block_on(s.stop());
        }
        Ok(())
    }
}

type St<'a> = tauri::State<'a, Arc<P2pService>>;

#[tauri::command]
pub async fn p2p_host_state(s: St<'_>, target_id: String) -> Result<HostView, String> {
    Ok(s.host_view(&target_id))
}
#[tauri::command]
pub async fn p2p_approve(s: St<'_>, target_id: String, request: u64, role: String) -> Result<(), String> {
    s.approve(&target_id, request, &role)
}
#[tauri::command]
pub async fn p2p_deny(s: St<'_>, target_id: String, request: u64) -> Result<(), String> {
    s.deny(&target_id, request)
}
#[tauri::command]
pub async fn p2p_revoke(s: St<'_>, target_id: String, endpoint_id: String) -> Result<(), String> {
    s.revoke(&target_id, &endpoint_id)
}
#[tauri::command]
pub async fn p2p_take_push(s: St<'_>, target_id: String, push: u64) -> Result<String, String> {
    s.take_push(&target_id, push)
}
#[tauri::command]
pub async fn p2p_join(s: St<'_>, code: String, name: String) -> Result<String, String> {
    s.join(&code, &name).await
}
#[tauri::command]
pub async fn p2p_guest_state(s: St<'_>, id: String) -> Result<GuestView, String> {
    s.guest_view(&id)
}
#[tauri::command]
pub async fn p2p_push(s: St<'_>, id: String, path: String) -> Result<(), String> {
    s.push(&id, &path)
}
#[tauri::command]
pub async fn p2p_leave(s: St<'_>, id: String) -> Result<(), String> {
    s.leave(&id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn wait<T>(mut f: impl FnMut() -> Option<T>) -> T {
        let t = Instant::now();
        loop {
            if let Some(v) = f() {
                return v;
            }
            assert!(t.elapsed() < Duration::from_secs(20), "timed out");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn host_and_guest_services_pair_update_and_revoke() {
        std::env::set_var("BIFORGE_P2P_LOCAL", "1");
        let host_dir = tempfile::tempdir().unwrap();
        let guest_dir = tempfile::tempdir().unwrap();
        let host = P2pService::new(host_dir.path().to_path_buf());
        let guest = P2pService::new(guest_dir.path().to_path_buf());

        let code = P2pBridge::publish(&host, "t1", b"v1", 1, 30).unwrap();
        assert!(code.starts_with("BF1T-"), "{code}");
        assert_eq!(P2pBridge::status(&host, "t1").unwrap().0, 1);
        let id = tauri::async_runtime::block_on(guest.join(&code, "Ann")).unwrap();
        let v = host.host_view("t1");
        let req = wait(|| host.host_view("t1").pending.first().cloned());
        assert_eq!(req.name, "Ann");
        assert!(v.running && v.pushes.is_empty());
        assert_eq!(guest.guest_view(&id).unwrap().state, "waiting");
        host.approve("t1", req.id, "edit").unwrap();
        let first = wait(|| guest.guest_view(&id).unwrap().new_package);
        assert_eq!((first.version, fs::read(&first.path).unwrap()), (1, b"v1".to_vec()));
        // a new version reaches the guest, and the guest's changed copy reaches the host as a file
        P2pBridge::publish(&host, "t1", b"v2", 2, 30).unwrap();
        let second = wait(|| guest.guest_view(&id).unwrap().new_package);
        assert_eq!((second.version, fs::read(&second.path).unwrap()), (2, b"v2".to_vec()));
        let mine = guest_dir.path().join("mine.biforge");
        fs::write(&mine, b"changed").unwrap();
        guest.push(&id, &mine.display().to_string()).unwrap();
        let push = wait(|| host.host_view("t1").pushes.first().cloned());
        let saved = host.take_push("t1", push.id).unwrap();
        assert_eq!(fs::read(saved).unwrap(), b"changed");
        // revoke ends the guest's access
        let peer = host.host_view("t1").peers[0].endpoint_id.clone();
        host.revoke("t1", &peer).unwrap();
        wait(|| (guest.guest_view(&id).unwrap().state == "ended").then_some(()));
        tauri::async_runtime::block_on(guest.leave(&id)).unwrap();
        P2pBridge::stop(&host, "t1").unwrap();
        assert!(P2pBridge::status(&host, "t1").is_none());
    }
}
