import { describe, expect, it } from "vitest";
import { decodeCell, type Value } from "./cells";
import { condFormatToPbir } from "./condFormat";
import type { Loaded } from "./dataLoader";
import { agg, column, lit, type Lit } from "./fields";
import { litExpr, queryRefOf } from "./pbir";
import { buildMatrixQuery, buildVisualQuery } from "./queryBuilder";
import { buildCard, buildKpi, buildMatrix, buildMultiRowCard, buildTable } from "./tableModels";
import { fixtureModel, visualOf } from "./testFixture";
import { DEFAULT_THEME } from "./theme";
import { setFormat, setRawProp, type VisualModel } from "./visualDoc";

const model = fixtureModel({ formats: { "Sales.Quantity": "#,0" } });
const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Qty = agg("Sales", "Quantity", 0);

type Cell = [string, string];
const dec = (r: Cell[]): Value[] => r.map(([t, x]) => decodeCell({ t: t as never, v: x }));
const t = (s: string): Cell => ["text", s];
const n = (x: number): Cell => ["int", String(x)];
const blank: Cell = ["blank", ""];

function grouped(v: VisualModel, rows: Cell[][]): Extract<Loaded, { kind: "grouped" }> {
  return { kind: "grouped", query: buildVisualQuery(v, model, { filters: [] })!, rows: rows.map(dec), highlightRows: null, totals: null, truncated: false, ms: 0 };
}

describe("table", () => {
  it("shows the fields in the order of the well, right-aligns values, formats numbers", () => {
    const v = visualOf("tableEx", { Values: [Cat, Qty, Country] });
    const m = buildTable(v, grouped(v, [[t("Bikes"), t("France"), n(1234)], [t("Clothing"), blank, n(5)]]), DEFAULT_THEME, null);
    expect(m.columns.map((c) => [c.label, c.align, c.isValue])).toEqual([["Category", "left", false], ["Sum of Quantity", "right", true], ["Country", "left", false]]);
    expect(m.rows[0].map((c) => c.text)).toEqual(["Bikes", "1,234", "France"]);
    expect(m.rows[1].map((c) => c.text)).toEqual(["Clothing", "5", ""]);
    expect(m.totals).toBeNull();
  });

  it("alternate rows take the secondary colors, but never over a color a rule gave the cell", () => {
    const v = visualOf("tableEx", { Values: [Cat, Qty] });
    setFormat(v.json, "values", "backColorSecondary", lit.str("#eeeeee"));
    setFormat(v.json, "values", "fontColorSecondary", lit.str("#112233"));
    const rows = [[t("A"), n(1)], [t("B"), n(2)], [t("C"), n(3)], [t("D"), n(4)]];
    const m = buildTable(v, grouped(v, rows), DEFAULT_THEME, null);
    expect(m.rows.map((r) => r[0].style.background)).toEqual([undefined, "#eeeeee", undefined, "#eeeeee"]);
    expect(m.rows.map((r) => r[0].style.color)).toEqual([undefined, "#112233", undefined, "#112233"]);
    // a column background wins in the rows it colors
    setFormat(v.json, "values", "backColor", lit.str("#ff0000"), queryRefOf(Qty));
    const m2 = buildTable(v, grouped(v, rows), DEFAULT_THEME, null);
    expect(m2.rows[1][1].style.background).toBe("#ff0000");
    expect(m2.rows[1][0].style.background).toBe("#eeeeee");
  });

  it("totals row, sort indicator", () => {
    const v = visualOf("tableEx", { Values: [Cat, Qty] }, { sort: { field: { Column: { Expression: { SourceRef: { Entity: "Product" } }, Property: "Category" } }, direction: "Descending" } });
    const m = buildTable(v, grouped(v, [[t("Bikes"), n(10)]]), DEFAULT_THEME, dec([n(10)]));
    expect(m.totals).toEqual(["Total", "10"]);
    expect(m.columns[0].sort).toBe("desc");
    expect(m.columns[1].sort).toBeNull();
    setFormat(v.json, "total", "totals", lit.bool(false));
    expect(buildTable(v, grouped(v, [[t("Bikes"), n(10)]]), DEFAULT_THEME, dec([n(10)])).totals).toBeNull();
  });

  it("conditional background, plain font color and data bars per column", () => {
    const v = visualOf("tableEx", { Values: [Cat, Qty] });
    const ref = queryRefOf(Qty);
    setRawProp(v.json, "values", "backColor", condFormatToPbir({ kind: "gradient", input: Qty, min: { color: "#000000" }, max: { color: "#ffffff" } }), ref);
    setFormat(v.json, "columnFormatting", "fontColor", lit.str("#ff0000"), queryRefOf(Cat));
    setRawProp(v.json, "columnFormatting", "dataBars", { positiveColor: { solid: { color: litExpr(lit.str("#6aa9e9")) } }, reverseDirection: litExpr(lit.bool(false)), hideText: litExpr(lit.bool(false)) }, ref);
    const m = buildTable(v, grouped(v, [[t("A"), n(10)], [t("B"), n(30)]]), DEFAULT_THEME, null);
    expect(m.rows[0][1].style.background).toBe("#000000");
    expect(m.rows[0][1].style.color).toBe("#ffffff");
    expect(m.rows[1][1].style.background).toBe("#ffffff");
    expect(m.rows[1][1].style.bar?.ratio).toBe(1);
    expect(m.rows[0][1].style.bar?.ratio).toBeCloseTo(1 / 3);
    expect(m.rows[0][0].style.color).toBe("#ff0000");
  });
});

