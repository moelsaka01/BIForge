//! One test per semantic rule of the DAX engine, on the hand-computable model in common/mod.rs.
//! Expected values are worked out by hand from the table in common/mod.rs and from Microsoft's public
//! DAX documentation. Rules that the public documentation leaves open are marked "harness": they are
//! our best reading and will be confirmed with recorded cases.

mod common;
use biforge_dax::{ErrorCode, Value};
use common::*;

// ---------------------------------------------------------------------------------------------------
// Filter context and relationship propagation

#[test]
fn aggregation_without_filters_sees_every_row_including_unmatched_keys() {
    let e = engine();
    assert_eq!(ev(&e, "SUM(Sales[Qty])"), i(14));
    assert_eq!(ev(&e, "COUNTROWS(Sales)"), i(7));
    assert_eq!(ev(&e, "[Total Qty]"), i(14));
}

#[test]
fn one_side_filters_flow_to_the_many_side() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Product[Color] = \"Red\")"), i(2));
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Product[Category] = \"Accessories\")"), i(11));
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Customer[Country] = \"US\")"), i(8));
    // filters on different tables combine
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Product[Color] = \"Red\", Customer[Country] = \"FR\")"), i(1));
    // text comparison ignores case
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Product[Color] = \"RED\")"), i(2));
}

#[test]
fn single_direction_does_not_flow_from_many_to_one() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Product), Sales[Qty] > 2)"), i(5));
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Customer), Product[Color] = \"Red\")"), i(3));
}

#[test]
fn unrelated_tables_are_not_filtered() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Dup[A] = \"x\")"), i(14));
}

#[test]
fn bidirectional_relationship_filters_the_one_side_only_when_the_many_side_is_filtered() {
    let e = engine();
    // nothing filters Sales: the unused promotion stays visible
    assert_eq!(ev(&e, "COUNTROWS(Promotion)"), i(3));
    // Sales filtered directly: promotions with matching sales
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Promotion), Sales[Qty] > 2)"), i(1));
    // a filter on another dimension flows Product -> Sales -> Promotion
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Promotion), Product[Color] = \"Red\")"), i(2));
    // a filter on Promotion itself does not loop back through Sales
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Promotion), Promotion[Promo] = \"Unused\")"), i(1));
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Promotion[Promo] = \"Sale\")"), i(3));
}

#[test]
fn many_to_many_filters_by_value() {
    let e = engine();
    assert_eq!(ev(&e, "SUM(Budget[Amount])"), i(1500));
    // red products are in Bikes and Clothing
    assert_eq!(ev(&e, "CALCULATE(SUM(Budget[Amount]), Product[Color] = \"Red\")"), i(1300));
    // single direction: Budget does not filter Product
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Product), Budget[Category] = \"Bikes\")"), i(5));
}

// ---------------------------------------------------------------------------------------------------
// Blank row

#[test]
fn unmatched_keys_add_a_blank_row_to_the_one_side() {
    let e = engine();
    // a table reference, DISTINCT and ALLNOBLANKROW exclude the blank row; VALUES and ALL include it
    assert_eq!(ev(&e, "COUNTROWS(Product)"), i(5));
    assert_eq!(ev(&e, "COUNTROWS(VALUES(Product))"), i(6));
    assert_eq!(ev(&e, "COUNTROWS(ALL(Product))"), i(6));
    assert_eq!(ev(&e, "COUNTROWS(ALLNOBLANKROW(Product))"), i(5));
    assert_eq!(ev(&e, "COUNTROWS(DISTINCT(Product))"), i(5));
    // genuine BLANK (Gloves) and the blank row are one value
    assert_eq!(ev(&e, "COUNTROWS(VALUES(Product[Color]))"), i(4));
    assert_eq!(ev(&e, "COUNTROWS(DISTINCT(Product[Color]))"), i(4));
    assert_eq!(ev(&e, "COUNTROWS(VALUES(Product[Category]))"), i(4));
    assert_eq!(ev(&e, "COUNTROWS(DISTINCT(Product[Category]))"), i(3));
    // Customer has a blank row (customer 9), Promotion has none
    assert_eq!(ev(&e, "COUNTROWS(VALUES(Customer))"), i(4));
    assert_eq!(ev(&e, "COUNTROWS(VALUES(Promotion))"), i(3));
}

