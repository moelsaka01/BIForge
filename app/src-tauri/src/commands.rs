//! Thin Tauri command wrappers around `biforge-model`. Errors are returned as readable strings.

use biforge_model::project::{Project, SaveReport};
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(read_recovery(root.clone()).unwrap(), Some(p));
        clear_recovery(root.clone()).unwrap();
        assert_eq!(read_recovery(root).unwrap(), None);

        let err = open_project(format!("{}/missing.pbip", d.path().display())).unwrap_err();
        assert!(err.contains("missing.pbip"), "{err}");
        assert!(new_project(d.path().join("q").to_string_lossy().into_owned(), "a/b".into()).is_err());
    }
}
