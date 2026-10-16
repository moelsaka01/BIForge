use biforge_publish::keys::{AccessKey, Identity};
use biforge_publish::manifest::*;
use biforge_publish::package::*;
use biforge_publish::Error;

fn files() -> Vec<PackageFile> {
    vec![
        PackageFile { path: "project/Sales.pbip".into(), bytes: br#"{"version":"1.0"}"#.to_vec() },
        PackageFile { path: "project/Sales.SemanticModel/definition/model.tmdl".into(), bytes: b"model Model\n\tculture: en-US\n".to_vec() },
        PackageFile { path: "data/Sales.parquet".into(), bytes: (0..5000u32).flat_map(|i| i.to_le_bytes()).collect() },
    ]
}

fn input(access: AccessLevel, recipients: Vec<String>) -> BuildInput {
    BuildInput {
        package_id: "abc123".into(),
        version: 3,
        report_name: "Sales".into(),
        publisher_name: "Ann".into(),
        access,
        included: vec![IncludedTable { table: "Sales".into(), columns: vec!["Amount".into(), "Date".into()] }],
        permissions: vec![Permission { principal: "anyone-with-key".into(), role: Role::Viewer }],
        created_at: "2026-10-17T10:00:00Z".into(),
        files: files(),
        recipients,
    }
}

#[test]
fn public_round_trip() {
    let id = Identity::generate();
    let bytes = build(input(AccessLevel::Public, vec![]), &id).unwrap();
    let p = open(&bytes, &OpenOptions::default()).unwrap();
    assert_eq!(p.manifest.version, 3);
    assert_eq!(p.manifest.publisher.key_id, id.key_id());
    assert_eq!(p.manifest.included[0].columns, vec!["Amount", "Date"]);
    assert!(!p.manifest.rls_enforced);
    assert_eq!(p.files.len(), 3);
    for f in files() {
        assert_eq!(p.files[&f.path], f.bytes);
    }
    assert!(!p.envelope.encrypted);
}

#[test]
fn private_round_trip_and_nothing_readable_without_the_key() {
    let id = Identity::generate();
    let key = AccessKey::generate();
    let bytes = build(input(AccessLevel::Private, vec![key.public.clone()]), &id).unwrap();
    // the table name and a file's text must not appear in the package bytes
    let hay = String::from_utf8_lossy(&bytes);
    assert!(!hay.contains("Amount") && !hay.contains("culture"));
    assert!(matches!(open(&bytes, &OpenOptions::default()), Err(Error::KeyRequired)));
    let p = open(&bytes, &OpenOptions { access_key: Some(key.secret.clone()), ..Default::default() }).unwrap();
    assert_eq!(p.manifest.access, AccessLevel::Private);
    assert_eq!(p.files["project/Sales.pbip"], files()[0].bytes);
    // the envelope can be read without a key (version check for sync)
    assert_eq!(peek(&bytes, None).unwrap().version, 3);
}

#[test]
fn wrong_key_fails_cleanly() {
    let id = Identity::generate();
    let bytes = build(input(AccessLevel::Private, vec![AccessKey::generate().public]), &id).unwrap();
    let other = AccessKey::generate();
    assert!(matches!(open(&bytes, &OpenOptions { access_key: Some(other.secret), ..Default::default() }), Err(Error::WrongKey)));
    assert!(matches!(open(&bytes, &OpenOptions { access_key: Some("not a key".into()), ..Default::default() }), Err(Error::WrongKey)));
}

#[test]
fn several_recipients_each_open_it() {
    let id = Identity::generate();
    let (a, b) = (AccessKey::generate(), AccessKey::generate());
    let bytes = build(input(AccessLevel::Private, vec![a.public.clone(), b.public.clone()]), &id).unwrap();
    for k in [a, b] {
        open(&bytes, &OpenOptions { access_key: Some(k.secret), ..Default::default() }).unwrap();
    }
}

/// Replaces the first occurrence of `from` in the named zip entry of `package` (stored entries are compressed, so
/// the entry is rewritten through the zip API).
fn rewrite_entry(package: &[u8], entry: &str, f: impl Fn(Vec<u8>) -> Vec<u8>) -> Vec<u8> {
    use std::io::{Cursor, Read, Write};
    let mut z = zip::ZipArchive::new(Cursor::new(package)).unwrap();
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for i in 0..z.len() {
        let mut file = z.by_index(i).unwrap();
        let name = file.name().to_string();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).unwrap();
        if name == entry {
            buf = f(buf);
        }
        w.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(&buf).unwrap();
    }
    w.finish().unwrap().into_inner()
}

