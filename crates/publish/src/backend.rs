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
    format!("biforge://open?src=server&url={}&invite={}", crate::deeplink::encode(server_url), crate::deeplink::encode(invite_token))
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
