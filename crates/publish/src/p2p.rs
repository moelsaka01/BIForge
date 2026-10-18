//! Adapter for method C (direct sharing). The session itself (iroh, pairing, approval) lives in `crates/p2p` and runs
//! inside the app; this crate only knows the small [`P2pBridge`] the app provides, so `biforge-publish` stays free of
//! the network stack. Without a bridge (tests, headless use) every operation says so.
//!
//! "Publishing" starts (or updates) the host session for this target: guests who were approved receive the new
//! package at once. The package is signed and not encrypted, because the transport is end-to-end encrypted and
//! authenticated, and nobody gets it without the host's explicit approval.

use std::sync::Arc;

use crate::adapter::*;
use crate::manifest::AccessLevel;
use crate::targets::Target;
use crate::{Error, Result};

pub const ID: &str = "p2p";

pub trait P2pBridge: Send + Sync {
    /// Starts the session for the target (or, when it runs, hands it the new version). Returns the pairing code.
    fn publish(&self, target_id: &str, package: &[u8], version: u64, expires_minutes: u64) -> Result<String>;
    /// (version, pairing code) while the session runs.
    fn status(&self, target_id: &str) -> Option<(u64, String)>;
    /// Ends the session.
    fn stop(&self, target_id: &str) -> Result<()>;
}

pub struct P2pAdapter {
    bridge: Option<Arc<dyn P2pBridge>>,
}

impl P2pAdapter {
    pub fn new(bridge: Option<Arc<dyn P2pBridge>>) -> Self {
        Self { bridge }
    }

    fn bridge(&self) -> Result<&Arc<dyn P2pBridge>> {
        self.bridge.as_ref().ok_or_else(|| Error::Adapter("Direct sharing needs the BIForge app window.".into()))
    }

    fn expires(t: &Target) -> u64 {
        t.settings.get("expiresMinutes").and_then(|v| v.parse().ok()).filter(|m| (1..=60 * 24 * 7).contains(m)).unwrap_or(60)
    }

    fn state(&self, t: &Target, code: String, version: u64, sha: &str) -> RemoteState {
        RemoteState { package_id: t.package_id.clone().unwrap_or_default(), version, sha256: sha.to_string(), location: code, updated_at: crate::time::now_rfc3339(), rev: None }
    }
}

impl Adapter for P2pAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: ID.into(),
            name: "Direct connection (peer to peer)".into(),
            method: Method::PeerToPeer,
            phase: "O4".into(),
            capabilities: Capabilities {
                implemented: true,
                public_access: true,
                private_access: false,
                update: true,
                sync: true,
                share_link: true,
                unpublish: true,
                live_session: true,
                needs_account: false,
                ..Capabilities::default()
            },
            limitations: vec![
                "Both people must be online at the same time".into(),
                "May fail on some networks (strict firewalls, company networks, some mobile hotspots); use another method then".into(),
                "Each guest needs your approval; the pairing code expires and you can end a guest's access at any time (a copy they already received stays with them)".into(),
                "The free public relay servers of the iroh project have no uptime guarantee and see connection metadata, never content".into(),
            ],
            free_tier: vec!["Free; uses the free public relay servers of the iroh project when a direct connection is impossible (no guarantee of availability)".into()],
        }
    }

    fn validate(&self, t: &Target) -> Vec<Issue> {
        let mut v = Vec::new();
        if t.access != AccessLevel::Public {
            v.push(Issue { severity: Severity::Error, message: "A direct session is protected by your approval and by encrypted transport, not by an access key: choose Public.".into() });
        }
        if self.bridge.is_none() {
            v.push(Issue { severity: Severity::Error, message: "Direct sharing needs the BIForge app window.".into() });
        }
        v
    }

    fn publish(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        let code = self.bridge()?.publish(&t.id, package, meta.version, Self::expires(t))?;
        Ok(self.state(t, code, meta.version, &meta.sha256))
    }

    fn update(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        self.publish(t, package, meta)
    }

    fn status(&self, t: &Target) -> Result<Option<RemoteState>> {
        Ok(self.bridge()?.status(&t.id).map(|(v, code)| self.state(t, code, v, "")))
    }

    fn share_link(&self, t: &Target) -> Result<String> {
        self.bridge()?.status(&t.id).map(|(_, code)| code).ok_or_else(|| Error::Adapter("The session is not running. Publish first (it starts the session).".into()))
    }

    fn unpublish(&self, t: &Target) -> Result<()> {
        self.bridge()?.stop(&t.id)
    }
}
