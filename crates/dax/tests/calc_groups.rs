use biforge_dax::model::{CalcGroup, CalcItem};
use biforge_dax::value::Value;
use biforge_dax::{DataType, Engine, MemorySource, Model};

fn engine() -> Engine {
    let mut m = Model::new();
    m.add_table("Sales", &[("Id", DataType::Int64), ("Amount", DataType::Int64)]).unwrap();
    m.add_table("Calc", &[("Name", DataType::String), ("Ordinal", DataType::Int64)]).unwrap();
    m.add_measure("Sales", "Total", "SUM(Sales[Amount])").unwrap();
    m.add_measure("Sales", "Rows", "COUNTROWS(Sales)").unwrap();
    let table = m.table_id("Calc").unwrap();
    let column = m.column_id(table, "Name").unwrap();
    let item = |n: &str, e: &str| CalcItem { name: n.into(), expression: e.into() };
    m.calc_groups.push(CalcGroup {
        table,
        column,
        items: vec![
            item("Current", "SELECTEDMEASURE()"),
            item("Double", "SELECTEDMEASURE() * 2"),
            item("Name", "SELECTEDMEASURENAME()"),
            item("OnlyTotal", "IF(ISSELECTEDMEASURE([Total]), SELECTEDMEASURE(), BLANK())"),
            item("Over Rows", "DIVIDE(SELECTEDMEASURE(), [Rows])"),
        ],
    });
    let s = |x: &str| Value::str(x);
    let src = MemorySource::new()
        .with_rows("Sales", vec![vec![Value::Int(1), Value::Int(10)], vec![Value::Int(2), Value::Int(30)]])
        .with_rows("Calc", ["Current", "Double", "Name", "OnlyTotal", "Over Rows"].iter().enumerate().map(|(i, n)| vec![s(n), Value::Int(i as i64)]).collect());
    Engine::new(m, &src).unwrap()
}

fn cell(e: &Engine, q: &str) -> Value {
    e.query(q).unwrap_or_else(|x| panic!("{q}: {}", x.message))[0].rows[0][0].clone()
}

#[test]
fn a_selected_calculation_item_replaces_the_measure() {
    let e = engine();
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", [Total])"), Value::Int(40), "nothing selected: the measure itself");
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", CALCULATE([Total], Calc[Name] = \"Double\"))"), Value::Int(80));
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", CALCULATE([Total], Calc[Name] = \"Current\"))"), Value::Int(40));
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", CALCULATE([Rows], Calc[Name] = \"Double\"))"), Value::Int(4));
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", CALCULATE([Total], Calc[Name] = \"Name\"))"), Value::str("Total"));
    // ISSELECTEDMEASURE tells the measures apart
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", CALCULATE([Total], Calc[Name] = \"OnlyTotal\"))"), Value::Int(40));
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", CALCULATE([Rows], Calc[Name] = \"OnlyTotal\"))"), Value::Blank);
    // an item can use other measures, which are evaluated plainly
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", CALCULATE([Total], Calc[Name] = \"Over Rows\"))"), Value::Double(20.0));
    // two items selected: no item applies
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", CALCULATE([Total], Calc[Name] IN {\"Double\", \"Current\"}))"), Value::Int(40));
}

#[test]
fn a_visual_grouped_by_the_calculation_group_shows_every_item() {
    let e = engine();
    let t = &e.query("EVALUATE SUMMARIZECOLUMNS(Calc[Name], \"v\", [Total]) ORDER BY Calc[Name]").unwrap()[0];
    let rows: Vec<(String, String)> = t.rows.iter().map(|r| (r[0].to_text(), r[1].to_text())).collect();
    // the engine orders text without regard to case
    let want = [("Current", "40"), ("Double", "80"), ("Name", "Total"), ("OnlyTotal", "40"), ("Over Rows", "20")];
    assert_eq!(rows, want.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>());
}

#[test]
fn the_functions_need_a_calculation_item() {
    let e = engine();
    assert!(e.query("EVALUATE ROW(\"v\", SELECTEDMEASURE())").unwrap_err().message.contains("calculation item"));
}

#[test]
fn the_model_reads_calculation_groups_from_tmdl() {
    let tmdl = "table Sales\n\tcolumn Amount\n\t\tdataType: int64\n\tmeasure Total = SUM(Sales[Amount])\n\ntable 'Time Calc'\n\tcalculationGroup\n\t\tcalculationItem Double = SELECTEDMEASURE() * 2\n\t\tcalculationItem Plain = SELECTEDMEASURE()\n\tcolumn Period\n\t\tdataType: string\n\t\tsourceColumn: Name\n\tcolumn Ordinal\n\t\tdataType: int64\n\tpartition 'Time Calc' = calculationGroup\n\t\tmode: import\n";
    let doc = biforge_model::tmdl::parse(tmdl).unwrap();
    let m = Model::from_tmdl([&doc]).unwrap();
    assert_eq!(m.calc_groups.len(), 1);
    assert_eq!(m.calc_groups[0].items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["Double", "Plain"]);
    let s = |x: &str| Value::str(x);
    let src = MemorySource::new().with_rows("Sales", vec![vec![Value::Int(5)]]).with_rows("Time Calc", vec![vec![s("Double"), Value::Int(0)], vec![s("Plain"), Value::Int(1)]]);
    let e = Engine::new(m, &src).unwrap();
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", CALCULATE([Total], 'Time Calc'[Period] = \"Double\"))"), Value::Int(10));
}

#[test]
fn nameof_and_the_field_parameter_table() {
    let e = engine();
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", NAMEOF(Sales[Amount]))"), Value::str("'Sales'[Amount]"));
    assert_eq!(cell(&e, "EVALUATE ROW(\"v\", NAMEOF([Total]))"), Value::str("[Total]"));
    // the table BIForge writes for a field parameter
    let t = &e
        .query("EVALUATE SELECTCOLUMNS({(\"Amount\", NAMEOF('Sales'[Amount]), 0), (\"Total\", NAMEOF([Total]), 1)}, \"Pick\", [Value1], \"Pick Fields\", [Value2], \"Pick Order\", [Value3])")
        .unwrap()[0];
    assert_eq!(t.columns, ["[Pick]", "[Pick Fields]", "[Pick Order]"]);
    assert_eq!(t.rows[1].iter().map(|v| v.to_text()).collect::<Vec<_>>(), ["Total", "[Total]", "1"]);
    assert!(e.query("EVALUATE ROW(\"v\", NAMEOF(1))").is_err());
}