#[test]
fn rows_with_unmatched_keys_follow_the_blank_row() {
    let e = engine();
    // the blank row has a BLANK category: excluded by Category = "Bikes", included by Color = BLANK()
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Product[Category] = \"Bikes\")"), i(2));
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Product[Color] = BLANK())"), i(1));
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), ISBLANK(Product[Category]))"), i(1));
    // the blank row disappears when every unmatched fact row is filtered away
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(VALUES(Product)), Product[Color] = \"Red\")"), i(2));
    // iterating the table reference skips the blank row, so its sales are not counted
    assert_eq!(ev(&e, "SUMX(Product, [Total Qty])"), i(13));
    assert_eq!(ev(&e, "SUMX(VALUES(Product), [Total Qty])"), i(14));
}

// ---------------------------------------------------------------------------------------------------
// CALCULATE filter arguments and modifiers

#[test]
fn filter_arguments_override_existing_filters_on_the_same_columns() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), Product[Color] = \"Red\"), Product[Color] = \"Blue\")"), i(2));
    // other columns of the same table keep their filters
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), Product[Color] = \"Red\"), Product[Category] = \"Accessories\")"), Value::Blank);
}

#[test]
fn filter_arguments_on_one_column_intersect() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Product[Color] = \"Red\", Product[Color] = \"Blue\")"), Value::Blank);
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Product[Color] IN {\"Red\", \"Blue\"}, Product[Color] = \"Blue\")"), i(5));
}

#[test]
fn keepfilters_intersects_instead_of_overriding() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), KEEPFILTERS(Product[Color] = \"Red\")), Product[Color] = \"Blue\")"), Value::Blank);
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), KEEPFILTERS(Product[Color] IN {\"Red\", \"Blue\"})), Product[Color] = \"Blue\")"), i(5));
}

#[test]
fn boolean_filters_are_evaluated_in_the_outer_context() {
    let e = engine();
    // MAX(Sales[Qty]) is 4 overall; Sales[Qty] = 4 matches row 5 only
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Sales[Qty] = MAX(Sales[Qty]))"), i(4));
    // inside Color = Red the outer MAX is 1; the new filter replaces only the Qty filter
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), Sales[Qty] = MAX(Sales[Qty])), Product[Color] = \"Red\")"), i(2));
    // a predicate on two columns of one table
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Sales), Sales[Qty] * Sales[Price] >= 100)"), i(2));
}

#[test]
fn boolean_filter_errors() {
    let e = engine();
    assert_eq!(e.eval_scalar("CALCULATE(SUM(Sales[Qty]), Sales[Qty] = Product[ListPrice])").unwrap_err().code, ErrorCode::InvalidParameter);
    assert_eq!(e.eval_scalar("CALCULATE(SUM(Sales[Qty]), 1 = 1)").unwrap_err().code, ErrorCode::InvalidParameter);
}

#[test]
fn all_and_removefilters_remove_filters_from_columns_or_tables() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALL(Product)), Product[Color] = \"Red\")"), i(14));
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), REMOVEFILTERS(Product)), Product[Color] = \"Red\")"), i(14));
    assert_eq!(
        ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALL(Product[Color])), Product[Color] = \"Blue\", Product[Category] = \"Accessories\")"),
        i(11)
    );
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALL()), Product[Color] = \"Red\", Customer[Country] = \"US\")"), i(14));
}

#[test]
fn all_on_a_fact_table_removes_filters_from_its_expanded_table() {
    let e = engine();
    // ALL(Sales) also removes the filters on Product and Customer (they are part of expanded Sales)
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALL(Sales)), Product[Color] = \"Red\", Customer[Country] = \"FR\")"), i(14));
    // ALL(Product) does not touch Customer (FR = rows 2, 4, 7)
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALL(Product)), Product[Color] = \"Red\", Customer[Country] = \"FR\")"), i(4));
}

#[test]
fn allexcept_keeps_only_the_listed_columns() {
    let e = engine();
    assert_eq!(
        ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), ALLEXCEPT(Sales, Product[Category])), Product[Color] = \"Blue\", Product[Category] = \"Accessories\", Customer[Country] = \"US\")"),
        i(11)
    );
}

