//! Cloudflare adapter (method A, static hosting), through Workers static assets.
//!
//! Cloudflare's current documentation steers new static sites to Workers static assets (Pages is described as the
//! older workflow), so this adapter uses the plain-HTTP direct upload of that product: register a manifest of file
//! hashes, upload the files Cloudflare does not have yet, then deploy a small Worker that carries the uploaded
//! assets. The site is `https://<name>.<account subdomain>.workers.dev/`.
//!
//! Needs an API token with the permission "Workers Scripts: Edit" (account level) and the account id. Both are
//! entered by the user; the token is kept in the Windows Credential Manager under [`TOKEN_KEY`], the account id and
//! worker name are target settings (not secrets).
//!
//! Status: written from Cloudflare's documentation and tested against a recorded fake of the API. It has not been run
//! against a real Cloudflare account yet (that needs the owner's API token), and the adapter says so.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::adapter::*;
use crate::deeplink;
use crate::feed::{self, Feed};
use crate::http::{multipart, Request, Response};
use crate::keys::hex;
use crate::manifest::AccessLevel;
use crate::subscribe;
use crate::targets::Target;
use crate::{Error, Result};

pub const ID: &str = "cloudflare-pages";
pub const TOKEN_KEY: &str = "biforge.cloudflare.token";
const API: &str = "https://api.cloudflare.com/client/v4";
pub const MAX_FILE: usize = 25 * 1024 * 1024;
const WORKER: &str = "export default { fetch() { return new Response('Not found', { status: 404 }); } };\n";

pub struct CloudflareAdapter {
    ctx: Context,
    api: String,
}

/// Cloudflare's asset hash: the first 32 hex digits of SHA-256 over the base64 text of the file followed by its
/// extension without the dot (as in Cloudflare's own upload example).
pub fn asset_hash(bytes: &[u8], path: &str) -> String {
    let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let mut h = Sha256::new();
    h.update(B64.encode(bytes).as_bytes());
    h.update(ext.as_bytes());
    hex(&h.finalize())[..32].to_string()
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, e)| e).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "json" => "application/json",
        "biforge" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

impl CloudflareAdapter {
    pub fn new(ctx: Context) -> Self {
        Self { ctx, api: API.into() }
    }

    pub fn with_api(ctx: Context, api: &str) -> Self {
        Self { ctx, api: api.trim_end_matches('/').into() }
    }

    fn token(&self) -> Result<String> {
        self.ctx.keys.get(TOKEN_KEY)?.filter(|t| !t.trim().is_empty()).ok_or_else(|| Error::Adapter("Cloudflare is not connected. Choose Connect Cloudflare and paste an API token.".into()))
    }

