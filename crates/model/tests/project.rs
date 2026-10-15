use biforge_model::project::{sanitize_file_name, Project, ProjectError};
use biforge_model::tmdl;
use std::fs;
use std::path::{Path, PathBuf};

fn sample_src() -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "tests", "fixtures", "sample"]
        .iter()
        .collect()
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dst = to.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &dst);
        } else {
            fs::copy(e.path(), dst).unwrap();
        }
    }
}

fn sample_copy() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    copy_dir(&sample_src(), dir.path());
    let pbip = dir.path().join("Retail.pbip");
    (dir, pbip)
}

fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let rel = p
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, fs::read(&p).unwrap()));
            }
        }
    }
    let mut v = Vec::new();
    walk(root, root, &mut v);
    v.sort();
    v
}

#[test]
fn opens_hand_written_pbip_sample() {
    let (_d, pbip) = sample_copy();
    let p = Project::open(&pbip).unwrap();
    assert_eq!(p.name, "Retail");
    assert_eq!(p.report_dir, "Retail.Report");
    assert_eq!(p.model_dir, "Retail.SemanticModel");
    let keys: Vec<_> = p.model.tmdl.keys().cloned().collect();
    assert_eq!(
        keys,
        vec![
            "database.tmdl",
            "expressions.tmdl",
            "model.tmdl",
            "relationships.tmdl",
            "tables/Product.tmdl",
            "tables/Sales.tmdl"
        ]
    );
    let sales = &p.model.tmdl["tables/Sales.tmdl"].nodes[0];
    let measures: Vec<_> = sales
        .children
        .iter()
        .filter(|c| c.kind == "measure")
        .map(|c| c.name.clone().unwrap())
        .collect();
    assert_eq!(measures, vec!["Total Amount", "Average Price"]);
    assert_eq!(p.report.files.len(), 5);
    assert_eq!(
        p.report.files["pages/overview/page.json"]["displayName"],
        "Overview"
    );
}

#[test]
fn save_and_reopen_gives_identical_project() {
    let (d, pbip) = sample_copy();
    let p = Project::open(&pbip).unwrap();
    p.save(d.path()).unwrap();
    assert_eq!(Project::open(&pbip).unwrap(), p);
}

#[test]
fn second_save_writes_nothing() {
    let (d, pbip) = sample_copy();
    let p = Project::open(&pbip).unwrap();
    p.save(d.path()).unwrap();
    let before = tree(d.path());
    let r = p.save(d.path()).unwrap();
    assert!(r.written.is_empty(), "rewrote {:?}", r.written);
    assert!(r.deleted.is_empty());
    assert_eq!(tree(d.path()), before);
}

#[test]
fn files_outside_the_managed_set_are_untouched() {
    let (d, pbip) = sample_copy();
    let before = tree(d.path());
    let p = Project::open(&pbip).unwrap();
    p.save(d.path()).unwrap();
    let mut checked = 0;
    for (path, bytes) in before {
        if path.ends_with(".dax")
            || path.ends_with("diagramLayout.json")
            || path.ends_with("cache.abf")
            || path.ends_with("logo.txt")
        {
            assert_eq!(
                fs::read(d.path().join(&path)).unwrap(),
                bytes,
                "{path} changed"
            );
            checked += 1;
        }
    }
    assert_eq!(checked, 4);
}

#[test]
fn edits_are_saved_and_removed_tables_are_deleted() {
    let (d, pbip) = sample_copy();
    let mut p = Project::open(&pbip).unwrap();
    p.model.tmdl.remove("tables/Product.tmdl");
    let sales = &mut p.model.tmdl.get_mut("tables/Sales.tmdl").unwrap().nodes[0];
    let mut m = tmdl::Node::new("measure", Some("Double"));
    m.default = Some(tmdl::Expr {
        text: "[Total Amount] * 2".into(),
        verbatim: false,
    });
    sales.children.push(m);
    let r = p.save(d.path()).unwrap();
    assert!(r.deleted.iter().any(|f| f.ends_with("tables/Product.tmdl")));
    assert!(!d
        .path()
        .join("Retail.SemanticModel/definition/tables/Product.tmdl")
        .exists());
    let again = Project::open(&pbip).unwrap();
    let names: Vec<_> = again.model.tmdl["tables/Sales.tmdl"].nodes[0]
        .children
        .iter()
        .filter_map(|c| c.name.clone())
        .collect();
    assert!(names.contains(&"Double".to_string()));
}

#[test]
fn new_project_round_trips_and_creates_gitignore() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("proj");
    let p = Project::new("My Project");
    p.save(&root).unwrap();
    let reopened = Project::open(&p.pbip_path(&root)).unwrap();
    assert_eq!(reopened, p);
    let gi = fs::read_to_string(root.join(".gitignore")).unwrap();
    assert!(gi.contains("**/.pbi/cache.abf") && gi.contains(".biforge/recovery/"));
    let db =
        fs::read_to_string(root.join("My Project.SemanticModel/definition/database.tmdl")).unwrap();
    assert!(db.starts_with("database 'My Project'\n"), "{db}");
}

