//! biforge-server.exe: `biforge-server [--data <folder>] [--bind <address:port>] [--public-url <url>] [--reset-admin-token]`

use std::net::SocketAddr;
use std::path::PathBuf;

fn main() {
    let mut data = PathBuf::from("biforge-server-data");
    let mut bind: SocketAddr = "0.0.0.0:7878".parse().unwrap();
    let mut public_url = None;
    let mut reset = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--data" => data = PathBuf::from(args.next().unwrap_or_else(|| usage("--data needs a folder"))),
            "--bind" => bind = args.next().unwrap_or_else(|| usage("--bind needs an address")).parse().unwrap_or_else(|_| usage("--bind must look like 0.0.0.0:7878")),
            "--public-url" => public_url = Some(args.next().unwrap_or_else(|| usage("--public-url needs an address"))),
            "--reset-admin-token" => reset = true,
            "--help" | "-h" => usage(""),
            other => usage(&format!("unknown option {other}")),
        }
    }
    // a new token is made on the first start, or when asked for; the server stores only its hash
    let token = if reset { Some(format!("bfa_{}", biforge_publish::keys::hex(&biforge_publish::keys::random_bytes::<32>()))) } else { None };
    let running = match biforge_server::start(biforge_server::Config { data_dir: data, bind, admin_token: token, public_url }) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    println!("BIForge server listening on {}", running.url());
    println!("This server uses plain HTTP. Use it on a trusted network, over a VPN or through a tunnel.");
    if let Some(t) = &running.admin_token {
        println!("Admin token (shown once, keep it safe): {t}");
    }
    loop {
        std::thread::park();
    }
}

fn usage(msg: &str) -> ! {
    if !msg.is_empty() {
        eprintln!("{msg}");
    }
    eprintln!("Usage: biforge-server [--data <folder>] [--bind <address:port>] [--public-url <url>] [--reset-admin-token]");
    std::process::exit(if msg.is_empty() { 0 } else { 2 });
}
