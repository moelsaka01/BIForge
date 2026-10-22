//! Method D, shared by the server and its clients: the JSON types of the BIForge server API and a small client.
//!
//! The server itself is `crates/server` (biforge-server.exe, also embedded in the app as "Host from this PC").
//! Authentication: `Authorization: Bearer <token>`. The server admin token belongs to the person who runs the
//! server; a member token is handed out once, when an invite link is redeemed.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::http::{Http, Request, Response};
use crate::{Error, Result};

pub const API_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WsRole {
    Viewer,
    Editor,
    Admin,
}

impl WsRole {
    pub fn can_edit(self) -> bool {
        self >= WsRole::Editor
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberInfo {
    pub id: String,
    pub name: String,
    /// What USERPRINCIPALNAME() returns for this member. Set by the admin in the invite, never by the member.
    pub identity: String,
    pub role: WsRole,
    /// Names of the report roles (row-level security) assigned to this member.
    pub rls_roles: Vec<String>,
    pub created_at: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteRequest {
    pub role: WsRole,
    pub identity: String,
    #[serde(default)]
    pub rls_roles: Vec<String>,
    pub expires_minutes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteInfo {
    pub id: String,
    /// Shown once. The server keeps only a hash.
    pub token: String,
    pub link: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinResponse {
    pub workspace_id: String,
    pub workspace_name: String,
    pub member_id: String,
    /// The member's token. Kept in Windows Credential Manager by the app; the server keeps only a hash.
    pub token: String,
    pub role: WsRole,
    pub identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportInfo {
    pub id: String,
    pub name: String,
    pub version: u64,
    pub publisher_key_id: String,
    pub uploaded_by: String,
    pub updated_at: String,
    /// True when the report has row-level security roles.
    pub has_roles: bool,
}

/// The scheduled refresh of a report on a server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshInfo {
    pub enabled: bool,
    pub plan: crate::schedule::Plan,
    pub runs_on: String,
    pub needs: String,
    pub has_bundle: bool,
    pub running: bool,
    pub source_folder: String,
    pub sources: Vec<String>,
    pub history: Vec<crate::schedule::RunRecord>,
    pub refreshed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollabReply {
    pub update: Vec<u8>,
    pub state_vector: Vec<u8>,
    pub seeded: bool,
    pub empty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub time: String,
    pub actor: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: u64,
    pub uploaded_by: String,
    pub at: String,
    pub size_bytes: u64,
    /// The version the server currently answers with.
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub time: String,
    pub actor: String,
    pub event: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RlsFilter {
    pub table: String,
    pub expression: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RlsRole {
    pub name: String,
    pub filters: Vec<RlsFilter>,
}

pub fn build_link(server_url: &str, invite_token: &str) -> String {
    build_link_pinned(server_url, invite_token, None)
}

/// An invitation link; `pin` is the SHA-256 fingerprint of the server's self-signed certificate (TLS).
pub fn build_link_pinned(server_url: &str, invite_token: &str, pin: Option<&str>) -> String {
    let mut l = format!("biforge://open?src=server&url={}&invite={}", crate::deeplink::encode(server_url), crate::deeplink::encode(invite_token));
    if let Some(p) = pin {
        l.push_str(&format!("&pin={}", crate::deeplink::encode(p)));
    }
    l
}

fn fail(r: &Response) -> Error {
    Error::Adapter(r.describe())
}

/// A client of one BIForge server. `token` is the admin token or a member token.
pub struct Client<'a> {
    pub http: &'a dyn Http,
    pub base: String,
    pub token: String,
}

impl<'a> Client<'a> {
    pub fn new(http: &'a dyn Http, base: &str, token: &str) -> Self {
        Self { http, base: base.trim_end_matches('/').to_string(), token: token.to_string() }
    }

    fn call(&self, req: Request) -> Result<Response> {
        let r = self.http.send(&req.bearer(&self.token))?;
        if r.ok() {
            Ok(r)
        } else {
            Err(fail(&r))
        }
    }
    fn get(&self, path: &str) -> Result<Value> {
        self.call(Request::new("GET", &format!("{}{path}", self.base)))?.json()
    }
    fn send_json(&self, method: &str, path: &str, body: &Value) -> Result<Value> {
        self.call(Request::new(method, &format!("{}{path}", self.base)).json(body))?.json()
    }
    fn de<T: for<'d> Deserialize<'d>>(v: Value) -> Result<T> {
        serde_json::from_value(v).map_err(|e| Error::Adapter(format!("unexpected answer from the server: {e}")))
    }

    /// Redeems an invite. No token is needed (the invite is the credential).
    pub fn join(http: &dyn Http, base: &str, invite_token: &str, display_name: &str) -> Result<JoinResponse> {
        let req = Request::new("POST", &format!("{}/api/join", base.trim_end_matches('/'))).json(&json!({"invite": invite_token, "displayName": display_name}));
        let r = http.send(&req)?;
        if !r.ok() {
            return Err(fail(&r));
        }
        Self::de(r.json()?)
    }

    pub fn info(http: &dyn Http, base: &str) -> Result<Value> {
        let r = http.send(&Request::new("GET", &format!("{}/api/info", base.trim_end_matches('/'))))?;
        if !r.ok() {
            return Err(fail(&r));
        }
        r.json()
    }

    pub fn create_workspace(&self, name: &str) -> Result<WorkspaceInfo> {
        Self::de(self.send_json("POST", "/api/workspaces", &json!({"name": name}))?)
    }
    pub fn workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        Self::de(self.get("/api/workspaces")?)
    }
    pub fn invite(&self, workspace: &str, req: &InviteRequest) -> Result<InviteInfo> {
        Self::de(self.send_json("POST", &format!("/api/workspaces/{workspace}/invites"), &serde_json::to_value(req)?)?)
    }
    pub fn members(&self, workspace: &str) -> Result<Vec<MemberInfo>> {
        Self::de(self.get(&format!("/api/workspaces/{workspace}/members"))?)
    }
    pub fn set_member(&self, workspace: &str, member: &str, role: Option<WsRole>, rls_roles: Option<Vec<String>>) -> Result<MemberInfo> {
        Self::de(self.send_json("PATCH", &format!("/api/workspaces/{workspace}/members/{member}"), &json!({"role": role, "rlsRoles": rls_roles}))?)
    }
    pub fn revoke(&self, workspace: &str, member: &str) -> Result<()> {
        self.call(Request::new("DELETE", &format!("{}/api/workspaces/{workspace}/members/{member}", self.base)))?;
        Ok(())
    }
    pub fn audit(&self, workspace: &str) -> Result<Vec<AuditEntry>> {
        Self::de(self.get(&format!("/api/workspaces/{workspace}/audit"))?)
    }
    pub fn reports(&self, workspace: &str) -> Result<Vec<ReportInfo>> {
        Self::de(self.get(&format!("/api/workspaces/{workspace}/reports"))?)
    }
    /// Uploads a signed, unencrypted package (the server must read the data to answer queries).
    pub fn upload_report(&self, workspace: &str, report: &str, package: Vec<u8>) -> Result<ReportInfo> {
        let r = self.call(Request::new("PUT", &format!("{}/api/workspaces/{workspace}/reports/{report}", self.base)).bytes("application/octet-stream", package))?;
        Self::de(r.json()?)
    }
    pub fn versions(&self, workspace: &str, report: &str) -> Result<Vec<VersionInfo>> {
        Self::de(self.get(&format!("/api/workspaces/{workspace}/reports/{report}/versions"))?)
    }
    /// Makes an older uploaded version the one the server answers with.
    pub fn restore_version(&self, workspace: &str, report: &str, version: u64) -> Result<ReportInfo> {
        Self::de(self.send_json("POST", &format!("/api/workspaces/{workspace}/reports/{report}/versions/{version}/restore"), &json!({}))?)
    }
    /// One round trip of co-editing (see biforge_collab::SharedDoc::sync). Byte fields travel as base64.
    pub fn collab_sync(&self, workspace: &str, report: &str, state_vector: &[u8], update: &[u8], seed: bool, summary: &str) -> Result<CollabReply> {
        use base64::Engine as _;
        let b = base64::engine::general_purpose::STANDARD;
        let v = self.send_json("POST", &format!("/api/workspaces/{workspace}/reports/{report}/collab/sync"), &json!({"stateVector": b.encode(state_vector), "update": b.encode(update), "seed": seed, "summary": summary}))?;
        let get = |k: &str| -> Result<Vec<u8>> { b.decode(v.get(k).and_then(|x| x.as_str()).unwrap_or("")).map_err(|e| Error::Adapter(format!("bad answer: {e}"))) };
        Ok(CollabReply { update: get("update")?, state_vector: get("stateVector")?, seeded: v.get("seeded").and_then(|x| x.as_bool()).unwrap_or(false), empty: v.get("empty").and_then(|x| x.as_bool()).unwrap_or(true) })
    }
    pub fn collab_changes(&self, workspace: &str, report: &str) -> Result<Vec<ChangeEntry>> {
        Self::de(self.get(&format!("/api/workspaces/{workspace}/reports/{report}/collab/changes"))?)
    }
    pub fn comments(&self, workspace: &str, report: &str) -> Result<Vec<biforge_collab::Comment>> {
        Self::de(self.get(&format!("/api/workspaces/{workspace}/reports/{report}/comments"))?)
    }
    pub fn add_comment(&self, workspace: &str, report: &str, text: &str, anchor: &biforge_collab::Anchor, parent: Option<&str>) -> Result<biforge_collab::Comment> {
        Self::de(self.send_json("POST", &format!("/api/workspaces/{workspace}/reports/{report}/comments"), &json!({"text": text, "anchor": anchor, "parent": parent}))?)
    }
    pub fn resolve_comment(&self, workspace: &str, report: &str, comment: &str, resolved: bool) -> Result<()> {
        self.send_json("POST", &format!("/api/workspaces/{workspace}/reports/{report}/comments/{comment}/resolve"), &json!({"resolved": resolved}))?;
        Ok(())
    }
    pub fn delete_comment(&self, workspace: &str, report: &str, comment: &str) -> Result<()> {
        self.call(Request::new("DELETE", &format!("{}/api/workspaces/{workspace}/reports/{report}/comments/{comment}", self.base)))?;
        Ok(())
    }
    /// Open comments by others that mention the caller, in every report of the workspace.
    pub fn mentions(&self, workspace: &str) -> Result<Vec<Value>> {
        Self::de(self.get(&format!("/api/workspaces/{workspace}/mentions"))?)
    }
    pub fn refresh_info(&self, workspace: &str, report: &str) -> Result<RefreshInfo> {
        Self::de(self.get(&format!("/api/workspaces/{workspace}/reports/{report}/refresh"))?)
    }
    pub fn refresh_set(&self, workspace: &str, report: &str, enabled: bool, plan: &crate::schedule::Plan) -> Result<RefreshInfo> {
        Self::de(self.send_json("PUT", &format!("/api/workspaces/{workspace}/reports/{report}/refresh"), &json!({"enabled": enabled, "plan": plan}))?)
    }
    /// Sends the refresh bundle (a signed package made by the publisher) the server reloads the sources from.
    pub fn refresh_put_bundle(&self, workspace: &str, report: &str, bundle: Vec<u8>) -> Result<RefreshInfo> {
        let r = self.call(Request::new("PUT", &format!("{}/api/workspaces/{workspace}/reports/{report}/refresh/bundle", self.base)).bytes("application/octet-stream", bundle))?;
        Self::de(r.json()?)
    }
    pub fn refresh_delete_bundle(&self, workspace: &str, report: &str) -> Result<RefreshInfo> {
        Self::de(self.call(Request::new("DELETE", &format!("{}/api/workspaces/{workspace}/reports/{report}/refresh/bundle", self.base)))?.json()?)
    }
    /// Puts a source file in the report's source folder on the server (it replaces the bundle's copy of the same name).
    pub fn refresh_put_source(&self, workspace: &str, report: &str, name: &str, bytes: Vec<u8>) -> Result<RefreshInfo> {
        let r = self.call(Request::new("PUT", &format!("{}/api/workspaces/{workspace}/reports/{report}/refresh/sources/{}", self.base, crate::deeplink::encode(name))).bytes("application/octet-stream", bytes))?;
        Self::de(r.json()?)
    }
    /// Runs one refresh now and waits for it; returns the record.
    pub fn refresh_run(&self, workspace: &str, report: &str) -> Result<crate::schedule::RunRecord> {
        Self::de(self.send_json("POST", &format!("/api/workspaces/{workspace}/reports/{report}/refresh/run"), &json!({}))?)
    }
    pub fn delete_report(&self, workspace: &str, report: &str) -> Result<()> {
        self.call(Request::new("DELETE", &format!("{}/api/workspaces/{workspace}/reports/{report}", self.base)))?;
        Ok(())
    }
    pub fn set_roles(&self, workspace: &str, report: &str, roles: &[RlsRole]) -> Result<()> {
        self.send_json("PUT", &format!("/api/workspaces/{workspace}/reports/{report}/roles"), &serde_json::to_value(roles)?)?;
        Ok(())
    }
    pub fn roles(&self, workspace: &str, report: &str) -> Result<Vec<RlsRole>> {
        Self::de(self.get(&format!("/api/workspaces/{workspace}/reports/{report}/roles"))?)
    }
    /// The project files of the report (no data) as the package paths `project/...`.
    pub fn project(&self, workspace: &str, report: &str) -> Result<Vec<(String, Vec<u8>)>> {
        let v = self.get(&format!("/api/workspaces/{workspace}/reports/{report}/project"))?;
        let files = v.get("files").and_then(|f| f.as_array()).ok_or_else(|| Error::Adapter("the server sent no project files".into()))?;
        files
            .iter()
            .map(|f| {
                use base64::Engine as _;
                let path = f.get("path").and_then(|p| p.as_str()).ok_or_else(|| Error::Adapter("bad project file".into()))?;
                let data = f.get("data").and_then(|p| p.as_str()).ok_or_else(|| Error::Adapter("bad project file".into()))?;
                Ok((path.to_string(), base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| Error::Adapter(e.to_string()))?))
            })
            .collect()
    }
    /// Runs a DAX query on the server as this member (row-level security applies). Returns the engine's result DTOs.
    pub fn query(&self, workspace: &str, report: &str, dax: &str) -> Result<Value> {
        self.send_json("POST", &format!("/api/workspaces/{workspace}/reports/{report}/query"), &json!({"query": dax}))
    }
}
