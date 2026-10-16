//! `biforge://` deep links.
//!
//! ```text
//! biforge://open?src=file&path=<percent-encoded path of a .biforge package>
//! ```
//! Other sources (`url`, `p2p`, `server`) are reserved for later phases and parse as [`Link::Unsupported`].
//! A link never carries an access key. Opening one always shows a confirmation first (decided in the app).

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    /// Open a package file.
    File { path: String },
    /// A source this BIForge version does not know yet.
    Unsupported { src: String },
}

pub fn build_file(path: &str) -> String {
    format!("biforge://open?src=file&path={}", encode(path))
}

pub fn parse(link: &str) -> Result<Link> {
    let rest = link.trim().strip_prefix("biforge://").ok_or_else(|| Error::Invalid("this is not a biforge:// link".into()))?;
    let (action, query) = rest.split_once('?').unwrap_or((rest, ""));
    if action.trim_end_matches('/') != "open" {
        return Err(Error::Invalid(format!("unknown biforge:// action \"{action}\"")));
    }
    let mut src = None;
    let mut path = None;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "src" => src = Some(decode(v)?),
            "path" => path = Some(decode(v)?),
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
        Some(other) => Ok(Link::Unsupported { src: other.to_string() }),
        None => Err(Error::Invalid("the link has no source".into())),
    }
}

fn encode(s: &str) -> String {
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
    fn later_sources_are_reported_not_guessed() {
        assert_eq!(parse("biforge://open?src=p2p&ticket=abc").unwrap(), Link::Unsupported { src: "p2p".into() });
    }
}
