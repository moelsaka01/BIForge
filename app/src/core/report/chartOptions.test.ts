import { describe, expect, it } from "vitest";
import { decodeCell } from "./cells";
import { buildChart } from "./chartOptions";
import { condFormatToPbir } from "./condFormat";
import type { Loaded } from "./dataLoader";
import { agg, column, lit } from "./fields";
import { buildVisualQuery } from "./queryBuilder";
import { fixtureModel, visualOf } from "./testFixture";
import { DEFAULT_THEME } from "./theme";
import { setFormat, setRawProp, type VisualModel } from "./visualDoc";

const model = fixtureModel();
const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Qty = agg("Sales", "Quantity", 0);
const Price = agg("Sales", "UnitPrice", 1);

type Cell = [string, string];
const c = (v: string | number | null, t: "text" | "int" | "real" = typeof v === "string" ? "text" : "int"): Cell => (v === null ? ["blank", ""] : [t, String(v)]);

function grouped(v: VisualModel, rows: Cell[][], highlight?: Cell[][]): Extract<Loaded, { kind: "grouped" }> {
  const query = buildVisualQuery(v, model, { filters: [] })!;
  const dec = (r: Cell[]) => r.map(([t, x]) => decodeCell({ t: t as never, v: x }));
  return { kind: "grouped", query, rows: rows.map(dec), highlightRows: highlight ? highlight.map(dec) : null, totals: null, truncated: false, ms: 0 };
}
const build = (v: VisualModel, loaded: Extract<Loaded, { kind: "grouped" }>, selected: never[] = []) => buildChart({ visual: v, loaded, theme: DEFAULT_THEME, selected })!;

