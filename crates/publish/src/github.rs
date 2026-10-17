//! GitHub Pages adapter (method A, static hosting).
//!
//! Publishing makes (or reuses) one public repository per report, commits the package, the feed and a landing page
//! to it in a single commit through the Git Data API, and turns on GitHub Pages for the default branch. The repo's
//! history is the version history. BIForge only ever touches the repository named in the target, and reuses an
//! existing repository only when it carries BIForge's marker file for the same package.
//!
//! The account is a personal access token the user creates and BIForge keeps in the Windows Credential Manager
//! under [`TOKEN_KEY`]. Needed scopes: `repo` (create the repository and commit) and `workflow` (only for scheduled
//! refresh). Free GitHub accounts serve Pages only from public repositories, so a private report is an encrypted
//! package in a public repository.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};

use crate::adapter::*;
use crate::deeplink;
use crate::feed::{self, Feed, FEED_FILE};
use crate::http::{Request, Response};
use crate::manifest::AccessLevel;
use crate::subscribe;
use crate::targets::Target;
use crate::{Error, Result};

pub const ID: &str = "github-pages";
pub const TOKEN_KEY: &str = "biforge.github.token";
const MARKER: &str = ".biforge-site.json";
/// Files of a report's site that unpublishing removes. The marker and the workflow stay.
const API: &str = "https://api.github.com";
/// The Git Data API takes blobs up to 100 MB; the base64 form is a third larger, so stay well below.
pub const MAX_FILE: usize = 60 * 1024 * 1024;

pub struct GitHubAdapter {
    ctx: Context,
    api: String,
}

impl GitHubAdapter {
    pub fn new(ctx: Context) -> Self {
        Self { ctx, api: API.into() }
    }

    /// For tests against a local fake of the API.
    pub fn with_api(ctx: Context, api: &str) -> Self {
        Self { ctx, api: api.trim_end_matches('/').into() }
    }

    fn token(&self) -> Result<String> {
        self.ctx.keys.get(TOKEN_KEY)?.filter(|t| !t.trim().is_empty()).ok_or_else(|| Error::Adapter("GitHub is not connected. Choose Connect GitHub and paste an access token.".into()))
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Response> {
        let mut r = Request::new(method, &format!("{}{}", self.api, path))
            .bearer(&self.token()?)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(b) = body {
            r = r.json(b);
        }
        let resp = self.ctx.http.send(&r)?;
        if resp.status == 401 {
            return Err(Error::Adapter("GitHub did not accept the token (it may have expired or been revoked). Connect GitHub again.".into()));
        }
        Ok(resp)
    }

    fn expect(&self, resp: Response, what: &str) -> Result<Value> {
        if resp.ok() {
            resp.json()
        } else if resp.status == 403 || resp.status == 404 {
            Err(Error::Adapter(format!("GitHub refused to {what} ({}). The token needs the \"repo\" permission{}.", resp.describe(), if what.contains("workflow") { " and \"workflow\"" } else { "" })))
        } else {
            Err(Error::Adapter(format!("GitHub could not {what}: {}", resp.describe())))
        }
    }

    pub fn login(&self) -> Result<String> {
        let v = self.expect(self.call("GET", "/user", None)?, "read your account")?;
        v["login"].as_str().map(str::to_string).ok_or_else(|| Error::Adapter("GitHub did not say who you are".into()))
    }

    fn repo_name(t: &Target) -> Result<String> {
        let r = t.settings.get("repo").map(|s| s.trim().to_string()).unwrap_or_default();
        if r.is_empty() {
            return Err(Error::Adapter("Choose a name for the site's repository.".into()));
        }
        if r.len() > 100 || !r.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) || r.starts_with('.') || r.ends_with(".git") {
            return Err(Error::Adapter("The repository name may use letters, digits, - _ . only.".into()));
        }
        Ok(r)
    }

    /// `owner` of the target: the account recorded at connect time, or asked again.
    fn owner(&self, t: &Target) -> Result<String> {
        match &t.account {
            Some(a) if !a.is_empty() => Ok(a.clone()),
            _ => self.login(),
        }
    }

    pub fn site_url(owner: &str, repo: &str) -> String {
        if repo.eq_ignore_ascii_case(&format!("{owner}.github.io")) {
            format!("https://{}.github.io/", owner.to_lowercase())
        } else {
            format!("https://{}.github.io/{}/", owner.to_lowercase(), repo)
        }
    }

