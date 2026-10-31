//! Thin Tauri command wrappers around `biforge-model`. Errors are returned as readable strings.

use biforge_model::project::{Project, SaveReport};
use biforge_model::tmdl::{self, Document};
use std::collections::BTreeMap;
use std::path::Path;

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn new_project(root: String, name: String) -> Result<Project, String> {
    Project::create_new(Path::new(&root), &name).map_err(msg)
}

#[tauri::command]
pub fn open_project(pbip_path: String) -> Result<Project, String> {
    Project::open(Path::new(&pbip_path)).map_err(msg)
}

#[tauri::command]
pub fn save_project(root: String, project: Project) -> Result<SaveReport, String> {
    project.save(Path::new(&root)).map_err(msg)
}

#[tauri::command]
pub fn write_recovery(root: String, project: Project) -> Result<(), String> {
    project.write_recovery(Path::new(&root)).map_err(msg)
}

#[tauri::command]
pub fn read_recovery(root: String) -> Result<Option<Project>, String> {
    Project::read_recovery(Path::new(&root)).map_err(msg)
}

#[tauri::command]
pub fn clear_recovery(root: String) -> Result<(), String> {
    Project::clear_recovery(Path::new(&root)).map_err(msg)
}

/// The data files of the "Learn with sample data" project (our own synthetic cycle-shop data).
const SAMPLE_FILES: [(&str, &str); 4] = [
    ("Date.csv", include_str!("../sample/Date.csv")),
    ("Customer.csv", include_str!("../sample/Customer.csv")),
    ("Product.csv", include_str!("../sample/Product.csv")),
    ("Sales.csv", include_str!("../sample/Sales.csv")),
];

/// Writes the sample data under `<root>/data/` and returns the file paths in table order (Date, Customer, Product, Sales).
#[tauri::command]
pub fn write_sample_data(root: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&root).join("data");
    std::fs::create_dir_all(&dir).map_err(msg)?;
    let mut paths = Vec::new();
    for (name, text) in SAMPLE_FILES {
        let p = dir.join(name);
        std::fs::write(&p, text).map_err(msg)?;
        paths.push(p.to_string_lossy().into_owned());
    }
    Ok(paths)
}

/// Parses TMDL text typed in the TMDL view. The error says which line is wrong.
#[tauri::command]
pub fn tmdl_parse(text: String) -> Result<Document, String> {
    tmdl::parse(&text).map_err(|e| e.to_string())
}