#[test]
fn table_filters_filter_the_expanded_table() {
    let e = engine();
    // FILTER(ALL(Sales), ...) replaces the Color filter: rows 3 and 5 qualify regardless of color
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), FILTER(ALL(Sales), Sales[Qty] >= 3)), Product[Color] = \"Red\")"), i(7));
    // the boolean form only replaces the Qty filter
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), Sales[Qty] >= 3), Product[Color] = \"Red\")"), Value::Blank);
    // a filter on a dimension table: rows of Product
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), FILTER(Product, Product[ListPrice] > 50))"), i(2));
    // a table variable used as a filter
    assert_eq!(ev(&e, "VAR reds = FILTER(Product, Product[Color] = \"Red\") RETURN CALCULATE(SUM(Sales[Qty]), reds)"), i(2));
    // a fact-table filter overrides dimension filters (harness)
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(COUNTROWS(Product), FILTER(Sales, TRUE())), Product[Color] = \"Red\")"), i(5));
}

#[test]
fn values_and_treatas_as_filters() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), TREATAS({\"Bikes\"}, Product[Category]))"), i(2));
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), TREATAS(VALUES(Budget[Category]), Product[Category]))"), i(13));
    assert_eq!(ev(&e, "CALCULATE(CALCULATE(SUM(Sales[Qty]), VALUES(Product[Color])), Product[Color] = \"Blue\")"), i(5));
    // a constructed table without lineage does not filter anything
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), {1, 2})"), i(14));
}

// ---------------------------------------------------------------------------------------------------
// Row context and context transition

#[test]
fn iterators_create_a_row_context() {
    let e = engine();
    assert_eq!(ev(&e, "SUMX(Sales, Sales[Qty] * Sales[Price])"), f(355.0));
    assert_eq!(ev(&e, "SUM(Sales[Amount])"), f(355.0));
    assert_eq!(ev(&e, "COUNTROWS(FILTER(Sales, Sales[Qty] > 1))"), i(4));
    assert_eq!(ev(&e, "MAXX(Customer, Customer[Name])"), s("Cal"));
    assert_eq!(ev(&e, "AVERAGEX(Product, Product[ListPrice])"), f(39.0));
}

#[test]
fn a_column_outside_any_row_context_is_an_error() {
    let e = engine();
    let err = e.eval_scalar("Sales[Qty]").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidValue);
    assert!(err.message.contains("A single value for column 'Qty'"));
}

#[test]
fn context_transition_turns_the_current_row_into_filters() {
    let e = engine_with(|m| {
        m.add_calculated_column("Product", "SoldQty", "CALCULATE(SUM(Sales[Qty]))").unwrap();
        m.add_calculated_column("Product", "AllQty", "SUM(Sales[Qty])").unwrap();
        m.add_calculated_column("Product", "ViaMeasure", "[Total Qty]").unwrap();
    });
    assert!(e.column_errors.is_empty(), "{:?}", e.column_errors);
    let r = rows(&e, "EVALUATE SELECTCOLUMNS(Product, \"k\", Product[ProductKey], \"s\", Product[SoldQty], \"a\", Product[AllQty], \"m\", Product[ViaMeasure])");
    assert_eq!(
        sorted(r),
        vec![vec![i(1), i(2), i(14), i(2)], vec![i(2), i(6), i(14), i(6)], vec![i(3), i(5), i(14), i(5)], vec![i(4), B, i(14), B], vec![i(5), B, i(14), B]]
    );
}

#[test]
fn a_measure_reference_in_an_iterator_is_an_implicit_calculate() {
    let e = engine();
    // customer 9 does not exist, so its 2 units are not reached from Customer rows: 8 + 4 + blank
    assert_eq!(ev(&e, "SUMX(Customer, [Total Qty])"), i(12));
    assert_eq!(ev(&e, "SUMX(Customer, SUM(Sales[Qty]))"), i(42));
    assert_eq!(ev(&e, "SUMX(Customer, CALCULATE(SUM(Sales[Qty])))"), i(12));
}

#[test]
fn context_transition_selects_duplicate_rows_together() {
    let e = engine();
    // the two identical (x, 1) rows each filter both rows: 2 + 2 + 2
    assert_eq!(ev(&e, "SUMX(Dup, CALCULATE(SUM(Dup[V])))"), i(6));
    assert_eq!(ev(&e, "SUM(Dup[V])"), i(4));
}

