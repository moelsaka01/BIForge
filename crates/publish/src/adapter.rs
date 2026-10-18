//! The adapter interface. The UI offers an action only when the adapter's declared [`Capabilities`] allow it,
//! and the [`crate::publisher::Publisher`] refuses the same actions again on the Rust side.

use serde::{Deserialize, Serialize};

use std::sync::Arc;

use crate::cloudflare::CloudflareAdapter;
use crate::github::GitHubAdapter;
use crate::http::{Http, Request, Response};
use crate::keys::{KeyStore, MemoryKeyStore};
use crate::local::LocalFolderAdapter;
use crate::manifest::AccessLevel;
use crate::targets::Target;
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    /// Method A: static hosting.
    StaticHosting,
    /// Method B: personal cloud storage.
    PersonalStorage,
    /// Method C: peer to peer.
    PeerToPeer,
    /// Method D: backend (Host from this PC, biforge-server.exe).
    Backend,
    /// A folder on this PC or a network share (also a sync folder of any tool).
    LocalFolder,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// False for adapters that are listed but not built yet: nothing below may be used.
    pub implemented: bool,
    pub public_access: bool,
    /// Can carry an encrypted package.
    pub private_access: bool,
    pub update: bool,
    /// Viewers can pull new versions.
    pub sync: bool,
    pub share_link: bool,
    /// Can remove the package from the destination.
    pub unpublish: bool,
    /// Revoking access by key rotation works (needs `update` and `private_access`).
    pub key_rotation: bool,
    pub version_history: bool,
    pub scheduled_refresh: bool,
    /// Only the backend method may ever set this.
    pub row_level_security: bool,
    pub live_session: bool,
    pub comments: bool,
    pub co_edit: bool,
    pub needs_account: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub id: String,
    pub name: String,
    pub method: Method,
    /// Phase of docs/ONLINE_PLAN.md that builds it ("O1" for the folder adapter).
    pub phase: String,
    pub capabilities: Capabilities,
    /// Honest limits of this destination, shown in the Publish & Share dialog.
    pub limitations: Vec<String>,
    /// The provider's free-tier limits, shown in the setup pop-up.
    pub free_tier: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub severity: Severity,
    pub message: String,
}

/// What the destination currently holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteState {
    pub package_id: String,
    pub version: u64,
    pub sha256: String,
    /// Where it is (a path, a URL), for display.
    pub location: String,
    pub updated_at: String,
}

/// Facts about the package being handed to an adapter (the adapter never sees keys).
#[derive(Debug, Clone)]
pub struct PackageMeta {
    pub package_id: String,
    pub report_name: String,
    pub version: u64,
    pub access: AccessLevel,
    pub sha256: String,
    pub time: String,
}

pub trait Adapter: Send + Sync {
    fn info(&self) -> AdapterInfo;

    /// Checks the target's settings without changing anything.
    fn validate(&self, _target: &Target) -> Vec<Issue> {
        Vec::new()
    }

    fn authenticate(&self, _target: &mut Target) -> Result<()> {
        Err(self.unsupported("authenticate"))
    }
    fn publish(&self, _target: &Target, _package: &[u8], _meta: &PackageMeta) -> Result<RemoteState> {
        Err(self.unsupported("publish"))
    }
    fn update(&self, _target: &Target, _package: &[u8], _meta: &PackageMeta) -> Result<RemoteState> {
        Err(self.unsupported("update"))
    }
    fn status(&self, _target: &Target) -> Result<Option<RemoteState>> {
        Err(self.unsupported("status"))
    }
    fn share_link(&self, _target: &Target) -> Result<String> {
        Err(self.unsupported("share links"))
    }
    /// Viewer side: the latest package if its version is newer than `have`.
    fn sync(&self, _target: &Target, _have: Option<u64>) -> Result<Option<Vec<u8>>> {
        Err(self.unsupported("sync"))
    }
    /// Removes the package from the destination.
    fn unpublish(&self, _target: &Target) -> Result<()> {
        Err(self.unsupported("unpublish"))
    }
    /// Puts the scheduled-refresh files into the destination and stores the secrets the runner needs
    /// (secrets are passed in by the publisher; the adapter never reads the credential store for them).
    fn configure_refresh(&self, _target: &Target, _files: &[(String, Vec<u8>)], _secrets: &[(String, String)]) -> Result<()> {
        Err(self.unsupported("scheduled refresh"))
    }
    /// Removes the refresh files and secrets again.
    fn disable_refresh(&self, _target: &Target) -> Result<()> {
        Err(self.unsupported("scheduled refresh"))
    }
    /// Starts one refresh now; returns where to watch it.
    fn trigger_refresh(&self, _target: &Target) -> Result<String> {
        Err(self.unsupported("scheduled refresh"))
    }
    /// Forgets the account connection (tokens). Never deletes published data.
    fn disconnect(&self, _target: &mut Target) -> Result<()> {
        Err(self.unsupported("disconnect"))
    }

