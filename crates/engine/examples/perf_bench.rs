//! Performance benchmark for the DAX path over a large Sales table. Not part of the product.
//!
//!     node tools/dax-fixtures/generate-large.mjs 1000000
//!     cargo run --release -p biforge-engine --example perf_bench -- target/perf-fixtures/1000000 [--md]
//!
//! Prints one line per measurement (milliseconds and the process working set in MB), or a markdown table with --md.

use biforge_dax::model::Model;
use biforge_dax::CrossFilter;
use biforge_engine::dax_bridge::{dax_type, DaxCache};
use biforge_engine::{Engine, MemoryCredentialStore, SortSpec, SourceSpec};
use std::path::PathBuf;
use std::time::Instant;

#[repr(C)]
#[derive(Default)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set: usize,
    working_set: usize,
    rest: [usize; 6],
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> isize;
    fn K32GetProcessMemoryInfo(p: isize, c: *mut ProcessMemoryCounters, cb: u32) -> i32;
}

fn mem_mb() -> (f64, f64) {
    let mut c = ProcessMemoryCounters::default();
    c.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
    unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    (c.working_set as f64 / 1048576.0, c.peak_working_set as f64 / 1048576.0)
}

const TABLES: &[&str] = &["Date", "Customer", "Product", "Promotion", "Sales"];

const MEASURES: &str = "DEFINE
  MEASURE Sales[Qty] = SUM(Sales[Quantity])
  MEASURE Sales[Amount] = SUMX(Sales, Sales[Quantity] * Sales[UnitPrice] * (1 - Sales[Discount]))
  MEASURE Sales[Orders] = COUNTROWS(Sales)
  MEASURE Sales[AvgPrice] = AVERAGE(Sales[UnitPrice])
  MEASURE Sales[Qty PY] = CALCULATE(SUM(Sales[Quantity]), SAMEPERIODLASTYEAR('Date'[Date]))
  MEASURE Sales[Qty YTD] = TOTALYTD(SUM(Sales[Quantity]), 'Date'[Date])
";

fn build_model(store: &Engine) -> Model {
    let mut model = Model::new();
    for t in TABLES {
        let info = store.table_info(t).unwrap();
        let cols: Vec<(String, biforge_dax::DataType)> = info.columns.iter().map(|c| (c.name.clone(), dax_type(c.bi_type))).collect();
        let refs: Vec<(&str, biforge_dax::DataType)> = cols.iter().map(|(n, t)| (n.as_str(), *t)).collect();
        model.add_table(t, &refs).unwrap();
    }
    model.add_relationship(("Sales", "OrderDate"), ("Date", "Date"), CrossFilter::Single, true).unwrap();
    model.add_relationship(("Sales", "ShipDate"), ("Date", "Date"), CrossFilter::Single, false).unwrap();
    model.add_relationship(("Sales", "CustomerKey"), ("Customer", "CustomerKey"), CrossFilter::Single, true).unwrap();
    model.add_relationship(("Sales", "ProductKey"), ("Product", "ProductKey"), CrossFilter::Single, true).unwrap();
    model.add_relationship(("Sales", "PromotionKey"), ("Promotion", "PromotionKey"), CrossFilter::Both, true).unwrap();
    model.mark_date_table("Date", "Date").unwrap();
    model
}