describe("cartesian charts", () => {
  const rows = [
    [c("Accessories"), c("France"), c(30)],
    [c("Bikes"), c("France"), c(50)],
    [c("Bikes"), c("Canada"), c(70)],
    [c("Accessories"), c("Canada"), c(10)],
  ];

  it("pivots category x series and orders categories by total when the query sorts by value", () => {
    const v = visualOf("clusteredColumnChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    const b = build(v, grouped(v, rows));
    const o = b.option;
    expect(o.xAxis.data).toEqual(["Bikes", "Accessories"]); // Bikes 120, Accessories 40
    expect(o.series.map((s: { name: string }) => s.name)).toEqual(["France", "Canada"]);
    expect(o.series[0].data.map((d: { value: number }) => d.value)).toEqual([50, 30]);
    expect(o.series[1].data.map((d: { value: number }) => d.value)).toEqual([70, 10]);
    expect(o.series[0].type).toBe("bar");
    expect(o.series[0].stack).toBeUndefined();
    expect(o.legend.show).toBe(true);
    expect(b.count).toBe(2);
  });

  it("maps chart elements back to data points", () => {
    const v = visualOf("clusteredColumnChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    const b = build(v, grouped(v, rows));
    expect(b.pointAt(1, 0)).toEqual({ fields: [Cat, Country], values: [lit.str("Bikes"), lit.str("Canada")] });
    expect(b.pointAt(0, 1)).toEqual({ fields: [Cat, Country], values: [lit.str("Accessories"), lit.str("France")] });
    expect(b.pointAt(0, 9)).toBeNull();
  });

  it("without a series, one series per measure and no legend", () => {
    const v = visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] });
    const b = build(v, grouped(v, [[c("Bikes"), c(120)], [c("Accessories"), c(40)]]));
    expect(b.option.series).toHaveLength(1);
    expect(b.option.series[0].name).toBe("Sum of Quantity");
    expect(b.option.legend.show).toBe(false);
    expect(b.pointAt(0, 1)).toEqual({ fields: [Cat], values: [lit.str("Accessories")] });
  });

  it("horizontal bars swap the axes and put the first category on top", () => {
    const v = visualOf("clusteredBarChart", { Category: [Cat], Y: [Qty] });
    const o = build(v, grouped(v, [[c("Bikes"), c(120)]])).option;
    expect(o.yAxis.type).toBe("category");
    expect(o.yAxis.inverse).toBe(true);
    expect(o.xAxis.type).toBe("value");
  });

  it("stacked and 100% stacked charts", () => {
    const v = visualOf("columnChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    expect(build(v, grouped(v, rows)).option.series.every((s: { stack: string }) => s.stack === "total")).toBe(true);
    const h = visualOf("hundredPercentStackedColumnChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    const o = build(h, grouped(h, rows)).option;
    expect(o.series[0].data[0].value + o.series[1].data[0].value).toBeCloseTo(100);
    expect(o.series[0].data[0].raw).toBe(50);
    expect(o.yAxis[0].max).toBe(100);
  });

  it("line and area charts keep the order of the rows and draw lines", () => {
    const v = visualOf("lineChart", { Category: [column("Date", "YearMonth")], Y: [Qty] });
    const lr = [[c(202401, "int"), c(5)], [c(202402, "int"), c(9)], [c(202403, "int"), c(2)]];
    const o = build(v, grouped(v, lr)).option;
    expect(o.xAxis.data).toEqual(["202401", "202402", "202403"]);
    expect(o.series[0].type).toBe("line");
    expect(o.xAxis.boundaryGap).toBe(false);
    const a = visualOf("stackedAreaChart", { Category: [column("Date", "YearMonth")], Y: [Qty] });
    const ao = build(a, grouped(a, lr)).option;
    expect(ao.series[0].areaStyle).toBeDefined();
    expect(ao.series[0].stack).toBe("total");
  });

  it("combo chart: columns on the first axis, lines on the second", () => {
    const v = visualOf("lineClusteredColumnComboChart", { Category: [Cat], Y: [Qty], Y2: [Price] });
    const o = build(v, grouped(v, [[c("Bikes"), c(120), c(850.5, "real")]])).option;
    expect(o.series.map((s: { type: string }) => s.type)).toEqual(["bar", "line"]);
    expect(o.series[1].yAxisIndex).toBe(1);
    expect(o.yAxis).toHaveLength(2);
  });

  it("formatting: legend, labels, colors, axis range", () => {
    const v = visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] });
    setFormat(v.json, "legend", "show", lit.bool(true));
    setFormat(v.json, "legend", "position", lit.str("Bottom"));
    setFormat(v.json, "labels", "show", lit.bool(true));
    setFormat(v.json, "dataPoint", "fill", lit.str("#123456"), "Sum of Quantity");
    setFormat(v.json, "valueAxis", "start", lit.num(10));
    setFormat(v.json, "valueAxis", "gridlineShow", lit.bool(false));
    const o = build(v, grouped(v, [[c("Bikes"), c(120)]])).option;
    expect(o.legend.show).toBe(true); // switched on by the user
    expect(o.series[0].itemStyle.color).toBe("#123456");
    expect(o.series[0].label.show).toBe(true);
    expect(o.yAxis[0].min).toBe(10);
    expect(o.yAxis[0].splitLine.show).toBe(false);
    const two = visualOf("clusteredColumnChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    setFormat(two.json, "legend", "position", lit.str("Bottom"));
    const o2 = build(two, grouped(two, rows)).option;
    expect(o2.legend.bottom).toBe(0);
    expect(o2.grid.bottom).toBe(30);
    setFormat(two.json, "legend", "show", lit.bool(false));
    expect(build(two, grouped(two, rows)).option.legend.show).toBe(false);
  });

  it("conditional formatting colors the bars by rule", () => {
    const v = visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] });
    setRawProp(v.json, "dataPoint", "fill", condFormatToPbir({ kind: "rules", input: Qty, cases: [{ conds: [{ op: "gt", value: 100 }], color: "#00aa00" }], fallback: "#cc0000" }));
    const o = build(v, grouped(v, [[c("Bikes"), c(120)], [c("Accessories"), c(40)]])).option;
    expect(o.series[0].data.map((d: { itemStyle: { color: string } }) => d.itemStyle.color)).toEqual(["#00aa00", "#cc0000"]);
  });

  it("a selection dims the other points", () => {
    const v = visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] });
    const g = grouped(v, [[c("Bikes"), c(120)], [c("Accessories"), c(40)]]);
    const o = buildChart({ visual: v, loaded: g, theme: DEFAULT_THEME, selected: [{ fields: [Cat], values: [lit.str("Bikes")] }] })!.option;
    expect(o.series[0].data.map((d: { itemStyle: { opacity: number } }) => d.itemStyle.opacity)).toEqual([1, 0.35]);
  });

  it("highlight draws the highlighted part over a faded full bar", () => {
    const v = visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] });
    const g = grouped(v, [[c("Bikes"), c(120)], [c("Accessories"), c(40)]], [[c("Bikes"), c(30)]]);
    const o = build(v, g).option;
    expect(o.series).toHaveLength(2);
    expect(o.series[0].data[0].itemStyle.opacity).toBe(0.35);
    expect(o.series[1].data.map((d: { value: number | null }) => d.value)).toEqual([30, null]);
    expect(o.series[1].silent).toBe(true);
    expect(o.series[0].barGap).toBe("-100%");
  });
});

