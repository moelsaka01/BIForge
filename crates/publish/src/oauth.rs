//! OAuth 2.0 authorization code flow with PKCE for the personal storage providers (method B).
//!
//! BIForge is a public client: no client secret is shipped. The user (or the owner who registers the app) supplies a
//! client id, which is public. The redirect goes to a loopback address on this PC; the state value is checked.
//! Tokens are kept only in the credential store (`biforge.oauth.<provider>`), as JSON.
//!
//! Google's token endpoint still asks desktop clients for the client secret that Google issues with them; Google
//! documents it as not confidential for installed apps. It is read from the environment variable named in
//! [`ProviderCfg::secret_env`] and sent only to Google's token endpoint; nothing stores it.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::deeplink::encode;
use crate::http::{Http, Request};
use crate::keys::{random_bytes, KeyStore};
use crate::{Error, Result};

pub const REDIRECT_PORT: u16 = 53682;

#[derive(Debug, Clone, Copy)]
pub struct ProviderCfg {
    pub id: &'static str,
    pub name: &'static str,
    pub auth_url: &'static str,
    pub token_url: &'static str,
    pub scope: &'static str,
    /// Extra query parameters of the authorization request.
    pub extra_auth: &'static [(&'static str, &'static str)],
    /// The host of the redirect address ("127.0.0.1", or "localhost" where the provider's registration needs it).
    pub redirect_host: &'static str,
    pub secret_env: Option<&'static str>,
}

pub const GOOGLE: ProviderCfg = ProviderCfg {
    id: "google-drive",
    name: "Google Drive",
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.file",
    extra_auth: &[("access_type", "offline"), ("prompt", "consent")],
    redirect_host: "127.0.0.1",
    secret_env: Some("BIFORGE_GOOGLE_CLIENT_SECRET"),
};

pub const MICROSOFT: ProviderCfg = ProviderCfg {
    id: "onedrive",
    name: "OneDrive",
    auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "Files.ReadWrite.AppFolder offline_access User.Read",
    extra_auth: &[("response_mode", "query")],
    redirect_host: "localhost",
    secret_env: None,
};

pub const DROPBOX: ProviderCfg = ProviderCfg {
    id: "dropbox",
    name: "Dropbox",
    auth_url: "https://www.dropbox.com/oauth2/authorize",
    token_url: "https://api.dropboxapi.com/oauth2/token",
    scope: "",
    extra_auth: &[("token_access_type", "offline")],
    redirect_host: "127.0.0.1",
    secret_env: None,
};

pub fn provider(id: &str) -> Option<ProviderCfg> {
    [GOOGLE, MICROSOFT, DROPBOX].into_iter().find(|p| p.id == id)
}

pub fn redirect_uri(cfg: &ProviderCfg) -> String {
    format!("http://{}:{}/callback", cfg.redirect_host, REDIRECT_PORT)
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn generate() -> Self {
        let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<48>());
        Self { challenge: Self::challenge_of(&verifier), verifier }
    }
    pub fn challenge_of(verifier: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    }
}

pub fn new_state() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<18>())
}

