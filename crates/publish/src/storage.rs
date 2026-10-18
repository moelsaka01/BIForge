//! Method B: personal cloud storage (Google Drive, OneDrive, Dropbox).
//!
//! The package is stored as one `.biforge` file in a BIForge folder of the user's own account (the narrow scopes
//! `drive.file` / `Files.ReadWrite.AppFolder` / the Dropbox app folder: BIForge sees only what it created). Viewers
//! with access to the file (a provider sharing link, or shared with their account) open it like any package; this
//! shares the editable project snapshot, not a live dashboard. Public packages are readable by anyone with the file;
//! Private ones are age-encrypted and need the access key.
//!
//! One generic adapter ([`StorageAdapter`]) holds everything that is the same (names, conflict rule, sync, version
//! rules); each provider only implements [`Cloud`], the few file operations of its REST API.

use std::path::PathBuf;
use std::sync::Arc;

use crate::adapter::*;
use crate::http::Http;
use crate::keys::KeyStore;
use crate::oauth::{self, ProviderCfg, Tokens};
use crate::package;
use crate::targets::Target;
use crate::{Error, Result};

/// A file at the provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub id: String,
    /// The provider's revision marker (Drive head revision id, OneDrive eTag, Dropbox rev).
    pub rev: String,
    pub size: u64,
    pub modified: String,
    pub web_url: Option<String>,
}