/// The 8 visuals of the benchmark page; `filter` is a slicer selection (added to every visual) or empty.
fn page(filter: &str) -> Vec<(&'static str, String)> {
    let f = |extra: &str| if filter.is_empty() { extra.to_string() } else { format!("{extra}{filter}, ") };
    let q = |body: &str| format!("{MEASURES}EVALUATE {body}");
    vec![
        ("card Qty", q(&format!("SUMMARIZECOLUMNS({}\"m0\", [Qty])", f("")))),
        ("card Amount (SUMX)", q(&format!("SUMMARIZECOLUMNS({}\"m0\", [Amount])", f("")))),
        ("column Category", q(&format!("SUMMARIZECOLUMNS(Product[Category], {}\"m0\", [Qty]) ORDER BY [m0] DESC", f("")))),
        ("line YearMonth", q(&format!("SUMMARIZECOLUMNS(Date[YearMonth], {}\"m0\", [Amount]) ORDER BY Date[YearMonth]", f("")))),
        ("donut Color", q(&format!("SUMMARIZECOLUMNS(Product[Color], {}\"m0\", [Qty]) ORDER BY [m0] DESC", f("")))),
        ("bar Country x Category", q(&format!("SUMMARIZECOLUMNS(Customer[Country], Product[Category], {}\"m0\", [Amount]) ORDER BY [m0] DESC", f("")))),
        ("table Category/Country/Channel", q(&format!("SUMMARIZECOLUMNS(Product[Category], Customer[Country], Sales[Channel], {}\"q\", [Qty], \"o\", [Orders], \"p\", [AvgPrice]) ORDER BY Product[Category]", f("")))),
        ("matrix Year x Category", q(&format!("SUMMARIZECOLUMNS(Date[Year], Product[Category], {}\"m0\", [Qty]) ORDER BY Date[Year], Product[Category]", f("")))),
    ]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = PathBuf::from(args.first().expect("fixture directory"));
    let md = args.iter().any(|a| a == "--md");
    let mut rows: Vec<(String, f64, String)> = Vec::new();
    let mut note = |name: &str, ms: f64, extra: String| {
        let (ws, peak) = mem_mb();
        let extra = format!("{extra}working set {ws:.0} MB, peak {peak:.0} MB");
        if md {
            rows.push((name.to_string(), ms, extra));
        } else {
            println!("{name:<48} {ms:>10.1} ms   {extra}");
        }
    };
    let work = std::env::temp_dir().join(format!("biforge-perf-{}.duckdb", std::process::id()));
    let _ = std::fs::remove_file(&work);
    let store = Engine::open(&work).expect("store");
    let creds = MemoryCredentialStore::default();
    let spec = |t: &str| SourceSpec::Csv { path: dir.join(format!("{t}.csv")).to_string_lossy().into_owned(), delimiter: None, header: None };

    note("start", 0.0, String::new());
    let t0 = Instant::now();
    for t in TABLES {
        let info = store.import(t, &spec(t), &creds).expect("import");
        if *t == "Sales" {
            note("import Sales", t0.elapsed().as_secs_f64() * 1000.0, format!("{} rows; ", info.row_count));
        }
    }
    let total_rows = store.table_info("Sales").unwrap().row_count;

    // Table view scrolling: pages from the top, the middle and the end, and a sorted page.
    for (label, off) in [("table page @0", 0u64), ("table page @middle", total_rows / 2), ("table page @end", total_rows.saturating_sub(100))] {
        let t = Instant::now();
        store.fetch_page("Sales", off, 100, None).unwrap();
        note(label, t.elapsed().as_secs_f64() * 1000.0, String::new());
    }
    let t = Instant::now();
    store.fetch_page("Sales", total_rows / 2, 100, Some(&SortSpec { column: "UnitPrice".into(), descending: true })).unwrap();
    note("table page @middle sorted by UnitPrice", t.elapsed().as_secs_f64() * 1000.0, String::new());

    let model = build_model(&store);
    let cache = DaxCache::default();
    let t = Instant::now();
    let engine = cache.get(1, &store, || Ok(model.clone())).expect("engine load");
    note("DAX engine load (the first query pays this)", t.elapsed().as_secs_f64() * 1000.0, String::new());

    let run = |label: &str, queries: &[(&str, String)], note: &mut dyn FnMut(&str, f64, String)| {
        let t = Instant::now();
        for (name, q) in queries {
            let tq = Instant::now();
            let r = engine.query_with(q, Some(&store));
            if let Err(e) = &r {
                println!("   ERROR in {name}: {}", e.message);
            }
            if std::env::var("PERF_EACH").is_ok() {
                println!("   {name:<40} {:>9.1} ms", tq.elapsed().as_secs_f64() * 1000.0);
            }
        }
        note(label, t.elapsed().as_secs_f64() * 1000.0, String::new());
    };
    run("page of 8 visuals, first render", &page(""), &mut note);
    run("page of 8 visuals, repeat", &page(""), &mut note);
    let slicer = "TREATAS({\"France\", \"Germany\"}, Customer[Country])";
    let mut after = page(slicer);
    after.push(("slicer Country list", "EVALUATE CALCULATETABLE(VALUES(Customer[Country]))".to_string()));
    run("slicer click: all 8 visuals + 1 slicer", &after, &mut note);
    let heavy = format!("{MEASURES}EVALUATE SUMMARIZECOLUMNS(Customer[Country], Product[Category], Date[Year], \"m0\", [Amount])");
    run("heavy query: 3 grouping columns, SUMX", &[("heavy", heavy)], &mut note);
    let ti = format!("{MEASURES}EVALUATE SUMMARIZECOLUMNS(Date[Month], Date[MonthNumber], \"cy\", [Qty], \"py\", [Qty PY], \"ytd\", [Qty YTD])");
    run("CALCULATE time intelligence (PY, YTD) by month", &[("ti", ti)], &mut note);

    // refresh: re-import Sales, then the next query reloads the engine (the old one is released first, as the app does)
    drop(engine);
    cache.clear();
    let t = Instant::now();
    store.import("Sales", &spec("Sales"), &creds).expect("re-import");
    store.data_changed();
    let engine2 = cache.get(2, &store, || Ok(model.clone())).expect("reload");
    let _ = engine2.query_with(&page("")[0].1, Some(&store));
    note("refresh Sales (re-import + engine reload + 1 query)", t.elapsed().as_secs_f64() * 1000.0, String::new());
    if md {
        println!("| Measurement | ms | Memory |\n|---|---:|---|");
        for (n, ms, e) in rows {
            println!("| {n} | {ms:.0} | {e} |");
        }
    }
    drop(store);
    let _ = std::fs::remove_file(&work);
}
