//! PBIP-shaped project folder: open, save, create, and crash-recovery snapshot.
//!
//! Layout handled (see `research/pbip-tmdl-format.md`):
//! `<name>.pbip`, `<name>.SemanticModel/{definition.pbism, .platform, definition/**/*.tmdl}`,
//! `<name>.Report/{definition.pbir, .platform, definition/**/*.json}`.
//! Files outside that set (caches, DAX queries, resources, diagram layouts, ...) are never read,
//! rewritten or deleted by this module.

use crate::tmdl::{self, Document, ParseError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const PBIP_SCHEMA: &str =
    "https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json";
const PBISM_SCHEMA: &str = "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json";
const PBIR_SCHEMA: &str = "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json";
const REPORT_SCHEMA: &str = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.3.0/schema.json";
const VERSION_SCHEMA: &str = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json";
const PAGES_SCHEMA: &str = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.1.0/schema.json";
const PAGE_SCHEMA: &str = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/1.0.0/schema.json";

const GITIGNORE: &str = "**/.pbi/localSettings.json\n**/.pbi/cache.abf\n.biforge/recovery/\n";
const RECOVERY_REL: &str = ".biforge/recovery/project.json";

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("cannot access {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{path} is not valid JSON: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("{path}: {source}")]
    Tmdl {
        path: PathBuf,
        #[source]
        source: ParseError,
    },
    #[error("not supported yet: {0}")]
    Unsupported(String),
    #[error("invalid project: {0}")]
    Invalid(String),
    #[error("invalid file path in project: {0}")]
    InvalidPath(String),
    #[error("recovery file is damaged: {0}")]
    Corrupt(String),
}

fn io_err(path: &Path, source: io::Error) -> ProjectError {
    ProjectError::Io {
        path: path.to_path_buf(),
        source,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SemanticModelFolder {
    /// Contents of `definition.pbism`.
    pub pbism: Value,
    /// Contents of `.platform`, if present.
    pub platform: Option<Value>,
    /// TMDL files, keyed by path relative to `definition/` using `/` separators.
    pub tmdl: BTreeMap<String, Document>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportFolder {
    /// Contents of `definition.pbir`.
    pub pbir: Value,
    pub platform: Option<Value>,
    /// PBIR JSON files, keyed by path relative to `definition/` using `/` separators.
    pub files: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    /// File stem of the `.pbip`.
    pub name: String,
    pub pbip: Value,
    pub report_dir: String,
    pub model_dir: String,
    pub model: SemanticModelFolder,
    pub report: ReportFolder,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SaveReport {
    pub written: Vec<String>,
    pub deleted: Vec<String>,
}

fn read_json(path: &Path) -> Result<Value, ProjectError> {
    let text = fs::read_to_string(path).map_err(|e| io_err(path, e))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).map_err(|source| ProjectError::Json {
        path: path.to_path_buf(),
        source,
    })
}

fn read_optional_json(path: &Path) -> Result<Option<Value>, ProjectError> {
    if path.is_file() {
        read_json(path).map(Some)
    } else {
        Ok(None)
    }
}

/// Lists files below `dir` with the given extension, as `/`-separated relative paths.
fn list_files(dir: &Path, ext: &str) -> Result<Vec<String>, ProjectError> {
    fn walk(base: &Path, dir: &Path, ext: &str, out: &mut Vec<String>) -> Result<(), ProjectError> {
        for entry in fs::read_dir(dir).map_err(|e| io_err(dir, e))? {
            let entry = entry.map_err(|e| io_err(dir, e))?;
            let p = entry.path();
            if p.is_dir() {
                walk(base, &p, ext, out)?;
            } else if p.extension().and_then(|e| e.to_str()) == Some(ext) {
                let rel = p.strip_prefix(base).unwrap_or(&p);
                out.push(
                    rel.components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    if dir.is_dir() {
        walk(dir, dir, ext, &mut out)?;
    }
    out.sort();
    Ok(out)
}

fn to_pretty_json(v: &Value) -> Vec<u8> {
    let mut s = serde_json::to_string_pretty(v).expect("a JSON value always serializes");
    s.push('\n');
    s.into_bytes()
}

/// Rejects keys that could escape the definition folder or are not portable file names.
fn validate_key(key: &str, ext: &str) -> Result<(), ProjectError> {
    let bad = key.is_empty()
        || key.starts_with('/')
        || key.contains('\\')
        || key.contains(':')
        || !key.ends_with(&format!(".{ext}"))
        || key.split('/').any(|seg| {
            seg.is_empty()
                || seg == "."
                || seg == ".."
                || seg.ends_with('.')
                || seg.ends_with(' ')
                || seg.chars().any(|c| c.is_control() || "<>\"|?*".contains(c))
        });
    if bad {
        Err(ProjectError::InvalidPath(key.to_string()))
    } else {
        Ok(())
    }
}

/// Makes an object name safe to use as a file name (not reversible; the name lives in the file).
pub fn sanitize_file_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    s = s.trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() {
        s.push('_');
    }
    let upper = s.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    let reserved = matches!(stem, "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        s.insert(0, '_');
    }
    s
}

impl Project {
    /// Creates a minimal project: empty model plus a report with one blank page.
    pub fn new(name: &str) -> Project {
        let model_dir = format!("{name}.SemanticModel");
        let report_dir = format!("{name}.Report");
        let mut tmdl_files = BTreeMap::new();
        tmdl_files.insert(
            "database.tmdl".to_string(),
            tmdl::parse(&format!(
                "database {}\n\tcompatibilityLevel: 1600\n",
                quote(name)
            ))
            .expect("static TMDL"),
        );
        tmdl_files.insert(
            "model.tmdl".to_string(),
            tmdl::parse(
                "model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n",
            )
            .expect("static TMDL"),
        );
        let page = "page1";
        let mut files = BTreeMap::new();
        files.insert(
            "version.json".to_string(),
            json!({"$schema": VERSION_SCHEMA, "version": "2.0.0"}),
        );
        files.insert(
            "report.json".to_string(),
            json!({
                "$schema": REPORT_SCHEMA,
                "themeCollection": {"baseTheme": {"name": "BIForgeDefault", "reportVersionAtImport": "1.0", "type": "SharedResources"}}
            }),
        );
        files.insert(
            "pages/pages.json".to_string(),
            json!({"$schema": PAGES_SCHEMA, "pageOrder": [page], "activePageName": page}),
        );
        files.insert(
            format!("pages/{page}/page.json"),
            json!({"$schema": PAGE_SCHEMA, "name": page, "displayName": "Page 1", "displayOption": "FitToPage", "height": 720, "width": 1280}),
        );
        Project {
            name: name.to_string(),
            pbip: json!({
                "$schema": PBIP_SCHEMA,
                "version": "1.0",
                "artifacts": [{"report": {"path": report_dir}}],
                "settings": {"enableAutoRecovery": true}
            }),
            report_dir: report_dir.clone(),
            model_dir: model_dir.clone(),
            model: SemanticModelFolder {
                pbism: json!({"$schema": PBISM_SCHEMA, "version": "4.0"}),
                platform: None,
                tmdl: tmdl_files,
            },
            report: ReportFolder {
                pbir: json!({
                    "$schema": PBIR_SCHEMA,
                    "version": "4.0",
                    "datasetReference": {"byPath": {"path": format!("../{model_dir}")}}
                }),
                platform: None,
                files,
            },
        }
    }

    /// Opens a project from its `.pbip` file.
    pub fn open(pbip_path: &Path) -> Result<Project, ProjectError> {
        let root = pbip_path
            .parent()
            .ok_or_else(|| ProjectError::Invalid("the .pbip path has no folder".into()))?;
        let name = pbip_path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| ProjectError::Invalid("the .pbip file name is not valid text".into()))?
            .to_string();
        let pbip = read_json(pbip_path)?;
        let report_rel = pbip
            .pointer("/artifacts/0/report/path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProjectError::Invalid("the .pbip file does not point to a report".into())
            })?
            .to_string();
        let report_root = root.join(&report_rel);
        let pbir = read_json(&report_root.join("definition.pbir"))?;
        let model_rel = match pbir
            .pointer("/datasetReference/byPath/path")
            .and_then(Value::as_str)
        {
            Some(p) => p.to_string(),
            None if pbir.pointer("/datasetReference/byConnection").is_some() => {
                return Err(ProjectError::Unsupported(
                    "reports connected to a remote semantic model (byConnection)".into(),
                ))
            }
            None => {
                return Err(ProjectError::Invalid(
                    "definition.pbir has no datasetReference".into(),
                ))
            }
        };
        let model_root = report_root.join(&model_rel);
        let model_dir = model_rel
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&model_rel)
            .to_string();

        // Semantic model
        let pbism = read_json(&model_root.join("definition.pbism"))?;
        let def_dir = model_root.join("definition");
        if !def_dir.is_dir() {
            if model_root.join("model.bim").is_file() {
                return Err(ProjectError::Unsupported(
                    "semantic models saved in TMSL (model.bim); re-save the project with TMDL"
                        .into(),
                ));
            }
            return Err(ProjectError::Invalid(
                "the semantic model has no definition folder".into(),
            ));
        }
        let mut tmdl_files = BTreeMap::new();
        for rel in list_files(&def_dir, "tmdl")? {
            let path = def_dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            let text = fs::read_to_string(&path).map_err(|e| io_err(&path, e))?;
            let doc = tmdl::parse(&text).map_err(|source| ProjectError::Tmdl {
                path: path.clone(),
                source,
            })?;
            tmdl_files.insert(rel, doc);
        }

        // Report
        let rdef = report_root.join("definition");
        if !rdef.is_dir() {
            if report_root.join("report.json").is_file() {
                return Err(ProjectError::Unsupported(
                    "reports in the legacy single-file format (report.json); save them as PBIR first".into(),
                ));
            }
            return Err(ProjectError::Invalid(
                "the report has no definition folder".into(),
            ));
        }
        let mut files = BTreeMap::new();
        for rel in list_files(&rdef, "json")? {
            let path = rdef.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            files.insert(rel, read_json(&path)?);
        }

        Ok(Project {
            name,
            pbip,
            report_dir: report_rel,
            model_dir,
            model: SemanticModelFolder {
                pbism,
                platform: read_optional_json(&model_root.join(".platform"))?,
                tmdl: tmdl_files,
            },
            report: ReportFolder {
                pbir,
                platform: read_optional_json(&report_root.join(".platform"))?,
                files,
            },
        })
    }

    /// Where the `.pbip` file lives for a given project root folder.
    pub fn pbip_path(&self, root: &Path) -> PathBuf {
        root.join(format!("{}.pbip", self.name))
    }

    /// Saves into `root`. Only files whose content changed are rewritten. All new content is
    /// staged in temporary files first, so a failure while staging leaves the project untouched.
    pub fn save(&self, root: &Path) -> Result<SaveReport, ProjectError> {
        let model_root = root.join(&self.model_dir);
        let report_root = root.join(&self.report_dir);
        let mut planned: Vec<(PathBuf, Vec<u8>)> = vec![
            (self.pbip_path(root), to_pretty_json(&self.pbip)),
            (
                model_root.join("definition.pbism"),
                to_pretty_json(&self.model.pbism),
            ),
            (
                report_root.join("definition.pbir"),
                to_pretty_json(&self.report.pbir),
            ),
        ];
        if let Some(p) = &self.model.platform {
            planned.push((model_root.join(".platform"), to_pretty_json(p)));
        }
        if let Some(p) = &self.report.platform {
            planned.push((report_root.join(".platform"), to_pretty_json(p)));
        }
        let def = model_root.join("definition");
        for (key, doc) in &self.model.tmdl {
            validate_key(key, "tmdl")?;
            planned.push((def.join(key), tmdl::print(doc).into_bytes()));
        }
        let rdef = report_root.join("definition");
        for (key, v) in &self.report.files {
            validate_key(key, "json")?;
            planned.push((rdef.join(key), to_pretty_json(v)));
        }
        let stale: Vec<PathBuf> = [
            (&def, "tmdl", self.model.tmdl.keys().collect::<Vec<_>>()),
            (&rdef, "json", self.report.files.keys().collect::<Vec<_>>()),
        ]
        .into_iter()
        .map(|(dir, ext, keep)| -> Result<Vec<PathBuf>, ProjectError> {
            Ok(list_files(dir, ext)?
                .into_iter()
                .filter(|r| !keep.contains(&r))
                .map(|r| dir.join(r))
                .collect())
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect();

        // Skip unchanged files; refuse to run if a target is a directory.
        let mut changed: Vec<(PathBuf, Vec<u8>)> = Vec::new();
        for (path, bytes) in planned {
            if path.is_dir() {
                return Err(ProjectError::InvalidPath(format!(
                    "{} is a folder",
                    path.display()
                )));
            }
            if fs::read(&path).map(|old| old == bytes).unwrap_or(false) {
                continue;
            }
            changed.push((path, bytes));
        }

        // Phase 1: stage.
        let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
        let cleanup = |staged: &[(PathBuf, PathBuf)]| {
            for (tmp, _) in staged {
                let _ = fs::remove_file(tmp);
            }
        };
        for (path, bytes) in &changed {
            let result = (|| -> io::Result<PathBuf> {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
                tmp_name.push(".biforge-tmp");
                let tmp = path.with_file_name(tmp_name);
                fs::write(&tmp, bytes)?;
                Ok(tmp)
            })();
            match result {
                Ok(tmp) => staged.push((tmp, path.clone())),
                Err(e) => {
                    cleanup(&staged);
                    return Err(io_err(path, e));
                }
            }
        }
        // Phase 2: commit.
        let mut report = SaveReport::default();
        for (tmp, path) in &staged {
            fs::rename(tmp, path).map_err(|e| io_err(path, e))?;
            report.written.push(rel_display(root, path));
        }
        // .gitignore only if neither this folder nor a parent already has one.
        if !root.ancestors().any(|d| d.join(".gitignore").is_file()) {
            let gi = root.join(".gitignore");
            fs::write(&gi, GITIGNORE).map_err(|e| io_err(&gi, e))?;
            report.written.push(".gitignore".into());
        }
        for path in stale {
            fs::remove_file(&path).map_err(|e| io_err(&path, e))?;
            report.deleted.push(rel_display(root, &path));
        }
        Ok(report)
    }

    // ---- crash recovery -------------------------------------------------

    /// Writes a snapshot of the in-memory project (including unsaved edits) under `.biforge/recovery/`.
    pub fn write_recovery(&self, root: &Path) -> Result<(), ProjectError> {
        let path = root.join(RECOVERY_REL);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_vec(self).map_err(|source| ProjectError::Json {
            path: path.clone(),
            source,
        })?;
        fs::write(&tmp, text).map_err(|e| io_err(&tmp, e))?;
        fs::rename(&tmp, &path).map_err(|e| io_err(&path, e))
    }

    /// Returns the recovery snapshot if one exists. A damaged snapshot is an error, not a panic.
    pub fn read_recovery(root: &Path) -> Result<Option<Project>, ProjectError> {
        let path = root.join(RECOVERY_REL);
        if !path.is_file() {
            return Ok(None);
        }
        let text = fs::read(&path).map_err(|e| io_err(&path, e))?;
        serde_json::from_slice(&text)
            .map(Some)
            .map_err(|e| ProjectError::Corrupt(e.to_string()))
    }

    pub fn clear_recovery(root: &Path) -> Result<(), ProjectError> {
        let path = root.join(RECOVERY_REL);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err(&path, e)),
        }
    }
}

fn quote(name: &str) -> String {
    // Reuse the TMDL printer's name quoting by printing a throwaway node.
    let mut n = tmdl::Node::new("database", Some(name));
    n.props.clear();
    let printed = tmdl::print(&tmdl::Document { nodes: vec![n] });
    printed
        .trim_end()
        .strip_prefix("database ")
        .unwrap_or(name)
        .to_string()
}

fn rel_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

impl Project {
    /// Creates a new project on disk (a fresh folder or an empty existing one) and returns it.
    /// Refuses to touch a folder that already contains a project with the same name.
    pub fn create_new(root: &Path, name: &str) -> Result<Project, ProjectError> {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed != name || sanitize_file_name(name) != name || name.ends_with(".pbip") {
            return Err(ProjectError::Invalid(format!(
                "\"{name}\" cannot be used as a project name (use letters, digits, spaces, dashes)"
            )));
        }
        let project = Project::new(name);
        if project.pbip_path(root).exists() {
            return Err(ProjectError::Invalid(format!("a project named \"{name}\" already exists in {}", root.display())));
        }
        project.save(root)?;
        Ok(project)
    }
}
