//! Package container.
//!
//! ```text
//! package.biforge  (zip)
//!   envelope.json   signed outer description (package id, version, publisher key, payload hash)
//!   envelope.sig    ed25519 signature over the exact bytes of envelope.json
//!   payload.bin     zip of manifest.json + project/** + data/**; age-encrypted when access is Private
//! ```
//! The signature covers the payload through its hash, so changing any byte of the payload, the envelope or
//! the signature is detected before anything is decrypted or extracted.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::keys::{key_id_of, sha256_hex, verify, Identity};
use crate::manifest::*;
use crate::{Error, Result};

/// Upper bound for the unpacked size of a package (zip-bomb guard).
pub const MAX_UNPACKED: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct PackageFile {
    /// Path inside the payload: `project/...` or `data/...`.
    pub path: String,
    pub bytes: Vec<u8>,
}

pub struct BuildInput {
    pub package_id: String,
    pub version: u64,
    pub report_name: String,
    pub publisher_name: String,
    pub access: AccessLevel,
    pub included: Vec<IncludedTable>,
    pub permissions: Vec<Permission>,
    pub created_at: String,
    pub files: Vec<PackageFile>,
    /// Required for [`AccessLevel::Private`]: age public keys (`age1...`) that may open the package.
    pub recipients: Vec<String>,
}

#[derive(Debug, Default)]
pub struct OpenOptions {
    /// Secret access key (`AGE-SECRET-KEY-...`) for private packages.
    pub access_key: Option<String>,
    /// If set, the package must be signed by this public key (base64). Used for subscriptions.
    pub expected_publisher: Option<String>,
}

#[derive(Debug)]
pub struct Package {
    pub envelope: Envelope,
    pub manifest: Manifest,
    pub files: BTreeMap<String, Vec<u8>>,
}

/// Rejects absolute paths, drive letters, backslashes, `..` and empty segments.
pub fn check_path(path: &str) -> Result<()> {
    let bad = path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains(':')
        || path.split('/').any(|s| s.is_empty() || s == "." || s == "..");
    if bad {
        return Err(Error::UnsafePath(path.to_string()));
    }
    if !(path.starts_with("project/") || path.starts_with("data/")) {
        return Err(Error::UnsafePath(format!("{path} (files must be under project/ or data/)")));
    }
    Ok(())
}

/// Files that hold local state or credentials and must never leave the machine.
fn forbidden_name(path: &str) -> Option<&'static str> {
    let l = path.to_ascii_lowercase();
    if l.contains("/.biforge/") {
        return Some("BIForge local state");
    }
    if l.ends_with("/localsettings.json") {
        return Some("local settings");
    }
    if l.ends_with("/cache.abf") {
        return Some("a model cache");
    }
    None
}

const SECRET_MARKERS: &[(&str, &str)] = &[
    ("AGE-SECRET-KEY-1", "an access key"),
    ("-----BEGIN PRIVATE KEY", "a private key"),
    ("-----BEGIN RSA PRIVATE KEY", "a private key"),
    ("-----BEGIN OPENSSH PRIVATE KEY", "a private key"),
    ("accountkey=", "a storage account key"),
    ("sharedaccesssignature=", "a shared access signature"),
    ("password=", "a password"),
    ("pwd=", "a password"),
    ("client_secret", "a client secret"),
    ("ghp_", "a GitHub token"),
    ("github_pat_", "a GitHub token"),
];

/// Scans text files of the project for credentials. Data files (Parquet) are not scanned.
pub fn scan_for_secrets(path: &str, bytes: &[u8]) -> Result<()> {
    if let Some(why) = forbidden_name(path) {
        return Err(Error::SecretFound(path.to_string(), why.to_string()));
    }
    if !path.starts_with("project/") || bytes.len() > 8 * 1024 * 1024 {
        return Ok(());
    }
    let Ok(text) = std::str::from_utf8(bytes) else { return Ok(()) };
    let lower = text.to_ascii_lowercase();
    for (marker, what) in SECRET_MARKERS {
        let m = marker.to_ascii_lowercase();
        // `password=` with an empty value (as Desktop writes for sources without a saved password) is not a secret
        if let Some(i) = lower.find(&m) {
            if (m == "password=" || m == "pwd=") && matches!(lower[i + m.len()..].chars().next(), None | Some(';') | Some('"') | Some('\'') | Some(' ') | Some('\n') | Some('\r')) {
                continue;
            }
            return Err(Error::SecretFound(path.to_string(), what.to_string()));
        }
    }
    Ok(())
}