describe("matrix", () => {
  const Ch = column("Sales", "Channel");
  const v = visualOf("pivotTable", { Rows: [Cat, Country], Columns: [Ch], Values: [Qty] });
  const q = buildMatrixQuery(v, model, { filters: [] })!;
  // parts in order: (0,0) (0,1) (1,0) (1,1) (2,0) (2,1)
  const parts: Cell[][][] = [
    [[n(100)]],
    [[t("Online"), n(70)], [t("Store"), n(30)]],
    [[t("Bikes"), n(60)], [t("Clothing"), n(40)]],
    [[t("Bikes"), t("Online"), n(40)], [t("Bikes"), t("Store"), n(20)], [t("Clothing"), t("Online"), n(30)], [t("Clothing"), t("Store"), n(10)]],
    [[t("Bikes"), t("France"), n(25)], [t("Bikes"), t("Canada"), n(35)], [t("Clothing"), t("France"), n(40)]],
    [[t("Bikes"), t("France"), t("Online"), n(15)], [t("Bikes"), t("France"), t("Store"), n(10)], [t("Bikes"), t("Canada"), t("Online"), n(25)], [t("Bikes"), t("Canada"), t("Store"), n(10)], [t("Clothing"), t("France"), t("Online"), n(30)], [t("Clothing"), t("France"), t("Store"), n(10)]],
  ];
  const build = (collapsed = new Set<string>()) => buildMatrix(v, parts.map((p) => p.map(dec)), q, DEFAULT_THEME, collapsed);
  const texts = (r: { cells: { text: string }[] }) => r.cells.map((c) => c.text);

  it("stepped rows with subtotals on the parents, leaf rows, grand total", () => {
    const m = build();
    expect(m.headers[0].map((h) => [h.text, h.span])).toEqual([["Online", 1], ["Store", 1]]);
    expect(m.rows.map((r) => [r.depth, r.label])).toEqual([[0, "Bikes"], [1, "France"], [1, "Canada"], [0, "Clothing"], [1, "France"], [0, "Total"]]);
    expect(texts(m.rows[0])).toEqual(["40", "20"]); // Bikes subtotal per channel
    expect(m.rows[0].total.map((c) => c.text)).toEqual(["60"]);
    expect(texts(m.rows[1])).toEqual(["15", "10"]);
    expect(texts(m.rows[2])).toEqual(["25", "10"]);
    expect(texts(m.rows[m.rows.length - 1])).toEqual(["70", "30"]);
    expect(m.rows[m.rows.length - 1].total[0].text).toBe("100");
    expect(m.rows[0].expandable && m.rows[0].expanded).toBe(true);
    expect(m.rows[1].expandable).toBe(false);
    expect(m.showRowTotals).toBe(true);
  });

  it("collapsing a parent hides its children", () => {
    const m = build();
    const bikes = m.rows[0].key;
    const c = build(new Set([bikes]));
    expect(c.rows.map((r) => r.label)).toEqual(["Bikes", "Clothing", "France", "Total"]);
    expect(c.rows[0].expanded).toBe(false);
  });

  // the Subtotals card: where a group's subtotal stands, what it is called, and whether there is one
  const withSub = (props: Record<string, Lit>) => {
    const v2 = visualOf("pivotTable", { Rows: [Cat, Country], Columns: [Ch], Values: [Qty] });
    for (const [k, val] of Object.entries(props)) setFormat(v2.json, "subTotals", k, val);
    return buildMatrix(v2, parts.map((p) => p.map(dec)), q, DEFAULT_THEME, new Set());
  };
  it("Row subtotals position Bottom puts the subtotal on its own row under the group and empties the group's row", () => {
    const m = withSub({ rowSubtotalsPosition: lit.str("Bottom") });
    expect(m.rows.map((r) => r.label)).toEqual(["Bikes", "France", "Canada", "Bikes Total", "Clothing", "France", "Clothing Total", "Total"]);
    expect(texts(m.rows[0])).toEqual(["", ""]);
    expect(m.rows[3].isSubtotal).toBe(true);
    expect(texts(m.rows[3])).toEqual(["40", "20"]);
  });
  it("the subtotal label is the one of the card; subtotals off leave none", () => {
    expect(withSub({ rowSubtotalsPosition: lit.str("Bottom"), rowSubtotalsLabel: lit.str("Sum") }).rows[3].label).toBe("Bikes Sum");
    const off = withSub({ rowSubtotals: lit.bool(false) });
    expect(off.rows.map((r) => r.label)).toEqual(["Bikes", "France", "Canada", "Clothing", "France", "Total"]);
    expect(texts(off.rows[0])).toEqual(["", ""]);
  });

  // two column levels: a subtotal column after each group of the first level
  const twoLevels = (props: Record<string, Lit> = {}) => {
    const v3 = visualOf("pivotTable", { Rows: [Cat], Columns: [Ch, Country], Values: [Qty] });
    for (const [k, val] of Object.entries(props)) setFormat(v3.json, "subTotals", k, val);
    const q3 = buildMatrixQuery(v3, model, { filters: [] })!;
    expect(q3.parts).toHaveLength(6);
    const p3: Cell[][][] = [
      [[n(100)]],
      [[t("Online"), n(70)], [t("Store"), n(30)]],
      [[t("Online"), t("France"), n(40)], [t("Online"), t("Canada"), n(30)], [t("Store"), t("France"), n(30)]],
      [[t("Bikes"), n(60)], [t("Clothing"), n(40)]],
      [[t("Bikes"), t("Online"), n(45)], [t("Bikes"), t("Store"), n(15)], [t("Clothing"), t("Online"), n(25)], [t("Clothing"), t("Store"), n(15)]],
      [[t("Bikes"), t("Online"), t("France"), n(25)], [t("Bikes"), t("Online"), t("Canada"), n(20)], [t("Bikes"), t("Store"), t("France"), n(15)], [t("Clothing"), t("Online"), t("France"), n(15)], [t("Clothing"), t("Online"), t("Canada"), n(10)], [t("Clothing"), t("Store"), t("France"), n(15)]],
    ];
    return buildMatrix(v3, p3.map((p) => p.map(dec)), q3, DEFAULT_THEME, new Set());
  };
  it("column subtotals: a subtotal column after each group of the first column level", () => {
    const m = twoLevels();
    expect(m.headers[0].map((h) => [h.text, h.span])).toEqual([["Online", 3], ["Store", 2]]);
    expect(m.headers[1].map((h) => [h.text, h.span])).toEqual([["France", 1], ["Canada", 1], ["Online Total", 1], ["France", 1], ["Store Total", 1]]);
    expect(texts(m.rows[0])).toEqual(["25", "20", "45", "15", "15"]);
    expect(texts(m.rows[m.rows.length - 1])).toEqual(["40", "30", "70", "30", "30"]);
  });
  it("column subtotals off or relabelled", () => {
    const off = twoLevels({ columnSubtotals: lit.bool(false) });
    expect(off.headers[1].map((h) => h.text)).toEqual(["France", "Canada", "France"]);
    expect(texts(off.rows[0])).toEqual(["25", "20", "15"]);
    expect(twoLevels({ columnSubtotalsLabel: lit.str("Sum") }).headers[1][2].text).toBe("Online Sum");
  });

  it("several values add a header row of value names", () => {
    const v2 = visualOf("pivotTable", { Rows: [Cat], Columns: [Ch], Values: [Qty, agg("Sales", "UnitPrice", 1)] });
    const q2 = buildMatrixQuery(v2, model, { filters: [] })!;
    expect(q2.parts).toHaveLength(4);
    const p2: Cell[][][] = [
      [[n(100), ["real", "2.5"]]],
      [[t("Online"), n(70), ["real", "2"]]],
      [[t("Bikes"), n(60), ["real", "3"]]],
      [[t("Bikes"), t("Online"), n(40), ["real", "4"]]],
    ];
    const m = buildMatrix(v2, p2.map((p) => p.map(dec)), q2, DEFAULT_THEME, new Set());
    expect(m.headers).toHaveLength(2);
    expect(m.headers[0][0]).toEqual({ text: "Online", span: 2 });
    expect(m.headers[1].map((h) => h.text)).toEqual(["Sum of Quantity", "Average of UnitPrice"]);
    expect(m.rows[0].cells.map((c) => c.text)).toEqual(["40", "4"]);
    expect(m.totalLabels).toEqual(["Total Sum of Quantity", "Total Average of UnitPrice"]);
  });

  it("one statement per depth pair", () => {
    expect(q.dax.split("EVALUATE").length - 1).toBe(6);
  });
});

