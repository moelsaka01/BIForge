//! Viewer side of static hosting: subscriptions to a feed address, update checks and downloads.
//!
//! A subscription pins the publisher's public key the first time the viewer accepts the package (trust on first
//! use). Later versions must be signed by that key. Subscriptions live in one file outside any project
//! (`%LOCALAPPDATA%\BIForge\subscriptions.json` in the app). The access key of a private report is stored by the
//! app in the credential store, never here.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::feed::{self, Feed, FEED_FILE};
use crate::http::{Http, Request};
use crate::keys::sha256_hex;
use crate::{Error, Result};

/// Largest package a viewer downloads without being asked.
pub const MAX_DOWNLOAD: usize = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub package_id: String,
    pub feed_url: String,
    pub report_name: String,
    /// Base64 public key the publisher signed with when the viewer first accepted the report.
    pub pinned_publisher: String,
    pub have_version: u64,
    pub last_check: Option<String>,
    pub last_error: Option<String>,
    /// Folder or file the latest accepted package was saved to.
    pub package_path: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    version: u32,
    subscriptions: Vec<Subscription>,
}

pub struct SubscriptionStore {
    path: PathBuf,
}

impl SubscriptionStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self) -> Result<Vec<Subscription>> {
        match fs::read(&self.path) {
            Ok(b) => Ok(serde_json::from_slice::<File>(&b)?.subscriptions),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn put(&self, s: Subscription) -> Result<()> {
        let mut all = self.list()?;
        match all.iter_mut().find(|x| x.package_id == s.package_id) {
            Some(slot) => *slot = s,
            None => all.push(s),
        }
        self.write(all)
    }

    pub fn remove(&self, package_id: &str) -> Result<()> {
        let mut all = self.list()?;
        all.retain(|x| x.package_id != package_id);
        self.write(all)
    }

    fn write(&self, subs: Vec<Subscription>) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&File { version: 1, subscriptions: subs })?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn get(http: &dyn Http, url: &str) -> Result<Vec<u8>> {
    feed::check_feed_url(url)?;
    let r = http.send(&Request::new("GET", url))?;
    if r.status == 404 {
        return Err(Error::Adapter("Nothing is published at this address (it may have been unpublished, or the site is still being built; try again in a minute).".into()));
    }
    if !r.ok() {
        return Err(Error::Adapter(format!("The address answered with an error ({}).", r.describe())));
    }
    Ok(r.body)
}

pub fn fetch_feed(http: &dyn Http, feed_url: &str) -> Result<Feed> {
    Feed::parse(&get(http, feed_url)?)
}

/// Downloads the package the feed names and checks its hash against the feed.
pub fn fetch_package(http: &dyn Http, feed_url: &str, f: &Feed) -> Result<Vec<u8>> {
    f.check()?;
    let bytes = get(http, &feed::sibling_url(feed_url, &f.file)?)?;
    if bytes.len() > MAX_DOWNLOAD {
        return Err(Error::TooLarge);
    }
    if sha256_hex(&bytes) != f.sha256 {
        return Err(Error::Adapter("The downloaded file does not match the feed (the site may be updating; try again in a minute).".into()));
    }
    Ok(bytes)
}

/// The feed, if it announces a version newer than `have`.
pub fn newer(http: &dyn Http, feed_url: &str, have: u64) -> Result<Option<Feed>> {
    let f = fetch_feed(http, feed_url)?;
    Ok((f.version > have).then_some(f))
}

pub fn feed_address(site_url: &str) -> String {
    format!("{}{}", if site_url.ends_with('/') { site_url.to_string() } else { format!("{site_url}/") }, FEED_FILE)
}
