//! Certificate pinning for BIForge servers with a self-signed certificate.
//!
//! A server made by BIForge has no certificate from a public authority (those cost money or need a domain name).
//! Its invitation link carries the SHA-256 fingerprint of its certificate instead (`pin=<64 hex digits>`), so the
//! link is the root of trust: the client accepts exactly that certificate and nothing else, whatever name or
//! address it is reached under. The handshake signature is still verified, so the server has to hold the matching
//! private key.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

/// The fingerprint of a DER certificate, as 64 lowercase hex digits.
pub fn fingerprint(der: &[u8]) -> String {
    crate::keys::hex(&Sha256::digest(der))
}

/// Accepts `AB:CD:...`, upper or lower case, with or without colons or spaces; returns 64 lowercase hex digits.
pub fn normalize(pin: &str) -> Result<String> {
    let s: String = pin.chars().filter(|c| !matches!(c, ':' | ' ' | '-')).collect::<String>().to_ascii_lowercase();
    if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(s)
    } else {
        Err(Error::Adapter("The certificate fingerprint must be 64 hexadecimal digits (SHA-256).".into()))
    }
}

#[derive(Debug)]
struct PinVerifier {
    pin: Vec<u8>,
    algs: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, _intermediates: &[CertificateDer<'_>], _name: &ServerName<'_>, _ocsp: &[u8], _now: UnixTime) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if Sha256::digest(end_entity.as_ref()).as_slice() == self.pin.as_slice() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("the server's certificate is not the one named in the invitation (possible impostor, or the server was reinstalled; ask for a new invitation)".into()))
        }
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algs)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

/// `host:port` of an https URL (port 443 when absent), lower case; None for other schemes.
pub fn host_port(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let h = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    Some(if h.contains(':') { h } else { format!("{h}:443") })
}

/// Tells an HTTP client to trust exactly this certificate for the server at `url` (no-op for http URLs).
pub fn apply(http: &dyn crate::http::Http, url: &str, pin: &str) {
    if let Some(hp) = host_port(url) {
        http.pin(&hp, pin);
    }
}

/// A TLS client configuration that trusts only the certificate with this fingerprint.
pub fn client_config(pin_hex: &str) -> Result<rustls::ClientConfig> {
    let pin = normalize(pin_hex)?;
    let bytes: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&pin[2 * i..2 * i + 2], 16).unwrap()).collect();
    let provider = Arc::new(ring::default_provider());
    let algs = provider.signature_verification_algorithms;
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::Adapter(format!("TLS setup failed: {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerifier { pin: bytes, algs }))
        .with_no_client_auth();
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_are_normalized() {
        let a = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
        let n = normalize(a).unwrap();
        assert_eq!(n.len(), 64);
        assert_eq!(n, n.to_ascii_lowercase());
        assert!(normalize("abc").is_err());
        assert!(normalize(&"g".repeat(64)).is_err());
        assert!(client_config(&n).is_ok());
    }
}