    fn settings(t: &Target) -> Result<(String, String)> {
        let account = t.settings.get("accountId").map(|s| s.trim().to_string()).unwrap_or_default();
        let name = t.settings.get("name").map(|s| s.trim().to_string()).unwrap_or_default();
        if account.len() != 32 || !account.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(Error::Adapter("The Cloudflare account id is 32 letters and digits (see Connect Cloudflare for where to find it).".into()));
        }
        if name.is_empty() || name.len() > 63 || name.starts_with('-') || name.ends_with('-') || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(Error::Adapter("The site name may use letters, digits and - only (up to 63 characters, not starting or ending with -).".into()));
        }
        Ok((account, name))
    }

    fn send(&self, req: Request, token: &str, what: &str) -> Result<Response> {
        let resp = self.ctx.http.send(&req.bearer(token))?;
        if resp.status == 401 || resp.status == 403 {
            return Err(Error::Adapter(format!("Cloudflare refused to {what} ({}). Check that the API token is valid and has the permission \"Workers Scripts: Edit\" for this account.", resp.describe())));
        }
        Ok(resp)
    }

    fn ok_json(&self, resp: Response, what: &str) -> Result<Value> {
        if !resp.ok() {
            return Err(Error::Adapter(format!("Cloudflare could not {what}: {}", resp.describe())));
        }
        let v = resp.json()?;
        if v["success"].as_bool() == Some(false) {
            return Err(Error::Adapter(format!("Cloudflare could not {what}: {}", resp.describe())));
        }
        Ok(v)
    }

    fn subdomain(&self, account: &str, token: &str) -> Result<String> {
        let r = self.send(Request::new("GET", &format!("{}/accounts/{account}/workers/subdomain", self.api)), token, "read the account's workers.dev address")?;
        let v = self.ok_json(r, "read the account's workers.dev address")?;
        v["result"]["subdomain"].as_str().filter(|s| !s.is_empty()).map(str::to_string).ok_or_else(|| {
            Error::Adapter("This Cloudflare account has no workers.dev address yet. In the Cloudflare dashboard open Workers & Pages once and pick a subdomain, then publish again.".into())
        })
    }

    pub fn site_url(name: &str, subdomain: &str) -> String {
        format!("https://{name}.{subdomain}.workers.dev/")
    }

    fn put(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        let (account, name) = Self::settings(t)?;
        let token = self.token()?;
        let site = Self::site_url(&name, &self.subdomain(&account, &token)?);
        let feed_url = subscribe::feed_address(&site);
        let f = Feed { package_id: meta.package_id.clone(), version: meta.version, file: format!("{}.biforge", meta.package_id), sha256: meta.sha256.clone(), access: meta.access, updated_at: meta.time.clone() };
        let files: Vec<(String, Vec<u8>)> = feed::site_files(package, &meta.report_name, &f, &deeplink::build_url(&feed_url)).into_iter().filter(|(p, _)| p != ".nojekyll").collect();
        if let Some((p, b)) = files.iter().find(|(_, b)| b.len() > MAX_FILE) {
            return Err(Error::Adapter(format!("{p} is {} MB; Cloudflare accepts files up to 25 MB. Publish fewer tables or columns.", b.len() / 1_000_000)));
        }

        // 1. manifest
        let mut manifest = serde_json::Map::new();
        for (p, b) in &files {
            manifest.insert(format!("/{p}"), json!({"hash": asset_hash(b, p), "size": b.len()}));
        }
        let r = self.send(
            Request::new("POST", &format!("{}/accounts/{account}/workers/scripts/{name}/assets-upload-session", self.api)).json(&json!({"manifest": manifest})),
            &token,
            "start the upload",
        )?;
        let v = self.ok_json(r, "start the upload")?;
        let session_jwt = v["result"]["jwt"].as_str().ok_or_else(|| Error::Adapter("Cloudflare did not return an upload token".into()))?.to_string();
        let buckets: Vec<Vec<String>> = v["result"]["buckets"].as_array().map(|a| a.iter().map(|b| b.as_array().map(|x| x.iter().filter_map(|h| h.as_str().map(str::to_string)).collect()).unwrap_or_default()).collect()).unwrap_or_default();

        // 2. upload the files Cloudflare does not have
        let mut completion = if buckets.is_empty() { Some(session_jwt.clone()) } else { None };
        for bucket in &buckets {
            let mut parts: Vec<(&str, Option<&str>, &str, Vec<u8>)> = Vec::new();
            let mut names = Vec::new();
            for h in bucket {
                let (p, b) = files.iter().find(|(p, b)| &asset_hash(b, p) == h).ok_or_else(|| Error::Adapter("Cloudflare asked for a file BIForge does not have".into()))?;
                names.push((h.clone(), content_type(p), B64.encode(b).into_bytes()));
            }
            for (h, ct, body) in &names {
                parts.push((h.as_str(), Some(h.as_str()), ct, body.clone()));
            }
            let (ctype, body) = multipart(&parts);
            let r = self.send(Request::new("POST", &format!("{}/accounts/{account}/workers/assets/upload?base64=true", self.api)).bytes(&ctype, body), &session_jwt, "upload the files")?;
            if !r.ok() {
                return Err(Error::Adapter(format!("Cloudflare could not upload the files: {}", r.describe())));
            }
            if r.status == 201 {
                completion = r.json()?["result"]["jwt"].as_str().map(str::to_string);
            }
        }
        let completion = completion.ok_or_else(|| Error::Adapter("Cloudflare did not confirm the upload".into()))?;

        // 3. deploy the worker that serves the assets
        let metadata = json!({
            "main_module": "worker.js",
            "compatibility_date": "2025-01-01",
            "assets": {"jwt": completion, "config": {"html_handling": "auto-trailing-slash", "not_found_handling": "404-page"}},
        });
        let (ctype, body) = multipart(&[
            ("metadata", None, "application/json", serde_json::to_vec(&metadata)?),
            ("worker.js", Some("worker.js"), "application/javascript+module", WORKER.as_bytes().to_vec()),
        ]);
        let r = self.send(Request::new("PUT", &format!("{}/accounts/{account}/workers/scripts/{name}", self.api)).bytes(&ctype, body), &token, "publish the site")?;
        self.ok_json(r, "publish the site")?;
        // make sure the workers.dev address is on (it is by default; ignore a refusal, the status check will tell)
        let _ = self.send(Request::new("POST", &format!("{}/accounts/{account}/workers/scripts/{name}/subdomain", self.api)).json(&json!({"enabled": true, "previews_enabled": false})), &token, "enable the address");
        Ok(RemoteState { package_id: meta.package_id.clone(), version: meta.version, sha256: meta.sha256.clone(), location: feed_url, updated_at: meta.time.clone(), rev: None })
    }
}

