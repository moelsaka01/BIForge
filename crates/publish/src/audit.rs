//! Audit log of publish / share / revoke events: `<project>/.biforge/publish/audit.jsonl`, one JSON object per line.
//! Entries never contain keys, tokens or data values.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::targets::TargetStore;
use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub time: String,
    /// publish, update, share-link, rotate-key, unpublish, disconnect, open-package, ...
    pub event: String,
    pub target_id: String,
    pub adapter_id: String,
    pub detail: String,
}

fn path(store: &TargetStore) -> PathBuf {
    store.dir().join("audit.jsonl")
}

pub fn append(store: &TargetStore, ev: &AuditEvent) -> Result<()> {
    fs::create_dir_all(store.dir())?;
    let mut f = OpenOptions::new().create(true).append(true).open(path(store))?;
    let mut line = serde_json::to_vec(ev)?;
    line.push(b'\n');
    f.write_all(&line)?;
    Ok(())
}

pub fn read_all(store: &TargetStore) -> Result<Vec<AuditEvent>> {
    match fs::read_to_string(path(store)) {
        Ok(s) => s.lines().filter(|l| !l.trim().is_empty()).map(|l| Ok(serde_json::from_str(l)?)).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}