    fn unsupported(&self, op: &str) -> Error {
        Error::Unsupported { adapter: self.info().name, operation: op.into() }
    }
}

/// A destination that is listed in the dialog but not built yet. Every operation fails; nothing is simulated.
pub struct NotImplemented {
    info: AdapterInfo,
}

impl NotImplemented {
    fn new(id: &str, name: &str, method: Method, phase: &str, limitations: &[&str], free_tier: &[&str]) -> Box<dyn Adapter> {
        Box::new(Self {
            info: AdapterInfo {
                id: id.into(),
                name: name.into(),
                method,
                phase: phase.into(),
                capabilities: Capabilities::default(),
                limitations: limitations.iter().map(|s| s.to_string()).collect(),
                free_tier: free_tier.iter().map(|s| s.to_string()).collect(),
            },
        })
    }
}

impl Adapter for NotImplemented {
    fn info(&self) -> AdapterInfo {
        self.info.clone()
    }
}

/// What network adapters need: where secrets live and how to talk HTTP. Adapters never see the publisher keys.
#[derive(Clone)]
pub struct Context {
    pub keys: Arc<dyn KeyStore>,
    pub http: Arc<dyn Http>,
}

struct NoNetwork;
impl Http for NoNetwork {
    fn send(&self, _r: &Request) -> crate::Result<Response> {
        Err(Error::Adapter("network access is not available here".into()))
    }
}

impl Context {
    pub fn offline() -> Self {
        Self { keys: Arc::new(MemoryKeyStore::default()), http: Arc::new(NoNetwork) }
    }
}

pub struct Registry {
    adapters: Vec<Box<dyn Adapter>>,
}

impl Registry {
    pub fn new(adapters: Vec<Box<dyn Adapter>>) -> Self {
        Self { adapters }
    }

    /// Every destination BIForge knows about: the real ones and the planned ones (marked not implemented).
    /// Every destination without network access or stored accounts (tests, and callers that only list adapters).
    pub fn standard() -> Self {
        Self::standard_with(Context::offline())
    }

    pub fn standard_with(ctx: Context) -> Self {
        Self::new(vec![
            Box::new(LocalFolderAdapter),
            Box::new(GitHubAdapter::new(ctx.clone())),
            Box::new(CloudflareAdapter::new(ctx.clone())),
            NotImplemented::new(
                "google-drive",
                "Google Drive",
                Method::PersonalStorage,
                "O3",
                &["Shares the editable project, not a live dashboard", "Only files BIForge creates are visible to it (drive.file)"],
                &["Free Google account, 15 GB shared with Gmail and Photos"],
            ),
            NotImplemented::new(
                "onedrive",
                "OneDrive",
                Method::PersonalStorage,
                "O3",
                &["Shares the editable project, not a live dashboard"],
                &["Free Microsoft account, 5 GB"],
            ),
            NotImplemented::new(
                "dropbox",
                "Dropbox",
                Method::PersonalStorage,
                "O3",
                &["Shares the editable project, not a live dashboard"],
                &["Free Dropbox Basic account, 2 GB"],
            ),
            NotImplemented::new(
                "p2p",
                "Direct connection (peer to peer)",
                Method::PeerToPeer,
                "O4",
                &["Both people must be online at the same time", "May fail on some networks; use another method then"],
                &["Free; uses the free public relay servers of the iroh project when a direct connection is impossible (no guarantee of availability)"],
            ),
            Box::new(crate::server::ServerAdapter::host_from_pc(ctx.clone())),
            Box::new(crate::server::ServerAdapter::standalone(ctx)),
        ])
    }

    pub fn infos(&self) -> Vec<AdapterInfo> {
        self.adapters.iter().map(|a| a.info()).collect()
    }

    pub fn get(&self, id: &str) -> Result<&dyn Adapter> {
        self.adapters.iter().find(|a| a.info().id == id).map(|a| a.as_ref()).ok_or_else(|| Error::UnknownAdapter(id.into()))
    }
}
