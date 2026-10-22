use std::path::PathBuf;
use std::process::ExitCode;

use biforge_cli::{refresh_site, release, Outcome};

const USAGE: &str = "BIForge command line\n\nUsage:\n  biforge-cli refresh --site <folder>   reload the data of a published report and write the next version\n  biforge-cli verify-release --public-key <base64> --dir <folder with SHA256SUMS and SHA256SUMS.sig>\n  biforge-cli sign-release --key-env <variable holding the release key> --out-dir <folder> <file>...\n  biforge-cli new-release-key --public-out <file>   (prints the secret key only)\n  biforge-cli --version\n\nEnvironment for refresh: BIFORGE_SIGNING_KEY (required), BIFORGE_ACCESS_KEY (private reports).";

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
        Some("new-release-key") => {
            // writes the public half to --public-out and prints ONLY the secret half (pipe it into `gh secret set`)
            let Some(out) = args.iter().position(|a| a == "--public-out").and_then(|i| args.get(i + 1)) else {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            };
            let id = biforge_publish::keys::Identity::generate();
            if let Err(e) = std::fs::write(out, format!("{}\n", id.public_key())) {
                eprintln!("Cannot write {out}: {e}");
                return ExitCode::FAILURE;
            }
            print!("{}", id.secret());
            ExitCode::SUCCESS
        }
        Some("sign-release") => {
            // biforge-cli sign-release --key-env VAR --out-dir DIR file...
            let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
            let (Some(var), Some(out)) = (value("--key-env"), value("--out-dir")) else {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            };
            let Ok(secret) = std::env::var(&var) else {
                eprintln!("{var} is not set.");
                return ExitCode::from(2);
            };
            let files: Vec<PathBuf> = args.iter().skip(1).scan(false, |skip, a| {
                if *skip {
                    *skip = false;
                    return Some(None);
                }
                if a.starts_with("--") {
                    *skip = true;
                    return Some(None);
                }
                Some(Some(PathBuf::from(a)))
            }).flatten().collect();
            let result = release::sums(&files).and_then(|s| release::sign(&s, &secret).map(|sig| (s, sig)));
            match result {
                Ok((sums, sig)) => {
                    let out = PathBuf::from(out);
                    if std::fs::write(out.join(release::SUMS_FILE), &sums).and_then(|_| std::fs::write(out.join(release::SIG_FILE), &sig)).is_err() {
                        eprintln!("Cannot write into {}", out.display());
                        return ExitCode::FAILURE;
                    }
                    print!("{sums}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("verify-release") => {
            // biforge-cli verify-release --public-key B64 --dir DIR
            let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
            let (Some(public), Some(dir)) = (value("--public-key"), value("--dir")) else {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            };
            let dir = PathBuf::from(dir);
            let (Ok(sums), Ok(sig)) = (std::fs::read_to_string(dir.join(release::SUMS_FILE)), std::fs::read_to_string(dir.join(release::SIG_FILE))) else {
                eprintln!("{} and {} must be in the folder.", release::SUMS_FILE, release::SIG_FILE);
                return ExitCode::FAILURE;
            };
            match release::verify(&public, &sums, &sig, &dir) {
                Ok(names) => {
                    println!("Signature and hashes are correct for: {}", names.join(", "));
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
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