describe("cards and KPI", () => {
  it("card shows a compact value and the label", () => {
    const v = visualOf("card", { Values: [Qty] });
    const c = buildCard(v, grouped(v, [[n(1234567)]]), DEFAULT_THEME);
    expect(c.text).toBe("1.2M");
    expect(c.label).toBe("Sum of Quantity");
    setFormat(v.json, "labels", "labelDisplayUnits", lit.num(1));
    expect(buildCard(v, grouped(v, [[n(1234567)]]), DEFAULT_THEME).text).toBe("1,234,567");
    setFormat(v.json, "categoryLabels", "show", lit.bool(false));
    expect(buildCard(v, grouped(v, [[n(1)]]), DEFAULT_THEME).showLabel).toBe(false);
    expect(buildCard(v, grouped(v, [[blank]]), DEFAULT_THEME).text).toBe("");
  });

  it("card font color by rule", () => {
    const v = visualOf("card", { Values: [Qty] });
    setRawProp(v.json, "labels", "color", condFormatToPbir({ kind: "rules", input: Qty, cases: [{ conds: [{ op: "lt", value: 100 }], color: "#cc0000" }], fallback: "#00aa00" }));
    expect(buildCard(v, grouped(v, [[n(5)]]), DEFAULT_THEME).color).toBe("#cc0000");
    expect(buildCard(v, grouped(v, [[n(500)]]), DEFAULT_THEME).color).toBe("#00aa00");
  });

  it("multi-row card: one card per row", () => {
    const v = visualOf("multiRowCard", { Values: [Cat, Qty] });
    const m = buildMultiRowCard(v, grouped(v, [[t("Bikes"), n(5)], [t("Clothing"), n(7)]]), DEFAULT_THEME);
    expect(m.cards.map((c) => c.items.map((i) => i.text))).toEqual([["Bikes", "5"], ["Clothing", "7"]]);
    expect(m.cards[0].items[1].label).toBe("Sum of Quantity");
  });

  it("KPI: last value against the goal, trend, status direction", () => {
    const v = visualOf("kpi", { Indicator: [Qty], TrendLine: [column("Date", "YearMonth")], Goal: [agg("Sales", "Quantity", 4)] });
    const g = grouped(v, [[n(202401), n(80), n(100)], [n(202402), n(120), n(100)]]);
    const k = buildKpi(v, g, DEFAULT_THEME);
    expect([k.value, k.goal, k.varianceText, k.status]).toEqual(["120", "100", "+20.0%", "good"]);
    expect(k.trend).toEqual([{ x: "202401", y: 80 }, { x: "202402", y: 120 }]);
    setFormat(v.json, "goals", "direction", lit.str("Low is good"));
    expect(buildKpi(v, g, DEFAULT_THEME).status).toBe("bad");
    const none = visualOf("kpi", { Indicator: [Qty] });
    const k2 = buildKpi(none, grouped(none, [[n(5)]]), DEFAULT_THEME);
    expect([k2.goal, k2.variance, k2.status]).toEqual([null, null, "neutral"]);
  });
});

