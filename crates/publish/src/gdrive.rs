//! Google Drive (REST v3) for [`crate::storage::StorageAdapter`]. Scope `drive.file`: BIForge sees only the files it
//! created, in a folder named "BIForge". Written from Google's documentation; run against fakes only until the owner
//! registers an OAuth client (docs/PROGRESS.md, Owner steps).

use serde_json::{json, Value};

use crate::adapter::VersionInfo;
use crate::deeplink::encode;
use crate::http::{Http, Request, Response};
use crate::storage::{auth_failed, Cloud, Remote};
use crate::{Error, Result};

const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
const FOLDER: &str = "BIForge";
const FIELDS: &str = "id,size,modifiedTime,headRevisionId,webViewLink";

/// The folder id is looked up once per adapter and kept.
#[derive(Default)]
pub struct GoogleDrive {
    folder_id: std::sync::Mutex<Option<String>>,
}

fn check(r: Response, what: &str) -> Result<Response> {
    if r.ok() {
        return Ok(r);
    }
    if r.status == 401 {
        return Err(auth_failed("Google Drive"));
    }
    Err(Error::Adapter(format!("Google Drive could not {what} ({})", r.describe())))
}

fn call(http: &dyn Http, tok: &str, req: Request, what: &str) -> Result<Response> {
    check(http.send(&req.bearer(tok))?, what)
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

fn remote(v: &Value) -> Result<Remote> {
    Ok(Remote {
        id: v["id"].as_str().ok_or_else(|| Error::Adapter("Google Drive sent a file without an id".into()))?.to_string(),
        rev: v["headRevisionId"].as_str().unwrap_or("").to_string(),
        size: v["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
        modified: v["modifiedTime"].as_str().unwrap_or("").to_string(),
        web_url: v["webViewLink"].as_str().map(str::to_string),
    })
}

impl GoogleDrive {
    /// The BIForge folder (created when missing).
    fn folder(&self, http: &dyn Http, tok: &str) -> Result<String> {
        if let Some(id) = self.folder_id.lock().unwrap().clone() {
            return Ok(id);
        }
        let id = self.folder_uncached(http, tok)?;
        *self.folder_id.lock().unwrap() = Some(id.clone());
        Ok(id)
    }

    fn folder_uncached(&self, http: &dyn Http, tok: &str) -> Result<String> {
        let q = format!("name = '{FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
        let r = call(http, tok, Request::new("GET", &format!("{API}/files?q={}&fields=files(id)&spaces=drive", encode(&q))), "look for the BIForge folder")?.json()?;
        if let Some(id) = r["files"][0]["id"].as_str() {
            return Ok(id.to_string());
        }
        let c = call(http, tok, Request::new("POST", &format!("{API}/files?fields=id")).json(&json!({"name": FOLDER, "mimeType": "application/vnd.google-apps.folder"})), "create the BIForge folder")?.json()?;
        c["id"].as_str().map(str::to_string).ok_or_else(|| Error::Adapter("Google Drive did not return the new folder".into()))
    }
}

impl Cloud for GoogleDrive {
    fn whoami(&self, http: &dyn Http, tok: &str) -> Result<String> {
        let v = call(http, tok, Request::new("GET", &format!("{API}/about?fields=user(displayName,emailAddress)")), "read the account")?.json()?;
        Ok(v["user"]["emailAddress"].as_str().or_else(|| v["user"]["displayName"].as_str()).unwrap_or("Google account").to_string())
    }

    fn find(&self, http: &dyn Http, tok: &str, name: &str) -> Result<Option<Remote>> {
        let folder = self.folder(http, tok)?;
        let q = format!("name = '{}' and '{folder}' in parents and trashed = false", escape(name));
        let v = call(http, tok, Request::new("GET", &format!("{API}/files?q={}&fields=files({FIELDS})&spaces=drive", encode(&q))), "look for the file")?.json()?;
        match v["files"].as_array().and_then(|a| a.first()) {
            Some(f) => Ok(Some(remote(f)?)),
            None => Ok(None),
        }
    }

    fn upload(&self, http: &dyn Http, tok: &str, name: &str, bytes: &[u8], existing: Option<&Remote>, _if_rev: Option<&str>) -> Result<Remote> {
        let v = match existing {
            Some(f) => call(http, tok, Request::new("PATCH", &format!("{UPLOAD}/files/{}?uploadType=media&fields={FIELDS}", f.id)).bytes("application/octet-stream", bytes.to_vec()), "update the file")?.json()?,
            None => {
                let folder = self.folder(http, tok)?;
                let boundary = format!("biforge{}", crate::keys::hex(&crate::keys::random_bytes::<8>()));
                let meta = serde_json::to_vec(&json!({"name": name, "parents": [folder]}))?;
                let mut body = Vec::new();
                body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n").as_bytes());
                body.extend_from_slice(&meta);
                body.extend_from_slice(format!("\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
                body.extend_from_slice(bytes);
                body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
                call(http, tok, Request::new("POST", &format!("{UPLOAD}/files?uploadType=multipart&fields={FIELDS}")).bytes(&format!("multipart/related; boundary={boundary}"), body), "upload the file")?.json()?
            }
        };
        remote(&v)
    }

    fn download(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<Vec<u8>> {
        Ok(call(http, tok, Request::new("GET", &format!("{API}/files/{}?alt=media", file.id)), "download the file")?.body)
    }

    fn share_link(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<String> {
        call(http, tok, Request::new("POST", &format!("{API}/files/{}/permissions", file.id)).json(&json!({"role": "reader", "type": "anyone"})), "make the file readable by link")?;
        let v = call(http, tok, Request::new("GET", &format!("{API}/files/{}?fields=webViewLink", file.id)), "read the file's link")?.json()?;
        v["webViewLink"].as_str().map(str::to_string).ok_or_else(|| Error::Adapter("Google Drive did not return a link".into()))
    }

    fn share_with(&self, http: &dyn Http, tok: &str, file: &Remote, email: &str, can_edit: bool) -> Result<()> {
        call(
            http,
            tok,
            Request::new("POST", &format!("{API}/files/{}/permissions?sendNotificationEmail=true", file.id)).json(&json!({"role": if can_edit { "writer" } else { "reader" }, "type": "user", "emailAddress": email})),
            "share the file",
        )?;
        Ok(())
    }

    fn versions(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<Vec<VersionInfo>> {
        let v = call(http, tok, Request::new("GET", &format!("{API}/files/{}/revisions?fields=revisions(id,modifiedTime,size)", file.id)), "read the version history")?.json()?;
        let mut out: Vec<VersionInfo> = v["revisions"]
            .as_array()
            .map(|a| a.iter().map(|r| VersionInfo { id: r["id"].as_str().unwrap_or("").into(), modified: r["modifiedTime"].as_str().unwrap_or("").into(), size: r["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0) }).collect())
            .unwrap_or_default();
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(out)
    }

    fn delete(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<()> {
        call(http, tok, Request::new("DELETE", &format!("{API}/files/{}", file.id)), "delete the file")?;
        Ok(())
    }
}
