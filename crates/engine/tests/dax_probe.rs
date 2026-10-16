//! Triage helper (no assertions): runs the queries in BIFORGE_DAX_PROBE (separated by ";;") on the fixture and
//! prints the results the way tools/dax-record/probe.mjs prints Power BI's, so the two can be compared by eye.
//!   BIFORGE_DAX_PROBE='EVALUATE ROW("a", 1)' cargo test -p biforge-engine --test dax_probe -- --nocapture

mod fixture;

#[test]
fn probe() {
    let Ok(qs) = std::env::var("BIFORGE_DAX_PROBE") else { return };
    let (_store, dax) = fixture::setup();
    for q in qs.split(";;") {
        println!("## {q}");
        match dax.query(q) {
            Err(e) => println!("ERROR: {}", e.message),
            Ok(t) => {
                let t = &t[0];
                println!("{:?}", t.columns);
                for r in t.rows.iter().take(40) {
                    println!("{}", r.iter().map(|v| if v.is_blank() { "null".to_string() } else { format!("{v:?}") }).collect::<Vec<_>>().join(", "));
                }
            }
        }
    }
}