describe("other charts", () => {
  it("pie and donut", () => {
    const v = visualOf("pieChart", { Category: [Cat], Y: [Qty] });
    const b = build(v, grouped(v, [[c("Bikes"), c(120)], [c("Clothing"), c(40)]]));
    expect(b.option.series[0].type).toBe("pie");
    expect(b.option.series[0].data.map((d: { name: string; value: number }) => [d.name, d.value])).toEqual([["Bikes", 120], ["Clothing", 40]]);
    expect(b.option.series[0].radius[0]).toBe("0%");
    expect(b.pointAt(0, 1)).toEqual({ fields: [Cat], values: [lit.str("Clothing")] });
    const d = visualOf("donutChart", { Category: [Cat], Y: [Qty] });
    expect(build(d, grouped(d, [[c("Bikes"), c(120)]])).option.series[0].radius[0]).toBe("50%");
    setFormat(v.json, "labels", "labelStyle", lit.str("Percent of total"));
    const lab = build(v, grouped(v, [[c("Bikes"), c(120)], [c("Clothing"), c(40)]])).option.series[0].label.formatter({ name: "Bikes", value: 120 });
    expect(lab).toBe("75.0%");
  });

  it("funnel and treemap", () => {
    const f = visualOf("funnel", { Category: [Cat], Y: [Qty] });
    expect(build(f, grouped(f, [[c("Bikes"), c(120)]])).option.series[0].type).toBe("funnel");
    const t = visualOf("treemap", { Group: [Cat, column("Product", "Product")], Values: [Qty] });
    const tb = build(t, grouped(t, [[c("Bikes"), c("City Bike"), c(60)], [c("Bikes"), c("Kids Bike"), c(60)], [c("Clothing"), c("Jersey"), c(40)]]));
    const data = tb.option.series[0].data;
    expect(data.map((d: { name: string; value: number }) => [d.name, d.value])).toEqual([["Bikes", 120], ["Clothing", 40]]);
    expect(data[0].children).toHaveLength(2);
    expect(tb.pointAt(0, 1)).toEqual({ fields: [Cat, column("Product", "Product")], values: [lit.str("Bikes"), lit.str("City Bike")] });
  });

  it("scatter groups points by series and scales the size", () => {
    const v = visualOf("scatterChart", { Category: [column("Product", "Product")], Series: [Cat], X: [Price], Y: [Qty], Size: [agg("Sales", "SalesKey", 5)] });
    const b = build(v, grouped(v, [[c("City Bike"), c("Bikes"), c(850, "real"), c(60), c(10)], [c("Jersey"), c("Clothing"), c(60, "real"), c(40), c(30)]]));
    expect(b.option.series).toHaveLength(2);
    expect(b.option.series[0].data[0]).toEqual([850, 60, 10, "City Bike"]);
    expect(b.option.series[0].symbolSize([850, 60, 10])).toBe(8);
    expect(b.option.series[1].symbolSize([60, 40, 30])).toBe(36);
    expect(b.pointAt(1, 0)).toEqual({ fields: [column("Product", "Product"), Cat], values: [lit.str("Jersey"), lit.str("Clothing")] });
  });

  it("waterfall: floating bars with a total at the end", () => {
    const v = visualOf("waterfallChart", { Category: [Cat], Y: [Qty] });
    const b = build(v, grouped(v, [[c("A"), c(10)], [c("B"), c(-4)], [c("C"), c(6)]]));
    const s = b.option.series;
    expect(b.option.xAxis.data).toEqual(["A", "B", "C", "Total"]);
    expect(s[0].data).toEqual([0, 6, 6, 0]); // invisible base
    expect(s[1].data).toEqual([10, "-", 6, "-"]);
    expect(s[2].data).toEqual(["-", 4, "-", "-"]);
    expect(s[3].data).toEqual(["-", "-", "-", 12]);
  });

  it("gauge with a target", () => {
    const v = visualOf("gauge", { Y: [Qty], TargetValue: [agg("Sales", "Quantity", 4)], MaxValue: [agg("Sales", "Quantity", 4)] });
    const b = build(v, grouped(v, [[c(120), c(200), c(200)]]));
    const s = b.option.series;
    expect(s).toHaveLength(2);
    expect(s[0].data[0].value).toBe(120);
    expect(s[0].max).toBe(200);
    expect(s[1].data[0].value).toBe(200);
  });

  it("non-chart visuals return null", () => {
    const v = visualOf("tableEx", { Values: [Cat] });
    expect(buildChart({ visual: v, loaded: grouped(v, [[c("Bikes")]]), theme: DEFAULT_THEME, selected: [] })).toBeNull();
  });
});
