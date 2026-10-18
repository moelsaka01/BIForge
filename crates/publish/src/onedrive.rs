//! OneDrive (Microsoft Graph) for [`crate::storage::StorageAdapter`]. Permission `Files.ReadWrite.AppFolder`: BIForge
//! sees only its own app folder (`/me/drive/special/approot`). Written from Microsoft's documentation; run against
//! fakes only until the owner registers an app (docs/PROGRESS.md, Owner steps).

use serde_json::{json, Value};

use crate::adapter::VersionInfo;
use crate::deeplink::encode;
use crate::http::{Http, Request, Response};
use crate::storage::{auth_failed, Cloud, Remote};
use crate::{Error, Result};

const API: &str = "https://graph.microsoft.com/v1.0";
/// A simple upload is allowed up to 4 MB; larger files use an upload session in 320 KiB multiples.
const SIMPLE_LIMIT: usize = 4_000_000;
const CHUNK: usize = 320 * 1024 * 10;

pub struct OneDrive;

fn check(r: Response, what: &str) -> Result<Response> {
    if r.ok() {
        return Ok(r);
    }
    if r.status == 401 {
        return Err(auth_failed("OneDrive"));
    }
    if r.status == 412 {
        return Err(Error::Conflict("The file in OneDrive was changed by someone else since your last upload. Nothing was overwritten. Choose Overwrite to replace it, or download theirs first.".into()));
    }
    Err(Error::Adapter(format!("OneDrive could not {what} ({})", r.describe())))
}

fn call(http: &dyn Http, tok: &str, req: Request, what: &str) -> Result<Response> {
    check(http.send(&req.bearer(tok))?, what)
}

fn remote(v: &Value) -> Result<Remote> {
    Ok(Remote {
        id: v["id"].as_str().ok_or_else(|| Error::Adapter("OneDrive sent a file without an id".into()))?.to_string(),
        rev: v["eTag"].as_str().unwrap_or("").to_string(),
        size: v["size"].as_u64().unwrap_or(0),
        modified: v["lastModifiedDateTime"].as_str().unwrap_or("").to_string(),
        web_url: v["webUrl"].as_str().map(str::to_string),
    })
}

fn item_path(name: &str) -> String {
    format!("{API}/me/drive/special/approot:/{}", encode(name))
}

impl Cloud for OneDrive {
    fn whoami(&self, http: &dyn Http, tok: &str) -> Result<String> {
        let v = call(http, tok, Request::new("GET", &format!("{API}/me")), "read the account")?.json()?;
        Ok(v["mail"].as_str().or_else(|| v["userPrincipalName"].as_str()).or_else(|| v["displayName"].as_str()).unwrap_or("Microsoft account").to_string())
    }

    fn find(&self, http: &dyn Http, tok: &str, name: &str) -> Result<Option<Remote>> {
        let r = http.send(&Request::new("GET", &item_path(name)).bearer(tok))?;
        if r.status == 404 {
            return Ok(None);
        }
        Ok(Some(remote(&check(r, "look for the file")?.json()?)?))
    }

    fn upload(&self, http: &dyn Http, tok: &str, name: &str, bytes: &[u8], _existing: Option<&Remote>, if_rev: Option<&str>) -> Result<Remote> {
        if bytes.len() <= SIMPLE_LIMIT {
            let mut req = Request::new("PUT", &format!("{}:/content", item_path(name))).bytes("application/octet-stream", bytes.to_vec());
            if let Some(rev) = if_rev {
                req = req.header("If-Match", rev);
            }
            return remote(&call(http, tok, req, "upload the file")?.json()?);
        }
        let mut open = Request::new("POST", &format!("{}:/createUploadSession", item_path(name))).json(&json!({"item": {"@microsoft.graph.conflictBehavior": "replace"}}));
        if let Some(rev) = if_rev {
            open = open.header("If-Match", rev);
        }
        let session = call(http, tok, open, "start the upload")?.json()?;
        let url = session["uploadUrl"].as_str().ok_or_else(|| Error::Adapter("OneDrive did not return an upload address".into()))?.to_string();
        let total = bytes.len();
        let mut last = None;
        let mut start = 0;
        while start < total {
            let end = (start + CHUNK).min(total);
            // the upload address carries its own authorization: no bearer token
            let r = http.send(&Request::new("PUT", &url).header("Content-Range", &format!("bytes {start}-{}/{total}", end - 1)).bytes("application/octet-stream", bytes[start..end].to_vec()))?;
            let r = check(r, "upload the file")?;
            if end == total {
                last = Some(r.json()?);
            }
            start = end;
        }
        remote(&last.ok_or_else(|| Error::Adapter("OneDrive did not finish the upload".into()))?)
    }

    fn download(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<Vec<u8>> {
        Ok(call(http, tok, Request::new("GET", &format!("{API}/me/drive/items/{}/content", file.id)), "download the file")?.body)
    }

    fn share_link(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<String> {
        let v = call(http, tok, Request::new("POST", &format!("{API}/me/drive/items/{}/createLink", file.id)).json(&json!({"type": "view", "scope": "anonymous"})), "make a sharing link")?.json()?;
        v["link"]["webUrl"].as_str().map(str::to_string).ok_or_else(|| Error::Adapter("OneDrive did not return a link".into()))
    }

    fn share_with(&self, http: &dyn Http, tok: &str, file: &Remote, email: &str, can_edit: bool) -> Result<()> {
        call(
            http,
            tok,
            Request::new("POST", &format!("{API}/me/drive/items/{}/invite", file.id)).json(&json!({"recipients": [{"email": email}], "message": "", "requireSignIn": true, "sendInvitation": true, "roles": [if can_edit { "write" } else { "read" }]})),
            "share the file",
        )?;
        Ok(())
    }

    fn versions(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<Vec<VersionInfo>> {
        let v = call(http, tok, Request::new("GET", &format!("{API}/me/drive/items/{}/versions", file.id)), "read the version history")?.json()?;
        let mut out: Vec<VersionInfo> = v["value"].as_array().map(|a| a.iter().map(|r| VersionInfo { id: r["id"].as_str().unwrap_or("").into(), modified: r["lastModifiedDateTime"].as_str().unwrap_or("").into(), size: r["size"].as_u64().unwrap_or(0) }).collect()).unwrap_or_default();
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(out)
    }

    fn delete(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<()> {
        call(http, tok, Request::new("DELETE", &format!("{API}/me/drive/items/{}", file.id)), "delete the file")?;
        Ok(())
    }
}
