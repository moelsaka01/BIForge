//! Reloading the data of a project on this PC without a window: the tables that were imported from a source
//! (the source description is kept in the `BIForge.Source` annotation of the table) and the tables a Power Query
//! (M) query loads. This is what a scheduled refresh on this PC does before it publishes; it mirrors what Refresh all
//! does in the app.
//!
//! It changes data only. If a source now has other columns than the model has, the table is reported instead of
//! silently changing the model: the person opens the report in BIForge, refreshes it there and saves.

use std::collections::BTreeMap;

use biforge_engine::{CredentialStore, Engine, SourceSpec};
use biforge_model::project::Project;
use biforge_model::tmdl::{Node, PropValue};

const SOURCE_ANNOTATION: &str = "BIForge.Source";
const GENERATED: &str = "BIForge.GeneratedM";

fn nodes(p: &Project) -> impl Iterator<Item = &Node> {
    p.model.tmdl.values().flat_map(|d| d.nodes.iter())
}

fn is_m_partition(n: &Node) -> bool {
    n.kind == "partition" && n.default.as_ref().map(|d| d.text.trim().eq_ignore_ascii_case("m")).unwrap_or(false)
}

fn partition_source(part: &Node) -> Option<String> {
    part.props.iter().find(|p| p.key == "source").and_then(|p| match &p.value {
        PropValue::Expr(e) => Some(e.text.clone()),
        _ => None,
    })
}

fn is_generated(part: &Node) -> bool {
    part.children.iter().any(|a| a.kind == "annotation" && a.name.as_deref() == Some(GENERATED))
}

/// The M text of every query: loaded tables (their partition) and named expressions.
pub fn queries_of(p: &Project) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for n in nodes(p) {
        if n.kind == "table" {
            if let (Some(name), Some(src)) = (&n.name, n.children.iter().find(|c| is_m_partition(c)).and_then(partition_source)) {
                out.insert(name.clone(), src);
            }
        } else if n.kind == "expression" {
            if let (Some(name), Some(d)) = (&n.name, &n.default) {
                out.insert(name.clone(), d.text.clone());
            }
        }
    }
    out
}

/// How a table gets its data.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// Imported from a source the engine reads (file, database, web, ...).
    Import(SourceSpec),
    /// Loaded by running the M of its partition (the person wrote or edited it).
    Query,
}

fn import_spec(t: &Node) -> Option<SourceSpec> {
    let a = t.children.iter().find(|c| c.kind == "annotation" && c.name.as_deref() == Some(SOURCE_ANNOTATION))?;
    serde_json::from_str(&a.default.as_ref()?.text).ok()
}

/// The tables that can be refreshed, in model order.
pub fn refreshable(p: &Project) -> Vec<(String, Source)> {
    let mut out = Vec::new();
    for n in nodes(p).filter(|n| n.kind == "table") {
        let Some(name) = &n.name else { continue };
        if let Some(spec) = import_spec(n) {
            out.push((name.clone(), Source::Import(spec)));
        } else if n.children.iter().any(|c| is_m_partition(c) && !is_generated(c)) {
            out.push((name.clone(), Source::Query));
        }
    }
    out
}

#[derive(Debug, Default)]
pub struct DataReport {
    /// Table and the number of rows now in it.
    pub loaded: Vec<(String, u64)>,
    pub failures: Vec<(String, String)>,
}

/// Reloads every refreshable table into `engine`. A table that fails is reported and the others are still loaded.
pub fn refresh_data(p: &Project, engine: &Engine, creds: &dyn CredentialStore) -> DataReport {
    let mut report = DataReport::default();
    let queries = queries_of(p);
    for (table, source) in refreshable(p) {
        let result = match &source {
            Source::Import(spec) => engine.import(&table, spec, creds).map_err(|e| e.to_string()),
            Source::Query => engine.m_load(&queries, &table, &table).map_err(|e| e.to_string()),
        };
        match result {
            Ok(info) => report.loaded.push((table, info.row_count)),
            Err(e) => report.failures.push((table, e)),
        }
    }
    report
}