#[test]
fn explicit_filters_override_the_transition_filters() {
    let e = engine();
    // within each product row, Product[Color] = "Red" replaces the row's color filter but the row's other
    // columns (ProductKey ...) still filter
    assert_eq!(ev(&e, "SUMX(Product, CALCULATE(SUM(Sales[Qty]), Product[Color] = \"Red\"))"), i(2));
    // ALL(Product) inside the iteration removes the transition filter
    assert_eq!(ev(&e, "SUMX(Product, CALCULATE(SUM(Sales[Qty]), ALL(Product)))"), i(70));
}

#[test]
fn nested_row_contexts_and_earlier() {
    let e = engine_with(|m| {
        m.add_calculated_column("Sales", "QtyRank", "COUNTROWS(FILTER(Sales, Sales[Qty] > EARLIER(Sales[Qty]))) + 1").unwrap();
    });
    assert!(e.column_errors.is_empty(), "{:?}", e.column_errors);
    let r = rows(&e, "EVALUATE SELECTCOLUMNS(Sales, \"k\", Sales[SalesKey], \"r\", Sales[QtyRank])");
    assert_eq!(sorted(r).into_iter().map(|r| r[1].clone()).collect::<Vec<_>>(), vec![i(5), i(3), i(2), i(5), i(1), i(3), i(5)]);
    // EARLIEST is the outermost row context
    assert_eq!(ev(&e, "SUMX(FILTER(Sales, Sales[SalesKey] = 3), SUMX(FILTER(Sales, Sales[SalesKey] = 5), EARLIEST(Sales[Qty])))"), i(3));
    assert_eq!(e.eval_scalar("EARLIER(Sales[Qty])").unwrap_err().code, ErrorCode::InvalidValue);
}

#[test]
fn row_context_survives_inside_calculate() {
    let e = engine();
    assert_eq!(ev(&e, "SUMX(Sales, CALCULATE(Sales[Qty] * 2))"), i(28));
}

// ---------------------------------------------------------------------------------------------------
// RELATED / RELATEDTABLE / USERELATIONSHIP / CROSSFILTER

#[test]
fn related_follows_many_to_one_from_the_row_context() {
    let e = engine();
    assert_eq!(ev(&e, "COUNTROWS(FILTER(Sales, RELATED(Product[Color]) = \"Red\"))"), i(2));
    // row 7 has no product: BLANK * 1 is BLANK and SUMX skips it
    assert_eq!(ev(&e, "SUMX(Sales, Sales[Qty] * RELATED(Product[ListPrice]))"), f(285.0));
    // an unmatched key relates to the blank row
    assert_eq!(ev(&e, "COUNTROWS(FILTER(Sales, ISBLANK(RELATED(Product[Category]))))"), i(1));
    assert_eq!(ev(&e, "COUNTROWS(FILTER(Sales, ISBLANK(RELATED(Customer[Country]))))"), i(1));
    assert_eq!(e.eval_scalar("RELATED(Product[Color])").unwrap_err().code, ErrorCode::InvalidValue);
}

#[test]
fn relatedtable_filters_the_many_side_by_the_current_row() {
    let e = engine_with(|m| {
        m.add_calculated_column("Product", "NSales", "COUNTROWS(RELATEDTABLE(Sales))").unwrap();
    });
    let r = rows(&e, "EVALUATE SELECTCOLUMNS(Product, \"k\", Product[ProductKey], \"n\", Product[NSales])");
    assert_eq!(sorted(r).into_iter().map(|r| r[1].clone()).collect::<Vec<_>>(), vec![i(2), i(2), i(2), B, B]);
    assert_eq!(ev(&e, "SUMX(Customer, COUNTROWS(RELATEDTABLE(Sales)))"), i(6));
}

#[test]
fn userelationship_activates_an_inactive_relationship() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), 'Date'[Year] = 2024)"), i(8));
    // by ship date: rows 3, 4, 6, 7 (row 5 has no ship date)
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), 'Date'[Year] = 2024, USERELATIONSHIP(Sales[ShipDate], 'Date'[Date]))"), i(7));
    // argument order does not matter
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), 'Date'[Year] = 2024, USERELATIONSHIP('Date'[Date], Sales[ShipDate]))"), i(7));
    // RELATED follows the activated relationship
    assert_eq!(ev(&e, "CALCULATE(SUMX(Sales, RELATED('Date'[Year])), USERELATIONSHIP(Sales[ShipDate], 'Date'[Date]))"), i(2023 * 2 + 2024 * 4));
    // the inactive relationship stays inactive elsewhere
    assert_eq!(ev(&e, "SUMX(Sales, RELATED('Date'[Year]))"), i(2023 * 3 + 2024 * 4));
}