#[test]
fn tampering_with_the_payload_is_detected() {
    let id = Identity::generate();
    let bytes = build(input(AccessLevel::Public, vec![]), &id).unwrap();
    let bad = rewrite_entry(&bytes, "payload.bin", |mut b| {
        let n = b.len() / 2;
        b[n] ^= 0x01;
        b
    });
    assert!(matches!(open(&bad, &OpenOptions::default()), Err(Error::Tampered(_))));
}

#[test]
fn tampering_with_the_envelope_or_signature_is_detected() {
    let id = Identity::generate();
    let bytes = build(input(AccessLevel::Public, vec![]), &id).unwrap();
    // version bumped in the envelope (a downgrade/replay trick)
    let bad = rewrite_entry(&bytes, "envelope.json", |b| String::from_utf8(b).unwrap().replace("\"version\": 3", "\"version\": 9").into_bytes());
    assert!(matches!(open(&bad, &OpenOptions::default()), Err(Error::SignatureInvalid)));
    let bad = rewrite_entry(&bytes, "envelope.sig", |mut b| {
        b[0] ^= 0xff;
        b
    });
    assert!(matches!(open(&bad, &OpenOptions::default()), Err(Error::SignatureInvalid)));
    // swapping in another publisher's key does not help an attacker either
    let other = Identity::generate();
    let bad = rewrite_entry(&bytes, "envelope.json", |b| String::from_utf8(b).unwrap().replace(&id.public_key(), &other.public_key()).into_bytes());
    assert!(matches!(open(&bad, &OpenOptions::default()), Err(Error::SignatureInvalid)));
}

#[test]
fn a_package_re_signed_by_someone_else_is_rejected_when_the_publisher_is_pinned() {
    let owner = Identity::generate();
    let attacker = Identity::generate();
    let forged = build(input(AccessLevel::Public, vec![]), &attacker).unwrap();
    // valid on its own...
    open(&forged, &OpenOptions::default()).unwrap();
    // ...but not for a subscriber who pinned the owner's key
    let r = open(&forged, &OpenOptions { expected_publisher: Some(owner.public_key()), ..Default::default() });
    assert!(matches!(r, Err(Error::UntrustedPublisher)));
    let genuine = build(input(AccessLevel::Public, vec![]), &owner).unwrap();
    open(&genuine, &OpenOptions { expected_publisher: Some(owner.public_key()), ..Default::default() }).unwrap();
}

#[test]
fn garbage_is_not_a_package() {
    assert!(matches!(open(b"hello", &OpenOptions::default()), Err(Error::BadFormat(_))));
    assert!(open(&[], &OpenOptions::default()).is_err());
}

#[test]
fn access_level_and_recipients_must_agree() {
    let id = Identity::generate();
    assert!(build(input(AccessLevel::Private, vec![]), &id).is_err(), "private without a key must not be built unencrypted");
    assert!(build(input(AccessLevel::Public, vec![AccessKey::generate().public]), &id).is_err());
    assert!(build(input(AccessLevel::Private, vec!["nonsense".into()]), &id).is_err());
}

#[test]
fn unsafe_paths_are_refused() {
    let id = Identity::generate();
    for bad in ["../x", "project/../../x", "/abs/x", "C:/x", "project\\x", "other/x", "project//x", ""] {
        let mut i = input(AccessLevel::Public, vec![]);
        i.files.push(PackageFile { path: bad.into(), bytes: vec![1] });
        assert!(matches!(build(i, &id), Err(Error::UnsafePath(_))), "{bad:?}");
    }
}

#[test]
fn secrets_never_enter_a_package() {
    let id = Identity::generate();
    let cases: Vec<(&str, &[u8])> = vec![
        ("project/a.tmdl", b"source = \"Server=x;Password=hunter2;\""),
        ("project/a.tmdl", b"key AGE-SECRET-KEY-1ABCDEF"),
        ("project/a.json", b"{\"token\":\"ghp_abcdefghijklmnopqrstuvwxyz0123456789\"}"),
        ("project/a.txt", b"-----BEGIN PRIVATE KEY-----"),
        ("project/.biforge/recovery/project.json", b"{}"),
        ("project/Sales.Report/.pbi/localSettings.json", b"{}"),
    ];
    for (path, bytes) in cases {
        let mut i = input(AccessLevel::Public, vec![]);
        i.files.push(PackageFile { path: path.into(), bytes: bytes.to_vec() });
        assert!(matches!(build(i, &id), Err(Error::SecretFound(..))), "{path}");
    }
    // an empty password value (how Desktop writes a source without a saved password) is fine
    let mut i = input(AccessLevel::Public, vec![]);
    i.files.push(PackageFile { path: "project/b.tmdl".into(), bytes: b"Server=x;Password=;Port=1".to_vec() });
    build(i, &id).unwrap();
}
