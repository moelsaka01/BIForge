//! Peer to peer sharing (method C of docs/ONLINE_PLAN.md) over iroh: encrypted QUIC between two BIForge apps,
//! dialed by the host's public key, with hole punching and the free public relay servers as fallback.
//!
//! Flow
//! 1. The host starts a [`HostSession`] with a signed package and gets a pairing code (`BF1-<endpoint id>-<secret>`;
//!    the ticket form `BF1T-...` also carries the host's addresses, for networks without internet).
//! 2. A guest [`Guest::connect`]s with the code and a display name. The host sees a *join request* (name, endpoint
//!    id) and must approve it explicitly, choosing a role: [`Role::ReadOnly`] or [`Role::Edit`]. The code alone
//!    never gives access.
//! 3. An approved guest receives the package and every later version the host publishes (live updates).
//!    A guest with the edit role can send a changed copy; the host receives it as a pending push and decides what
//!    to do with it (nothing is applied by itself; real co-editing is phase O6).
//! 4. The code expires; the host can revoke a guest at any time (the connection is closed and the endpoint id is
//!    refused afterwards); stopping the session ends everything.
//!
//! Limits (also in docs/COVERAGE.md): both computers must be online at the same time; the public relay servers have
//! no uptime guarantee and see connection metadata (never content); some networks (strict firewalls, some mobile
//! hotspots) prevent every kind of connection, and then the guest gets a message that names the other methods.

mod rpc;
pub use rpc::{Change, GuestCaller};

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc, oneshot};

pub const ALPN: &[u8] = b"biforge/p2p/1";
const PROTOCOL: u32 = 1;
/// Largest package accepted over a direct session.
pub const MAX_PACKAGE: u64 = 256 * 1024 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(30);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_BAD_CODES: u32 = 10;

pub const NO_CONNECTION_MESSAGE: &str = "BIForge could not reach the other computer. Both computers must be online at the same time, and some networks (strict firewalls, company networks, some mobile hotspots) block direct connections and relays. Use another way to share instead: Host from this PC over a VPN, a shared folder, or cloud storage.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P2pError(pub String);

impl std::fmt::Display for P2pError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for P2pError {}

fn err<T>(m: impl Into<String>) -> Result<T, P2pError> {
    Err(P2pError(m.into()))
}
fn e(m: impl std::fmt::Display) -> P2pError {
    P2pError(m.to_string())
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
fn sha(s: &str) -> String {
    biforge_publish::keys::hex(&Sha256::digest(s.as_bytes()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    ReadOnly,
    Edit,
}

/// How the endpoint reaches the other side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    /// The public relay servers and DNS lookup of the iroh project (the normal choice).
    Internet,
    /// Direct addresses only (the ticket form of the code carries them): a LAN without internet, and tests.
    Local,
}

async fn bind(network: Network, key: Option<SecretKey>, accept: bool) -> Result<Endpoint, P2pError> {
    let alpns = if accept { vec![ALPN.to_vec()] } else { vec![] };
    let b = match network {
        Network::Internet => Endpoint::builder(presets::N0).relay_mode(RelayMode::Default),
        Network::Local => Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled),
    };
    let b = b.alpns(alpns);
    let b = match key {
        Some(k) => b.secret_key(k),
        None => b,
    };
    b.bind().await.map_err(|x| P2pError(format!("Could not start the network endpoint: {x}")))
}

// ------------------------------------------------------------------------------------------------ pairing code

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    pub endpoint: EndpointAddr,
    pub secret: String,
}

#[derive(Serialize, Deserialize)]
struct TicketJson {
    id: String,
    addrs: Vec<String>,
    relay: Option<String>,
    secret: String,
}

impl Pairing {
    /// `BF1-<endpoint id>-<secret>`: enough when both sides have internet.
    pub fn short(&self) -> String {
        format!("BF1-{}-{}", self.endpoint.id, self.secret)
    }

