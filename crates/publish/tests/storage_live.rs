//! Live tests of personal storage against the real services. They run only when the account is connected and the
//! client id is known; otherwise each prints SKIPPED and passes (CI never has an account).
//!
//! How to run (once per provider, on a PC where you are signed in):
//!   1. Put the public client ids into `%LOCALAPPDATA%\BIForge\oauth-clients.json`
//!      (`{"google-drive": "...", "onedrive": "...", "dropbox": "..."}`) or the variables
//!      `BIFORGE_GOOGLE_DRIVE_CLIENT_ID`, `BIFORGE_ONEDRIVE_CLIENT_ID`, `BIFORGE_DROPBOX_CLIENT_ID`.
//!      For Google also set `BIFORGE_GOOGLE_CLIENT_SECRET` (Google issues one with desktop clients).
//!   2. Start BIForge, open any project, Publish & Share, add the destination of the provider and press
//!      "Connect <provider> account"; finish the sign-in in the browser. The tokens go to Windows Credential Manager.
//!   3. `cargo test -p biforge-publish --test storage_live -- --nocapture`
//!
//! Each test uses a file with a random name in BIForge's own folder of the account and deletes it at the end, also
//! when an assertion fails. They never touch other files.

use std::sync::Arc;

use biforge_engine::CredentialStore;
use biforge_publish::adapter::{Adapter, Context, PackageMeta};
use biforge_publish::http::ReqwestHttp;
use biforge_publish::keys::KeyStore;
use biforge_publish::manifest::AccessLevel;
use biforge_publish::oauth;
use biforge_publish::storage::{client_id_for, StorageAdapter};
use biforge_publish::targets::Target;
use biforge_publish::Error;

/// The Windows Credential Manager as the publish engine's key store (same store the app uses).
struct Cm(biforge_engine::SystemCredentialStore);
impl KeyStore for Cm {
    fn get(&self, name: &str) -> biforge_publish::Result<Option<String>> {
        self.0.get(name).map_err(|e| Error::KeyStore(e.to_string()))
    }
    fn set(&self, name: &str, secret: &str) -> biforge_publish::Result<()> {
        self.0.set(name, secret).map_err(|e| Error::KeyStore(e.to_string()))
    }
    fn delete(&self, name: &str) -> biforge_publish::Result<()> {
        self.0.delete(name).map_err(|e| Error::KeyStore(e.to_string()))
    }
}

fn package(version: u64) -> (Vec<u8>, PackageMeta) {
    use biforge_publish::keys::Identity;
    use biforge_publish::package::{build, BuildInput, PackageFile};
    let signer = Identity::generate();
    let bytes = build(
        BuildInput {
            package_id: "live-test".into(),
            version,
            report_name: "Live test".into(),
            publisher_name: "BIForge live test".into(),
            access: AccessLevel::Public,
            included: vec![],
            permissions: vec![],
            created_at: "2026-10-18T00:00:00Z".into(),
            files: vec![PackageFile { path: "project/Live.pbip".into(), bytes: format!("{{\"v\":{version}}}").into_bytes() }],
            recipients: vec![],
        },
        &signer,
    )
    .unwrap();
    let meta = PackageMeta { package_id: "live-test".into(), report_name: "Live test".into(), version, access: AccessLevel::Public, sha256: biforge_publish::keys::sha256_hex(&bytes), time: "2026-10-18T00:00:00Z".into() };
    (bytes, meta)
}

fn run(provider: &str, make: fn(Context) -> StorageAdapter) {
    if client_id_for(provider).is_none() {
        println!("SKIPPED {provider}: no client id (see the header of this file)");
        return;
    }
    // BIFORGE_TEST_<PROVIDER>_ACCESS_TOKEN: a short-lived token from the provider console, kept only in memory.
    let env_token = std::env::var(format!("BIFORGE_TEST_{}_ACCESS_TOKEN", provider.to_ascii_uppercase().replace('-', "_"))).ok().filter(|t| !t.trim().is_empty());
    let keys: Arc<dyn KeyStore> = match &env_token {
        Some(tok) => {
            let m = biforge_publish::keys::MemoryKeyStore::default();
            let far = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 3000;
            oauth::store_tokens(&m, provider, &oauth::Tokens { access: tok.trim().to_string(), refresh: None, expires_at: far }).unwrap();
            Arc::new(m)
        }
        None => Arc::new(Cm(biforge_engine::SystemCredentialStore)),
    };
    if oauth::load_tokens(keys.as_ref(), provider).ok().flatten().is_none() {
        println!("SKIPPED {provider}: not connected (connect it in the app first)");
        return;
    }
    let http = Arc::new(ReqwestHttp::new().unwrap());
    let a = make(Context { keys, http });
    let name = format!("biforge-live-{}.biforge", biforge_publish::keys::hex(&biforge_publish::keys::random_bytes::<4>()));
    let mut t = Target::new("live", provider, "live", AccessLevel::Public);
    t.settings.insert("file".into(), name.clone());

    struct Cleanup<'a>(&'a StorageAdapter, Target);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            if let Err(e) = self.0.unpublish(&self.1) {
                println!("COULD NOT CLEAN UP {}: {e}; delete it by hand", self.1.settings["file"]);
            }
        }
    }

    a.authenticate(&mut t).expect("the stored sign-in works");
    println!("{provider}: signed in as {}", t.account.clone().unwrap_or_default());
    let (b1, m1) = package(1);
    let first = a.publish(&t, &b1, &m1).expect("upload");
    let guard = Cleanup(&a, t.clone());
    t.settings.insert("rev".into(), first.rev.clone().expect("a revision"));
    println!("{provider}: uploaded {name}");

    // update with the remembered revision
    let (b2, m2) = package(2);
    let second = a.update(&t, &b2, &m2).expect("update");
    assert_ne!(first.rev, second.rev, "a new revision");
    // the stale revision is a conflict, and nothing was overwritten
    let (b3, m3) = package(3);
    let err = a.update(&t, &b3, &m3).expect_err("the old revision must conflict");
    assert!(matches!(err, Error::Conflict(_)), "{err}");
    t.settings.insert("rev".into(), second.rev.clone().unwrap());
    // sync: a viewer gets version 2, and nothing newer than it has
    let got = a.sync(&t, Some(1)).unwrap().expect("version 2");
    assert_eq!(biforge_publish::package::open(&got, &Default::default()).unwrap().manifest.version, 2);
    assert!(a.sync(&t, Some(2)).unwrap().is_none());
    // history and a share link
    match a.versions(&t) {
        Ok(v) => println!("{provider}: {} versions kept", v.len()),
        Err(e) => println!("{provider}: no version history ({e})"),
    }
    let link = a.share_link(&t).expect("a sharing link");
    assert!(link.starts_with("https://"));
    println!("{provider}: sharing link works");
    drop(guard);
    assert!(a.status(&t).unwrap().is_none(), "the test file is gone");
    println!("{provider}: cleaned up");
}

#[test]
fn google_drive_live() {
    run("google-drive", StorageAdapter::google_drive);
}

#[test]
fn onedrive_live() {
    run("onedrive", StorageAdapter::onedrive);
}

#[test]
fn dropbox_live() {
    run("dropbox", StorageAdapter::dropbox);
}
