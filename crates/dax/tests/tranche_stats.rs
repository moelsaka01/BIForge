//! Statistical function tranche. Aggregates are hand-computed on Sales[Qty] = 1,2,3,1,4,2,1 (sum 14, mean 2,
//! squared deviations 8) and Product[ListPrice] = 100,10,5,60,20 (mean 39, squared deviations 6520); distribution
//! values are the standard published table values.

mod common;
use biforge_dax::Value;
use common::*;

fn near(e: &biforge_dax::Engine, src: &str, want: f64) {
    near_tol(e, src, want, 1e-9)
}

fn near_tol(e: &biforge_dax::Engine, src: &str, want: f64, tol: f64) {
    match ev(e, src) {
        Value::Double(x) => assert!((x - want).abs() <= tol * want.abs().max(1.0), "{src}: {x} vs {want}"),
        other => panic!("{src}: expected a number, got {other:?}"),
    }
}

fn fails(e: &biforge_dax::Engine, src: &str) {
    assert!(e.eval_scalar(src).is_err(), "{src} should fail");
}

#[test]
fn column_aggregates() {
    let e = engine();
    assert_eq!(ev(&e, "MEDIAN(Sales[Qty])"), f(2.0));
    near(&e, "GEOMEAN(Sales[Qty])", 48f64.powf(1.0 / 7.0));
    near(&e, "VAR.P(Sales[Qty])", 8.0 / 7.0);
    near(&e, "VAR.S(Sales[Qty])", 8.0 / 6.0);
    near(&e, "STDEV.P(Sales[Qty])", (8.0f64 / 7.0).sqrt());
    near(&e, "STDEV.S(Sales[Qty])", (8.0f64 / 6.0).sqrt());
    assert_eq!(ev(&e, "MEDIAN(Product[ListPrice])"), f(20.0));
    // filters apply; nothing left gives BLANK
    assert_eq!(ev(&e, "CALCULATE(MEDIAN(Sales[Qty]), Product[Color] = \"Red\")"), f(1.0));
    assert_eq!(ev(&e, "CALCULATE(MEDIAN(Sales[Qty]), Product[Color] = \"Purple\")"), B);
    // a sample statistic over one value is NaN, over no value BLANK (recorded from Power BI)
    assert!(matches!(ev(&e, "CALCULATE(VAR.S(Sales[Qty]), Sales[SalesKey] = 1)"), Value::Double(x) if x.is_nan()));
    assert_eq!(ev(&e, "CALCULATE(VAR.S(Sales[Qty]), Product[Color] = \"Purple\")"), B);
    assert_eq!(ev(&e, "CALCULATE(VAR.P(Sales[Qty]), Sales[SalesKey] = 1)"), f(0.0));
    fails(&e, "GEOMEAN(Product[ListPrice] - 100)");
}

#[test]
fn percentiles() {
    let e = engine();
    assert_eq!(ev(&e, "PERCENTILE.INC(Sales[Qty], 0.5)"), f(2.0));
    assert_eq!(ev(&e, "PERCENTILE.INC(Sales[Qty], 0.25)"), f(1.0));
    near(&e, "PERCENTILE.INC(Sales[Qty], 0.9)", 3.4);
    assert_eq!(ev(&e, "PERCENTILE.INC(Sales[Qty], 0)"), f(1.0));
    assert_eq!(ev(&e, "PERCENTILE.INC(Sales[Qty], 1)"), f(4.0));
    assert_eq!(ev(&e, "PERCENTILE.EXC(Sales[Qty], 0.5)"), f(2.0));
    assert_eq!(ev(&e, "PERCENTILE.EXC(Sales[Qty], 0.25)"), f(1.0));
    fails(&e, "PERCENTILE.EXC(Sales[Qty], 0.9)");
    fails(&e, "PERCENTILE.INC(Sales[Qty], 1.5)");
}

#[test]
fn x_aggregates_evaluate_per_row() {
    let e = engine();
    assert_eq!(ev(&e, "MEDIANX(Product, Product[ListPrice])"), f(20.0));
    near(&e, "VARX.S(Product, Product[ListPrice])", 1630.0);
    near(&e, "VARX.P(Product, Product[ListPrice])", 1304.0);
    near(&e, "STDEVX.P(Product, Product[ListPrice])", 1304f64.sqrt());
    near(&e, "STDEVX.S(Product, Product[ListPrice])", 1630f64.sqrt());
    near(&e, "GEOMEANX(Product, Product[ListPrice])", 6_000_000f64.powf(0.2));
    assert_eq!(ev(&e, "PERCENTILEX.INC(Product, Product[ListPrice], 0.5)"), f(20.0));
    assert_eq!(ev(&e, "PERCENTILEX.EXC(Product, Product[ListPrice], 0.5)"), f(20.0));
    // an expression with a measure transition
    near(&e, "MEDIANX(VALUES(Product[Category]), CALCULATE(SUM(Sales[Qty])))", 2.0);
}