    /// `BF1T-...`: also carries the host's addresses, so a LAN without internet works.
    pub fn ticket(&self) -> String {
        let j = TicketJson {
            id: self.endpoint.id.to_string(),
            addrs: self.endpoint.ip_addrs().map(|a| a.to_string()).collect(),
            relay: self.endpoint.relay_urls().next().map(|u| u.to_string()),
            secret: self.secret.clone(),
        };
        format!("BF1T-{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&j).unwrap_or_default()))
    }

    pub fn parse(code: &str) -> Result<Pairing, P2pError> {
        let code = code.trim();
        let bad = || P2pError("This is not a BIForge pairing code. It starts with BF1-.".into());
        if let Some(rest) = code.strip_prefix("BF1T-") {
            let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(rest).map_err(|_| bad())?;
            let j: TicketJson = serde_json::from_slice(&raw).map_err(|_| bad())?;
            let id: EndpointId = j.id.parse().map_err(|_| bad())?;
            let mut addr = EndpointAddr::new(id);
            for a in &j.addrs {
                addr = addr.with_ip_addr(a.parse().map_err(|_| bad())?);
            }
            if let Some(r) = &j.relay {
                addr = addr.with_relay_url(r.parse().map_err(|_| bad())?);
            }
            return Ok(Pairing { endpoint: addr, secret: j.secret });
        }
        let rest = code.strip_prefix("BF1-").ok_or_else(bad)?;
        let (id, secret) = rest.rsplit_once('-').ok_or_else(bad)?;
        if secret.len() < 8 {
            return Err(bad());
        }
        let id: EndpointId = id.parse().map_err(|_| bad())?;
        Ok(Pairing { endpoint: EndpointAddr::new(id), secret: secret.to_string() })
    }
}

// ------------------------------------------------------------------------------------------------ wire

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "t", rename_all = "camelCase")]
enum ToHost {
    Hello { secret: String, name: String, proto: u32 },
    Push { len: u64 },
    Bye,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "t", rename_all = "camelCase")]
enum ToGuest {
    Pending,
    Approved { role: Role, version: u64, expires_at: u64 },
    Denied { reason: String },
    Package { version: u64, len: u64 },
    Update { version: u64, len: u64 },
    PushResult { message: String },
    Revoked,
    Expired,
}

async fn write_frame<T: Serialize>(send: &mut SendStream, v: &T) -> Result<(), P2pError> {
    let b = serde_json::to_vec(v).map_err(e)?;
    send.write_all(&(b.len() as u32).to_be_bytes()).await.map_err(e)?;
    send.write_all(&b).await.map_err(e)
}

async fn read_frame<T: for<'d> Deserialize<'d>>(recv: &mut RecvStream) -> Result<T, P2pError> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.map_err(e)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > 64 * 1024 {
        return err("The other side sent a message that is too large.");
    }
    let mut buf = vec![0u8; n];
    recv.read_exact(&mut buf).await.map_err(e)?;
    serde_json::from_slice(&buf).map_err(e)
}

async fn write_blob(send: &mut SendStream, bytes: &[u8]) -> Result<(), P2pError> {
    send.write_all(bytes).await.map_err(e)
}

async fn read_blob(recv: &mut RecvStream, len: u64) -> Result<Vec<u8>, P2pError> {
    if len > MAX_PACKAGE {
        return err("The package is larger than the allowed size.");
    }
    let mut buf = vec![0u8; len as usize];
    recv.read_exact(&mut buf).await.map_err(e)?;
    Ok(buf)
}

// ------------------------------------------------------------------------------------------------ host

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequest {
    pub id: u64,
    pub name: String,
    pub endpoint_id: String,
    pub requested_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub endpoint_id: String,
    pub name: String,
    pub role: Role,
    pub connected: bool,
    pub revoked: bool,
    pub approved_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushInfo {
    pub id: u64,
    pub from: String,
    pub name: String,
    pub bytes: u64,
    pub received_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Event {
    JoinRequested { request: u64, name: String },
    Approved { endpoint_id: String, role: Role },
    Denied { endpoint_id: String },
    Revoked { endpoint_id: String },
    Connected { endpoint_id: String },
    Disconnected { endpoint_id: String },
    PushReceived { push: u64, name: String },
    Expired,
}

enum Decision {
    Approve(Role),
    Deny,
}

enum Out {
    Update { version: u64, bytes: Arc<Vec<u8>> },
    Revoke,
    Expire,
}

struct PendingRec {
    info: JoinRequest,
    tx: oneshot::Sender<Decision>,
}

struct PeerRec {
    name: String,
    role: Role,
    approved_at: u64,
    revoked: bool,
    tx: Option<mpsc::UnboundedSender<Out>>,
}

struct PushRec {
    info: PushInfo,
    bytes: Vec<u8>,
}

struct HostState {
    package: Arc<Vec<u8>>,
    version: u64,
    next_id: u64,
    bad_codes: u32,
    stopped: bool,
    pending: Vec<PendingRec>,
    peers: HashMap<String, PeerRec>,
    pushes: Vec<PushRec>,
}

struct HostShared {
    secret_hash: String,
    expires_at: u64,
    events: broadcast::Sender<Event>,
    st: Mutex<HostState>,
    collab: rpc::CollabState,
}

#[derive(Clone)]
struct Handler(Arc<HostShared>);

impl std::fmt::Debug for Handler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Handler")
    }
}