#[test]
fn existing_parent_gitignore_is_not_overwritten() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join(".gitignore"), "custom\n").unwrap();
    let root = d.path().join("inner");
    Project::new("P").save(&root).unwrap();
    assert!(!root.join(".gitignore").exists());
    assert_eq!(
        fs::read_to_string(d.path().join(".gitignore")).unwrap(),
        "custom\n"
    );
}

#[test]
fn legacy_report_and_tmsl_model_are_reported_as_unsupported() {
    let (d, pbip) = sample_copy();
    fs::remove_dir_all(d.path().join("Retail.Report/definition")).unwrap();
    fs::write(d.path().join("Retail.Report/report.json"), "{}").unwrap();
    assert!(matches!(
        Project::open(&pbip),
        Err(ProjectError::Unsupported(_))
    ));

    let (d2, pbip2) = sample_copy();
    fs::remove_dir_all(d2.path().join("Retail.SemanticModel/definition")).unwrap();
    fs::write(d2.path().join("Retail.SemanticModel/model.bim"), "{}").unwrap();
    assert!(matches!(
        Project::open(&pbip2),
        Err(ProjectError::Unsupported(_))
    ));
}

#[test]
fn invalid_json_and_tmdl_give_readable_errors_with_paths() {
    let (d, pbip) = sample_copy();
    fs::write(
        d.path().join("Retail.Report/definition/report.json"),
        "{ nope",
    )
    .unwrap();
    let msg = Project::open(&pbip).unwrap_err().to_string();
    assert!(
        msg.contains("report.json") && msg.contains("not valid JSON"),
        "{msg}"
    );

    let (d2, pbip2) = sample_copy();
    fs::write(
        d2.path().join("Retail.SemanticModel/definition/model.tmdl"),
        "model M\n\t\tbad\n",
    )
    .unwrap();
    let msg = Project::open(&pbip2).unwrap_err().to_string();
    assert!(
        msg.contains("model.tmdl") && msg.contains("line 2"),
        "{msg}"
    );
}

#[test]
fn missing_pbip_is_an_io_error_not_a_panic() {
    let d = tempfile::tempdir().unwrap();
    assert!(matches!(
        Project::open(&d.path().join("none.pbip")),
        Err(ProjectError::Io { .. })
    ));
}

#[test]
fn unsafe_keys_are_rejected_before_anything_is_written() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("p");
    for bad in [
        "../evil.tmdl",
        "a\\b.tmdl",
        "/abs.tmdl",
        "tables/x.txt",
        "tables//x.tmdl",
        "tables/a:b.tmdl",
    ] {
        let mut p = Project::new("P");
        let doc = p.model.tmdl["model.tmdl"].clone();
        p.model.tmdl.insert(bad.to_string(), doc);
        assert!(
            matches!(p.save(&root), Err(ProjectError::InvalidPath(_))),
            "{bad}"
        );
    }
    assert!(!root.exists(), "nothing should have been written");
}

#[test]
fn failed_save_leaves_existing_files_unchanged() {
    let (d, pbip) = sample_copy();
    let mut p = Project::open(&pbip).unwrap();
    // A folder occupies the path a new table file would need.
    fs::create_dir_all(
        d.path()
            .join("Retail.SemanticModel/definition/tables/Blocked.tmdl"),
    )
    .unwrap();
    let before = tree(d.path());
    p.model.tmdl.insert(
        "tables/Blocked.tmdl".into(),
        tmdl::parse("table Blocked\n").unwrap(),
    );
    p.model.tmdl.get_mut("model.tmdl").unwrap().nodes[0]
        .props
        .push(tmdl::Prop {
            key: "description".into(),
            value: tmdl::PropValue::Text("changed".into()),
        });
    assert!(p.save(d.path()).is_err());
    assert_eq!(tree(d.path()), before);
}

#[test]
fn recovery_snapshot_round_trips_and_clears() {
    let d = tempfile::tempdir().unwrap();
    assert!(Project::read_recovery(d.path()).unwrap().is_none());
    let mut p = Project::new("R");
    p.model.tmdl.get_mut("model.tmdl").unwrap().nodes[0]
        .props
        .push(tmdl::Prop {
            key: "description".into(),
            value: tmdl::PropValue::Text("unsaved edit".into()),
        });
    p.write_recovery(d.path()).unwrap();
    assert_eq!(Project::read_recovery(d.path()).unwrap().unwrap(), p);
    Project::clear_recovery(d.path()).unwrap();
    assert!(Project::read_recovery(d.path()).unwrap().is_none());
    Project::clear_recovery(d.path()).unwrap();
}

#[test]
fn damaged_recovery_file_is_reported() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir_all(d.path().join(".biforge/recovery")).unwrap();
    fs::write(
        d.path().join(".biforge/recovery/project.json"),
        "{ truncated",
    )
    .unwrap();
    assert!(matches!(
        Project::read_recovery(d.path()),
        Err(ProjectError::Corrupt(_))
    ));
}

#[test]
fn file_name_sanitizing() {
    assert_eq!(sanitize_file_name("Sales"), "Sales");
    assert_eq!(sanitize_file_name("a/b:c"), "a_b_c");
    assert_eq!(sanitize_file_name("CON"), "_CON");
    assert_eq!(sanitize_file_name("name. "), "name");
    assert_eq!(sanitize_file_name(""), "_");
}
