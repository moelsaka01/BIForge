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
