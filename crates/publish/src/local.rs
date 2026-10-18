//! The file/folder adapter: publishes to a folder on this PC, a network share, or a folder that some other tool
//! (Syncthing, a sync client, a USB stick) carries to other people. No account, no network code.
//!
//! Layout of the folder: `<packageId>.biforge` (the package) and `feed.json` (what the latest version is).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::adapter::*;
use crate::deeplink;
use crate::keys::sha256_hex;
use crate::manifest::AccessLevel;
use crate::targets::Target;
use crate::{Error, Result};

pub const ID: &str = "local-folder";
const FEED: &str = "feed.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Feed {
    package_id: String,
    version: u64,
    file: String,
    sha256: String,
    access: AccessLevel,
    updated_at: String,
}

pub struct LocalFolderAdapter;

fn folder(t: &Target) -> Result<PathBuf> {
    let f = t.settings.get("folder").map(|s| s.trim()).filter(|s| !s.is_empty()).ok_or_else(|| Error::Adapter("Choose a folder.".into()))?;
    Ok(PathBuf::from(f))
}

fn read_feed(dir: &Path) -> Result<Option<Feed>> {
    match fs::read(dir.join(FEED)) {
        Ok(b) => Ok(Some(serde_json::from_slice(&b).map_err(|e| Error::Adapter(format!("{FEED} in the folder is not valid: {e}")))?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn state(dir: &Path, f: &Feed) -> RemoteState {
    RemoteState { package_id: f.package_id.clone(), version: f.version, sha256: f.sha256.clone(), location: dir.join(&f.file).display().to_string(), updated_at: f.updated_at.clone(), rev: None }
}

fn put(t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
    let dir = folder(t)?;
    fs::create_dir_all(&dir)?;
    if let Some(old) = read_feed(&dir)? {
        if old.package_id != meta.package_id {
            return Err(Error::Adapter("This folder already holds a different published report. Choose another folder.".into()));
        }
        if meta.version <= old.version {
            return Err(Error::Adapter(format!("The folder already has version {}; a new version must be higher than that.", old.version)));
        }
    }
    let file = format!("{}.biforge", meta.package_id);
    write_atomic(&dir.join(&file), package)?;
    let feed = Feed { package_id: meta.package_id.clone(), version: meta.version, file, sha256: sha256_hex(package), access: meta.access, updated_at: meta.time.clone() };
    write_atomic(&dir.join(FEED), &serde_json::to_vec_pretty(&feed)?)?;
    Ok(state(&dir, &feed))
}

impl Adapter for LocalFolderAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: ID.into(),
            name: "Folder on this PC or network".into(),
            method: Method::LocalFolder,
            phase: "O1".into(),
            capabilities: Capabilities {
                implemented: true,
                public_access: true,
                private_access: true,
                update: true,
                sync: true,
                share_link: true,
                unpublish: true,
                key_rotation: true,
                ..Capabilities::default()
            },
            limitations: vec![
                "There is no access control: whoever can open the folder can copy the package. Private packages are encrypted, public ones are not.".into(),
                "Revoking a private package (changing its key) stops new versions from opening with the old key; copies already downloaded stay readable.".into(),
                "No row-level security: everything in the package is visible to everyone who can open it.".into(),
            ],
            free_tier: vec!["No account and no limits except the space on your disk.".into()],
        }
    }

    fn validate(&self, t: &Target) -> Vec<Issue> {
        let mut out = Vec::new();
        match folder(t) {
            Err(e) => out.push(Issue { severity: Severity::Error, message: e.to_string() }),
            Ok(dir) => {
                if !dir.is_absolute() {
                    out.push(Issue { severity: Severity::Error, message: "The folder must be a full path.".into() });
                } else if dir.exists() && !dir.is_dir() {
                    out.push(Issue { severity: Severity::Error, message: "That path is a file, not a folder.".into() });
                } else if !dir.exists() && !dir.ancestors().skip(1).any(|a| a.is_dir()) {
                    out.push(Issue { severity: Severity::Error, message: "That location does not exist (not even its drive or parent folders).".into() });
                }
            }
        }
        if t.access == AccessLevel::Public {
            out.push(Issue { severity: Severity::Warning, message: "A public package is not encrypted: everyone who can open this folder can read the data.".into() });
        }
        out
    }

    fn publish(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        put(t, package, meta)
    }

    fn update(&self, t: &Target, package: &[u8], meta: &PackageMeta) -> Result<RemoteState> {
        put(t, package, meta)
    }

    fn status(&self, t: &Target) -> Result<Option<RemoteState>> {
        let dir = folder(t)?;
        Ok(read_feed(&dir)?.map(|f| state(&dir, &f)))
    }

    fn share_link(&self, t: &Target) -> Result<String> {
        let dir = folder(t)?;
        let feed = read_feed(&dir)?.ok_or_else(|| Error::Adapter("Publish first, then share.".into()))?;
        Ok(deeplink::build_file(&dir.join(feed.file).display().to_string()))
    }

    fn sync(&self, t: &Target, have: Option<u64>) -> Result<Option<Vec<u8>>> {
        let dir = folder(t)?;
        let Some(feed) = read_feed(&dir)? else { return Ok(None) };
        if have.map(|h| feed.version <= h).unwrap_or(false) {
            return Ok(None);
        }
        let bytes = fs::read(dir.join(&feed.file))?;
        if sha256_hex(&bytes) != feed.sha256 {
            return Err(Error::Adapter("The package in the folder does not match its feed (a sync may be in progress). Try again later.".into()));
        }
        Ok(Some(bytes))
    }

    fn unpublish(&self, t: &Target) -> Result<()> {
        let dir = folder(t)?;
        if let Some(feed) = read_feed(&dir)? {
            let _ = fs::remove_file(dir.join(&feed.file));
            fs::remove_file(dir.join(FEED))?;
        }
        Ok(())
    }

    fn disconnect(&self, _t: &mut Target) -> Result<()> {
        Ok(())
    }
}
