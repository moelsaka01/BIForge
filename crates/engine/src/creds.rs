use crate::error::{EngineError, Result};
use std::collections::HashMap;
use std::sync::Mutex;

/// Secrets never go into project files or logs; they live in the OS credential store.
pub trait CredentialStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, secret: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}

const SERVICE: &str = "BIForge";

/// Windows Credential Manager.
pub struct SystemCredentialStore;

impl CredentialStore for SystemCredentialStore {
    fn get(&self, key: &str) -> Result<Option<String>> {
        let e = keyring::Entry::new(SERVICE, key).map_err(|e| EngineError::Credential(e.to_string()))?;
        match e.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(EngineError::Credential(e.to_string())),
        }
    }
    fn set(&self, key: &str, secret: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, key)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| EngineError::Credential(e.to_string()))
    }
    fn delete(&self, key: &str) -> Result<()> {
        match keyring::Entry::new(SERVICE, key).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(EngineError::Credential(e.to_string())),
        }
    }
}

/// In-memory store for tests of code that needs a store.
#[derive(Default)]
pub struct MemoryCredentialStore(Mutex<HashMap<String, String>>);

impl CredentialStore for MemoryCredentialStore {
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn set(&self, key: &str, secret: &str) -> Result<()> {
        self.0.lock().unwrap().insert(key.into(), secret.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}