impl Adapter for CloudflareAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: ID.into(),
            name: "Cloudflare (workers.dev)".into(),
            method: Method::StaticHosting,
            phase: "O2".into(),
            capabilities: Capabilities {
                implemented: true,
                public_access: true,
                private_access: true,
                update: true,
                sync: true,
                share_link: true,
                unpublish: true,
                key_rotation: true,
                needs_account: true,
                ..Capabilities::default()
            },
            limitations: vec![
                "The site is public: anyone with the address can download the package. A private report is encrypted, but the encrypted file is still downloadable by anyone.".into(),
                "Not tested against a real Cloudflare account yet; it follows Cloudflare's documented upload API.".into(),
                "Revoking access (changing the key) stops new versions from opening with the old key; copies already downloaded stay readable.".into(),
                "No version history and no scheduled refresh on this destination (use GitHub Pages for scheduled refresh).".into(),
                "No row-level security: everything in the package is visible to everyone who can open it.".into(),
                "Files up to 25 MB each.".into(),
            ],
            free_tier: vec![
                "Free Cloudflare account (the owner confirmed no payment card is asked for a static upload)".into(),
                "Requests for static files are free; Cloudflare's current limits apply (files up to 25 MiB)".into(),
            ],
        }
    }

    fn validate(&self, t: &Target) -> Vec<Issue> {
        let mut out = Vec::new();
        if let Err(e) = Self::settings(t) {
            out.push(Issue { severity: Severity::Error, message: e.to_string() });
        }
        if self.ctx.keys.get(TOKEN_KEY).ok().flatten().is_none() {
            out.push(Issue { severity: Severity::Error, message: "Cloudflare is not connected. Choose Connect Cloudflare first.".into() });
        }
        out.push(Issue {
            severity: Severity::Warning,
            message: if t.access == AccessLevel::Public { "The report and its data will be readable by anyone on the internet.".into() } else { "The report is encrypted, but the encrypted file is public: anyone can download it and try to open it.".into() },
        });
        out
    }

    fn authenticate(&self, t: &mut Target) -> Result<()> {
        let (account, _) = Self::settings(t)?;
        let token = self.token()?;
        t.account = Some(self.subdomain(&account, &token)?);
        Ok(())
    }

    fn publish(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        self.put(t, package, meta)
    }

    fn update(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        self.put(t, package, meta)
    }

    fn status(&self, t: &Target) -> Result<Option<RemoteState>> {
        let (account, name) = Self::settings(t)?;
        let url = subscribe::feed_address(&Self::site_url(&name, &self.subdomain(&account, &self.token()?)?));
        match subscribe::fetch_feed(self.ctx.http.as_ref(), &url) {
            Ok(f) => Ok(Some(RemoteState { package_id: f.package_id, version: f.version, sha256: f.sha256, location: url, updated_at: f.updated_at, rev: None })),
            Err(Error::Adapter(m)) if m.starts_with("Nothing is published") => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn share_link(&self, t: &Target) -> Result<String> {
        let (account, name) = Self::settings(t)?;
        Ok(deeplink::build_url(&subscribe::feed_address(&Self::site_url(&name, &self.subdomain(&account, &self.token()?)?))))
    }

    fn sync(&self, t: &Target, have: Option<u64>) -> Result<Option<Vec<u8>>> {
        let (account, name) = Self::settings(t)?;
        let url = subscribe::feed_address(&Self::site_url(&name, &self.subdomain(&account, &self.token()?)?));
        match subscribe::newer(self.ctx.http.as_ref(), &url, have.unwrap_or(0))? {
            Some(f) => Ok(Some(subscribe::fetch_package(self.ctx.http.as_ref(), &url, &f)?)),
            None => Ok(None),
        }
    }

    fn unpublish(&self, t: &Target) -> Result<()> {
        let (account, name) = Self::settings(t)?;
        let token = self.token()?;
        let r = self.send(Request::new("DELETE", &format!("{}/accounts/{account}/workers/scripts/{name}", self.api)), &token, "remove the site")?;
        if r.status == 404 {
            return Ok(());
        }
        self.ok_json(r, "remove the site")?;
        Ok(())
    }

    fn disconnect(&self, t: &mut Target) -> Result<()> {
        t.account = None;
        Ok(())
    }
}