/// The TMDL text of each model file (the TMDL view shows it read-only).
#[tauri::command]
pub fn tmdl_print(documents: BTreeMap<String, Document>) -> BTreeMap<String, String> {
    documents.into_iter().map(|(path, doc)| (path, tmdl::print(&doc))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmdl_parse_returns_the_document_or_a_line_error() {
        let doc = tmdl_parse("table T\n\tcolumn A\n\t\tdataType: int64\n".into()).unwrap();
        assert_eq!(doc.nodes.len(), 1);
        assert_eq!(doc.nodes[0].children[0].name.as_deref(), Some("A"));
        // what the printer writes parses back to the same document
        assert_eq!(tmdl_parse(tmdl::print(&doc)).unwrap(), doc);
        let err = tmdl_parse("table T\n\t\t\tcolumn Deep\n".into()).unwrap_err();
        assert!(err.starts_with("line "), "{err}");
    }

    #[test]
    fn sample_data_is_written_with_a_header_and_rows() {
        let d = tempfile::tempdir().unwrap();
        let paths = write_sample_data(d.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(paths.len(), 4);
        let sales = std::fs::read_to_string(&paths[3]).unwrap();
        assert!(sales.starts_with("SalesKey,OrderDate,CustomerKey,ProductKey,Quantity,UnitPrice,Channel"));
        assert_eq!(sales.lines().count(), 401);
    }

    #[test]
    fn command_wrappers_round_trip_a_project_and_return_readable_errors() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("p").to_string_lossy().into_owned();
        let p = new_project(root.clone(), "Demo".into()).unwrap();
        let pbip = format!("{root}/Demo.pbip");
        assert_eq!(open_project(pbip.clone()).unwrap(), p);

        // the JSON the UI sends back must deserialize into the same project
        let json = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert!(save_project(root.clone(), back).unwrap().written.is_empty());

        write_recovery(root.clone(), p.clone()).unwrap();
        assert_eq!(read_recovery(root.clone()).unwrap(), Some(p.clone()));
        clear_recovery(root.clone()).unwrap();
        assert_eq!(read_recovery(root).unwrap(), None);

        // the TMDL view prints the model files the project holds
        let printed = tmdl_print(p.model.tmdl.clone());
        assert_eq!(printed.len(), p.model.tmdl.len());
        assert!(printed["model.tmdl"].starts_with("model Model"), "{}", printed["model.tmdl"]);

        let err = open_project(format!("{}/missing.pbip", d.path().display())).unwrap_err();
        assert!(err.contains("missing.pbip"), "{err}");
        assert!(new_project(d.path().join("q").to_string_lossy().into_owned(), "a/b".into()).is_err());
    }
}

/// Test seam for the real-window UI test: native file dialogs cannot be driven by WebDriver/CDP, so when the
/// environment variable BIFORGE_TEST_PICKS (paths separated by `|`) is set the app answers its pickers from it,
/// one value per call. Without the variable this returns None and the real dialog is used.
#[tauri::command]
pub fn test_pick() -> Option<String> {
    use std::sync::Mutex;
    static QUEUE: Mutex<Option<std::collections::VecDeque<String>>> = Mutex::new(None);
    let mut g = QUEUE.lock().ok()?;
    if g.is_none() {
        let raw = std::env::var("BIFORGE_TEST_PICKS").ok()?;
        *g = Some(raw.split('|').filter(|s| !s.is_empty()).map(String::from).collect());
    }
    g.as_mut()?.pop_front()
}

/// Reads a picture chosen for an Image visual as a data: URI (png, jpg, gif, svg, webp; up to 5 MB).
#[tauri::command]
pub fn read_image_data_uri(path: String) -> Result<String, String> {
    use base64::Engine;
    let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => return Err("Choose a png, jpg, gif, svg or webp picture.".into()),
    };
    let meta = std::fs::metadata(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("The picture is larger than 5 MB.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Reads the report definition chosen for a Paginated report visual (.rdl, up to 10 MB) as text; a byte order mark is dropped.
#[tauri::command]
pub fn read_report_definition(path: String) -> Result<String, String> {
    let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "rdl" {
        return Err("Choose an .rdl report definition.".into());
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("The report definition is larger than 10 MB.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "The report definition is not UTF-8 text.".to_string())?;
    Ok(text.strip_prefix('﻿').unwrap_or(&text).to_string())
}

/// Runs a script visual with the user's own Python or R: the data of the visual goes in as `dataset`, a PNG data address comes back.
/// Runs on a worker thread so that the window stays responsive while the script works.
#[tauri::command]
pub async fn run_script_visual(language: String, code: String, csv: String, home: Option<String>, width: u32, height: u32, timeout_minutes: Option<u64>) -> Result<String, String> {
    let png = tauri::async_runtime::spawn_blocking(move || biforge_engine::sources::script_src::run_visual_script(&language, &code, &csv, home.as_deref(), width, height, timeout_minutes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    use base64::Engine as _;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

/// Opens an http(s) address in the default browser.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Only http:// and https:// addresses can be opened.".into());
    }
    #[cfg(windows)]
    {
        // ShellExecuteW inside this process (the `open` crate): no other program is started to open the address
        open::that_detached(&url).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("Opening addresses is only implemented on Windows.".into())
    }
}

#[cfg(test)]
mod image_tests {
    use super::*;

    #[test]
    fn image_becomes_a_data_uri_and_other_files_are_refused() {
        let dir = std::env::temp_dir().join("biforge-img-test");
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("a.png");
        std::fs::write(&png, [137, 80, 78, 71]).unwrap();
        assert_eq!(read_image_data_uri(png.to_string_lossy().into()).unwrap(), "data:image/png;base64,iVBORw==");
        let txt = dir.join("a.txt");
        std::fs::write(&txt, "x").unwrap();
        assert!(read_image_data_uri(txt.to_string_lossy().into()).is_err());
        let rdl = dir.join("a.rdl");
        std::fs::write(&rdl, "﻿<Report/>").unwrap();
        assert_eq!(read_report_definition(rdl.to_string_lossy().into()).unwrap(), "<Report/>");
        assert!(read_report_definition(txt.to_string_lossy().into()).is_err());
        assert!(open_url("file:///c:/windows/system32/calc.exe".into()).is_err());
        assert!(open_url("https://example.com/a b".into()).is_err());
    }
}