#[test]
fn crossfilter_changes_or_disables_a_relationship() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Promotion), Sales[Qty] > 2, CROSSFILTER(Sales[PromotionKey], Promotion[PromotionKey], NONE))"), i(3));
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Product), Sales[Qty] > 2, CROSSFILTER(Sales[ProductKey], Product[ProductKey], BOTH))"), i(2));
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Product[Color] = \"Red\", CROSSFILTER(Sales[ProductKey], Product[ProductKey], NONE))"), i(14));
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Promotion), Sales[Qty] > 2, CROSSFILTER(Sales[PromotionKey], Promotion[PromotionKey], ONEWAY))"), i(3));
}

// ---------------------------------------------------------------------------------------------------
// Blank semantics through the engine

#[test]
fn blank_semantics() {
    let e = engine();
    assert_eq!(ev(&e, "BLANK() + 1"), i(1));
    assert_eq!(ev(&e, "BLANK() * 1"), B);
    assert_eq!(ev(&e, "BLANK() = 0"), Value::Bool(true));
    assert_eq!(ev(&e, "BLANK() == 0"), Value::Bool(false));
    assert_eq!(ev(&e, "BLANK() = \"\""), Value::Bool(true));
    assert_eq!(ev(&e, "BLANK() IN {0}"), Value::Bool(false));
    assert_eq!(ev(&e, "0 IN {0, 1}"), Value::Bool(true));
    assert_eq!(ev(&e, "ISBLANK(CALCULATE(SUM(Sales[Qty]), Product[Color] = \"Green\"))"), Value::Bool(true));
    assert_eq!(ev(&e, "CALCULATE(COUNTROWS(Sales), Product[Color] = \"Green\")"), B);
    assert_eq!(ev(&e, "DIVIDE(1, 0)"), B);
    assert_eq!(ev(&e, "DIVIDE(1, 0, -1)"), i(-1));
    assert_eq!(ev(&e, "1 / 0"), f(f64::INFINITY));
    assert_eq!(ev(&e, "IF(BLANK(), 1, 2)"), i(2));
    assert_eq!(ev(&e, "IF(FALSE(), 1)"), B);
    assert_eq!(ev(&e, "COALESCE(BLANK(), BLANK(), 3)"), i(3));
    assert_eq!(ev(&e, "BLANK() & BLANK()"), B);
    assert_eq!(ev(&e, "CALCULATE(SUM(Sales[Qty]), Sales[Qty] = BLANK())"), B);
    // COUNT skips BLANK ship dates; COUNTBLANK counts them
    assert_eq!(ev(&e, "COUNT(Sales[ShipDate])"), i(6));
    assert_eq!(ev(&e, "COUNTBLANK(Sales[ShipDate])"), i(1));
}

// ---------------------------------------------------------------------------------------------------
// VAR / RETURN

#[test]
fn variables_are_evaluated_where_they_are_defined() {
    let e = engine();
    assert_eq!(ev(&e, "VAR t = SUM(Sales[Qty]) RETURN CALCULATE(t, Product[Color] = \"Red\")"), i(14));
    assert_eq!(ev(&e, "CALCULATE(VAR t = SUM(Sales[Qty]) RETURN t, Product[Color] = \"Red\")"), i(2));
    assert_eq!(ev(&e, "VAR a = 2 VAR b = a * 3 RETURN a + b"), i(8));
    // a variable inside an iterator captures the row context of its definition
    assert_eq!(ev(&e, "SUMX(Sales, VAR q = Sales[Qty] RETURN q * q)"), i(36));
    // variables are lazy: an unused failing variable is not an error
    assert_eq!(ev(&e, "VAR bad = Sales[Qty] RETURN 1"), i(1));
    // shadowing
    assert_eq!(ev(&e, "VAR x = 1 RETURN VAR x = 2 RETURN x"), i(2));
}

