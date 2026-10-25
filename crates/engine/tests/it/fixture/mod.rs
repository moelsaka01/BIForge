//! The fixture model of tests/dax/fixtures (see its README): CSVs imported into DuckDB, the five relationships of the
//! Power BI fixture report, and a DAX engine over them.
#![allow(dead_code)]

use biforge_dax::model::Model;
use biforge_dax::CrossFilter;
use biforge_engine::dax_bridge::dax_type;
use biforge_engine::{Engine, MemoryCredentialStore, SourceSpec};
use std::path::PathBuf;

pub fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/dax/fixtures")
}

pub const TABLES: &[&str] = &["Date", "Customer", "Product", "Promotion", "Sales", "Budget"];

pub fn setup() -> (Engine, biforge_dax::Engine) {
    let store = Engine::in_memory().unwrap();
    let creds = MemoryCredentialStore::default();
    let mut model = Model::new();
    for t in TABLES {
        let path = fixtures().join(format!("{t}.csv")).to_string_lossy().into_owned();
        let info = store.import(t, &SourceSpec::Csv { path, delimiter: None, header: None }, &creds).unwrap();
        // Power BI's CSV import loads an empty text field as "" (not BLANK); the recorded results depend on it
        for c in info.columns.iter().filter(|c| c.bi_type == biforge_engine::BiType::String) {
            store.connection().execute(&format!("UPDATE \"{t}\" SET \"{}\" = '' WHERE \"{}\" IS NULL", c.name, c.name), []).unwrap();
        }
        let cols: Vec<(String, biforge_dax::DataType)> = info.columns.iter().map(|c| (c.name.clone(), dax_type(c.bi_type))).collect();
        let refs: Vec<(&str, biforge_dax::DataType)> = cols.iter().map(|(n, t)| (n.as_str(), *t)).collect();
        model.add_table(t, &refs).unwrap();
    }
    // the relationships of the fixture report (tests/dax/fixtures/README.md)
    model.add_relationship(("Sales", "OrderDate"), ("Date", "Date"), CrossFilter::Single, true).unwrap();
    model.add_relationship(("Sales", "ShipDate"), ("Date", "Date"), CrossFilter::Single, false).unwrap();
    model.add_relationship(("Sales", "CustomerKey"), ("Customer", "CustomerKey"), CrossFilter::Single, true).unwrap();
    model.add_relationship(("Sales", "ProductKey"), ("Product", "ProductKey"), CrossFilter::Single, true).unwrap();
    model.add_relationship(("Sales", "PromotionKey"), ("Promotion", "PromotionKey"), CrossFilter::Both, true).unwrap();
    // step 5 of the fixture README: Mark as date table
    model.mark_date_table("Date", "Date").unwrap();
    let dax = biforge_dax::Engine::new(model, &store).unwrap();
    (store, dax)
}

