//! Prints every catalog function with its category and whether the evaluator implements it
//! (used by tools/inventory to build docs/INVENTORY.md). Output: category<TAB>name<TAB>implemented
fn main() {
    let imp: std::collections::HashSet<&str> = biforge_dax::functions::implemented_names().into_iter().collect();
    let raw: serde_json::Value = serde_json::from_str(include_str!("../catalog/functions.json")).unwrap();
    for e in raw.as_array().unwrap() {
        let sig = e["s"].as_str().unwrap();
        let name = sig.split('(').next().unwrap();
        println!("{}\t{}\t{}", e["c"].as_str().unwrap(), name, imp.contains(name));
    }
}
