//! TLS for the server without paying for anything: a self-signed certificate made on the first start and kept in
//! `<data>/tls/`. Nobody is asked to trust it through a public authority; the invitation link carries its SHA-256
//! fingerprint (`pin=`) and clients accept exactly that certificate (crates/publish/src/pin.rs).

use std::fs;
use std::io;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

pub struct Identity {
    pub cert_der: Vec<u8>,
    pub key_der: Vec<u8>,
    pub fingerprint: String,
}

/// Loads `<data>/tls/cert.der` + `key.der`, or makes a new certificate valid for `names` (host names and IP
/// addresses; the pin does not depend on them, they only help tools that look at the name). A stored certificate is
/// reused so the fingerprint in old invitation links stays valid.
pub fn load_or_create(data_dir: &Path, names: &[String]) -> Result<Identity, String> {
    let dir = data_dir.join("tls");
    let (cp, kp) = (dir.join("cert.der"), dir.join("key.der"));
    if let (Ok(c), Ok(k)) = (fs::read(&cp), fs::read(&kp)) {
        let fingerprint = biforge_publish::pin::fingerprint(&c);
        return Ok(Identity { cert_der: c, key_der: k, fingerprint });
    }
    let mut sans: Vec<String> = vec!["localhost".into(), "127.0.0.1".into()];
    for n in names {
        if !n.is_empty() && !sans.contains(n) {
            sans.push(n.clone());
        }
    }
    let mut params = rcgen::CertificateParams::new(sans).map_err(|e| format!("Cannot make the server certificate: {e}"))?;
    params.distinguished_name.push(rcgen::DnType::CommonName, "BIForge server");
    let (y, m, d) = today_ymd();
    params.not_before = rcgen::date_time_ymd(y, m, d);
    params.not_after = rcgen::date_time_ymd(y + 10, m, d.min(28));
    let key = rcgen::KeyPair::generate().map_err(|e| format!("Cannot make the server key: {e}"))?;
    let cert = params.self_signed(&key).map_err(|e| format!("Cannot make the server certificate: {e}"))?;
    let (c, k) = (cert.der().to_vec(), key.serialize_der());
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot use the data folder: {e}"))?;
    fs::write(&cp, &c).map_err(|e| e.to_string())?;
    fs::write(&kp, &k).map_err(|e| e.to_string())?;
    let fingerprint = biforge_publish::pin::fingerprint(&c);
    Ok(Identity { cert_der: c, key_der: k, fingerprint })
}

/// Yesterday's date (UTC), so a clock that is a little slow on another computer still accepts the certificate.
fn today_ymd() -> (i32, u8, u8) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) - 86_400;
    let s = biforge_publish::time::rfc3339(secs);
    let n = |r: std::ops::Range<usize>| s[r].parse::<i32>().unwrap_or(1);
    (n(0..4), n(5..7) as u8, n(8..10).clamp(1, 28) as u8)
}

pub fn acceptor(id: &Identity) -> Result<TlsAcceptor, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(id.cert_der.clone())], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(id.key_der.clone())))
        .map_err(|e| format!("The stored server certificate is not usable: {e}"))?;
    let mut cfg = cfg;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(cfg)))
}

/// A TCP listener that completes the TLS handshake of each connection in its own task, so a slow or silent client
/// cannot hold up the others.
pub struct TlsListener {
    local: SocketAddr,
    rx: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
}

impl TlsListener {
    pub fn new(inner: TcpListener, acceptor: TlsAcceptor) -> io::Result<Self> {
        let local = inner.local_addr()?;
        let (tx, rx) = mpsc::channel(64);
        tokio::spawn(async move {
            loop {
                let Ok((sock, peer)) = inner.accept().await else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                };
                let (acceptor, tx) = (acceptor.clone(), tx.clone());
                tokio::spawn(async move {
                    if let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(sock)).await {
                        let _ = tx.send((tls, peer)).await;
                    }
                });
            }
        });
        Ok(Self { local, rx })
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.rx.recv().await {
            Some(x) => x,
            // the accept loop only ends with the runtime
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(self.local)
    }
}
