//! Publication targets, stored per report (one report can have several).
//!
//! Stored in `<project>/.biforge/publish/targets.json`. The file holds no secrets: signing keys and access
//! keys live in the [`crate::keys::KeyStore`] (Windows Credential Manager in the app).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::manifest::AccessLevel;
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetStatus {
    NeverPublished,
    Published,
    /// Unpublished from the destination.
    Unpublished,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub adapter_id: String,
    /// Name the user gave this destination.
    pub label: String,
    /// Adapter settings (for the folder adapter: `folder`). Never secrets.
    pub settings: BTreeMap<String, String>,
    pub access: AccessLevel,
    /// Account the destination uses, shown in the dialog (a login name, not a token).
    pub account: Option<String>,
    pub package_id: Option<String>,
    pub last_version: Option<u64>,
    pub last_sync: Option<String>,
    /// Version history of this target, newest last: (version, time).
    #[serde(default)]
    pub history: Vec<(u64, String)>,
    pub status: TargetStatus,
    pub last_error: Option<String>,
}

impl Target {
    pub fn new(id: &str, adapter_id: &str, label: &str, access: AccessLevel) -> Self {
        Self {
            id: id.into(),
            adapter_id: adapter_id.into(),
            label: label.into(),
            settings: BTreeMap::new(),
            access,
            account: None,
            package_id: None,
            last_version: None,
            last_sync: None,
            history: Vec::new(),
            status: TargetStatus::NeverPublished,
            last_error: None,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    version: u32,
    targets: Vec<Target>,
}

/// The targets of one project.
pub struct TargetStore {
    dir: PathBuf,
}

impl TargetStore {
    /// `project_root` is the folder with the .pbip file.
    pub fn for_project(project_root: &Path) -> Self {
        Self { dir: project_root.join(".biforge").join("publish") }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self) -> PathBuf {
        self.dir.join("targets.json")
    }

    pub fn list(&self) -> Result<Vec<Target>> {
        match fs::read(self.path()) {
            Ok(b) => Ok(serde_json::from_slice::<File>(&b)?.targets),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn get(&self, id: &str) -> Result<Target> {
        self.list()?.into_iter().find(|t| t.id == id).ok_or_else(|| Error::UnknownTarget(id.into()))
    }

    fn write(&self, targets: Vec<Target>) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join("targets.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&File { version: 1, targets })?)?;
        fs::rename(&tmp, self.path())?;
        Ok(())
    }

    /// Adds or replaces (by id).
    pub fn put(&self, target: Target) -> Result<()> {
        let mut all = self.list()?;
        match all.iter_mut().find(|t| t.id == target.id) {
            Some(slot) => *slot = target,
            None => all.push(target),
        }
        self.write(all)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let mut all = self.list()?;
        let n = all.len();
        all.retain(|t| t.id != id);
        if all.len() == n {
            return Err(Error::UnknownTarget(id.into()));
        }
        self.write(all)
    }
}
