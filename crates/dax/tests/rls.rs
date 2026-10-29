use biforge_dax::security::{Role, TableFilter};
use biforge_dax::value::Value;
use biforge_dax::{CrossFilter, DataType, Engine, MemorySource, Model};

fn model() -> (Model, MemorySource) {
    let mut m = Model::new();
    m.add_table("Region", &[("Id", DataType::Int64), ("Name", DataType::String), ("Manager", DataType::String)]).unwrap();
    m.add_table("Sales", &[("Id", DataType::Int64), ("RegionId", DataType::Int64), ("Qty", DataType::Int64)]).unwrap();
    m.add_relationship(("Sales", "RegionId"), ("Region", "Id"), CrossFilter::Single, true).unwrap();
    m.add_measure("Sales", "Total", "SUM(Sales[Qty])").unwrap();
    m.add_measure("Sales", "Me", "USERPRINCIPALNAME()").unwrap();
    let s = |x: &str| Value::str(x);
    let src = MemorySource::new()
        .with_rows("Region", vec![vec![Value::Int(1), s("East"), s("ann@x.com")], vec![Value::Int(2), s("West"), s("bob@x.com")], vec![Value::Int(3), s("North"), s("ann@x.com")]])
        .with_rows(
            "Sales",
            vec![vec![Value::Int(1), Value::Int(1), Value::Int(10)], vec![Value::Int(2), Value::Int(2), Value::Int(20)], vec![Value::Int(3), Value::Int(3), Value::Int(30)], vec![Value::Int(4), Value::Int(9), Value::Int(1000)]],
        );
    (m, src)
}

fn role(name: &str, table: &str, expr: &str) -> Role {
    Role { name: name.into(), filters: vec![TableFilter { table: table.into(), expression: expr.into() }] }
}

fn total(m: &Model, src: &MemorySource, roles: &[&Role], who: &str) -> Value {
    let e = Engine::new_secured(m.clone(), src, roles, who).unwrap();
    e.eval_measure("Total").unwrap()
}

#[test]
fn a_filter_on_the_one_side_limits_the_many_side_per_user() {
    let (m, src) = model();
    let r = role("Managers", "Region", "[Manager] = USERPRINCIPALNAME()");
    assert_eq!(total(&m, &src, &[], "anyone"), Value::Int(1060)); // no roles: everything, also the row with no region
    assert_eq!(total(&m, &src, &[&r], "ann@x.com"), Value::Int(40)); // East + North
    assert_eq!(total(&m, &src, &[&r], "bob@x.com"), Value::Int(20));
    // nobody matches: nothing is shown, the unmatched fact row (blank member) stays hidden too
    assert_eq!(total(&m, &src, &[&r], "eve@x.com"), Value::Blank);
}

#[test]
fn dax_cannot_get_around_the_filter() {
    let (m, src) = model();
    let r = role("Managers", "Region", "[Manager] = USERPRINCIPALNAME()");
    let e = Engine::new_secured(m, &src, &[&r], "bob@x.com").unwrap();
    let t = e.query("EVALUATE ROW(\"v\", CALCULATE(SUM(Sales[Qty]), ALL(Region), REMOVEFILTERS(Sales)), \"n\", COUNTROWS(ALL(Region)))").unwrap();
    assert_eq!(t[0].rows[0], vec![Value::Int(20), Value::Int(1)]);
    assert_eq!(e.eval_measure("Me").unwrap(), Value::str("bob@x.com"));
}

#[test]
fn roles_add_up_and_a_role_without_a_filter_shows_all() {
    let (m, src) = model();
    let a = role("EastOnly", "Region", "[Name] = \"East\"");
    let b = role("WestOnly", "Region", "[Name] = \"West\"");
    assert_eq!(total(&m, &src, &[&a, &b], "u"), Value::Int(30));
    let other = role("OnlyFacts", "Sales", "[Qty] < 25");
    // each role lacks a filter on the other table, so both tables show all rows; only the row with no region (1000) goes
    assert_eq!(total(&m, &src, &[&a, &other], "u"), Value::Int(60));
}

#[test]
fn a_filter_that_errors_fails_the_request() {
    let (m, src) = model();
    let bad = role("Bad", "Region", "[Nope] = 1");
    assert!(Engine::new_secured(m, &src, &[&bad], "u").is_err());
}

#[test]
fn a_security_filter_on_the_many_side_reaches_the_one_side_only_when_the_relationship_applies_it_both_ways() {
    let (mut m, src) = model();
    let small = role("Small", "Sales", "[Qty] < 25");
    let regions = |m: &Model| {
        let e = Engine::new_secured(m.clone(), &src, &[&small], "u").unwrap();
        e.eval_scalar("COUNTROWS(Region)").unwrap()
    };
    // by default a filter flows downhill only: every region stays, also North, whose only sale (30) is hidden
    assert_eq!(regions(&m), Value::Int(3));
    // both directions needs the cross-filter direction Both too
    m.relationships[0].security_both = true;
    assert_eq!(regions(&m), Value::Int(3));
    m.relationships[0].cross_filter = CrossFilter::Both;
    assert_eq!(regions(&m), Value::Int(2)); // East and West
    // the sales that remain are the same either way
    let e = Engine::new_secured(m.clone(), &src, &[&small], "u").unwrap();
    assert_eq!(e.eval_measure("Total").unwrap(), Value::Int(30));
}

#[test]
fn username_and_userprincipalname_return_the_identity_of_the_viewer() {
    let (mut m, src) = model();
    m.add_measure("Sales", "Who", "USERNAME()").unwrap();
    let e = Engine::new_secured(m, &src, &[], "ann@x.com").unwrap();
    assert_eq!(e.eval_measure("Who").unwrap(), Value::str("ann@x.com"));
    assert_eq!(e.eval_measure("Me").unwrap(), Value::str("ann@x.com"));
}