pub fn authorize_url(cfg: &ProviderCfg, client_id: &str, state: &str, challenge: &str) -> String {
    let mut q: Vec<(String, String)> = vec![
        ("client_id".into(), client_id.into()),
        ("response_type".into(), "code".into()),
        ("redirect_uri".into(), redirect_uri(cfg)),
        ("state".into(), state.into()),
        ("code_challenge".into(), challenge.into()),
        ("code_challenge_method".into(), "S256".into()),
    ];
    if !cfg.scope.is_empty() {
        q.push(("scope".into(), cfg.scope.into()));
    }
    for (k, v) in cfg.extra_auth {
        q.push(((*k).into(), (*v).into()));
    }
    format!("{}?{}", cfg.auth_url, q.iter().map(|(k, v)| format!("{}={}", encode(k), encode(v))).collect::<Vec<_>>().join("&"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
    /// Unix seconds.
    pub expires_at: u64,
}

pub fn token_key(provider: &str) -> String {
    format!("biforge.oauth.{provider}")
}

/// A Windows credential holds at most 2,560 bytes and the store writes text as UTF-16, so a long token (Microsoft's
/// access and refresh tokens together are often over 3,000 characters) is kept in pieces: the base key holds
/// `chunks:<n>`, the pieces live under `<base>.0` ... `<base>.<n-1>`.
const CHUNK: usize = 600;

fn forget_tokens(keys: &dyn KeyStore, provider: &str) -> Result<()> {
    let base = token_key(provider);
    if let Some(head) = keys.get(&base)? {
        if let Some(n) = head.strip_prefix("chunks:").and_then(|n| n.parse::<usize>().ok()) {
            for i in 0..n {
                keys.delete(&format!("{base}.{i}"))?;
            }
        }
    }
    keys.delete(&base)
}

pub fn load_tokens(keys: &dyn KeyStore, provider: &str) -> Result<Option<Tokens>> {
    let base = token_key(provider);
    let Some(head) = keys.get(&base)? else { return Ok(None) };
    let json = match head.strip_prefix("chunks:").and_then(|n| n.parse::<usize>().ok()) {
        Some(n) => {
            let mut all = String::new();
            for i in 0..n {
                match keys.get(&format!("{base}.{i}"))? {
                    Some(p) => all.push_str(&p),
                    None => return Ok(None), // a piece is missing: treat as not connected
                }
            }
            all
        }
        None => head,
    };
    Ok(serde_json::from_str(&json).ok())
}

pub fn store_tokens(keys: &dyn KeyStore, provider: &str, t: &Tokens) -> Result<()> {
    let base = token_key(provider);
    let json = serde_json::to_string(t)?;
    // pieces first, the head last: a reader never sees a head without its pieces
    let chars: Vec<char> = json.chars().collect();
    let pieces: Vec<String> = chars.chunks(CHUNK).map(|c| c.iter().collect()).collect();
    for (i, p) in pieces.iter().enumerate() {
        keys.set(&format!("{base}.{i}"), p)?;
    }
    // pieces of an older, longer value are removed
    let mut i = pieces.len();
    while keys.get(&format!("{base}.{i}"))?.is_some() {
        keys.delete(&format!("{base}.{i}"))?;
        i += 1;
    }
    keys.set(&base, &format!("chunks:{}", pieces.len()))
}

pub fn delete_tokens(keys: &dyn KeyStore, provider: &str) -> Result<()> {
    forget_tokens(keys, provider)
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", encode(k), encode(v))).collect::<Vec<_>>().join("&")
}

fn token_request(http: &dyn Http, cfg: &ProviderCfg, mut pairs: Vec<(&str, String)>, previous_refresh: Option<&str>) -> Result<Tokens> {
    let secret = cfg.secret_env.and_then(|n| std::env::var(n).ok()).filter(|s| !s.is_empty());
    if let Some(s) = &secret {
        pairs.push(("client_secret", s.clone()));
    }
    let body = form(&pairs.iter().map(|(k, v)| (*k, v.as_str())).collect::<Vec<_>>());
    let r = http.send(&Request::new("POST", cfg.token_url).bytes("application/x-www-form-urlencoded", body.into_bytes()))?;
    if !r.ok() {
        let detail = r.json().ok().and_then(|v| v.get("error_description").or_else(|| v.get("error")).and_then(|e| e.as_str().map(str::to_string))).unwrap_or_else(|| r.describe());
        return Err(Error::Adapter(format!("{} did not accept the sign-in: {detail}", cfg.name)));
    }
    let v = r.json()?;
    let access = v.get("access_token").and_then(|a| a.as_str()).ok_or_else(|| Error::Adapter(format!("{} sent no access token", cfg.name)))?.to_string();
    let refresh = v.get("refresh_token").and_then(|a| a.as_str()).map(str::to_string).or_else(|| previous_refresh.map(str::to_string));
    let expires_in = v.get("expires_in").and_then(|e| e.as_u64()).unwrap_or(3600);
    Ok(Tokens { access, refresh, expires_at: now() + expires_in })
}

pub fn exchange_code(http: &dyn Http, cfg: &ProviderCfg, client_id: &str, code: &str, verifier: &str) -> Result<Tokens> {
    token_request(
        http,
        cfg,
        vec![("grant_type", "authorization_code".into()), ("code", code.into()), ("redirect_uri", redirect_uri(cfg)), ("client_id", client_id.into()), ("code_verifier", verifier.into())],
        None,
    )
}

pub fn refresh(http: &dyn Http, cfg: &ProviderCfg, client_id: &str, refresh_token: &str) -> Result<Tokens> {
    let mut pairs = vec![("grant_type", "refresh_token".to_string()), ("refresh_token", refresh_token.to_string()), ("client_id", client_id.to_string())];
    if cfg.id == "onedrive" {
        pairs.push(("scope", cfg.scope.to_string()));
    }
    token_request(http, cfg, pairs, Some(refresh_token))
}

/// Binds the loopback address the redirect goes to.
pub fn bind_loopback() -> Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).map_err(|e| Error::Adapter(format!("Cannot listen on 127.0.0.1:{REDIRECT_PORT} for the sign-in answer ({e}). Another BIForge window may be signing in; try again in a minute.")))
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>BIForge</title><body style=\"font-family:sans-serif;margin:3em\"><h2>You are connected</h2><p>You can close this window and go back to BIForge.</p></body>";
const FAIL_PAGE: &str = "<!doctype html><meta charset=utf-8><title>BIForge</title><body style=\"font-family:sans-serif;margin:3em\"><h2>The sign-in was not completed</h2><p>Go back to BIForge and try again.</p></body>";

/// Waits for the browser's redirect, checks the state value and returns the authorization code.
pub fn wait_for_code(listener: &TcpListener, expected_state: &str, timeout: Duration) -> Result<String> {
    listener.set_nonblocking(true)?;
    let end = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
                let (path, query) = target.split_once('?').unwrap_or((target, ""));
                let reply = |status: &str, page: &str| format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len());
                if path != "/callback" {
                    let _ = stream.write_all(reply("404 Not Found", "").as_bytes());
                    continue;
                }
                let get = |k: &str| query.split('&').filter_map(|p| p.split_once('=')).find(|(n, _)| *n == k).and_then(|(_, v)| crate::deeplink::decode_component(v).ok());
                if let Some(e) = get("error") {
                    let _ = stream.write_all(reply("200 OK", FAIL_PAGE).as_bytes());
                    return Err(Error::Adapter(format!("The sign-in was refused: {}", e)));
                }
                let state_ok = get("state").as_deref() == Some(expected_state);
                let code = get("code");
                if !state_ok || code.is_none() {
                    let _ = stream.write_all(reply("400 Bad Request", FAIL_PAGE).as_bytes());
                    return Err(Error::Adapter("The sign-in answer did not match this request (wrong state value). Nothing was connected.".into()));
                }
                let _ = stream.write_all(reply("200 OK", DONE_PAGE).as_bytes());
                return Ok(code.unwrap());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= end {
                    return Err(Error::Adapter("The sign-in was not finished in time.".into()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.into()),
        }
    }
}
