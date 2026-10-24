//! Financial, parent-child, TOCSV and LINEST functions through the whole engine (hand-computed expectations).
use biforge_dax::value::Value;
use biforge_dax::{DataType, Engine, MemorySource, Model};

fn engine() -> Engine {
    let mut m = Model::new();
    m.add_table("Emp", &[("Id", DataType::Int64), ("Boss", DataType::Int64), ("Name", DataType::String)]).unwrap();
    m.add_table("Pts", &[("X", DataType::Double), ("Y", DataType::Double), ("Z", DataType::Double)]).unwrap();
    m.add_table("Flows", &[("D", DataType::DateTime), ("V", DataType::Double)]).unwrap();
    m.add_calculated_column("Emp", "Path", "PATH(Emp[Id], Emp[Boss])").unwrap();
    let s = |x: &str| Value::str(x);
    let emp = vec![
        vec![Value::Int(1), Value::Blank, s("Ann")],
        vec![Value::Int(2), Value::Int(1), s("Bob")],
        vec![Value::Int(5), Value::Int(2), s("Cy")],
        vec![Value::Int(7), Value::Int(99), s("Orphan")],
    ];
    let pts: Vec<Vec<Value>> = [(1.0, 3.0, 5.0), (2.0, 5.0, 4.0), (3.0, 7.0, 6.0), (4.0, 9.0, 3.0), (5.0, 11.0, 8.0)].iter().map(|(x, y, z)| vec![Value::Double(*x), Value::Double(*y), Value::Double(*z)]).collect();
    let d = |n: f64| Value::DateTime(n);
    let flows = vec![vec![d(45000.0), Value::Double(-1000.0)], vec![d(45365.0), Value::Double(1100.0)]];
    let src = MemorySource::new().with_rows("Emp", emp).with_rows("Pts", pts).with_rows("Flows", flows);
    Engine::new(m, &src).unwrap()
}

fn one(e: &Engine, q: &str) -> Value {
    e.query(q).unwrap_or_else(|x| panic!("{q}: {}", x.message))[0].rows[0][0].clone()
}

fn near(v: Value, want: f64) {
    let got = v.as_f64().unwrap();
    assert!((got - want).abs() < 1e-6, "{got} vs {want}");
}

#[test]
fn financial_functions() {
    let e = engine();
    near(one(&e, "EVALUATE ROW(\"v\", FV(0.05, 10, -100))"), 1257.789253554883);
    near(one(&e, "EVALUATE ROW(\"v\", PV(0.05, 10, -100))"), 772.1734929184818);
    near(one(&e, "EVALUATE ROW(\"v\", PMT(0.05, 10, 1000))"), -129.5045749654567);
    near(one(&e, "EVALUATE ROW(\"v\", NPER(0.05, -129.5045749654567, 1000))"), 10.0);
    near(one(&e, "EVALUATE ROW(\"v\", RATE(10, -129.5045749654567, 1000))"), 0.05);
    near(one(&e, "EVALUATE ROW(\"v\", XIRR(Flows, Flows[V], Flows[D]))"), 0.1);
    near(one(&e, "EVALUATE ROW(\"v\", XNPV(Flows, Flows[V], Flows[D], 0.1))"), 0.0);
    // payments at the start of the period cost less
    near(one(&e, "EVALUATE ROW(\"v\", PMT(0.05, 10, 1000, 0, 1))"), -123.33769044329211);
    assert!(e.query("EVALUATE ROW(\"v\", XIRR(FILTER(Flows, Flows[V] > 0), Flows[V], Flows[D]))").is_err());
}