impl HostShared {
    fn emit(&self, ev: Event) {
        let _ = self.events.send(ev);
    }
}

pub struct HostOptions {
    pub network: Network,
    /// How long the pairing code (and the whole session) stays valid.
    pub expires_in: Duration,
    /// Keep the same identity across sessions (None: a new one each time).
    pub secret_key: Option<SecretKey>,
    /// The name comments and changes of the host carry.
    pub host_name: String,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self { network: Network::Internet, expires_in: Duration::from_secs(60 * 60), secret_key: None, host_name: "Host".into() }
    }
}

pub struct HostSession {
    shared: Arc<HostShared>,
    router: Router,
    pairing: Pairing,
}

impl HostSession {
    /// Starts hosting `package` (a signed `.biforge` package, version `version`).
    pub async fn start(package: Vec<u8>, version: u64, opts: HostOptions) -> Result<HostSession, P2pError> {
        let endpoint = bind(opts.network, opts.secret_key, true).await?;
        let secret = biforge_publish::keys::hex(&biforge_publish::keys::random_bytes::<10>());
        let (events, _) = broadcast::channel(64);
        let shared = Arc::new(HostShared {
            secret_hash: sha(&secret),
            expires_at: now() + opts.expires_in.as_secs(),
            events,
            st: Mutex::new(HostState { package: Arc::new(package), version, next_id: 1, bad_codes: 0, stopped: false, pending: vec![], peers: HashMap::new(), pushes: vec![] }),
            collab: rpc::CollabState::new(opts.host_name.clone()),
        });
        let router = Router::builder(endpoint.clone()).accept(ALPN, Handler(shared.clone())).spawn();
        if opts.network == Network::Internet {
            // the relay connection gives the code its address; do not wait forever without internet
            let _ = tokio::time::timeout(Duration::from_secs(10), endpoint.online()).await;
        }
        let pairing = Pairing { endpoint: endpoint.addr(), secret };
        // the session ends by itself when the code expires
        let s2 = shared.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(s2.expires_at.saturating_sub(now()))).await;
            let outs: Vec<_> = {
                let mut st = s2.st.lock().unwrap();
                st.stopped = true;
                st.peers.values().filter_map(|p| p.tx.clone()).collect()
            };
            for tx in outs {
                let _ = tx.send(Out::Expire);
            }
            s2.emit(Event::Expired);
        });
        Ok(HostSession { shared, router, pairing })
    }

    pub fn pairing(&self) -> &Pairing {
        &self.pairing
    }
    pub fn expires_at(&self) -> u64 {
        self.shared.expires_at
    }
    pub fn version(&self) -> u64 {
        self.shared.st.lock().unwrap().version
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.shared.events.subscribe()
    }

    pub fn pending(&self) -> Vec<JoinRequest> {
        self.shared.st.lock().unwrap().pending.iter().map(|p| p.info.clone()).collect()
    }

    pub fn approve(&self, request: u64, role: Role) -> Result<(), P2pError> {
        self.decide(request, Decision::Approve(role))
    }
    pub fn deny(&self, request: u64) -> Result<(), P2pError> {
        self.decide(request, Decision::Deny)
    }
    fn decide(&self, request: u64, d: Decision) -> Result<(), P2pError> {
        let mut st = self.shared.st.lock().unwrap();
        let i = st.pending.iter().position(|p| p.info.id == request).ok_or_else(|| P2pError("This request is no longer waiting (the guest may have left).".into()))?;
        let rec = st.pending.remove(i);
        rec.tx.send(d).map_err(|_| P2pError("The guest left before the answer arrived.".into()))
    }

    pub fn peers(&self) -> Vec<PeerInfo> {
        let st = self.shared.st.lock().unwrap();
        let mut v: Vec<PeerInfo> = st.peers.iter().map(|(id, p)| PeerInfo { endpoint_id: id.clone(), name: p.name.clone(), role: p.role, connected: p.tx.is_some(), revoked: p.revoked, approved_at: p.approved_at }).collect();
        v.sort_by(|a, b| a.approved_at.cmp(&b.approved_at).then(a.endpoint_id.cmp(&b.endpoint_id)));
        v
    }

    /// Ends one guest's access now. The endpoint id is refused from then on, even with the code.
    pub fn revoke(&self, endpoint_id: &str) -> Result<(), P2pError> {
        let mut st = self.shared.st.lock().unwrap();
        let p = st.peers.get_mut(endpoint_id).ok_or_else(|| P2pError("No such guest.".into()))?;
        p.revoked = true;
        if let Some(tx) = p.tx.take() {
            let _ = tx.send(Out::Revoke);
        }
        drop(st);
        self.shared.emit(Event::Revoked { endpoint_id: endpoint_id.to_string() });
        Ok(())
    }

    /// Replaces the shared package; every connected guest receives it at once.
    pub fn publish(&self, package: Vec<u8>, version: u64) {
        let bytes = Arc::new(package);
        let mut st = self.shared.st.lock().unwrap();
        st.package = bytes.clone();
        st.version = version;
        for p in st.peers.values().filter(|p| !p.revoked) {
            if let Some(tx) = &p.tx {
                let _ = tx.send(Out::Update { version, bytes: bytes.clone() });
            }
        }
    }

    pub fn pushes(&self) -> Vec<PushInfo> {
        self.shared.st.lock().unwrap().pushes.iter().map(|p| p.info.clone()).collect()
    }

    /// Takes a changed copy a guest sent. The host decides what to do with the bytes; nothing is applied here.
    pub fn take_push(&self, id: u64) -> Result<Vec<u8>, P2pError> {
        let mut st = self.shared.st.lock().unwrap();
        let i = st.pushes.iter().position(|p| p.info.id == id).ok_or_else(|| P2pError("No such pending copy.".into()))?;
        Ok(st.pushes.remove(i).bytes)
    }
    pub fn discard_push(&self, id: u64) {
        self.shared.st.lock().unwrap().pushes.retain(|p| p.info.id != id);
    }

    pub async fn stop(self) {
        {
            let mut st = self.shared.st.lock().unwrap();
            st.stopped = true;
            for p in st.peers.values_mut() {
                if let Some(tx) = p.tx.take() {
                    let _ = tx.send(Out::Revoke);
                }
            }
            st.pending.clear();
        }
        // give the revoke message a moment to leave before the endpoint closes
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = self.router.shutdown().await;
    }
}