    /// Returns (default branch) of the repository, creating it when it does not exist.
    fn ensure_repo(&self, owner: &str, repo: &str, package_id: &str, report_name: &str) -> Result<String> {
        let r = self.call("GET", &format!("/repos/{owner}/{repo}"), None)?;
        if r.status == 404 {
            let body = json!({
                "name": repo,
                "description": format!("BIForge report site for \"{}\" (managed by BIForge)", report_name.chars().take(80).collect::<String>()),
                "private": false,
                "auto_init": true,
                "has_issues": false,
                "has_wiki": false,
            });
            let made = self.expect(self.call("POST", "/user/repos", Some(&body))?, "create the repository")?;
            return Ok(made["default_branch"].as_str().unwrap_or("main").to_string());
        }
        let v = self.expect(r, "read the repository")?;
        if v["private"].as_bool().unwrap_or(false) {
            return Err(Error::Adapter(format!("The repository {owner}/{repo} is private. GitHub Pages on a free account needs a public repository; choose another name and BIForge will create a public one.")));
        }
        let branch = v["default_branch"].as_str().unwrap_or("main").to_string();
        // never touch a repository BIForge did not make for this report
        let m = self.call("GET", &format!("/repos/{owner}/{repo}/contents/{MARKER}"), None)?;
        let ours = if m.ok() {
            let j = m.json()?;
            let raw = j["content"].as_str().unwrap_or("").replace('\n', "");
            let bytes = B64.decode(raw).unwrap_or_default();
            serde_json::from_slice::<Value>(&bytes).ok().and_then(|x| x["packageId"].as_str().map(|s| s == package_id)).unwrap_or(false)
        } else {
            false
        };
        if !ours {
            return Err(Error::Adapter(format!("The repository {owner}/{repo} already exists and was not made by BIForge for this report, so BIForge will not change it. Choose another name.")));
        }
        Ok(branch)
    }

    /// One commit that sets `put` files and removes `remove` paths.
    fn commit(&self, owner: &str, repo: &str, branch: &str, put: &[(String, Vec<u8>)], remove: &[String], message: &str) -> Result<()> {
        let base = format!("/repos/{owner}/{repo}");
        let r = self.expect(self.call("GET", &format!("{base}/git/ref/heads/{branch}"), None)?, "read the branch")?;
        let head = r["object"]["sha"].as_str().ok_or_else(|| Error::Adapter("GitHub did not return the branch head".into()))?.to_string();
        let c = self.expect(self.call("GET", &format!("{base}/git/commits/{head}"), None)?, "read the last commit")?;
        let base_tree = c["tree"]["sha"].as_str().ok_or_else(|| Error::Adapter("GitHub did not return the tree".into()))?.to_string();
        let mut entries = Vec::new();
        for (path, bytes) in put {
            if bytes.len() > MAX_FILE {
                return Err(Error::Adapter(format!("{path} is {} MB; GitHub Pages publishing through BIForge is limited to {} MB per file. Publish fewer tables or columns.", bytes.len() / 1_000_000, MAX_FILE / 1_000_000)));
            }
            let b = self.expect(self.call("POST", &format!("{base}/git/blobs"), Some(&json!({"content": B64.encode(bytes), "encoding": "base64"})))?, "upload a file")?;
            entries.push(json!({"path": path, "mode": "100644", "type": "blob", "sha": b["sha"]}));
        }
        for path in remove {
            entries.push(json!({"path": path, "mode": "100644", "type": "blob", "sha": null}));
        }
        let t = self.expect(self.call("POST", &format!("{base}/git/trees"), Some(&json!({"base_tree": base_tree, "tree": entries})))?, "build the commit")?;
        let n = self.expect(self.call("POST", &format!("{base}/git/commits"), Some(&json!({"message": message, "tree": t["sha"], "parents": [head]})))?, "write the commit")?;
        self.expect(self.call("PATCH", &format!("{base}/git/refs/heads/{branch}"), Some(&json!({"sha": n["sha"]})))?, "move the branch")?;
        Ok(())
    }

    fn ensure_pages(&self, owner: &str, repo: &str, branch: &str) -> Result<String> {
        let path = format!("/repos/{owner}/{repo}/pages");
        let r = self.call("GET", &path, None)?;
        if r.ok() {
            let v = r.json()?;
            return Ok(v["html_url"].as_str().map(|s| format!("{}/", s.trim_end_matches('/'))).unwrap_or_else(|| Self::site_url(owner, repo)));
        }
        if r.status != 404 {
            return Err(Error::Adapter(format!("GitHub could not read the Pages settings: {}", r.describe())));
        }
        let v = self.expect(self.call("POST", &path, Some(&json!({"source": {"branch": branch, "path": "/"}})))?, "turn on GitHub Pages")?;
        Ok(v["html_url"].as_str().map(|s| format!("{}/", s.trim_end_matches('/'))).unwrap_or_else(|| Self::site_url(owner, repo)))
    }

    fn put(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        let repo = Self::repo_name(t)?;
        let owner = self.owner(t)?;
        let branch = self.ensure_repo(&owner, &repo, &meta.package_id, &meta.report_name)?;
        let site = self.ensure_pages(&owner, &repo, &branch)?;
        let feed_url = subscribe::feed_address(&site);
        let file = format!("{}.biforge", meta.package_id);
        let f = Feed { package_id: meta.package_id.clone(), version: meta.version, file, sha256: meta.sha256.clone(), access: meta.access, updated_at: meta.time.clone() };
        let mut files = feed::site_files(package, &meta.report_name, &f, &deeplink::build_url(&feed_url));
        files.push((MARKER.into(), serde_json::to_vec_pretty(&json!({"createdBy": "BIForge", "packageId": meta.package_id}))?));
        self.commit(&owner, &repo, &branch, &files, &[], &format!("BIForge: publish version {}", meta.version))?;
        Ok(RemoteState { package_id: meta.package_id.clone(), version: meta.version, sha256: meta.sha256.clone(), location: feed_url, updated_at: meta.time.clone() })
    }
}