#[test]
fn parent_child_paths() {
    let e = engine();
    let t = &e.query("EVALUATE SELECTCOLUMNS(Emp, \"n\", Emp[Name], \"p\", Emp[Path]) ORDER BY [n]").unwrap()[0];
    let got: Vec<(String, String)> = t.rows.iter().map(|r| (r[0].to_text(), r[1].to_text())).collect();
    assert_eq!(got, [("Ann", "1"), ("Bob", "1|2"), ("Cy", "1|2|5"), ("Orphan", "99|7")].map(|(a, b)| (a.to_string(), b.to_string())));
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", PATHITEM(\"1|2|5\", 2))"), Value::str("2"));
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", PATHITEM(\"1|2|5\", 2, INTEGER))"), Value::Int(2));
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", PATHITEMREVERSE(\"1|2|5\", 1))"), Value::str("5"));
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", PATHITEM(\"1|2|5\", 4))"), Value::Blank);
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", PATHLENGTH(\"1|2|5\"))"), Value::Int(3));
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", PATHCONTAINS(\"1|2|5\", 2))"), Value::Bool(true));
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", PATHCONTAINS(\"1|2|5\", 3))"), Value::Bool(false));
}

#[test]
fn linest_and_tocsv() {
    let e = engine();
    // Y = 2 X + 1 exactly
    let t = &e.query("EVALUATE LINEST(Pts[Y], Pts[X])").unwrap()[0];
    assert_eq!(t.columns, ["[Slope1]", "[Intercept]", "[StandardErrorSlope1]", "[StandardErrorIntercept]", "[CoefficientOfDetermination]", "[StandardError]", "[FStatistic]", "[DegreesOfFreedom]", "[RegressionSumOfSquares]", "[ResidualSumOfSquares]"]);
    near(t.rows[0][0].clone(), 2.0);
    near(t.rows[0][1].clone(), 1.0);
    near(t.rows[0][4].clone(), 1.0);
    assert_eq!(t.rows[0][7], Value::Int(3));
    near(t.rows[0][8].clone(), 40.0);
    // two predictors by expressions: Z = 9 - X + ... is not exact; check the fit is reported with 2 slopes
    let t2 = &e.query("EVALUATE LINESTX(Pts, Pts[Z], Pts[X], Pts[Y] * Pts[Y])").unwrap()[0];
    assert!(t2.columns.contains(&"[Slope2]".to_string()));
    assert_eq!(t2.rows[0][5 + 0].is_blank(), false);
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", TOCSV(TOPN(2, Emp, Emp[Id], ASC)))"), Value::str("'Emp'[Id],'Emp'[Boss],'Emp'[Name],'Emp'[Path]\n1,,Ann,1\n2,1,Bob,1|2"));
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", TOCSV(SELECTCOLUMNS(Emp, \"a\", Emp[Name]), 1, \";\", FALSE))"), Value::str("Ann"));
}

#[test]
fn isinscope_tells_a_group_by_column_from_a_filter() {
    let e = engine();
    let by = "EVALUATE SUMMARIZECOLUMNS(Emp[Name], \"s\", IF(ISINSCOPE(Emp[Name]), \"in\", \"out\")) ORDER BY Emp[Name]";
    assert_eq!(e.query(by).unwrap()[0].rows[0][1], Value::str("in"));
    // a slicer-like filter is not a group-by
    assert_eq!(one(&e, "EVALUATE ROW(\"s\", CALCULATE(IF(ISINSCOPE(Emp[Name]), \"in\", \"out\"), Emp[Name] = \"Ann\"))"), Value::str("out"));
    assert_eq!(one(&e, "EVALUATE ROW(\"s\", IF(ISINSCOPE(Emp[Name]), \"in\", \"out\"))"), Value::str("out"));
}

#[test]
fn isempty_and_columnstatistics() {
    let e = engine();
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", ISEMPTY(Emp))").to_text(), "FALSE");
    assert_eq!(one(&e, "EVALUATE ROW(\"v\", ISEMPTY(FILTER(Emp, Emp[Id] > 100)))").to_text(), "TRUE");
    // Emp: Id 1, 2, 5, 7 (4 distinct values, longest text 1 character)
    let t = &e.query("EVALUATE FILTER(COLUMNSTATISTICS(), [Table Name] = \"Emp\" && [Column Name] = \"Id\")").unwrap()[0];
    let row: Vec<String> = t.rows[0].iter().map(|v| v.to_text()).collect();
    assert_eq!(row, vec!["Emp", "Id", "1", "7", "4", "1"]);
}