#[test]
fn rankx_and_rank_eq() {
    let e = engine();
    let r = sorted(rows(&e, "EVALUATE ADDCOLUMNS(VALUES(Product[Category]), \"r\", RANKX(ALL(Product[Category]), CALCULATE(SUM(Sales[Qty]))))"));
    assert_eq!(r, vec![vec![B, i(3)], vec![s("Accessories"), i(1)], vec![s("Bikes"), i(2)], vec![s("Clothing"), i(4)]]);
    let r = sorted(rows(&e, "EVALUATE ADDCOLUMNS(VALUES(Product[Category]), \"r\", RANKX(ALL(Product[Category]), CALCULATE(SUM(Sales[Qty])), , ASC))"));
    assert_eq!(r, vec![vec![B, i(1)], vec![s("Accessories"), i(3)], vec![s("Bikes"), i(2)], vec![s("Clothing"), i(1)]]);
    assert_eq!(ev(&e, "RANKX({1, 2, 2, 3}, [Value], 3)"), i(1));
    assert_eq!(ev(&e, "RANKX({1, 2, 2, 3}, [Value], 2)"), i(2));
    assert_eq!(ev(&e, "RANKX({1, 2, 2, 3}, [Value], 1)"), i(4));
    assert_eq!(ev(&e, "RANKX({1, 2, 2, 3}, [Value], 1, , DENSE)"), i(3));
    assert_eq!(ev(&e, "RANKX({1, 2, 2, 3}, [Value], 1, ASC)"), i(1));
    assert_eq!(ev(&e, "RANKX({1, 2, 2, 3}, [Value], 7)"), i(1));
    // a BLANK value ranks like 0 (recorded from Power BI)
    assert_eq!(ev(&e, "RANKX({1, 2, 2, 3}, [Value], BLANK())"), i(5));
    assert_eq!(ev(&e, "RANK.EQ(2, Sales[Qty])"), i(3));
    assert_eq!(ev(&e, "RANK.EQ(2, Sales[Qty], 1)"), i(4));
    assert_eq!(ev(&e, "RANK.EQ(5, Sales[Qty])"), B);
}

#[test]
fn normal_exponential_poisson() {
    let e = engine();
    near(&e, "NORM.S.DIST(1.96, TRUE())", 0.9750021048517795);
    near(&e, "NORM.S.DIST(0, FALSE())", 0.3989422804014327);
    near(&e, "NORM.DIST(110, 100, 15, TRUE())", 0.7475074624530771);
    near(&e, "NORM.DIST(100, 100, 15, FALSE())", 0.3989422804014327 / 15.0);
    near(&e, "NORM.S.INV(0.975)", 1.959963984540054);
    near(&e, "NORM.S.INV(0.5)", 0.0);
    near(&e, "NORM.INV(0.975, 100, 15)", 129.39945976810081);
    near(&e, "EXPON.DIST(1, 2, TRUE())", 0.8646647167633873);
    near(&e, "EXPON.DIST(1, 2, FALSE())", 0.2706705664732254);
    near(&e, "POISSON.DIST(2, 3, FALSE())", 0.22404180765538775);
    near(&e, "POISSON.DIST(2, 3, TRUE())", 0.42319008112684353);
    fails(&e, "NORM.S.INV(0)");
    fails(&e, "NORM.DIST(1, 0, 0, TRUE())");
    fails(&e, "EXPON.DIST(-1, 2, TRUE())");
}

#[test]
fn t_chisq_beta() {
    let e = engine();
    near(&e, "T.DIST(2, 10, TRUE())", 0.9633059826146299);
    near(&e, "T.DIST(0, 5, FALSE())", 0.3796066898224944);
    near(&e, "T.DIST.RT(2, 10)", 0.0366940173853701);
    near(&e, "T.DIST.2T(2, 10)", 0.0733880347707402);
    near(&e, "T.INV(0.975, 10)", 2.228138851986274);
    near(&e, "T.INV.2T(0.05, 10)", 2.228138851986274);
    near(&e, "T.INV(0.5, 3)", 0.0);
    near(&e, "CHISQ.INV(0.95, 4)", 9.487729036781154);
    near(&e, "CHISQ.INV.RT(0.05, 4)", 9.487729036781154);
    near(&e, "CHISQ.DIST(9.487729036781154, 4, TRUE())", 0.95);
    near(&e, "CHISQ.DIST.RT(9.487729036781154, 4)", 0.05);
    near(&e, "CHISQ.DIST(2, 2, FALSE())", 0.5 * (-1.0f64).exp());
    near(&e, "BETA.DIST(0.4, 2, 3, TRUE())", 0.5248);
    near(&e, "BETA.DIST(0.4, 2, 3, FALSE())", 1.728);
    near(&e, "BETA.INV(0.5248, 2, 3)", 0.4);
    near(&e, "BETA.DIST(3, 2, 3, TRUE(), 2, 4)", 0.5248 * 0.0 + 0.6875);
    fails(&e, "T.DIST.2T(-1, 10)");
    fails(&e, "T.INV(1.5, 10)");
    fails(&e, "BETA.DIST(2, 2, 3, TRUE())");
}

#[test]
fn confidence_intervals() {
    let e = engine();
    near(&e, "CONFIDENCE.NORM(0.05, 2.5, 50)", 1.959963984540054 * 2.5 / 50f64.sqrt());
    near_tol(&e, "CONFIDENCE.T(0.05, 2.5, 50)", 0.7105, 1e-3);
    fails(&e, "CONFIDENCE.NORM(0, 2.5, 50)");
    fails(&e, "CONFIDENCE.T(0.05, 2.5, 1)");
}
