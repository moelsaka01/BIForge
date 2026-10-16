use serde::{Deserialize, Serialize};

pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccessLevel {
    /// Anyone who gets the package can read it. Not encrypted.
    Public,
    /// Encrypted for the holders of the access key.
    Private,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Viewer,
    Editor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludedTable {
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub principal: String,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherInfo {
    pub name: String,
    /// Short fingerprint of the public key (first 16 hex digits of its SHA-256).
    pub key_id: String,
    /// Base64 of the 32-byte ed25519 public key.
    pub public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

/// What a package says about itself. Lives inside the (possibly encrypted) payload; the signature covers it
/// through the payload hash in the envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format_version: u32,
    pub package_id: String,
    /// Increases by one with every publish of the same package.
    pub version: u64,
    pub report_name: String,
    pub publisher: PublisherInfo,
    pub access: AccessLevel,
    /// Exactly the tables and columns whose data is in the package.
    pub included: Vec<IncludedTable>,
    pub permissions: Vec<Permission>,
    pub created_at: String,
    pub files: Vec<FileEntry>,
    /// Always false for packages: row-level security is only enforced by a BIForge server (method D).
    pub rls_enforced: bool,
}

/// The unencrypted, signed outer description.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub format: u32,
    pub package_id: String,
    pub version: u64,
    pub access: AccessLevel,
    pub encrypted: bool,
    pub publisher_public_key: String,
    pub payload_sha256: String,
    pub payload_len: u64,
}
