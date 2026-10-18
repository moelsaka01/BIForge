//! `biforge://` deep links.
//!
//! ```text
//! biforge://open?src=file&path=<percent-encoded path of a .biforge package>
//! ```
//! `src=url&url=<feed address>` points at the feed of a static host (O2).
//! Other sources (`p2p`, `server`) are reserved for later phases and parse as [`Link::Unsupported`].
//! A link never carries an access key. Opening one always shows a confirmation first (decided in the app).

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    /// Open a package file.
    File { path: String },
    /// A feed on a static host: `biforge://open?src=url&url=<feed address>`.
    Url { url: String },
    /// A BIForge server invitation: `biforge://open?src=server&url=<server address>&invite=<invite token>`.
    Server { url: String, invite: String },
    /// A source this BIForge version does not know yet.
    Unsupported { src: String },
}

pub fn build_file(path: &str) -> String {
    format!("biforge://open?src=file&path={}", encode(path))
}

pub fn build_url(feed_url: &str) -> String {
    format!("biforge://open?src=url&url={}", encode(feed_url))
}

pub fn parse(link: &str) -> Result<Link> {
    let rest = link.trim().strip_prefix("biforge://").ok_or_else(|| Error::Invalid("this is not a biforge:// link".into()))?;
    let (action, query) = rest.split_once('?').unwrap_or((rest, ""));
    if action.trim_end_matches('/') != "open" {
        return Err(Error::Invalid(format!("unknown biforge:// action \"{action}\"")));
    }
    let mut src = None;
    let mut path = None;
    let mut url = None;
    let mut invite = None;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "src" => src = Some(decode(v)?),
            "path" => path = Some(decode(v)?),
            "url" => url = Some(decode(v)?),
            "invite" => invite = Some(decode(v)?),
            _ => {}
        }
    }
    match src.as_deref() {
        Some("file") => {
            let path = path.filter(|p| !p.is_empty()).ok_or_else(|| Error::Invalid("the link has no path".into()))?;
            if !path.to_ascii_lowercase().ends_with(".biforge") {
                return Err(Error::Invalid("the link does not point to a .biforge package".into()));
            }
            Ok(Link::File { path })
        }
        Some("url") => {
            let url = url.filter(|u| !u.is_empty()).ok_or_else(|| Error::Invalid("the link has no address".into()))?;
            crate::feed::check_feed_url(&url).map_err(|e| Error::Invalid(e.to_string()))?;
            Ok(Link::Url { url })
        }
        Some("server") => {
            let url = url.filter(|u| u.starts_with("http://") || u.starts_with("https://")).ok_or_else(|| Error::Invalid("the link has no server address".into()))?;
            let invite = invite.filter(|i| !i.is_empty()).ok_or_else(|| Error::Invalid("the link has no invitation".into()))?;
            Ok(Link::Server { url, invite })
        }
        Some(other) => Ok(Link::Unsupported { src: other.to_string() }),
        None => Err(Error::Invalid("the link has no source".into())),
    }
}

pub fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Percent-decodes one URL component.
pub fn decode_component(s: &str) -> Result<String> {
    decode(s)
}

fn decode(s: &str) -> Result<String> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = s.get(i + 1..i + 3).ok_or_else(|| Error::Invalid("bad %-escape in link".into()))?;
            out.push(u8::from_str_radix(h, 16).map_err(|_| Error::Invalid("bad %-escape in link".into()))?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| Error::Invalid("link is not valid text".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_awkward_paths() {
        for p in [r"C:\Users\Ann Lee\Shared\abc.biforge", "/srv/share/ü & more/x.biforge", r"\\server\share\a=b.biforge"] {
            assert_eq!(parse(&build_file(p)).unwrap(), Link::File { path: p.into() });
        }
    }

    #[test]
    fn rejects_bad_links() {
        assert!(parse("http://x").is_err());
        assert!(parse("biforge://delete?src=file&path=a.biforge").is_err());
        assert!(parse("biforge://open?src=file").is_err());
        assert!(parse("biforge://open?src=file&path=C%3A%5Cx.exe").is_err());
        assert!(parse("biforge://open?src=file&path=%ZZ").is_err());
        assert!(parse("biforge://open").is_err());
    }

    #[test]
    fn feed_links_round_trip_and_need_https() {
        let u = "https://ann.github.io/my-report/feed.json";
        assert_eq!(parse(&build_url(u)).unwrap(), Link::Url { url: u.into() });
        assert!(parse("biforge://open?src=url&url=http%3A%2F%2Fexample.com%2Ffeed.json").is_err());
        assert!(parse("biforge://open?src=url&url=file%3A%2F%2F%2Fc%2Fx").is_err());
        assert!(parse("biforge://open?src=url").is_err());
    }

    #[test]
    fn later_sources_are_reported_not_guessed() {
        assert_eq!(parse("biforge://open?src=future&ticket=abc").unwrap(), Link::Unsupported { src: "future".into() });
    }
}

#[cfg(test)]
mod server_tests {
    use super::*;

    #[test]
    fn server_invitations_round_trip() {
        let l = crate::backend::build_link("http://192.168.1.5:7878", "bfi_abc");
        assert_eq!(parse(&l).unwrap(), Link::Server { url: "http://192.168.1.5:7878".into(), invite: "bfi_abc".into() });
        assert!(parse("biforge://open?src=server&url=http%3A%2F%2Fx").is_err());
        assert!(parse("biforge://open?src=server&url=ftp%3A%2F%2Fx&invite=a").is_err());
    }
}
