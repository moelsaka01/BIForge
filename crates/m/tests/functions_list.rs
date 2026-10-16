//! app/src/core/queries/mFunctions.json (completions in the M editor) must list exactly what the engine supports.
//! Run with BLESS=1 to rewrite the file after changing the library.
use biforge_m::stdlib::{supported_functions, NOT_SUPPORTED};

#[test]
fn the_apps_function_list_matches_the_library() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/src/core/queries/mFunctions.json");
    let mut not_supported: Vec<&str> = NOT_SUPPORTED.to_vec();
    not_supported.sort_unstable();
    let want = serde_json::to_string_pretty(&serde_json::json!({ "supported": supported_functions(), "notSupported": not_supported })).unwrap() + "\n";
    if std::env::var("BLESS").is_ok() {
        std::fs::write(&path, &want).unwrap();
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert_eq!(have, want, "run `BLESS=1 cargo test -p biforge-m --test functions_list` to rewrite {}", path.display());
}
