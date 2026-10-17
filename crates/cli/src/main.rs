use std::path::PathBuf;
use std::process::ExitCode;

use biforge_cli::{refresh_site, Outcome};

const USAGE: &str = "BIForge command line\n\nUsage:\n  biforge-cli refresh --site <folder>   reload the data of a published report and write the next version\n  biforge-cli --version\n\nEnvironment for refresh: BIFORGE_SIGNING_KEY (required), BIFORGE_ACCESS_KEY (private reports).";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("biforge-cli {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("refresh") => {
            let site = match args.iter().position(|a| a == "--site").and_then(|i| args.get(i + 1)) {
                Some(s) => PathBuf::from(s),
                None => {
                    eprintln!("{USAGE}");
                    return ExitCode::from(2);
                }
            };
            let Ok(signing) = std::env::var("BIFORGE_SIGNING_KEY") else {
                eprintln!("BIFORGE_SIGNING_KEY is not set (it is a repository secret written by BIForge).");
                return ExitCode::from(2);
            };
            let access = std::env::var("BIFORGE_ACCESS_KEY").ok();
            match refresh_site(&site, &signing, access.as_deref()) {
                Ok(Outcome::Unchanged { version }) => {
                    println!("Nothing changed; the site stays at version {version}.");
                    ExitCode::SUCCESS
                }
                Ok(Outcome::Published { version, file }) => {
                    println!("Wrote version {version} to {file} and feed.json.");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("Refresh failed: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