#[test]
fn variables_can_hold_tables() {
    let e = engine();
    assert_eq!(ev(&e, "VAR t = FILTER(Sales, Sales[Qty] > 1) RETURN COUNTROWS(t)"), i(4));
    assert_eq!(ev(&e, "VAR t = VALUES(Product[Color]) RETURN CALCULATE(SUM(Sales[Qty]), t, Product[Color] = \"Red\")"), i(2));
}

// ---------------------------------------------------------------------------------------------------
// Measures and calculated columns

#[test]
fn measures_reference_measures_and_keep_their_own_filters() {
    let e = engine();
    assert_eq!(e.eval_measure("Red Qty").unwrap(), i(2));
    assert_eq!(ev(&e, "CALCULATE([Red Qty], Product[Color] = \"Blue\")"), i(2));
    assert_eq!(ev(&e, "CALCULATE([Red Qty], Customer[Country] = \"FR\")"), i(1));
    assert_eq!(ev(&e, "[Total Amount]"), f(355.0));
}

#[test]
fn measure_errors() {
    let e = engine_with(|m| {
        m.add_measure("Sales", "Loop A", "[Loop B] + 1").unwrap();
        m.add_measure("Sales", "Loop B", "[Loop A] + 1").unwrap();
        m.add_measure("Sales", "Naked", "Sales[Qty]").unwrap();
        m.add_measure("Sales", "Broken", "SUM(Sales[Qty]").unwrap();
    });
    assert_eq!(e.eval_measure("Loop A").unwrap_err().code, ErrorCode::CircularDependency);
    assert_eq!(e.eval_measure("Naked").unwrap_err().code, ErrorCode::InvalidValue);
    assert_eq!(e.eval_measure("Broken").unwrap_err().code, ErrorCode::GrammaticalError);
    // a measure body does not see the caller's row context
    assert_eq!(e.eval_scalar("SUMX(Sales, [Naked])").unwrap_err().code, ErrorCode::InvalidValue);
}

#[test]
fn calculated_columns_follow_dependencies_and_report_cycles() {
    let e = engine_with(|m| {
        // declared before the column it depends on
        m.add_calculated_column("Sales", "Twice", "Sales[Amount2] * 2").unwrap();
        m.add_calculated_column("Sales", "Amount2", "[Amount]").unwrap();
        m.add_calculated_column("Product", "C1", "Product[C2] + 1").unwrap();
        m.add_calculated_column("Product", "C2", "Product[C1] + 1").unwrap();
        m.add_calculated_column("Product", "Bad", "Product[Nope]").unwrap();
    });
    assert_eq!(ev(&e, "SUM(Sales[Twice])"), f(710.0));
    let errs: Vec<&str> = e.column_errors.iter().map(|(_, c, _)| c.as_str()).collect();
    assert!(errs.contains(&"C1") && errs.contains(&"C2") && errs.contains(&"Bad"), "{errs:?}");
    assert!(e.column_errors.iter().any(|(_, _, m)| m.contains("circular dependency")));
}

// ---------------------------------------------------------------------------------------------------
// Information functions over the filter context

#[test]
fn isfiltered_iscrossfiltered_hasonevalue_selectedvalue() {
    let e = engine();
    assert_eq!(ev(&e, "CALCULATE(ISFILTERED(Product[Color]), Product[Color] = \"Red\")"), Value::Bool(true));
    assert_eq!(ev(&e, "CALCULATE(ISFILTERED(Product[Category]), Product[Color] = \"Red\")"), Value::Bool(false));
    assert_eq!(ev(&e, "CALCULATE(ISFILTERED(Product), Product[Color] = \"Red\")"), Value::Bool(true));
    assert_eq!(ev(&e, "CALCULATE(ISCROSSFILTERED(Sales), Product[Color] = \"Red\")"), Value::Bool(true));
    assert_eq!(ev(&e, "CALCULATE(ISCROSSFILTERED(Customer), Product[Color] = \"Red\")"), Value::Bool(false));
    assert_eq!(ev(&e, "ISCROSSFILTERED(Sales)"), Value::Bool(false));
    assert_eq!(ev(&e, "CALCULATE(HASONEVALUE(Product[Category]), Product[Color] = \"Blue\")"), Value::Bool(true));
    assert_eq!(ev(&e, "HASONEVALUE(Product[Category])"), Value::Bool(false));
    assert_eq!(ev(&e, "CALCULATE(SELECTEDVALUE(Product[Category]), Product[Color] = \"Blue\")"), s("Accessories"));
    assert_eq!(ev(&e, "SELECTEDVALUE(Product[Category], \"many\")"), s("many"));
}

