//! The small HTTP layer the provider adapters use. Adapters talk to the [`Http`] trait so their request logic is
//! tested against a recording fake ([`FakeHttp`]); the app and the real-service tests use [`ReqwestHttp`].

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn new(method: &str, url: &str) -> Self {
        Self { method: method.into(), url: url.into(), headers: Vec::new(), body: Vec::new() }
    }
    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
    pub fn bearer(self, token: &str) -> Self {
        self.header("Authorization", &format!("Bearer {token}"))
    }
    pub fn json(mut self, v: &serde_json::Value) -> Self {
        self.headers.push(("Content-Type".into(), "application/json".into()));
        self.body = serde_json::to_vec(v).expect("a JSON value serializes");
        self
    }
    pub fn bytes(mut self, content_type: &str, body: Vec<u8>) -> Self {
        self.headers.push(("Content-Type".into(), content_type.into()));
        self.body = body;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    pub fn json(&self) -> Result<serde_json::Value> {
        serde_json::from_slice(&self.body).map_err(|e| Error::Adapter(format!("the server answered with something that is not JSON ({e}); HTTP {}", self.status)))
    }
    /// A short description of an error answer, for messages (never includes request headers).
    pub fn describe(&self) -> String {
        let text = String::from_utf8_lossy(&self.body);
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .and_then(|m| m.as_str().map(str::to_string))
                    .or_else(|| v.pointer("/errors/0/message").and_then(|m| m.as_str().map(str::to_string)))
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        format!("HTTP {}: {}", self.status, msg)
    }
}

pub trait Http: Send + Sync {
    fn send(&self, req: &Request) -> Result<Response>;
}

/// Builds a multipart/form-data body. Each part: (name, optional file name, content type, bytes).
pub fn multipart(parts: &[(&str, Option<&str>, &str, Vec<u8>)]) -> (String, Vec<u8>) {
    let boundary = format!("----biforge{}", crate::keys::hex(&crate::keys::random_bytes::<12>()));
    let mut body = Vec::new();
    for (name, file, ctype, data) in parts {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"").as_bytes());
        if let Some(f) = file {
            body.extend_from_slice(format!("; filename=\"{f}\"").as_bytes());
        }
        body.extend_from_slice(format!("\r\nContent-Type: {ctype}\r\n\r\n").as_bytes());
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// The real HTTP client. A connection that cannot be made (a reset while connecting, seen with flaky IPv6 routes to
/// github.io on one test machine: curl -6 failed 7 of 10 times, curl -4 never) is retried, from the second attempt
/// on over IPv4 only. Only connect errors are retried: the request never reached the server, so any method is safe.
pub struct ReqwestHttp {
    client: reqwest::blocking::Client,
    v4: reqwest::blocking::Client,
}

fn build_client(v4_only: bool) -> Result<reqwest::blocking::Client> {
    let mut b = reqwest::blocking::Client::builder().user_agent("BIForge").timeout(Duration::from_secs(300)).connect_timeout(Duration::from_secs(20));
    if v4_only {
        b = b.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    }
    b.build().map_err(|e| Error::Adapter(format!("cannot start the network client: {e}")))
}

impl ReqwestHttp {
    pub fn new() -> Result<Self> {
        Ok(Self { client: build_client(false)?, v4: build_client(true)? })
    }
}

const CONNECT_ATTEMPTS: u32 = 5;

impl Http for ReqwestHttp {
    fn send(&self, r: &Request) -> Result<Response> {
        let method = reqwest::Method::from_bytes(r.method.as_bytes()).map_err(|_| Error::Adapter("bad HTTP method".into()))?;
        let mut last = String::new();
        for attempt in 0..CONNECT_ATTEMPTS {
            let client = if attempt == 0 { &self.client } else { &self.v4 };
            let mut b = client.request(method.clone(), &r.url);
            for (k, v) in &r.headers {
                b = b.header(k, v);
            }
            if !r.body.is_empty() {
                b = b.body(r.body.clone());
            }
            match b.send() {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body = resp.bytes().map_err(|e| Error::Adapter(format!("the connection broke while reading the answer: {}", chain(&e))))?.to_vec();
                    return Ok(Response { status, body });
                }
                Err(e) if e.is_connect() && attempt + 1 < CONNECT_ATTEMPTS => {
                    last = chain(&e);
                    std::thread::sleep(Duration::from_millis(300 * (attempt as u64 + 1)));
                }
                Err(e) => return Err(Error::Adapter(format!("cannot reach {}: {}", host_of(&r.url), chain(&e)))),
            }
        }
        Err(Error::Adapter(format!("cannot reach {}: {}", host_of(&r.url), last)))
    }
}

/// The error and every cause below it ("error sending request: connection refused: ..."), without the address.
fn chain(e: &reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(c) = src {
        out.push_str(": ");
        out.push_str(&c.to_string());
        src = c.source();
    }
    out
}

fn host_of(url: &str) -> &str {
    url.split("//").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

/// A scripted fake: answers are consumed in order; every request is recorded.
#[derive(Default)]
pub struct FakeHttp {
    answers: Mutex<VecDeque<Response>>,
    pub seen: Mutex<Vec<Request>>,
}

impl FakeHttp {
    pub fn new(answers: Vec<Response>) -> Self {
        Self { answers: Mutex::new(answers.into()), seen: Mutex::new(Vec::new()) }
    }
    pub fn json(status: u16, v: serde_json::Value) -> Response {
        Response { status, body: serde_json::to_vec(&v).unwrap() }
    }
    pub fn requests(&self) -> Vec<Request> {
        self.seen.lock().unwrap().clone()
    }
}

impl Http for FakeHttp {
    fn send(&self, r: &Request) -> Result<Response> {
        self.seen.lock().unwrap().push(r.clone());
        self.answers.lock().unwrap().pop_front().ok_or_else(|| Error::Adapter(format!("unexpected request {} {}", r.method, r.url)))
    }
}