impl ProtocolHandler for Handler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        // errors of one guest never affect the session
        let _ = serve_guest(self.0.clone(), connection).await;
        Ok(())
    }
}

/// Tells the guest why it is refused and gives the message time to arrive before the connection goes away.
async fn refuse(send: &mut SendStream, conn: &Connection, reason: &str) {
    let _ = write_frame(send, &ToGuest::Denied { reason: reason.into() }).await;
    let _ = send.finish();
    let _ = tokio::time::timeout(Duration::from_secs(3), conn.closed()).await;
}

async fn serve_guest(sh: Arc<HostShared>, conn: Connection) -> Result<(), P2pError> {
    let id = conn.remote_id().to_string();
    let (mut send, mut recv) = tokio::time::timeout(HELLO_TIMEOUT, conn.accept_bi()).await.map_err(|_| P2pError("no hello".into()))?.map_err(e)?;
    let hello: ToHost = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut recv)).await.map_err(|_| P2pError("no hello".into()))??;
    let ToHost::Hello { secret, name, proto } = hello else { return err("unexpected message") };
    if proto != PROTOCOL {
        refuse(&mut send, &conn, "This BIForge version speaks a different sharing protocol.").await;
        return Ok(());
    }
    let name: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
    // decide: known guest, or code + approval
    let (ended, revoked, known_role) = {
        let st = sh.st.lock().unwrap();
        (st.stopped || now() >= sh.expires_at, st.peers.get(&id).map(|p| p.revoked).unwrap_or(false), st.peers.get(&id).map(|p| p.role))
    };
    if ended {
        refuse(&mut send, &conn, "This session has ended or the pairing code has expired.").await;
        return Ok(());
    }
    if revoked {
        refuse(&mut send, &conn, "The host ended your access.").await;
        return Ok(());
    }
    let role = match known_role {
        Some(r) => r,
        None => {
            let ok = sha(&secret) == sh.secret_hash;
            enum Gate {
                Locked,
                BadCode,
                Waiting(oneshot::Receiver<Decision>, u64),
            }
            let gate = {
                let mut st = sh.st.lock().unwrap();
                if st.bad_codes >= MAX_BAD_CODES {
                    Gate::Locked
                } else if !ok {
                    st.bad_codes += 1;
                    Gate::BadCode
                } else {
                    let (tx, rx) = oneshot::channel();
                    let req_id = st.next_id;
                    st.next_id += 1;
                    st.pending.push(PendingRec { info: JoinRequest { id: req_id, name: name.clone(), endpoint_id: id.clone(), requested_at: now() }, tx });
                    Gate::Waiting(rx, req_id)
                }
            };
            let (rx, req_id) = match gate {
                Gate::Locked => {
                    refuse(&mut send, &conn, "Too many wrong codes. Ask the host for a new session.").await;
                    return Ok(());
                }
                Gate::BadCode => {
                    refuse(&mut send, &conn, "The pairing code is not valid.").await;
                    return Ok(());
                }
                Gate::Waiting(rx, id) => (rx, id),
            };
            sh.emit(Event::JoinRequested { request: req_id, name: name.clone() });
            write_frame(&mut send, &ToGuest::Pending).await?;
            let decision = tokio::select! {
                d = tokio::time::timeout(APPROVAL_TIMEOUT, rx) => d.ok().and_then(|r| r.ok()),
                _ = conn.closed() => None,
            };
            // whatever happened, the request is no longer waiting
            sh.st.lock().unwrap().pending.retain(|p| p.info.id != req_id);
            match decision {
                Some(Decision::Approve(r)) => {
                    sh.st.lock().unwrap().peers.insert(id.clone(), PeerRec { name: name.clone(), role: r, approved_at: now(), revoked: false, tx: None });
                    sh.emit(Event::Approved { endpoint_id: id.clone(), role: r });
                    r
                }
                Some(Decision::Deny) => {
                    sh.emit(Event::Denied { endpoint_id: id.clone() });
                    refuse(&mut send, &conn, "The host did not accept your request.").await;
                    return Ok(());
                }
                None => return Ok(()),
            }
        }
    };
    // approved: send the package, then serve updates and pushes
    let (package, version) = {
        let st = sh.st.lock().unwrap();
        (st.package.clone(), st.version)
    };
    write_frame(&mut send, &ToGuest::Approved { role, version, expires_at: sh.expires_at }).await?;
    write_frame(&mut send, &ToGuest::Package { version, len: package.len() as u64 }).await?;
    write_blob(&mut send, &package).await?;
    let (otx, mut orx) = mpsc::unbounded_channel::<Out>();
    {
        let mut st = sh.st.lock().unwrap();
        if let Some(p) = st.peers.get_mut(&id) {
            if p.revoked {
                return Ok(());
            }
            p.tx = Some(otx);
        }
    }
    sh.emit(Event::Connected { endpoint_id: id.clone() });
    // calls (co-editing, comments) arrive on streams of their own
    tokio::spawn(rpc::serve_calls(sh.clone(), conn.clone(), id.clone()));
    // reader task: frames from the guest
    let (itx, mut irx) = mpsc::unbounded_channel::<Result<Option<(ToHost, Vec<u8>)>, P2pError>>();
    tokio::spawn(async move {
        loop {
            match read_frame::<ToHost>(&mut recv).await {
                Ok(ToHost::Push { len }) => match read_blob(&mut recv, len).await {
                    Ok(b) => {
                        let _ = itx.send(Ok(Some((ToHost::Push { len }, b))));
                    }
                    Err(x) => {
                        let _ = itx.send(Err(x));
                        return;
                    }
                },
                Ok(m) => {
                    let _ = itx.send(Ok(Some((m, vec![]))));
                }
                Err(x) => {
                    let _ = itx.send(Err(x));
                    return;
                }
            }
        }
    });
    loop {
        tokio::select! {
            out = orx.recv() => match out {
                Some(Out::Update { version, bytes }) => {
                    write_frame(&mut send, &ToGuest::Update { version, len: bytes.len() as u64 }).await?;
                    write_blob(&mut send, &bytes).await?;
                }
                Some(Out::Revoke) => {
                    let _ = write_frame(&mut send, &ToGuest::Revoked).await;
                    break;
                }
                Some(Out::Expire) => {
                    let _ = write_frame(&mut send, &ToGuest::Expired).await;
                    break;
                }
                None => break,
            },
            inc = irx.recv() => match inc {
                Some(Ok(Some((ToHost::Push { .. }, bytes)))) => {
                    let allowed = role == Role::Edit && sh.st.lock().unwrap().peers.get(&id).map(|p| !p.revoked).unwrap_or(false);
                    if !allowed {
                        write_frame(&mut send, &ToGuest::PushResult { message: "You have the read-only role: you cannot send changes.".into() }).await?;
                        continue;
                    }
                    let (pid, pname) = {
                        let mut st = sh.st.lock().unwrap();
                        let pid = st.next_id;
                        st.next_id += 1;
                        let pname = st.peers.get(&id).map(|p| p.name.clone()).unwrap_or_default();
                        st.pushes.push(PushRec { info: PushInfo { id: pid, from: id.clone(), name: pname.clone(), bytes: bytes.len() as u64, received_at: now() }, bytes });
                        (pid, pname)
                    };
                    sh.emit(Event::PushReceived { push: pid, name: pname });
                    write_frame(&mut send, &ToGuest::PushResult { message: "The host has your copy and will decide what to do with it.".into() }).await?;
                }
                Some(Ok(_)) => break,
                Some(Err(_)) | None => break,
            },
            _ = conn.closed() => break,
        }
    }
    if let Some(p) = sh.st.lock().unwrap().peers.get_mut(&id) {
        p.tx = None;
    }
    sh.emit(Event::Disconnected { endpoint_id: id });
    let _ = send.finish();
    // let the last message arrive before the connection is dropped
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(())
}

