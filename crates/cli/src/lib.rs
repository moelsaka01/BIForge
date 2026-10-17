//! Headless refresh of a published report, the program behind the generated GitHub Actions workflow.
//!
//! Input is a site folder (a checkout of the GitHub Pages repository) that holds `feed.json`, the published package
//! and `refresh.bundle`. The bundle is a normal BIForge package with the pruned project, `data/refresh.json` and the
//! whole source files; it is signed by the publisher and, for private reports, encrypted for the access key.
//! Secrets come from the environment (repository secrets): `BIFORGE_SIGNING_KEY`, and `BIFORGE_ACCESS_KEY` for
//! private reports. The program reloads the sources, exports the published tables and columns, and, when the data
//! changed, writes the next version of the package and the feed. It never publishes anything itself: the workflow
//! commits the changed files.

use std::fs;
use std::path::{Path, PathBuf};

use biforge_engine::{Engine, MemoryCredentialStore, SourceSpec};
use biforge_model::project::sanitize_file_name;
use biforge_publish::feed::{Feed, FEED_FILE};
use biforge_publish::keys::{sha256_hex, AccessKey, Identity};
use biforge_publish::manifest::AccessLevel;
use biforge_publish::package::{self, BuildInput, OpenOptions, PackageFile};
use biforge_publish::refresh::{RefreshConfig, BUNDLE_FILE, CONFIG_PATH};
use biforge_publish::time::now_rfc3339;

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing the report publishes changed; the site is untouched.
    Unchanged { version: u64 },
    Published { version: u64, file: String },
}

fn err<E: std::fmt::Display>(what: &str, e: E) -> String {
    format!("{what}: {e}")
}

/// Makes a source path from the bundle absolute under `root`.
fn spec_in(root: &Path, value: &serde_json::Value) -> Result<SourceSpec, String> {
    let mut v = value.clone();
    if let Some(p) = v.get("path").and_then(|p| p.as_str()).map(str::to_string) {
        let abs: PathBuf = root.join(&p);
        v["path"] = serde_json::Value::String(abs.display().to_string());
    }
    serde_json::from_value(v).map_err(|e| err("A source in the refresh bundle is not valid", e))
}

pub fn refresh_site(site: &Path, signing_key: &str, access_key: Option<&str>) -> Result<Outcome, String> {
    let signer = Identity::from_secret(signing_key).map_err(|e| err("BIFORGE_SIGNING_KEY", e))?;
    let access = access_key.map(str::trim).filter(|k| !k.is_empty());

    let feed = Feed::parse(&fs::read(site.join(FEED_FILE)).map_err(|e| err("Cannot read feed.json (is the report published here?)", e))?).map_err(|e| e.to_string())?;
    let bundle_bytes = fs::read(site.join(BUNDLE_FILE)).map_err(|e| err("Cannot read refresh.bundle (turn on scheduled refresh in BIForge)", e))?;
    let bundle = package::open(&bundle_bytes, &OpenOptions { access_key: access.map(str::to_string), expected_publisher: Some(signer.public_key()) }).map_err(|e| err("The refresh bundle cannot be opened with these keys", e))?;
    let config: RefreshConfig = serde_json::from_slice(bundle.files.get(CONFIG_PATH).ok_or("The refresh bundle has no data/refresh.json")?).map_err(|e| err("data/refresh.json", e))?;
    if config.package_id != feed.package_id {
        return Err("The refresh bundle belongs to a different report than this site's feed.".into());
    }
    if config.access == AccessLevel::Private && access.is_none() {
        return Err("This report is private: BIFORGE_ACCESS_KEY is needed.".into());
    }

    // unpack the sources next to each other so relative paths in the specs resolve
    let work = tempfile::tempdir().map_err(|e| err("temporary folder", e))?;
    for (name, bytes) in bundle.files.iter().filter(|(n, _)| n.starts_with("data/src/")) {
        let dest = work.path().join(name);
        fs::create_dir_all(dest.parent().expect("a file has a parent")).map_err(|e| err("unpacking", e))?;
        fs::write(&dest, bytes).map_err(|e| err("unpacking", e))?;
    }

    let engine = Engine::in_memory().map_err(|e| err("data engine", e))?;
    let creds = MemoryCredentialStore::default();
    for s in &config.sources {
        let spec = spec_in(work.path(), &s.spec)?;
        engine.import(&s.table, &spec, &creds).map_err(|e| format!("Could not reload table \"{}\" from {}: {e}", s.table, s.original))?;
    }

    // the published snapshots
    let mut included = config.included.clone();
    let mut files: Vec<PackageFile> = bundle.files.iter().filter(|(n, _)| n.starts_with("project/")).map(|(n, b)| PackageFile { path: n.clone(), bytes: b.clone() }).collect();
    let mut used = std::collections::BTreeSet::new();
    for t in &mut included {
        let mut base = sanitize_file_name(&t.table);
        while !used.insert(base.to_lowercase()) {
            base.push('_');
        }
        let rel = format!("data/{base}.parquet");
        let out = work.path().join(format!("{base}.parquet.out"));
        engine.export_parquet(&t.table, &t.columns, &out).map_err(|e| format!("Could not export table \"{}\": {e}", t.table))?;
        files.push(PackageFile { path: rel.clone(), bytes: fs::read(&out).map_err(|e| err("reading the export", e))? });
        t.data_file = rel;
    }

    // unchanged? compare with the package that is published now
    let current_bytes = fs::read(site.join(&feed.file)).map_err(|e| err("Cannot read the published package", e))?;
    let current = package::open(&current_bytes, &OpenOptions { access_key: access.map(str::to_string), expected_publisher: Some(signer.public_key()) }).map_err(|e| err("The published package cannot be opened with these keys", e))?;
    let same = files.iter().filter(|f| f.path.starts_with("data/")).all(|f| current.manifest.files.iter().any(|e| e.path == f.path && e.sha256 == sha256_hex(&f.bytes)))
        && current.manifest.included == included;
    if same {
        return Ok(Outcome::Unchanged { version: feed.version });
    }

    let recipients = match (config.access, access) {
        (AccessLevel::Private, Some(k)) => vec![AccessKey::public_of(k).map_err(|e| err("BIFORGE_ACCESS_KEY", e))?],
        _ => vec![],
    };
    let version = feed.version + 1;
    let now = now_rfc3339();
    let bytes = package::build(
        BuildInput {
            package_id: config.package_id.clone(),
            version,
            report_name: config.report_name.clone(),
            publisher_name: config.publisher_name.clone(),
            access: config.access,
            included,
            permissions: vec![],
            created_at: now.clone(),
            files,
            recipients,
        },
        &signer,
    )
    .map_err(|e| err("Building the new package", e))?;
    let new_feed = Feed { package_id: feed.package_id.clone(), version, file: feed.file.clone(), sha256: sha256_hex(&bytes), access: feed.access, updated_at: now };
    // package first, feed last: a viewer never sees a feed that points at a file that is not there yet
    fs::write(site.join(&feed.file), &bytes).map_err(|e| err("writing the package", e))?;
    fs::write(site.join(FEED_FILE), serde_json::to_vec_pretty(&new_feed).map_err(|e| err("feed", e))?).map_err(|e| err("writing feed.json", e))?;
    Ok(Outcome::Published { version, file: feed.file })
}
