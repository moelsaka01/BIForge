//! Window functions over a small monthly table (hand-computed).
use biforge_dax::value::Value;
use biforge_dax::{DataType, Engine, MemorySource, Model};

fn engine() -> Engine {
    let mut m = Model::new();
    m.add_table("T", &[("Region", DataType::String), ("M", DataType::Int64), ("Amount", DataType::Int64)]).unwrap();
    m.add_measure("T", "Total", "SUM(T[Amount])").unwrap();
    let s = |x: &str| Value::str(x);
    // East: 10 30 20 20 (months 1..4); West: 5 15 (months 1..2)
    let rows = [("East", 1, 10), ("East", 2, 30), ("East", 3, 20), ("East", 4, 20), ("West", 1, 5), ("West", 2, 15)];
    let src = MemorySource::new().with_rows("T", rows.iter().map(|(r, mm, a)| vec![s(r), Value::Int(*mm), Value::Int(*a)]).collect());
    Engine::new(m, &src).unwrap()
}

fn table(e: &Engine, q: &str) -> Vec<Vec<String>> {
    e.query(q).unwrap_or_else(|x| panic!("{q}: {}", x.message))[0].rows.iter().map(|r| r.iter().map(|v| v.to_text()).collect()).collect()
}

fn rows(v: &[&[&str]]) -> Vec<Vec<String>> {
    v.iter().map(|r| r.iter().map(|c| c.to_string()).collect()).collect()
}

#[test]
fn offset_reads_the_previous_and_next_month_inside_a_partition() {
    let e = engine();
    let q = "EVALUATE SUMMARIZECOLUMNS(T[Region], T[M], \"prev\", CALCULATE([Total], OFFSET(-1, ALLSELECTED(T[Region], T[M]), ORDERBY(T[M]), PARTITIONBY(T[Region]))), \"next\", CALCULATE([Total], OFFSET(1, ALLSELECTED(T[Region], T[M]), ORDERBY(T[M]), PARTITIONBY(T[Region])))) ORDER BY T[Region], T[M]";
    assert_eq!(
        table(&e, q),
        rows(&[
            &["East", "1", "", "30"],
            &["East", "2", "10", "20"],
            &["East", "3", "30", "20"],
            &["East", "4", "20", ""],
            &["West", "1", "", "15"],
            &["West", "2", "5", ""],
        ])
    );
}

#[test]
fn rank_rownumber_index_and_window() {
    let e = engine();
    let q = "EVALUATE SUMMARIZECOLUMNS(T[Region], T[M], \"amount\", [Total], \"rank\", RANK(SKIP, ALLSELECTED(T[Region], T[M]), ORDERBY([Total], DESC), PARTITIONBY(T[Region])), \"dense\", RANK(DENSE, ALLSELECTED(T[Region], T[M]), ORDERBY([Total], DESC), PARTITIONBY(T[Region])), \"n\", ROWNUMBER(ALLSELECTED(T[Region], T[M]), ORDERBY(T[M]), PARTITIONBY(T[Region]))) ORDER BY T[Region], T[M]";
    // East amounts 10 30 20 20: ranks 4 1 2 2 (skip) / 3 1 2 2 (dense)
    assert_eq!(
        table(&e, q),
        rows(&[&["East", "1", "10", "4", "3", "1"], &["East", "2", "30", "1", "1", "2"], &["East", "3", "20", "2", "2", "3"], &["East", "4", "20", "2", "2", "4"], &["West", "1", "5", "2", "2", "1"], &["West", "2", "15", "1", "1", "2"]])
    );
    // first and last month of the region, and a running total with WINDOW
    let q2 = "EVALUATE SUMMARIZECOLUMNS(T[Region], T[M], \"first\", CALCULATE([Total], INDEX(1, ALLSELECTED(T[Region], T[M]), ORDERBY(T[M]), PARTITIONBY(T[Region]))), \"last\", CALCULATE([Total], INDEX(-1, ALLSELECTED(T[Region], T[M]), ORDERBY(T[M]), PARTITIONBY(T[Region]))), \"running\", CALCULATE([Total], WINDOW(1, ABS, 0, REL, ALLSELECTED(T[Region], T[M]), ORDERBY(T[M]), PARTITIONBY(T[Region])))) ORDER BY T[Region], T[M]";
    assert_eq!(
        table(&e, q2),
        rows(&[&["East", "1", "10", "20", "10"], &["East", "2", "10", "20", "40"], &["East", "3", "10", "20", "60"], &["East", "4", "10", "20", "80"], &["West", "1", "5", "15", "5"], &["West", "2", "5", "15", "20"]])
    );
}

#[test]
fn errors_say_what_is_missing() {
    let e = engine();
    assert!(e.query("EVALUATE ROW(\"v\", RANK(SKIP, ALLSELECTED(T[M]), ORDERBY(T[M])))").unwrap_err().message.contains("current row"));
    assert!(e.query("EVALUATE ROW(\"v\", OFFSET(1, ORDERBY(T[M])))").unwrap_err().message.contains("relation"));
    assert!(e.query("EVALUATE ROW(\"v\", ORDERBY(T[M]))").unwrap_err().message.contains("window function"));
}

#[test]
fn matchby_names_the_columns_that_identify_the_current_row() {
    let e = engine();
    let q = "EVALUATE SUMMARIZECOLUMNS(T[Region], T[M], \"prev\", CALCULATE([Total], OFFSET(-1, ALLSELECTED(T[Region], T[M]), ORDERBY(T[M]), PARTITIONBY(T[Region]), MATCHBY(T[M])))) ORDER BY T[Region], T[M]";
    // SUMMARIZECOLUMNS leaves out the rows where the only measure is blank (the first month of each region)
    assert_eq!(
        table(&e, q),
        rows(&[&["East", "2", "10"], &["East", "3", "30"], &["East", "4", "20"], &["West", "2", "5"]])
    );
    // outside a window function it is refused with its name
    let err = e.query("EVALUATE ROW(\"x\", MATCHBY(T[M]))").unwrap_err();
    assert!(err.message.contains("MATCHBY"), "{}", err.message);
}
