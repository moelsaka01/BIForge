use std::collections::HashMap;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

/// Where secrets live. The app implements this with Windows Credential Manager; tests use [`MemoryKeyStore`].
/// Secrets never go into project files, packages, targets or the audit log.
pub trait KeyStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, secret: &str) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
}

#[derive(Default)]
pub struct MemoryKeyStore(Mutex<HashMap<String, String>>);

impl KeyStore for MemoryKeyStore {
    fn get(&self, name: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, secret: &str) -> Result<()> {
        self.0.lock().unwrap().insert(name.into(), secret.into());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<()> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).expect("the operating system random generator failed");
    b
}

/// 32 random hex digits.
pub fn new_package_id() -> String {
    hex(&random_bytes::<16>())
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// The publisher's signing identity.
pub struct Identity {
    key: SigningKey,
}

impl Identity {
    pub fn generate() -> Self {
        Self { key: SigningKey::from_bytes(&random_bytes::<32>()) }
    }

    pub fn from_secret(b64: &str) -> Result<Self> {
        let raw = B64.decode(b64.trim()).map_err(|_| Error::Invalid("the signing key is not valid base64".into()))?;
        let arr: [u8; 32] = raw.try_into().map_err(|_| Error::Invalid("the signing key must be 32 bytes".into()))?;
        Ok(Self { key: SigningKey::from_bytes(&arr) })
    }

    pub fn secret(&self) -> String {
        B64.encode(self.key.to_bytes())
    }

    pub fn public_key(&self) -> String {
        B64.encode(self.key.verifying_key().to_bytes())
    }

    pub fn key_id(&self) -> String {
        key_id_of(&self.public_key())
    }

    pub fn sign(&self, data: &[u8]) -> Vec<u8> {
        self.key.sign(data).to_bytes().to_vec()
    }

    /// Loads the identity stored under `name`, creating and storing one on first use.
    pub fn load_or_create(store: &dyn KeyStore, name: &str) -> Result<Self> {
        if let Some(s) = store.get(name)? {
            return Self::from_secret(&s);
        }
        let id = Self::generate();
        store.set(name, &id.secret())?;
        Ok(id)
    }
}

pub fn key_id_of(public_b64: &str) -> String {
    let raw = B64.decode(public_b64).unwrap_or_default();
    sha256_hex(&raw)[..16].to_string()
}

pub fn verify(public_b64: &str, data: &[u8], signature: &[u8]) -> bool {
    let Ok(raw) = B64.decode(public_b64) else { return false };
    let Ok(arr): std::result::Result<[u8; 32], _> = raw.try_into() else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&arr) else { return false };
    let Ok(sig) = Signature::from_slice(signature) else { return false };
    vk.verify_strict(data, &sig).is_ok()
}

/// An access key for private packages: an age X25519 key pair. The public half encrypts, the secret half is
/// the "access key" handed to viewers (never put in a link).
pub struct AccessKey {
    pub secret: String,
    pub public: String,
}

impl AccessKey {
    pub fn generate() -> Self {
        use age::secrecy::ExposeSecret;
        let id = age::x25519::Identity::generate();
        Self { secret: id.to_string().expose_secret().to_string(), public: id.to_public().to_string() }
    }

    /// The public (encrypting) half of a secret access key.
    pub fn public_of(secret: &str) -> Result<String> {
        let id: age::x25519::Identity = secret.trim().parse().map_err(|_| Error::Invalid("this is not a BIForge access key".into()))?;
        Ok(id.to_public().to_string())
    }
}
