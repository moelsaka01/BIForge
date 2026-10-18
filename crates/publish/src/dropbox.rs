//! Dropbox (API v2) for [`crate::storage::StorageAdapter`]. App folder access: paths are relative to the folder
//! Dropbox made for BIForge. Written from Dropbox's documentation; run against fakes only until the owner registers
//! an app (docs/PROGRESS.md, Owner steps).

use serde_json::{json, Value};

use crate::adapter::VersionInfo;
use crate::http::{Http, Request, Response};
use crate::storage::{auth_failed, Cloud, Remote};
use crate::{Error, Result};

const RPC: &str = "https://api.dropboxapi.com/2";
const CONTENT: &str = "https://content.dropboxapi.com/2";
/// The single-request upload limit.
const MAX_FILE: usize = 150 * 1024 * 1024;

pub struct Dropbox;

fn summary(r: &Response) -> String {
    r.json().ok().and_then(|v| v["error_summary"].as_str().map(str::to_string)).unwrap_or_else(|| r.describe())
}

fn check(r: Response, what: &str) -> Result<Response> {
    if r.ok() {
        return Ok(r);
    }
    if r.status == 401 {
        return Err(auth_failed("Dropbox"));
    }
    Err(Error::Adapter(format!("Dropbox could not {what} ({})", summary(&r))))
}

fn rpc(http: &dyn Http, tok: &str, path: &str, body: Option<Value>, what: &str) -> Result<Response> {
    let mut req = Request::new("POST", &format!("{RPC}/{path}")).bearer(tok);
    if let Some(b) = body {
        req = req.json(&b);
    }
    check(http.send(&req)?, what)
}

fn remote(v: &Value) -> Result<Remote> {
    Ok(Remote {
        id: v["id"].as_str().ok_or_else(|| Error::Adapter("Dropbox sent a file without an id".into()))?.to_string(),
        rev: v["rev"].as_str().unwrap_or("").to_string(),
        size: v["size"].as_u64().unwrap_or(0),
        modified: v["server_modified"].as_str().unwrap_or("").to_string(),
        web_url: None,
    })
}

impl Cloud for Dropbox {
    fn whoami(&self, http: &dyn Http, tok: &str) -> Result<String> {
        let v = rpc(http, tok, "users/get_current_account", None, "read the account")?.json()?;
        Ok(v["email"].as_str().or_else(|| v["name"]["display_name"].as_str()).unwrap_or("Dropbox account").to_string())
    }

    fn find(&self, http: &dyn Http, tok: &str, name: &str) -> Result<Option<Remote>> {
        let r = http.send(&Request::new("POST", &format!("{RPC}/files/get_metadata")).bearer(tok).json(&json!({"path": format!("/{name}")})))?;
        if r.status == 409 && summary(&r).starts_with("path/not_found") {
            return Ok(None);
        }
        let v = check(r, "look for the file")?.json()?;
        if v[".tag"] != "file" {
            return Err(Error::Adapter(format!("Dropbox has a folder named \"{name}\" where the report file should be")));
        }
        Ok(Some(remote(&v)?))
    }

    fn upload(&self, http: &dyn Http, tok: &str, name: &str, bytes: &[u8], existing: Option<&Remote>, if_rev: Option<&str>) -> Result<Remote> {
        if bytes.len() > MAX_FILE {
            return Err(Error::Adapter("This package is larger than Dropbox's 150 MB limit for one upload.".into()));
        }
        let mode = match (if_rev, existing) {
            (Some(rev), _) => json!({".tag": "update", "update": rev}),
            (None, Some(_)) => json!({".tag": "overwrite"}),
            (None, None) => json!({".tag": "add"}),
        };
        let arg = json!({"path": format!("/{name}"), "mode": mode, "autorename": false, "mute": true});
        let r = http.send(&Request::new("POST", &format!("{CONTENT}/files/upload")).bearer(tok).header("Dropbox-API-Arg", &arg.to_string()).bytes("application/octet-stream", bytes.to_vec()))?;
        if r.status == 409 && summary(&r).contains("conflict") {
            return Err(Error::Conflict("The file in Dropbox was changed by someone else since your last upload. Nothing was overwritten. Choose Overwrite to replace it, or download theirs first.".into()));
        }
        remote(&check(r, "upload the file")?.json()?)
    }

    fn download(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<Vec<u8>> {
        let r = http.send(&Request::new("POST", &format!("{CONTENT}/files/download")).bearer(tok).header("Dropbox-API-Arg", &json!({"path": file.id}).to_string()))?;
        Ok(check(r, "download the file")?.body)
    }

    fn share_link(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<String> {
        let r = http.send(&Request::new("POST", &format!("{RPC}/sharing/create_shared_link_with_settings")).bearer(tok).json(&json!({"path": file.id, "settings": {"requested_visibility": "public"}})))?;
        if r.status == 409 && summary(&r).contains("shared_link_already_exists") {
            let v = rpc(http, tok, "sharing/list_shared_links", Some(json!({"path": file.id, "direct_only": true})), "read the sharing link")?.json()?;
            return v["links"][0]["url"].as_str().map(str::to_string).ok_or_else(|| Error::Adapter("Dropbox did not return the existing link".into()));
        }
        check(r, "make a sharing link")?.json()?["url"].as_str().map(str::to_string).ok_or_else(|| Error::Adapter("Dropbox did not return a link".into()))
    }

    fn share_with(&self, http: &dyn Http, tok: &str, file: &Remote, email: &str, can_edit: bool) -> Result<()> {
        rpc(
            http,
            tok,
            "sharing/add_file_member",
            Some(json!({"file": file.id, "members": [{".tag": "email", "email": email}], "access_level": {".tag": if can_edit { "editor" } else { "viewer" }}, "quiet": false})),
            "share the file",
        )?;
        Ok(())
    }

    fn versions(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<Vec<VersionInfo>> {
        let v = rpc(http, tok, "files/list_revisions", Some(json!({"path": file.id, "mode": "id", "limit": 30})), "read the version history")?.json()?;
        let mut out: Vec<VersionInfo> = v["entries"].as_array().map(|a| a.iter().map(|r| VersionInfo { id: r["rev"].as_str().unwrap_or("").into(), modified: r["server_modified"].as_str().unwrap_or("").into(), size: r["size"].as_u64().unwrap_or(0) }).collect()).unwrap_or_default();
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(out)
    }

    fn delete(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<()> {
        rpc(http, tok, "files/delete_v2", Some(json!({"path": file.id})), "delete the file")?;
        Ok(())
    }
}
