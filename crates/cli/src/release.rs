//! Signed releases without a paid code-signing certificate.
//!
//! Every release carries `SHA256SUMS` (one line per file: the SHA-256 and the name) and `SHA256SUMS.sig`, an Ed25519
//! signature over exactly the bytes of `SHA256SUMS`, made with BIForge's release key. The public key is in the
//! repository (`docs/release-public-key.txt`) and in every release's notes, so anyone can check a download with
//! `biforge-cli verify-release`. The installer itself is not Authenticode-signed (that needs a certificate that costs
//! money), so Windows SmartScreen may warn about it; the signature and GitHub's build attestation are the proof of
//! where it came from.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use biforge_publish::keys::{self, Identity};

pub const SUMS_FILE: &str = "SHA256SUMS";
pub const SIG_FILE: &str = "SHA256SUMS.sig";

fn file_name(p: &Path) -> Result<String, String> {
    p.file_name().map(|n| n.to_string_lossy().to_string()).ok_or_else(|| format!("{} has no file name", p.display()))
}

/// The `SHA256SUMS` text for these files (sorted by name; names are file names only).
pub fn sums(files: &[PathBuf]) -> Result<String, String> {
    let mut lines: Vec<(String, String)> = Vec::new();
    for f in files {
        let bytes = fs::read(f).map_err(|e| format!("Cannot read {}: {e}", f.display()))?;
        lines.push((file_name(f)?, keys::sha256_hex(&bytes)));
    }
    lines.sort();
    if lines.windows(2).any(|w| w[0].0 == w[1].0) {
        return Err("Two files have the same name.".into());
    }
    Ok(lines.iter().map(|(n, h)| format!("{h}  {n}\n")).collect())
}

/// Base64 signature over the sums text.
pub fn sign(sums: &str, secret_b64: &str) -> Result<String, String> {
    let id = Identity::from_secret(secret_b64).map_err(|e| format!("The release key: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(id.sign(sums.as_bytes())))
}

/// Checks the signature of `SHA256SUMS` and the hash of every file it lists (found in `dir`). Returns the names checked.
pub fn verify(public_b64: &str, sums_text: &str, sig_b64: &str, dir: &Path) -> Result<Vec<String>, String> {
    let sig = base64::engine::general_purpose::STANDARD.decode(sig_b64.trim()).map_err(|_| "The signature file is not valid.".to_string())?;
    if !keys::verify(public_b64.trim(), sums_text.as_bytes(), &sig) {
        return Err("The signature of SHA256SUMS does not match the release key: this release was not signed by BIForge, or the file was changed.".into());
    }
    let mut checked = Vec::new();
    for line in sums_text.lines().filter(|l| !l.trim().is_empty()) {
        let (hash, name) = line.split_once("  ").ok_or_else(|| format!("Bad line in SHA256SUMS: {line}"))?;
        if name.contains(['/', '\\']) || name == ".." || name == "." {
            return Err(format!("SHA256SUMS names a path, not a file: {name}"));
        }
        let bytes = fs::read(dir.join(name)).map_err(|e| format!("Cannot read {name}: {e}"))?;
        if keys::sha256_hex(&bytes) != hash {
            return Err(format!("{name} does not match its signed hash: it was changed or damaged."));
        }
        checked.push(name.to_string());
    }
    if checked.is_empty() {
        return Err("SHA256SUMS lists no files.".into());
    }
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_sums_verify_and_any_change_is_caught() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("BIForge_setup.exe");
        let b = dir.path().join("biforge-cli.exe");
        fs::write(&a, b"installer bytes").unwrap();
        fs::write(&b, b"cli bytes").unwrap();
        let key = Identity::generate();
        let text = sums(&[b.clone(), a.clone()]).unwrap();
        assert!(text.starts_with(&keys::sha256_hex(b"installer bytes")) && text.contains("  BIForge_setup.exe\n") && text.contains("  biforge-cli.exe\n"));
        let sig = sign(&text, &key.secret()).unwrap();
        assert_eq!(verify(&key.public_key(), &text, &sig, dir.path()).unwrap(), ["BIForge_setup.exe", "biforge-cli.exe"]);
        // another key, an edited list, an edited file, a missing file
        assert!(verify(&Identity::generate().public_key(), &text, &sig, dir.path()).unwrap_err().contains("does not match the release key"));
        assert!(verify(&key.public_key(), &text.replace("setup", "setxp"), &sig, dir.path()).is_err());
        fs::write(&a, b"installer bytez").unwrap();
        assert!(verify(&key.public_key(), &text, &sig, dir.path()).unwrap_err().contains("BIForge_setup.exe does not match"));
        fs::remove_file(&b).unwrap();
        assert!(verify(&key.public_key(), &text, &sig, dir.path()).is_err());
        // a list that names a path is refused even when signed
        let evil = format!("{}  ..\\x.exe\n", keys::sha256_hex(b"x"));
        let esig = sign(&evil, &key.secret()).unwrap();
        assert!(verify(&key.public_key(), &evil, &esig, dir.path()).unwrap_err().contains("not a file"));
    }
}
