import { describe, expect, it } from "vitest";
import { linearTrend, percentile, referenceValue, ribbonLayout } from "./analytics";
import { decodeCell } from "./cells";
import { buildChart } from "./chartOptions";
import type { Loaded } from "./dataLoader";
import { agg, column, lit } from "./fields";
import { buildVisualQuery } from "./queryBuilder";
import { fixtureModel, visualOf } from "./testFixture";
import { DEFAULT_THEME } from "./theme";
import { setFormat, type VisualModel } from "./visualDoc";

const model = fixtureModel();
const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Qty = agg("Sales", "Quantity", 0);

type Cell = [string, string];
const c = (v: string | number): Cell => (typeof v === "string" ? ["text", v] : ["int", String(v)]);
function grouped(v: VisualModel, rows: Cell[][]): Extract<Loaded, { kind: "grouped" }> {
  const query = buildVisualQuery(v, model, { filters: [] })!;
  return { kind: "grouped", query, rows: rows.map((r) => r.map(([t, x]) => decodeCell({ t: t as never, v: x }))), highlightRows: null, totals: null, truncated: false, ms: 0 };
}
const build = (v: VisualModel, loaded: Extract<Loaded, { kind: "grouped" }>) => buildChart({ visual: v, loaded, theme: DEFAULT_THEME, selected: [] })!;
const fmt = (v: VisualModel, object: string, prop: string, value: ReturnType<typeof lit.num> | ReturnType<typeof lit.bool> | ReturnType<typeof lit.str>) => setFormat(v.json, object, prop, value);

describe("reference line values", () => {
  const xs = [4, 1, 3, 2, null, 10];
  it("min, max, average, median and percentile over the non-blank values", () => {
    expect(referenceValue("minLine", xs)).toBe(1);
    expect(referenceValue("maxLine", xs)).toBe(10);
    expect(referenceValue("averageLine", xs)).toBe(4);
    expect(referenceValue("medianLine", xs)).toBe(3);
    expect(referenceValue("percentileLine", xs, { percentile: 90 })).toBeCloseTo(7.6, 10);
    expect(referenceValue("percentileLine", xs, { percentile: 0 })).toBe(1);
    expect(referenceValue("percentileLine", xs, { percentile: 100 })).toBe(10);
  });
  it("a constant line is its value; nothing to compute from gives null", () => {
    expect(referenceValue("constantLine", [], { constant: 7 })).toBe(7);
    expect(referenceValue("constantLine", [1])).toBeNull();
    expect(referenceValue("averageLine", [null])).toBeNull();
    expect(referenceValue("medianLine", [])).toBeNull();
  });
  it("percentile interpolates between ranks and handles one value", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([5], 75)).toBe(5);
  });
});

describe("trend line", () => {
  it("fits a least-squares line and skips blanks", () => {
    const t = linearTrend([1, 3, null, 7, 9])!;
    expect(t.slope).toBeCloseTo(2, 10);
    expect(t.intercept).toBeCloseTo(1, 10);
    expect(t.at(2)).toBeCloseTo(5, 10);
    expect(linearTrend([5])).toBeNull();
    expect(linearTrend([null, null])).toBeNull();
  });
});

describe("Analytics on a chart", () => {
  const rows = [[c("Accessories"), c(10)], [c("Bikes"), c(30)], [c("Clothing"), c(20)], [c("Shoes"), c(40)]];
  const mk = (type = "clusteredColumnChart") => visualOf(type, { Category: [Cat], Y: [Qty] });

  it("draws the lines that are switched on, with value, color and style", () => {
    const v = mk();
    fmt(v, "averageLine", "show", lit.bool(true));
    fmt(v, "maxLine", "show", lit.bool(true));
    fmt(v, "maxLine", "lineColor", lit.str("#ff0000"));
    fmt(v, "maxLine", "style", lit.str("solid"));
    fmt(v, "constantLine", "show", lit.bool(true));
    fmt(v, "constantLine", "value", lit.num(25));
    fmt(v, "constantLine", "dataLabelShow", lit.bool(true));
    const mark = build(v, grouped(v, rows)).option.series[0].markLine;
    const byName = Object.fromEntries(mark.data.map((d: { name: string }) => [d.name, d]));
    expect(byName.Average.yAxis).toBe(25);
    expect(byName.Max.yAxis).toBe(40);
    expect(byName.Max.lineStyle).toMatchObject({ color: "#ff0000", type: "solid" });
    expect(byName.Constant.yAxis).toBe(25);
    expect(byName.Constant.label.show).toBe(true);
    expect(byName.Constant.label.formatter()).toMatch(/^Constant: 25/);
    expect(byName.Average.label.show).toBe(false);
  });

  it("a percentile line is named after its percentile; horizontal bars put lines on the x axis", () => {
    const v = mk("clusteredBarChart");
    fmt(v, "percentileLine", "show", lit.bool(true));
    fmt(v, "percentileLine", "percentile", lit.num(75));
    const d = build(v, grouped(v, rows)).option.series[0].markLine.data[0];
    expect(d.name).toBe("75th percentile");
    expect(d.xAxis).toBeCloseTo(32.5, 10);
    expect(d.yAxis).toBeUndefined();
  });

  it("no lines are drawn by default, and a constant line without a value is skipped", () => {
    const v = mk();
    expect(build(v, grouped(v, rows)).option.series[0].markLine).toBeUndefined();
    fmt(v, "constantLine", "show", lit.bool(true));
    expect(build(v, grouped(v, rows)).option.series[0].markLine).toBeUndefined();
  });

  it("the trend line is one more series that is not a data point", () => {
    const v = mk("lineChart");
    fmt(v, "trendLine", "show", lit.bool(true));
    const b = build(v, grouped(v, rows));
    const s = b.option.series;
    expect(s).toHaveLength(2);
    expect(s[1].name).toBe("Trend line");
    expect(s[1].data.map((d: { value: number }) => d.value)).toEqual([10, 17, 24, 31].map((x) => x + 0).map((_, i) => linearTrend([10, 30, 20, 40])!.at(i)));
    expect(b.pointAt(1, 0)).toBeNull();
    const tip = b.option.tooltip.formatter([{ seriesIndex: 0, seriesName: "Sum of Quantity", name: "Accessories", marker: "", data: { raw: 10 }, value: 10 }, { seriesIndex: 1, seriesName: "Trend line", name: "Accessories", marker: "", data: { raw: 12 }, value: 12 }]);
    expect(tip).not.toContain("Trend line");
  });

  it("is not offered or drawn on 100% stacked charts", () => {
    const v = mk("hundredPercentStackedColumnChart");
    fmt(v, "averageLine", "show", lit.bool(true));
    expect(build(v, grouped(v, rows)).option.series[0].markLine).toBeUndefined();
  });
});

