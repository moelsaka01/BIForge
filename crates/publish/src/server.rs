//! Adapter for method D: publishes a report to a BIForge server (Host from this PC, or biforge-server.exe).
//!
//! Target settings: `url` (the server), `workspace`, `report` (the report id on the server) and `connection` (the id
//! under which the token is kept in the credential store as [`token_key`]). The package is signed and not
//! encrypted: the server must read the data to run queries. Who may see which rows is decided by the server
//! (invitations, roles, data roles), and the server is the only place where row-level security exists.

use crate::adapter::*;
use crate::backend::Client;
use crate::manifest::AccessLevel;
use crate::targets::Target;
use crate::{Error, Result};

pub const HOST_ID: &str = "host-from-pc";
pub const SERVER_ID: &str = "biforge-server";

pub fn token_key(connection: &str) -> String {
    format!("biforge.server.{connection}")
}

pub struct ServerAdapter {
    ctx: Context,
    id: &'static str,
    name: &'static str,
    limitations: Vec<String>,
    free_tier: Vec<String>,
}

impl ServerAdapter {
    pub fn host_from_pc(ctx: Context) -> Self {
        Self {
            ctx,
            id: HOST_ID,
            name: "Host from this PC",
            limitations: vec![
                "BIForge must stay open and this PC online for others to connect".into(),
                "The server speaks plain HTTP: use it on a trusted network, over a VPN or through a tunnel".into(),
                "The data is stored unencrypted on the host; access is controlled by invitations, roles and data roles".into(),
            ],
            free_tier: vec!["Free; uses your PC and your internet connection".into()],
        }
    }

    pub fn standalone(ctx: Context) -> Self {
        Self {
            ctx,
            id: SERVER_ID,
            name: "BIForge server (biforge-server.exe)",
            limitations: vec![
                "Needs a computer that stays on".into(),
                "The server speaks plain HTTP: use it on a trusted network, over a VPN or through a tunnel".into(),
                "The data is stored unencrypted on the server; access is controlled by invitations, roles and data roles".into(),
            ],
            free_tier: vec!["Free software; you provide the computer".into()],
        }
    }

    fn setting<'a>(&self, t: &'a Target, key: &str) -> Result<&'a str> {
        t.settings.get(key).map(|s| s.as_str()).filter(|s| !s.is_empty()).ok_or_else(|| Error::Adapter(format!("This destination has no {key} yet. Open the destination and choose a server and a workspace.")))
    }

    fn client<'a>(&'a self, t: &Target) -> Result<Client<'a>> {
        let url = self.setting(t, "url")?;
        let conn = self.setting(t, "connection")?;
        let token = self.ctx.keys.get(&token_key(conn))?.ok_or_else(|| Error::Adapter("You are not signed in to this server any more. Join it again with an invitation.".into()))?;
        Ok(Client::new(self.ctx.http.as_ref(), url, &token))
    }

    fn state(&self, t: &Target, r: &crate::backend::ReportInfo, package_sha: &str) -> RemoteState {
        RemoteState {
            package_id: r.id.clone(),
            version: r.version,
            sha256: package_sha.to_string(),
            location: format!("{}/workspaces/{}/reports/{}", self.setting(t, "url").unwrap_or(""), t.settings.get("workspace").cloned().unwrap_or_default(), r.id),
            updated_at: r.updated_at.clone(),
        }
    }
}

impl Adapter for ServerAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: self.id.into(),
            name: self.name.into(),
            method: Method::Backend,
            phase: "O5".into(),
            capabilities: Capabilities {
                implemented: true,
                public_access: true,
                private_access: false,
                update: true,
                sync: true,
                share_link: false,
                unpublish: true,
                key_rotation: false,
                version_history: false,
                scheduled_refresh: false,
                row_level_security: true,
                live_session: false,
                comments: false,
                co_edit: false,
                needs_account: false,
            },
            limitations: self.limitations.clone(),
            free_tier: self.free_tier.clone(),
        }
    }

    fn validate(&self, t: &Target) -> Vec<Issue> {
        let mut v = Vec::new();
        for k in ["url", "workspace", "report", "connection"] {
            if t.settings.get(k).map(|s| s.is_empty()).unwrap_or(true) {
                v.push(Issue { severity: Severity::Error, message: format!("Choose the server, workspace and report name first ({k} is missing).") });
            }
        }
        if t.access != AccessLevel::Public {
            v.push(Issue { severity: Severity::Error, message: "A server reads the data to answer queries, so it cannot host an encrypted package.".into() });
        }
        v
    }

    fn publish(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        let c = self.client(t)?;
        let r = c.upload_report(self.setting(t, "workspace")?, self.setting(t, "report")?, package.to_vec())?;
        Ok(self.state(t, &r, &meta.sha256))
    }

    fn update(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        self.publish(t, package, meta)
    }

    fn status(&self, t: &Target) -> Result<Option<RemoteState>> {
        let c = self.client(t)?;
        let report = self.setting(t, "report")?;
        Ok(c.reports(self.setting(t, "workspace")?)?.into_iter().find(|r| r.id == report).map(|r| self.state(t, &r, "")))
    }

    fn unpublish(&self, t: &Target) -> Result<()> {
        self.client(t)?.delete_report(self.setting(t, "workspace")?, self.setting(t, "report")?)
    }

    fn disconnect(&self, t: &mut Target) -> Result<()> {
        if let Some(conn) = t.settings.get("connection").cloned() {
            self.ctx.keys.delete(&token_key(&conn))?;
        }
        Ok(())
    }
}
