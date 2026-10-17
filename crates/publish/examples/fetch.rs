//! Fetches one address with the same HTTP client the app uses and prints the full error chain (a debugging aid).
//!   cargo run -p biforge-publish --example fetch -- https://example.com/feed.json
use biforge_publish::http::{Http, ReqwestHttp, Request};

fn main() {
    let url = std::env::args().nth(1).expect("an address");
    let http = ReqwestHttp::new().unwrap();
    match http.send(&Request::new("GET", &url)) {
        Ok(r) => println!("HTTP {} ({} bytes)", r.status, r.body.len()),
        Err(e) => println!("ERROR {e}"),
    }
}