describe("KPI goal line", () => {
  const mk = () => {
    const v = visualOf("kpi", { Indicator: [Qty], TrendLine: [column("Date", "YearMonth")], Goal: [agg("Sales", "Quantity", 4)] });
    return { v, g: grouped(v, [[n(202401), n(80), n(100)], [n(202402), n(120), n(100)]]) };
  };
  it("the distance has its own label type and font, the title and goal value theirs, the status card can flip the direction", () => {
    const { v, g } = mk();
    const k = (set?: () => void) => { set?.(); return buildKpi(v, g, DEFAULT_THEME); };
    expect(k().distanceText).toBe("+20.0%");
    expect(k(() => setFormat(v.json, "goals", "distanceLabel", lit.str("Value"))).distanceText).toBe("+20");
    expect(k(() => setFormat(v.json, "goals", "distanceLabel", lit.str("Value, percent"))).distanceText).toBe("+20 (+20.0%)");
    expect(k(() => setFormat(v.json, "goals", "distanceFontColor", lit.str("#112233"))).distanceColor).toBe("#112233");
    expect(k(() => setFormat(v.json, "goals", "goalFontColor", lit.str("#445566"))).goalColor).toBe("#445566");
    expect(k(() => setFormat(v.json, "goals", "titleBold", lit.bool(true))).titleStyle.fontWeight).toBe(700);
    expect(k(() => setFormat(v.json, "status", "direction", lit.str("Negative"))).status).toBe("bad");
    expect(k(() => setFormat(v.json, "indicator", "verticalAlignment", lit.str("bottom"))).verticalAlign).toBe("flex-end");
    expect(k(() => setFormat(v.json, "indicator", "iconSize", lit.num(30))).iconSize).toBe(30);
  });
});

describe("table word wrap", () => {
  it("a table whose values or headers wrap has rows of two lines", () => {
    const style = (object: string, on: boolean) => {
      const v = visualOf("tableEx", { Values: [Cat, Qty] });
      if (on) setFormat(v.json, object, "wordWrap", lit.bool(true));
      return buildTable(v, grouped(v, [[t("Bikes"), n(10)]]), DEFAULT_THEME, null).style;
    };
    expect(style("values", false).rowHeight).toBe(24);
    expect(style("values", true).rowHeight).toBe(48);
    expect(style("columnHeaders", true).headHeight).toBe(56);
    expect(style("columnHeaders", true).header.whiteSpace).toBe("normal");
  });
});