/// The few file operations of a provider's REST API. `tok` is a valid access token.
pub trait Cloud: Send + Sync {
    fn whoami(&self, http: &dyn Http, tok: &str) -> Result<String>;
    fn find(&self, http: &dyn Http, tok: &str, name: &str) -> Result<Option<Remote>>;
    /// Writes the file. `existing` is the current file (update) or None (create). `if_rev`: only write when the file
    /// still has this revision (providers that can check it answer with [`Error::Conflict`]).
    fn upload(&self, http: &dyn Http, tok: &str, name: &str, bytes: &[u8], existing: Option<&Remote>, if_rev: Option<&str>) -> Result<Remote>;
    fn download(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<Vec<u8>>;
    /// A link anyone can open (view).
    fn share_link(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<String>;
    /// Gives one person access by e-mail address.
    fn share_with(&self, http: &dyn Http, tok: &str, file: &Remote, email: &str, can_edit: bool) -> Result<()>;
    fn versions(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<Vec<VersionInfo>>;
    fn delete(&self, http: &dyn Http, tok: &str, file: &Remote) -> Result<()>;
}

/// An answer the provider gave that means "your token is no good".
pub fn auth_failed(provider: &str) -> Error {
    Error::Adapter(format!("{provider} did not accept the stored sign-in (it may have been revoked or expired). Connect {provider} again."))
}

pub fn slug(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "report".into() } else { s }
}

/// Where the public client ids live: `BIFORGE_<PROVIDER>_CLIENT_ID`, or `oauth-clients.json` in BIForge's data folder
/// (`{"google-drive": "...", "onedrive": "...", "dropbox": "..."}`). Client ids are public values, not secrets.
pub fn client_id_for(provider: &str) -> Option<String> {
    let env = format!("BIFORGE_{}_CLIENT_ID", provider.to_ascii_uppercase().replace('-', "_"));
    if let Ok(v) = std::env::var(&env) {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    let dir = std::env::var_os("BIFORGE_APP_DIR").filter(|d| !d.is_empty()).map(PathBuf::from).or_else(|| std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("BIForge")))?;
    let text = std::fs::read_to_string(dir.join("oauth-clients.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let alias = match provider {
        "google-drive" => "google",
        "onedrive" => "microsoft",
        other => other,
    };
    v.get(provider).or_else(|| v.get(alias)).and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// A sign-in in progress: the address to open in the browser and what is needed to finish it.
pub struct PendingConnect {
    pub url: String,
    pub state: String,
    pub verifier: String,
    pub listener: std::net::TcpListener,
}

pub struct StorageAdapter {
    ctx: Context,
    cfg: ProviderCfg,
    cloud: Box<dyn Cloud>,
    client_id: Option<String>,
    limitations: Vec<String>,
    free_tier: Vec<String>,
}

impl StorageAdapter {
    pub fn new(ctx: Context, cfg: ProviderCfg, cloud: Box<dyn Cloud>, limitations: &[&str], free_tier: &[&str]) -> Self {
        Self { ctx, cfg, cloud, client_id: None, limitations: limitations.iter().map(|s| s.to_string()).collect(), free_tier: free_tier.iter().map(|s| s.to_string()).collect() }
    }

    pub fn google_drive(ctx: Context) -> Self {
        Self::new(
            ctx,
            oauth::GOOGLE,
            Box::new(crate::gdrive::GoogleDrive::default()),
            &[
                "Shares the editable project snapshot, not a live dashboard",
                "BIForge sees only the files it created in your Drive (the narrow drive.file permission)",
                "Changes made by the people you share with are detected before BIForge overwrites the file",
            ],
            &["Free Google account, 15 GB shared with Gmail and Photos"],
        )
    }

    pub fn onedrive(ctx: Context) -> Self {
        Self::new(
            ctx,
            oauth::MICROSOFT,
            Box::new(crate::onedrive::OneDrive),
            &["Shares the editable project snapshot, not a live dashboard", "BIForge sees only its own app folder in your OneDrive", "Changes made by the people you share with are detected before BIForge overwrites the file"],
            &["Free Microsoft account, 5 GB"],
        )
    }

    pub fn dropbox(ctx: Context) -> Self {
        Self::new(
            ctx,
            oauth::DROPBOX,
            Box::new(crate::dropbox::Dropbox),
            &["Shares the editable project snapshot, not a live dashboard", "BIForge sees only its own app folder in your Dropbox", "Files up to 150 MB", "Changes made by the people you share with are detected before BIForge overwrites the file"],
            &["Free Dropbox Basic account, 2 GB"],
        )
    }

    pub fn with_client_id(mut self, id: &str) -> Self {
        self.client_id = Some(id.to_string());
        self
    }

    fn client_id(&self) -> Result<String> {
        self.client_id.clone().or_else(|| client_id_for(self.cfg.id)).ok_or_else(|| Error::Adapter(format!("BIForge has no {} client id yet. Put the id of the app you registered into oauth-clients.json or the BIFORGE_{}_CLIENT_ID variable (steps in docs/PROGRESS.md, Owner steps).", self.cfg.name, self.cfg.id.to_ascii_uppercase().replace('-', "_"))))
    }

    fn keys(&self) -> &dyn KeyStore {
        self.ctx.keys.as_ref()
    }

    pub fn is_connected(&self) -> bool {
        oauth::load_tokens(self.keys(), self.cfg.id).ok().flatten().is_some()
    }

    /// Step 1 of the sign-in: the browser address, and the loopback listener the answer comes back to.
    pub fn begin_connect(&self) -> Result<PendingConnect> {
        let client_id = self.client_id()?;
        let listener = oauth::bind_loopback()?;
        let pkce = oauth::Pkce::generate();
        let state = oauth::new_state();
        Ok(PendingConnect { url: oauth::authorize_url(&self.cfg, &client_id, &state, &pkce.challenge), state, verifier: pkce.verifier, listener })
    }

    /// Step 2: waits for the browser's answer, exchanges the code, keeps the tokens in the credential store and
    /// returns the account name.
    pub fn finish_connect(&self, pending: &PendingConnect, timeout: std::time::Duration) -> Result<String> {
        let code = oauth::wait_for_code(&pending.listener, &pending.state, timeout)?;
        let tokens = oauth::exchange_code(self.ctx.http.as_ref(), &self.cfg, &self.client_id()?, &code, &pending.verifier)?;
        let who = self.cloud.whoami(self.ctx.http.as_ref(), &tokens.access)?;
        oauth::store_tokens(self.keys(), self.cfg.id, &tokens)?;
        Ok(who)
    }

    /// Forgets the tokens. Files already in the account stay there.
    pub fn disconnect_account(&self) -> Result<()> {
        self.keys().delete(&oauth::token_key(self.cfg.id))
    }

    fn token(&self) -> Result<String> {
        let t = oauth::load_tokens(self.keys(), self.cfg.id)?.ok_or_else(|| Error::Adapter(format!("{} is not connected. Choose Connect {} first.", self.cfg.name, self.cfg.name)))?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if t.expires_at > now + 60 {
            return Ok(t.access);
        }
        let Some(refresh) = t.refresh.clone() else {
            return Err(auth_failed(self.cfg.name));
        };
        let fresh: Tokens = oauth::refresh(self.ctx.http.as_ref(), &self.cfg, &self.client_id()?, &refresh).map_err(|_| auth_failed(self.cfg.name))?;
        oauth::store_tokens(self.keys(), self.cfg.id, &fresh)?;
        Ok(fresh.access)
    }

    /// The file's name in the account: the target's `file` setting, else the destination's name.
    fn file_name(&self, t: &Target) -> String {
        match t.settings.get("file").filter(|f| !f.is_empty()) {
            Some(f) => f.clone(),
            None => format!("{}.biforge", slug(&t.label)),
        }
    }

    fn remote_state(&self, meta: &PackageMeta, r: &Remote) -> RemoteState {
        RemoteState { package_id: meta.package_id.clone(), version: meta.version, sha256: meta.sha256.clone(), location: r.web_url.clone().unwrap_or_else(|| r.id.clone()), updated_at: meta.time.clone(), rev: Some(r.rev.clone()) }
    }

    fn put(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        let tok = self.token()?;
        let h = self.ctx.http.as_ref();
        let name = self.file_name(t);
        let existing = self.cloud.find(h, &tok, &name)?;
        let overwrite = t.settings.get("overwrite").map(|v| v == "1").unwrap_or(false);
        let known = t.settings.get("rev").cloned();
        if let Some(r) = &existing {
            match (&known, overwrite) {
                (Some(k), false) if *k != r.rev => {
                    return Err(Error::Conflict(format!(
                        "The file \"{name}\" in {} was changed by someone else since your last upload. Nothing was overwritten. Choose Overwrite to replace it with this version, or download theirs first.",
                        self.cfg.name
                    )))
                }
                (None, false) => {
                    return Err(Error::Conflict(format!("{} already has a file named \"{name}\" that this report did not upload. Nothing was overwritten. Choose Overwrite to replace it, or give the destination another file name.", self.cfg.name)))
                }
                _ => {}
            }
        }
        let if_rev = if overwrite { None } else { known.as_deref() };
        let remote = self.cloud.upload(h, &tok, &name, package, existing.as_ref(), if_rev)?;
        Ok(self.remote_state(meta, &remote))
    }

    fn find_target(&self, t: &Target) -> Result<Option<(String, Remote)>> {
        let tok = self.token()?;
        let name = self.file_name(t);
        Ok(self.cloud.find(self.ctx.http.as_ref(), &tok, &name)?.map(|r| (tok, r)))
    }
}

impl Adapter for StorageAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: self.cfg.id.into(),
            name: self.cfg.name.into(),
            method: Method::PersonalStorage,
            phase: "O3".into(),
            capabilities: Capabilities {
                implemented: true,
                public_access: true,
                private_access: true,
                update: true,
                sync: true,
                share_link: true,
                unpublish: true,
                key_rotation: true,
                version_history: true,
                needs_account: true,
                ..Capabilities::default()
            },
            limitations: self.limitations.clone(),
            free_tier: self.free_tier.clone(),
        }
    }

    fn validate(&self, _t: &Target) -> Vec<Issue> {
        if self.is_connected() {
            Vec::new()
        } else {
            vec![Issue { severity: Severity::Error, message: format!("{} is not connected. Choose Connect {} first.", self.cfg.name, self.cfg.name) }]
        }
    }

    fn authenticate(&self, t: &mut Target) -> Result<()> {
        let tok = self.token()?;
        t.account = Some(self.cloud.whoami(self.ctx.http.as_ref(), &tok)?);
        Ok(())
    }

    fn publish(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        self.put(t, package, meta)
    }

    fn update(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        self.put(t, package, meta)
    }

    fn status(&self, t: &Target) -> Result<Option<RemoteState>> {
        Ok(self.find_target(t)?.map(|(_, r)| RemoteState { package_id: t.package_id.clone().unwrap_or_default(), version: t.last_version.unwrap_or(0), sha256: String::new(), location: r.web_url.clone().unwrap_or(r.id.clone()), updated_at: r.modified.clone(), rev: Some(r.rev) }))
    }

    fn share_link(&self, t: &Target) -> Result<String> {
        let (tok, r) = self.find_target(t)?.ok_or_else(|| Error::Adapter("The file is not in the account (any more). Publish first.".into()))?;
        self.cloud.share_link(self.ctx.http.as_ref(), &tok, &r)
    }

    /// Viewer side: downloads the file when its version is newer than `have`.
    fn sync(&self, t: &Target, have: Option<u64>) -> Result<Option<Vec<u8>>> {
        let (tok, r) = self.find_target(t)?.ok_or_else(|| Error::Adapter("The file is not in the account (any more).".into()))?;
        let bytes = self.cloud.download(self.ctx.http.as_ref(), &tok, &r)?;
        let env = package::peek(&bytes, None)?;
        Ok(if have.map(|h| env.version > h).unwrap_or(true) { Some(bytes) } else { None })
    }

    fn unpublish(&self, t: &Target) -> Result<()> {
        match self.find_target(t)? {
            Some((tok, r)) => self.cloud.delete(self.ctx.http.as_ref(), &tok, &r),
            None => Ok(()),
        }
    }

    fn versions(&self, t: &Target) -> Result<Vec<VersionInfo>> {
        let (tok, r) = self.find_target(t)?.ok_or_else(|| Error::Adapter("The file is not in the account (any more).".into()))?;
        self.cloud.versions(self.ctx.http.as_ref(), &tok, &r)
    }

    fn share_with(&self, t: &Target, email: &str, can_edit: bool) -> Result<()> {
        if !email.contains('@') || email.contains(char::is_whitespace) {
            return Err(Error::Adapter("Enter the person's e-mail address.".into()));
        }
        let (tok, r) = self.find_target(t)?.ok_or_else(|| Error::Adapter("The file is not in the account (any more). Publish first.".into()))?;
        self.cloud.share_with(self.ctx.http.as_ref(), &tok, &r, email.trim(), can_edit)
    }

    fn disconnect(&self, _t: &mut Target) -> Result<()> {
        self.disconnect_account()
    }
}

#[allow(dead_code)]
fn _assert_send_sync(_: Arc<dyn Cloud>) {}