// ------------------------------------------------------------------------------------------------ guest

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum GuestState {
    /// Connected; the host has not answered yet.
    Waiting,
    Approved,
    Denied { reason: String },
    /// The host ended this guest's access, stopped the session, or the code expired.
    Ended { reason: String },
}

struct GuestShared {
    state: GuestState,
    role: Role,
    version: u64,
    package: Option<Vec<u8>>,
    taken_version: u64,
    push_message: Option<String>,
}

pub struct Guest {
    shared: Arc<Mutex<GuestShared>>,
    out: mpsc::UnboundedSender<Vec<u8>>,
    conn: Connection,
    endpoint: Endpoint,
    host_id: String,
}

pub struct GuestOptions {
    pub network: Network,
    /// Keep the same identity across connections (None: a new one each time).
    pub secret_key: Option<SecretKey>,
    pub connect_timeout: Duration,
}

impl Default for GuestOptions {
    fn default() -> Self {
        Self { network: Network::Internet, secret_key: None, connect_timeout: Duration::from_secs(25) }
    }
}

impl Guest {
    /// Connects and says hello; returns as soon as the host has the request (state `Waiting`).
    pub async fn connect(code: &str, name: &str, opts: GuestOptions) -> Result<Guest, P2pError> {
        let pairing = Pairing::parse(code)?;
        let host_id = pairing.endpoint.id.to_string();
        let endpoint = bind(opts.network, opts.secret_key, false).await?;
        let conn = match tokio::time::timeout(opts.connect_timeout, endpoint.connect(pairing.endpoint.clone(), ALPN)).await {
            Ok(Ok(c)) => c,
            _ => {
                endpoint.close().await;
                return err(NO_CONNECTION_MESSAGE);
            }
        };
        let (mut send, mut recv) = conn.open_bi().await.map_err(e)?;
        write_frame(&mut send, &ToHost::Hello { secret: pairing.secret.clone(), name: name.to_string(), proto: PROTOCOL }).await?;
        let shared = Arc::new(Mutex::new(GuestShared { state: GuestState::Waiting, role: Role::ReadOnly, version: 0, package: None, taken_version: 0, push_message: None }));
        let (otx, mut orx) = mpsc::unbounded_channel::<Vec<u8>>();
        let sh = shared.clone();
        tokio::spawn(async move {
            let end = |reason: &str| {
                let mut g = sh.lock().unwrap();
                if matches!(g.state, GuestState::Waiting | GuestState::Approved) {
                    g.state = GuestState::Ended { reason: reason.into() };
                }
            };
            loop {
                tokio::select! {
                    msg = read_frame::<ToGuest>(&mut recv) => match msg {
                        Ok(ToGuest::Pending) => {}
                        Ok(ToGuest::Approved { role, version, .. }) => {
                            let mut g = sh.lock().unwrap();
                            g.state = GuestState::Approved;
                            g.role = role;
                            g.version = version;
                        }
                        Ok(ToGuest::Denied { reason }) => {
                            sh.lock().unwrap().state = GuestState::Denied { reason };
                            return;
                        }
                        Ok(ToGuest::Package { version, len }) | Ok(ToGuest::Update { version, len }) => match read_blob(&mut recv, len).await {
                            Ok(b) => {
                                let mut g = sh.lock().unwrap();
                                g.package = Some(b);
                                g.version = version;
                            }
                            Err(x) => return end(&x.0),
                        },
                        Ok(ToGuest::PushResult { message }) => sh.lock().unwrap().push_message = Some(message),
                        Ok(ToGuest::Revoked) => return end("The host ended your access."),
                        Ok(ToGuest::Expired) => return end("The session expired."),
                        Err(_) => return end("The connection to the host was lost."),
                    },
                    bytes = orx.recv() => match bytes {
                        Some(b) => {
                            let _ = write_frame(&mut send, &ToHost::Push { len: b.len() as u64 }).await;
                            let _ = write_blob(&mut send, &b).await;
                        }
                        None => {
                            let _ = write_frame(&mut send, &ToHost::Bye).await;
                            return;
                        }
                    },
                }
            }
        });
        Ok(Guest { shared, out: otx, conn, endpoint, host_id })
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }
    pub fn state(&self) -> GuestState {
        self.shared.lock().unwrap().state.clone()
    }
    pub fn role(&self) -> Role {
        self.shared.lock().unwrap().role
    }