impl Adapter for GitHubAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: ID.into(),
            name: "GitHub Pages".into(),
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
                version_history: true,
                scheduled_refresh: true,
                needs_account: true,
                ..Capabilities::default()
            },
            limitations: vec![
                "The site is public: anyone with the address can download the package. A private report is encrypted, but the encrypted file is still downloadable by anyone.".into(),
                "Updates reach viewers when their BIForge checks the feed, not instantly. GitHub needs about a minute to publish a new version.".into(),
                "Revoking access (changing the key) stops new versions from opening with the old key; copies already downloaded stay readable.".into(),
                "No row-level security: everything in the package is visible to everyone who can open it.".into(),
                "Files up to 60 MB each.".into(),
            ],
            free_tier: vec![
                "Free GitHub account, no payment card".into(),
                "Pages: site up to 1 GB, soft limit of 100 GB bandwidth per month".into(),
                "Free plan serves Pages only from public repositories".into(),
                "Actions (scheduled refresh) are free for public repositories".into(),
            ],
        }
    }

    fn validate(&self, t: &Target) -> Vec<Issue> {
        let mut out = Vec::new();
        if let Err(e) = Self::repo_name(t) {
            out.push(Issue { severity: Severity::Error, message: e.to_string() });
        }
        if self.ctx.keys.get(TOKEN_KEY).ok().flatten().is_none() {
            out.push(Issue { severity: Severity::Error, message: "GitHub is not connected. Choose Connect GitHub first.".into() });
        }
        out.push(Issue {
            severity: Severity::Warning,
            message: if t.access == AccessLevel::Public {
                "The report and its data will be readable by anyone on the internet.".into()
            } else {
                "The report is encrypted, but the encrypted file is public: anyone can download it and try to open it.".into()
            },
        });
        out
    }

    fn authenticate(&self, t: &mut Target) -> Result<()> {
        t.account = Some(self.login()?);
        Ok(())
    }

    fn publish(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        self.put(t, package, meta)
    }

    fn update(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        self.put(t, package, meta)
    }

    fn status(&self, t: &Target) -> Result<Option<RemoteState>> {
        let repo = Self::repo_name(t)?;
        let owner = self.owner(t)?;
        let r = self.call("GET", &format!("/repos/{owner}/{repo}/contents/{FEED_FILE}"), None)?;
        if r.status == 404 {
            return Ok(None);
        }
        let v = self.expect(r, "read the feed")?;
        let raw = v["content"].as_str().unwrap_or("").replace('\n', "");
        let bytes = B64.decode(raw).map_err(|_| Error::Adapter("feed.json in the repository is not readable".into()))?;
        let f = Feed::parse(&bytes)?;
        Ok(Some(RemoteState { package_id: f.package_id, version: f.version, sha256: f.sha256, location: subscribe::feed_address(&Self::site_url(&owner, &repo)), updated_at: f.updated_at }))
    }

    fn share_link(&self, t: &Target) -> Result<String> {
        let repo = Self::repo_name(t)?;
        let owner = self.owner(t)?;
        Ok(deeplink::build_url(&subscribe::feed_address(&Self::site_url(&owner, &repo))))
    }

    fn sync(&self, t: &Target, have: Option<u64>) -> Result<Option<Vec<u8>>> {
        let repo = Self::repo_name(t)?;
        let owner = self.owner(t)?;
        let url = subscribe::feed_address(&Self::site_url(&owner, &repo));
        match subscribe::newer(self.ctx.http.as_ref(), &url, have.unwrap_or(0))? {
            Some(f) if have.is_none() || f.version > have.unwrap_or(0) => Ok(Some(subscribe::fetch_package(self.ctx.http.as_ref(), &url, &f)?)),
            _ => Ok(None),
        }
    }

    fn unpublish(&self, t: &Target) -> Result<()> {
        let repo = Self::repo_name(t)?;
        let owner = self.owner(t)?;
        let r = self.call("GET", &format!("/repos/{owner}/{repo}/contents/{FEED_FILE}"), None)?;
        if r.status == 404 {
            return Ok(());
        }
        let v = self.expect(r, "read the feed")?;
        let bytes = B64.decode(v["content"].as_str().unwrap_or("").replace('\n', "")).unwrap_or_default();
        let f = Feed::parse(&bytes)?;
        let info = self.expect(self.call("GET", &format!("/repos/{owner}/{repo}"), None)?, "read the repository")?;
        let branch = info["default_branch"].as_str().unwrap_or("main").to_string();
        self.commit(&owner, &repo, &branch, &[], &[f.file, FEED_FILE.into(), feed::INDEX_FILE.into()], "BIForge: unpublish")
    }

    fn disconnect(&self, t: &mut Target) -> Result<()> {
        // the token is shared by every GitHub target of this user: it is removed from the credential store by
        // the app's "Disconnect GitHub" command, not here
        t.account = None;
        Ok(())
    }
}
