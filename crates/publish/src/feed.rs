//! The manifest feed: a small public `feed.json` next to the package that tells viewers which version is current.
//! Static hosts (GitHub Pages, Cloudflare), the folder adapter and the subscription code all use this one format.
//! The feed is unsigned on purpose: it only points at a package, and the package itself is signed, hashed and (for
//! private reports) encrypted, so a tampered feed can at worst make a viewer download the wrong file, which then
//! fails the checks (publisher pin, signature, hashes).

use serde::{Deserialize, Serialize};

use crate::manifest::AccessLevel;
use crate::{Error, Result};

pub const FEED_FILE: &str = "feed.json";
pub const INDEX_FILE: &str = "index.html";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub package_id: String,
    pub version: u64,
    /// File name of the package, relative to the feed's address. A plain file name: no folders.
    pub file: String,
    pub sha256: String,
    pub access: AccessLevel,
    pub updated_at: String,
}

impl Feed {
    pub fn parse(bytes: &[u8]) -> Result<Feed> {
        let f: Feed = serde_json::from_slice(bytes).map_err(|e| Error::Adapter(format!("feed.json is not valid: {e}")))?;
        f.check()?;
        Ok(f)
    }

    /// The package file name must be a plain `*.biforge` name so a feed cannot point anywhere else.
    pub fn check(&self) -> Result<()> {
        let ok = !self.file.is_empty()
            && self.file.ends_with(".biforge")
            && self.file.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && !self.file.contains("..")
            && self.sha256.len() == 64
            && self.sha256.chars().all(|c| c.is_ascii_hexdigit());
        if ok { Ok(()) } else { Err(Error::Adapter("feed.json names an unsafe package file or hash".into())) }
    }
}

/// `https://host/dir/feed.json` -> `https://host/dir/<file>`.
pub fn sibling_url(feed_url: &str, file: &str) -> Result<String> {
    let base = feed_url.split(['?', '#']).next().unwrap_or(feed_url);
    let cut = base.rfind('/').ok_or_else(|| Error::Adapter("not a web address".into()))?;
    Ok(format!("{}{}", &base[..=cut], file))
}

/// Only https addresses (and plain http for this PC, which tests and local hosting use).
pub fn check_feed_url(url: &str) -> Result<()> {
    let u = url.trim();
    let local = u.starts_with("http://127.0.0.1") || u.starts_with("http://localhost") || u.starts_with("http://[::1]");
    if (u.starts_with("https://") || local) && u.len() > 10 && !u.contains(char::is_whitespace) {
        Ok(())
    } else {
        Err(Error::Adapter("A feed address must start with https://".into()))
    }
}

/// A human-readable page for the site root. It holds no data: the report name only for public reports.
pub fn landing_page(report_name: &str, access: AccessLevel, link: &str) -> String {
    let name = match access {
        AccessLevel::Public => html_escape(report_name),
        AccessLevel::Private => "A private report".into(),
    };
    let note = match access {
        AccessLevel::Public => "This report is public: anyone with the address can read it.",
        AccessLevel::Private => "This report is encrypted. You need the access key from the person who shared it.",
    };
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>{name} - BIForge report</title>\n<style>body{{font:16px system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}}a.b{{display:inline-block;padding:.6rem 1rem;background:#0f6cbd;color:#fff;border-radius:6px;text-decoration:none}}</style></head>\n<body><h1>{name}</h1>\n<p>This page is a report shared with BIForge, a free desktop app. Reports open in BIForge, not in the browser.</p>\n<p>{note}</p>\n<p><a class=\"b\" href=\"{link}\">Open in BIForge</a></p>\n<p>No BIForge yet? Install the free app first, then use this button again.</p>\n</body></html>\n",
        link = html_escape(link)
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Files of a static site for one published version, as (path, bytes). The package goes first so a viewer can
/// never see a feed that points at a file which is not there yet.
pub fn site_files(package: &[u8], report_name: &str, feed: &Feed, link: &str) -> Vec<(String, Vec<u8>)> {
    vec![
        (feed.file.clone(), package.to_vec()),
        (INDEX_FILE.into(), landing_page(report_name, feed.access, link).into_bytes()),
        (".nojekyll".into(), Vec::new()),
        (FEED_FILE.into(), serde_json::to_vec_pretty(feed).expect("a feed serializes")),
    ]
}