fn zip_options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}

fn write_zip(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        w.start_file(name.as_str(), zip_options()).map_err(|e| Error::Invalid(e.to_string()))?;
        w.write_all(bytes)?;
    }
    Ok(w.finish().map_err(|e| Error::Invalid(e.to_string()))?.into_inner())
}

fn read_zip(bytes: &[u8], limit: u64) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).map_err(|e| Error::BadFormat(e.to_string()))?;
    let mut out = BTreeMap::new();
    let mut total = 0u64;
    for i in 0..z.len() {
        let f = z.by_index(i).map_err(|e| Error::BadFormat(e.to_string()))?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        let mut buf = Vec::new();
        f.take(limit.saturating_sub(total) + 1).read_to_end(&mut buf)?;
        total += buf.len() as u64;
        if total > limit {
            return Err(Error::TooLarge);
        }
        out.insert(name, buf);
    }
    Ok(out)
}

pub fn encrypt(data: &[u8], recipients: &[String]) -> Result<Vec<u8>> {
    if recipients.is_empty() {
        return Err(Error::Invalid("a private package needs at least one access key".into()));
    }
    let parsed: Vec<age::x25519::Recipient> = recipients
        .iter()
        .map(|r| r.trim().parse().map_err(|_| Error::Invalid(format!("not a valid access key recipient: {r}"))))
        .collect::<Result<_>>()?;
    let refs: Vec<&dyn age::Recipient> = parsed.iter().map(|r| r as &dyn age::Recipient).collect();
    let enc = age::Encryptor::with_recipients(refs.into_iter()).map_err(|e| Error::Invalid(e.to_string()))?;
    let mut out = Vec::new();
    let mut w = enc.wrap_output(&mut out).map_err(|e| Error::Invalid(e.to_string()))?;
    w.write_all(data)?;
    w.finish().map_err(|e| Error::Invalid(e.to_string()))?;
    Ok(out)
}

pub fn decrypt(data: &[u8], secret: &str, limit: u64) -> Result<Vec<u8>> {
    let id: age::x25519::Identity = secret.trim().parse().map_err(|_| Error::WrongKey)?;
    let dec = age::Decryptor::new(data).map_err(|e| Error::BadFormat(e.to_string()))?;
    let mut r = dec.decrypt(std::iter::once(&id as &dyn age::Identity)).map_err(|_| Error::WrongKey)?;
    let mut out = Vec::new();
    (&mut r).take(limit + 1).read_to_end(&mut out).map_err(|_| Error::WrongKey)?;
    if out.len() as u64 > limit {
        return Err(Error::TooLarge);
    }
    Ok(out)
}

/// Builds a signed package. Fails on unsafe paths, secrets in project files, and access/recipient mismatches.
pub fn build(input: BuildInput, signer: &Identity) -> Result<Vec<u8>> {
    match input.access {
        AccessLevel::Private if input.recipients.is_empty() => {
            return Err(Error::Invalid("a private package must be encrypted: give it an access key".into()))
        }
        AccessLevel::Public if !input.recipients.is_empty() => {
            return Err(Error::Invalid("a public package is not encrypted; remove the access keys or make it private".into()))
        }
        _ => {}
    }
    let mut entries = Vec::new();
    let mut listed = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for f in &input.files {
        check_path(&f.path)?;
        scan_for_secrets(&f.path, &f.bytes)?;
        if !seen.insert(f.path.clone()) {
            return Err(Error::Invalid(format!("duplicate file {}", f.path)));
        }
        listed.push(FileEntry { path: f.path.clone(), sha256: sha256_hex(&f.bytes), size: f.bytes.len() as u64 });
        entries.push((f.path.clone(), f.bytes.clone()));
    }
    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        package_id: input.package_id.clone(),
        version: input.version,
        report_name: input.report_name,
        publisher: PublisherInfo { name: input.publisher_name, key_id: signer.key_id(), public_key: signer.public_key() },
        access: input.access,
        included: input.included,
        permissions: input.permissions,
        created_at: input.created_at,
        files: listed,
        rls_enforced: false,
    };
    entries.insert(0, ("manifest.json".to_string(), serde_json::to_vec_pretty(&manifest)?));
    let payload_plain = write_zip(&entries)?;
    let payload = if input.access == AccessLevel::Private { encrypt(&payload_plain, &input.recipients)? } else { payload_plain };
    let envelope = Envelope {
        format: FORMAT_VERSION,
        package_id: input.package_id,
        version: input.version,
        access: input.access,
        encrypted: input.access == AccessLevel::Private,
        publisher_public_key: signer.public_key(),
        payload_sha256: sha256_hex(&payload),
        payload_len: payload.len() as u64,
    };
    let env_bytes = serde_json::to_vec_pretty(&envelope)?;
    let sig = signer.sign(&env_bytes);
    write_zip(&[("envelope.json".into(), env_bytes), ("envelope.sig".into(), sig), ("payload.bin".into(), payload)])
}

