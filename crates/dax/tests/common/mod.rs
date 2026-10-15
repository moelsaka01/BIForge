//! Small hand-computable model shared by the semantic tests.
//!
//! Sales (Amount = Qty * Price is a calculated column):
//! | Key | OrderDate  | ShipDate   | Cust | Prod | Promo | Qty | Price |
//! | 1   | 2023-01-01 | 2023-02-01 | 1    | 1    | 1     | 1   | 100   |
//! | 2   | 2023-01-01 | 2023-01-01 | 2    | 2    | 2     | 2   | 10    |
//! | 3   | 2023-02-01 | 2024-01-01 | 1    | 3    | 1     | 3   | 5     |
//! | 4   | 2024-01-01 | 2024-01-01 | 2    | 1    | 2     | 1   | 120   |
//! | 5   | 2024-02-01 | (blank)    | 1    | 2    | 1     | 4   | 10    |
//! | 6   | 2024-02-01 | 2024-02-01 | 9 *  | 3    | 1     | 2   | 5     |
//! | 7   | 2024-01-01 | 2024-02-01 | 2    | - *  | 1     | 1   | 50    |
//! (* = no match on the one side: customer 9 does not exist, product is blank)
//!
//! Product: 1 Bike Red Bikes 100 | 2 Helmet Black Accessories 10 | 3 Bottle Blue Accessories 5 |
//!          4 Jersey Red Clothing 60 (never sold) | 5 Gloves (blank color) Clothing 20 (never sold)
//! Customer: 1 Ann US | 2 Bob FR | 3 Cal US (never buys)
//! Date: 2023-01-01, 2023-02-01, 2024-01-01, 2024-02-01 with Year and Month
//! Promotion (BOTH directions): 1 None | 2 Sale | 3 Unused
//! Budget (many-to-many on Category, Product filters Budget): Bikes 1000 | Accessories 200 | Clothing 300
//! Dup (no relationships): (x,1) (x,1) (y,2): duplicate rows for context transition
#![allow(dead_code)]

use biforge_dax::value::{date_serial, Value};
use biforge_dax::{Cardinality, CrossFilter, DataType, Engine, MemorySource, Model};

pub fn d(y: i32, m: u32, day: u32) -> Value {
    Value::DateTime(date_serial(y, m, day).unwrap())
}
pub fn s(x: &str) -> Value {
    Value::str(x)
}
pub fn i(x: i64) -> Value {
    Value::Int(x)
}
pub fn f(x: f64) -> Value {
    Value::Double(x)
}
pub const B: Value = Value::Blank;

pub fn model() -> Model {
    use DataType::*;
    let mut m = Model::new();
    m.add_table(
        "Sales",
        &[("SalesKey", Int64), ("OrderDate", DateTime), ("ShipDate", DateTime), ("CustomerKey", Int64), ("ProductKey", Int64), ("PromotionKey", Int64), ("Qty", Int64), ("Price", Double)],
    )
    .unwrap();
    m.add_table("Product", &[("ProductKey", Int64), ("Name", String), ("Color", String), ("Category", String), ("ListPrice", Double)]).unwrap();
    m.add_table("Customer", &[("CustomerKey", Int64), ("Name", String), ("Country", String)]).unwrap();
    m.add_table("Date", &[("Date", DateTime), ("Year", Int64), ("Month", Int64)]).unwrap();
    m.add_table("Promotion", &[("PromotionKey", Int64), ("Promo", String)]).unwrap();
    m.add_table("Budget", &[("Category", String), ("Amount", Int64)]).unwrap();
    m.add_table("Dup", &[("A", String), ("V", Int64)]).unwrap();
    m.add_calculated_column("Sales", "Amount", "Sales[Qty] * Sales[Price]").unwrap();
    m.add_relationship(("Sales", "OrderDate"), ("Date", "Date"), CrossFilter::Single, true).unwrap();
    m.add_relationship(("Sales", "ShipDate"), ("Date", "Date"), CrossFilter::Single, false).unwrap();
    m.add_relationship(("Sales", "CustomerKey"), ("Customer", "CustomerKey"), CrossFilter::Single, true).unwrap();
    m.add_relationship(("Sales", "ProductKey"), ("Product", "ProductKey"), CrossFilter::Single, true).unwrap();
    m.add_relationship(("Sales", "PromotionKey"), ("Promotion", "PromotionKey"), CrossFilter::Both, true).unwrap();
    m.add_relationship_ex(("Budget", "Category"), ("Product", "Category"), Cardinality::ManyToMany, CrossFilter::Single, true).unwrap();
    m.add_measure("Sales", "Total Qty", "SUM(Sales[Qty])").unwrap();
    m.add_measure("Sales", "Total Amount", "SUM(Sales[Amount])").unwrap();
    m.add_measure("Sales", "Red Qty", "CALCULATE([Total Qty], Product[Color] = \"Red\")").unwrap();
    m
}