describe("100% stacked area chart", () => {
  it("stacks areas to 100 percent on an axis from 0 to 100", () => {
    const v = visualOf("hundredPercentStackedAreaChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    const rows = [[c("Bikes"), c("France"), c(50)], [c("Bikes"), c("Canada"), c(150)], [c("Shoes"), c("France"), c(30)], [c("Shoes"), c("Canada"), c(10)]];
    const o = build(v, grouped(v, rows)).option;
    expect(o.series.every((s: { type: string; stack: string; areaStyle: unknown }) => s.type === "line" && s.stack === "total" && !!s.areaStyle)).toBe(true);
    const france = o.series.find((s: { name: string }) => s.name === "France");
    expect(france.data.map((d: { value: number }) => d.value)).toEqual([25, 75]);
    expect(o.yAxis[0].max).toBe(100);
  });
});

describe("ribbon layout", () => {
  it("ranks the series in every category, largest on top, and stacks by rank", () => {
    // two series, three categories: A leads in the first and last category, B in the middle
    const slots = ribbonLayout([[5, 2, 9], [3, 7, 1]]);
    expect(slots[0].map((s) => s.rank)).toEqual([1, 2]);
    expect(slots[1].map((s) => s.rank)).toEqual([2, 1]);
    // the highest rank ends at the top of the column
    expect(slots[0][0]).toMatchObject({ start: 3, end: 8 });
    expect(slots[0][1]).toMatchObject({ start: 0, end: 3 });
    expect(slots[1][1]).toMatchObject({ start: 2, end: 9 });
    expect(slots[1][0]).toMatchObject({ start: 0, end: 2 });
  });
  it("blank and negative values take no room; ties keep the series order", () => {
    const slots = ribbonLayout([[null, 4], [-2, 4]]);
    expect(slots[0].map((s) => s.end - s.start)).toEqual([0, 0]);
    expect(slots[1].map((s) => s.rank)).toEqual([1, 2]);
    expect(ribbonLayout([])).toEqual([]);
  });
  it("the ribbon chart is one custom series per legend entry whose items carry the slot and the next slot", () => {
    const v = visualOf("ribbonChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    const rows = [[c("Bikes"), c("France"), c(50)], [c("Bikes"), c("Canada"), c(20)], [c("Shoes"), c("France"), c(10)], [c("Shoes"), c("Canada"), c(40)]];
    const b = build(v, grouped(v, rows));
    expect(b.option.series.map((s: { type: string }) => s.type)).toEqual(["custom", "custom"]);
    const france = b.option.series.find((s: { name: string }) => s.name === "France");
    const first = france.data[0];
    expect(first.raw).toBe(50);
    expect(first.rank).toBe(1);
    expect(first.value[3]).not.toBeNull(); // a ribbon to the next category
    expect(france.data[1].value[3]).toBeNull(); // none after the last one
    expect(typeof france.renderItem).toBe("function");
    expect(b.pointAt(0, 0)).toMatchObject({ values: expect.any(Array) });
    expect(b.count).toBe(2);
  });
  it("renderItem draws a column and a ribbon to the next column", () => {
    const v = visualOf("ribbonChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    const rows = [[c("Bikes"), c("France"), c(50)], [c("Shoes"), c("France"), c(10)]];
    const s = build(v, grouped(v, rows)).option.series[0];
    const api = {
      coord: ([x, y]: number[]) => [x * 100 + 50, 200 - y * 2],
      size: () => [100, 0],
      value: (i: number) => s.data[0].value[i],
    };
    const item = s.renderItem({ dataIndex: 0 }, api);
    expect(item.children.map((x: { type: string }) => x.type)).toEqual(["rect", "polygon"]);
    expect(item.children[0].shape.x).toBeCloseTo(22, 6);
    expect(item.children[0].shape.width).toBeCloseTo(56, 6);
    const last = s.renderItem({ dataIndex: 1 }, { ...api, value: (i: number) => s.data[1].value[i] });
    expect(last.children.map((x: { type: string }) => x.type)).toEqual(["rect"]);
  });
});