struct Outer {
    envelope: Envelope,
    payload: Vec<u8>,
}

fn open_outer(bytes: &[u8], expected_publisher: Option<&str>) -> Result<Outer> {
    let mut parts = read_zip(bytes, MAX_UNPACKED)?;
    let env_bytes = parts.remove("envelope.json").ok_or_else(|| Error::BadFormat("envelope.json is missing".into()))?;
    let sig = parts.remove("envelope.sig").ok_or_else(|| Error::BadFormat("envelope.sig is missing".into()))?;
    let payload = parts.remove("payload.bin").ok_or_else(|| Error::BadFormat("payload.bin is missing".into()))?;
    let envelope: Envelope = serde_json::from_slice(&env_bytes).map_err(|e| Error::BadFormat(format!("envelope: {e}")))?;
    if envelope.format != FORMAT_VERSION {
        return Err(Error::BadFormat(format!("format version {} is not supported by this BIForge", envelope.format)));
    }
    if !verify(&envelope.publisher_public_key, &env_bytes, &sig) {
        return Err(Error::SignatureInvalid);
    }
    if let Some(expected) = expected_publisher {
        if expected != envelope.publisher_public_key {
            return Err(Error::UntrustedPublisher);
        }
    }
    if sha256_hex(&payload) != envelope.payload_sha256 || payload.len() as u64 != envelope.payload_len {
        return Err(Error::Tampered("the payload does not match its signed hash".into()));
    }
    Ok(Outer { envelope, payload })
}

/// Reads and checks the signed envelope only (no key needed, nothing is decrypted).
pub fn peek(bytes: &[u8], expected_publisher: Option<&str>) -> Result<Envelope> {
    Ok(open_outer(bytes, expected_publisher)?.envelope)
}

/// Verifies, decrypts and unpacks a package. Every file is checked against the manifest.
pub fn open(bytes: &[u8], opts: &OpenOptions) -> Result<Package> {
    let Outer { envelope, payload } = open_outer(bytes, opts.expected_publisher.as_deref())?;
    let plain = if envelope.encrypted {
        let key = opts.access_key.as_deref().ok_or(Error::KeyRequired)?;
        decrypt(&payload, key, MAX_UNPACKED)?
    } else {
        payload
    };
    let mut files = read_zip(&plain, MAX_UNPACKED)?;
    let man_bytes = files.remove("manifest.json").ok_or_else(|| Error::BadFormat("manifest.json is missing".into()))?;
    let manifest: Manifest = serde_json::from_slice(&man_bytes).map_err(|e| Error::BadFormat(format!("manifest: {e}")))?;
    if manifest.package_id != envelope.package_id || manifest.version != envelope.version || manifest.access != envelope.access {
        return Err(Error::Tampered("manifest and envelope disagree".into()));
    }
    if manifest.publisher.public_key != envelope.publisher_public_key || manifest.publisher.key_id != key_id_of(&envelope.publisher_public_key) {
        return Err(Error::Tampered("manifest names a different publisher".into()));
    }
    if manifest.rls_enforced {
        return Err(Error::Tampered("a package cannot claim row-level security".into()));
    }
    if manifest.files.len() != files.len() {
        return Err(Error::Tampered("the file list does not match the files".into()));
    }
    for e in &manifest.files {
        check_path(&e.path)?;
        let f = files.get(&e.path).ok_or_else(|| Error::Tampered(format!("{} is listed but missing", e.path)))?;
        if sha256_hex(f) != e.sha256 || f.len() as u64 != e.size {
            return Err(Error::Tampered(format!("{} was changed", e.path)));
        }
    }
    Ok(Package { envelope, manifest, files })
}