pub fn source() -> MemorySource {
    MemorySource::new()
        .with_rows(
            "Sales",
            vec![
                vec![i(1), d(2023, 1, 1), d(2023, 2, 1), i(1), i(1), i(1), i(1), f(100.0)],
                vec![i(2), d(2023, 1, 1), d(2023, 1, 1), i(2), i(2), i(2), i(2), f(10.0)],
                vec![i(3), d(2023, 2, 1), d(2024, 1, 1), i(1), i(3), i(1), i(3), f(5.0)],
                vec![i(4), d(2024, 1, 1), d(2024, 1, 1), i(2), i(1), i(2), i(1), f(120.0)],
                vec![i(5), d(2024, 2, 1), B, i(1), i(2), i(1), i(4), f(10.0)],
                vec![i(6), d(2024, 2, 1), d(2024, 2, 1), i(9), i(3), i(1), i(2), f(5.0)],
                vec![i(7), d(2024, 1, 1), d(2024, 2, 1), i(2), B, i(1), i(1), f(50.0)],
            ],
        )
        .with_rows(
            "Product",
            vec![
                vec![i(1), s("Bike"), s("Red"), s("Bikes"), f(100.0)],
                vec![i(2), s("Helmet"), s("Black"), s("Accessories"), f(10.0)],
                vec![i(3), s("Bottle"), s("Blue"), s("Accessories"), f(5.0)],
                vec![i(4), s("Jersey"), s("Red"), s("Clothing"), f(60.0)],
                vec![i(5), s("Gloves"), B, s("Clothing"), f(20.0)],
            ],
        )
        .with_rows("Customer", vec![vec![i(1), s("Ann"), s("US")], vec![i(2), s("Bob"), s("FR")], vec![i(3), s("Cal"), s("US")]])
        .with_rows(
            "Date",
            vec![vec![d(2023, 1, 1), i(2023), i(1)], vec![d(2023, 2, 1), i(2023), i(2)], vec![d(2024, 1, 1), i(2024), i(1)], vec![d(2024, 2, 1), i(2024), i(2)]],
        )
        .with_rows("Promotion", vec![vec![i(1), s("None")], vec![i(2), s("Sale")], vec![i(3), s("Unused")]])
        .with_rows("Budget", vec![vec![s("Bikes"), i(1000)], vec![s("Accessories"), i(200)], vec![s("Clothing"), i(300)]])
        .with_rows("Dup", vec![vec![s("x"), i(1)], vec![s("x"), i(1)], vec![s("y"), i(2)]])
}

pub fn engine() -> Engine {
    let e = Engine::new(model(), &source()).unwrap();
    assert!(e.column_errors.is_empty(), "{:?}", e.column_errors);
    e
}

pub fn engine_with(f: impl FnOnce(&mut Model)) -> Engine {
    let mut m = model();
    f(&mut m);
    Engine::new(m, &source()).unwrap()
}

/// Evaluates a scalar expression; panics with the error message on failure.
pub fn ev(e: &Engine, src: &str) -> Value {
    e.eval_scalar(src).unwrap_or_else(|err| panic!("{src}\n  -> {:?}: {}", err.code, err.message))
}

pub fn rows(e: &Engine, q: &str) -> Vec<Vec<Value>> {
    let r = e.query(q).unwrap_or_else(|err| panic!("{q}\n  -> {:?}: {}", err.code, err.message));
    r.into_iter().next().unwrap().rows
}

/// Rows sorted with the DAX result order, for order-independent comparison.
pub fn sorted(mut v: Vec<Vec<Value>>) -> Vec<Vec<Value>> {
    v.sort_by(|a, b| {
        for (x, y) in a.iter().zip(b) {
            let o = biforge_dax::value::sort_cmp(x, y);
            if o != std::cmp::Ordering::Equal {
                return o;
            }
        }
        std::cmp::Ordering::Equal
    });
    v
}