/// Tables whose columns in the data differ from the columns the model declares.
pub fn columns_changed(p: &Project, engine: &Engine, tables: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for n in nodes(p).filter(|n| n.kind == "table") {
        let Some(name) = &n.name else { continue };
        if !tables.iter().any(|t| t.eq_ignore_ascii_case(name)) {
            continue;
        }
        let Ok(info) = engine.table_info(name) else { continue };
        let mut model: Vec<String> = n.children.iter().filter(|c| c.kind == "column").filter_map(|c| c.name.clone()).collect();
        let mut data: Vec<String> = info.columns.iter().map(|c| c.name.clone()).collect();
        model.sort();
        data.sort();
        if model != data {
            out.push(name.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use biforge_engine::MemoryCredentialStore;
    use biforge_model::tmdl::{Expr, Prop};

    fn table(name: &str, columns: &[&str], source: Option<serde_json::Value>) -> Node {
        let mut t = Node::new("table", Some(name));
        for c in columns {
            t.children.push(Node::new("column", Some(c)));
        }
        if let Some(s) = source {
            let mut a = Node::new("annotation", Some(SOURCE_ANNOTATION));
            a.default = Some(Expr { text: s.to_string(), verbatim: false });
            t.children.push(a);
        }
        t
    }

    fn project(dir: &std::path::Path, tables: Vec<Node>) -> Project {
        let mut p = Project::create_new(dir, "Demo").unwrap();
        p.model.tmdl.insert("tables/all.tmdl".into(), biforge_model::tmdl::Document { nodes: tables });
        p
    }

    #[test]
    fn imported_and_query_tables_reload_and_changed_columns_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let csv = dir.path().join("sales.csv");
        std::fs::write(&csv, "Id,Qty\n1,10\n2,20\n").unwrap();
        let spec = serde_json::json!({"kind": "csv", "path": csv.to_string_lossy(), "delimiter": null, "header": null});
        // a table the user made with M (not generated)
        let mut mt = Node::new("table", Some("Big"));
        mt.children.push(Node::new("column", Some("Id")));
        let mut part = Node::new("partition", Some("Big"));
        part.default = Some(Expr { text: "m".into(), verbatim: false });
        let m = format!("let Source = Csv.Document(File.Contents(\"{}\"), [Delimiter=\",\"]), P = Table.PromoteHeaders(Source), Out = Table.SelectColumns(P, {{\"Id\"}}) in Out", csv.to_string_lossy().replace('\\', "/"));
        part.props.push(Prop { key: "source".into(), value: PropValue::Expr(Expr { text: m, verbatim: false }) });
        mt.children.push(part);
        let p = project(dir.path(), vec![table("Sales", &["Id", "Qty"], Some(spec)), mt]);
        assert_eq!(refreshable(&p).iter().map(|(t, s)| (t.as_str(), matches!(s, Source::Import(_)))).collect::<Vec<_>>(), [("Sales", true), ("Big", false)]);

        let engine = Engine::in_memory().unwrap();
        let creds = MemoryCredentialStore::default();
        let r = refresh_data(&p, &engine, &creds);
        assert!(r.failures.is_empty(), "{:?}", r.failures);
        assert_eq!(r.loaded, [("Sales".to_string(), 2), ("Big".to_string(), 2)]);
        assert!(columns_changed(&p, &engine, &["Sales".into(), "Big".into()]).is_empty());

        // the file got a new row and a new column
        std::fs::write(&csv, "Id,Qty,Region\n1,10,E\n2,20,W\n3,30,N\n").unwrap();
        let r = refresh_data(&p, &engine, &creds);
        assert_eq!(r.loaded, [("Sales".to_string(), 3), ("Big".to_string(), 3)]);
        assert_eq!(columns_changed(&p, &engine, &["Sales".into(), "Big".into()]), ["Sales"]);

        // a missing file is reported for its table; the other table still loads
        std::fs::remove_file(&csv).unwrap();
        let r = refresh_data(&p, &engine, &creds);
        assert_eq!(r.failures.len(), 2, "{:?}", r.failures);
    }
}