    /// Waits until the host answered (approved, denied) or `timeout` passed.
    pub async fn wait_decision(&self, timeout: Duration) -> GuestState {
        let end = tokio::time::Instant::now() + timeout;
        loop {
            let s = self.state();
            if !matches!(s, GuestState::Waiting) || tokio::time::Instant::now() >= end {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The newest package not yet taken: (version, bytes). Call again to follow live updates.
    pub fn take_new(&self) -> Option<(u64, Vec<u8>)> {
        let mut g = self.shared.lock().unwrap();
        if g.version > g.taken_version || (g.version == g.taken_version && g.taken_version == 0 && g.package.is_some()) {
            let b = g.package.clone()?;
            g.taken_version = g.version.max(1);
            return Some((g.version, b));
        }
        None
    }

    /// Edit role only: sends a changed copy to the host.
    pub fn push(&self, package: Vec<u8>) -> Result<(), P2pError> {
        if self.role() != Role::Edit {
            return err("You have the read-only role: you cannot send changes.");
        }
        self.out.send(package).map_err(|_| P2pError("The connection is closed.".into()))
    }
    pub fn take_push_message(&self) -> Option<String> {
        self.shared.lock().unwrap().push_message.take()
    }

    pub async fn leave(self) {
        drop(self.out);
        tokio::time::sleep(Duration::from_millis(100)).await;
        self.conn.close(0u32.into(), b"bye");
        self.endpoint.close().await;
    }
}