// ---------------------------------------------------------------------------------------------------
// Queries

#[test]
fn summarizecolumns_groups_and_drops_blank_rows() {
    let e = engine();
    let r = rows(&e, "EVALUATE SUMMARIZECOLUMNS(Product[Color], \"Q\", [Total Qty])");
    // the blank row (unmatched product) and Gloves share the BLANK color
    assert_eq!(sorted(r), vec![vec![B, i(1)], vec![s("Black"), i(6)], vec![s("Blue"), i(5)], vec![s("Red"), i(2)]]);
    let r = rows(&e, "EVALUATE SUMMARIZECOLUMNS(Product[Category], Customer[Country], \"Q\", [Total Qty])");
    assert_eq!(
        sorted(r),
        vec![
            vec![B, s("FR"), i(1)],
            vec![s("Accessories"), B, i(2)],
            vec![s("Accessories"), s("FR"), i(2)],
            vec![s("Accessories"), s("US"), i(7)],
            vec![s("Bikes"), s("FR"), i(1)],
            vec![s("Bikes"), s("US"), i(1)],
        ]
    );
    // a filter table argument
    let r = rows(&e, "EVALUATE SUMMARIZECOLUMNS(Customer[Country], TREATAS({\"Red\"}, Product[Color]), \"Q\", [Total Qty])");
    assert_eq!(sorted(r), vec![vec![s("FR"), i(1)], vec![s("US"), i(1)]]);
}

#[test]
fn query_define_order_by_and_start_at() {
    let e = engine();
    let r = e
        .query(
            "DEFINE MEASURE Sales[Q2] = [Total Qty] * 2
                    VAR minQ = 3
             EVALUATE FILTER(SUMMARIZECOLUMNS(Product[Color], \"Q\", [Q2]), [Q] >= minQ)
             ORDER BY [Q] DESC
             EVALUATE ADDCOLUMNS(VALUES(Customer[Country]), \"Q\", [Total Qty])
             ORDER BY Customer[Country]
             START AT \"FR\"",
        )
        .unwrap();
    assert_eq!(r[0].columns, vec!["Product[Color]", "[Q]"]);
    assert_eq!(r[0].rows, vec![vec![s("Black"), i(12)], vec![s("Blue"), i(10)], vec![s("Red"), i(4)]]);
    assert_eq!(r[1].columns, vec!["Customer[Country]", "[Q]"]);
    assert_eq!(r[1].rows, vec![vec![s("FR"), i(4)], vec![s("US"), i(8)]]);
    assert_eq!(e.query("EVALUATE 1").unwrap_err().code, ErrorCode::InvalidParameter);
}

#[test]
fn query_measures_override_model_measures() {
    let e = engine();
    let r = rows(&e, "DEFINE MEASURE Sales[Total Qty] = 42 EVALUATE ROW(\"x\", [Total Qty], \"y\", [Red Qty])");
    // [Red Qty] refers to the model's [Total Qty]
    assert_eq!(r, vec![vec![i(42), i(2)]]);
}

#[test]
fn unknown_names_and_unimplemented_functions_are_reported() {
    let e = engine();
    assert_eq!(e.eval_scalar("SUM(Sales[Nope])").unwrap_err().code, ErrorCode::UnrecognizedIdentifier);
    assert_eq!(e.eval_scalar("SUM(Nope[Qty])").unwrap_err().code, ErrorCode::UnrecognizedIdentifier);
    assert_eq!(e.eval_scalar("FOO(1)").unwrap_err().code, ErrorCode::UnrecognizedIdentifier);
    assert_eq!(e.eval_scalar("[No Measure]").unwrap_err().code, ErrorCode::UnrecognizedIdentifier);
    let err = e.eval_scalar("XIRR(Sales, Sales[Qty], Sales[OrderDate])").unwrap_err();
    assert_eq!(err.code, ErrorCode::NotImplemented);
    assert!(err.message.contains("XIRR"));
    assert_eq!(e.eval_scalar("SUM(1)").unwrap_err().code, ErrorCode::InvalidParameter);
}
