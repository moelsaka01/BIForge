import { describe, expect, it } from "vitest";
import { REFERENCE_KINDS, linearTrend, percentile, referenceValue, ribbonLayout } from "./analytics";
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

/** Sets one property of an Analytics line the way the Format pane stores it (instance id, and the type of a statistic line). */
const ref = (v: VisualModel, kind: string, prop: string, value: ReturnType<typeof lit.num> | ReturnType<typeof lit.bool> | ReturnType<typeof lit.str>) => {
  const k = REFERENCE_KINDS.find((x) => x.kind === kind)!;
  setFormat(v.json, k.object, prop, value, `id:${kind}`);
  if (k.object === "referenceLine") setFormat(v.json, "referenceLine", "type", lit.str(k.name), `id:${kind}`);
};
const fmt = (v: VisualModel, object: string, prop: string, value: ReturnType<typeof lit.num> | ReturnType<typeof lit.bool> | ReturnType<typeof lit.str>) => setFormat(v.json, object, prop, value);

describe("reference line values", () => {
  const xs = [4, 1, 3, 2, null, 10];
  it("min, max, average, median and percentile over the non-blank values", () => {
    expect(referenceValue("min", xs)).toBe(1);
    expect(referenceValue("max", xs)).toBe(10);
    expect(referenceValue("average", xs)).toBe(4);
    expect(referenceValue("median", xs)).toBe(3);
    expect(referenceValue("percentile", xs, { percentile: 90 })).toBeCloseTo(7.6, 10);
    expect(referenceValue("percentile", xs, { percentile: 0 })).toBe(1);
    expect(referenceValue("percentile", xs, { percentile: 100 })).toBe(10);
  });
  it("a constant line is its value; nothing to compute from gives null", () => {
    expect(referenceValue("constant", [], { constant: 7 })).toBe(7);
    expect(referenceValue("constant", [1])).toBeNull();
    expect(referenceValue("average", [null])).toBeNull();
    expect(referenceValue("median", [])).toBeNull();
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
    ref(v, "average", "show", lit.bool(true));
    ref(v, "max", "show", lit.bool(true));
    ref(v, "max", "lineColor", lit.str("#ff0000"));
    ref(v, "max", "style", lit.str("solid"));
    ref(v, "constant", "show", lit.bool(true));
    ref(v, "constant", "value", lit.num(25));
    ref(v, "constant", "dataLabelShow", lit.bool(true));
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
    ref(v, "percentile", "show", lit.bool(true));
    ref(v, "percentile", "percentile", lit.num(75));
    const d = build(v, grouped(v, rows)).option.series[0].markLine.data[0];
    expect(d.name).toBe("75th percentile");
    expect(d.xAxis).toBeCloseTo(32.5, 10);
    expect(d.yAxis).toBeUndefined();
  });

  it("no lines are drawn by default, and a constant line without a value is skipped", () => {
    const v = mk();
    expect(build(v, grouped(v, rows)).option.series[0].markLine).toBeUndefined();
    ref(v, "constant", "show", lit.bool(true));
    expect(build(v, grouped(v, rows)).option.series[0].markLine).toBeUndefined();
  });

  it("the trend line is one more series that is not a data point", () => {
    const v = mk("lineChart");
    fmt(v, "trend", "show", lit.bool(true));
    const b = build(v, grouped(v, rows));
    const s = b.option.series;
    expect(s).toHaveLength(2);
    expect(s[1].name).toBe("Trend line");
    expect(s[1].data.map((d: { value: number }) => d.value)).toEqual([10, 17, 24, 31].map((x) => x + 0).map((_, i) => linearTrend([10, 30, 20, 40])!.at(i)));
    expect(b.pointAt(1, 0)).toBeNull();
    const tip = b.option.tooltip.formatter([{ seriesIndex: 0, seriesName: "Sum of Quantity", name: "Accessories", marker: "", data: { raw: 10 }, value: 10 }, { seriesIndex: 1, seriesName: "Trend line", name: "Accessories", marker: "", data: { raw: 12 }, value: 12 }]);
    expect(tip).not.toContain("Trend line");
  });

  it("shades the side of a reference line the shading names, in the line's color or its own", () => {
    const v = mk();
    ref(v, "constant", "show", lit.bool(true));
    ref(v, "constant", "value", lit.num(25));
    expect(build(v, grouped(v, rows)).option.series[0].markArea).toBeUndefined();
    ref(v, "constant", "shadeShow", lit.bool(true));
    expect(build(v, grouped(v, rows)).option.series[0].markArea).toBeUndefined(); // no region chosen
    ref(v, "constant", "shadeRegion", lit.str("before"));
    ref(v, "constant", "shadeColor", lit.str("#00ff00"));
    ref(v, "constant", "shadeTransparency", lit.num(70));
    let area = build(v, grouped(v, rows)).option.series[0].markArea.data[0];
    expect(area[1].yAxis).toBe(25);
    expect(area[0].yAxis).toBeLessThan(-1e9);
    expect(area[0].itemStyle).toMatchObject({ color: "#00ff00" });
    expect(area[0].itemStyle.opacity).toBeCloseTo(0.3, 5);
    ref(v, "constant", "shadeRegion", lit.str("after"));
    ref(v, "constant", "shadeColorMatchStroke", lit.bool(true));
    ref(v, "constant", "lineColor", lit.str("#ff0000"));
    area = build(v, grouped(v, rows)).option.series[0].markArea.data[0];
    expect(area[0].yAxis).toBe(25);
    expect(area[1].yAxis).toBeGreaterThan(1e9);
    expect(area[0].itemStyle.color).toBe("#ff0000");
    // horizontal bars shade along the x axis
    const h = mk("clusteredBarChart");
    ref(h, "constant", "show", lit.bool(true));
    ref(h, "constant", "value", lit.num(25));
    ref(h, "constant", "shadeShow", lit.bool(true));
    ref(h, "constant", "shadeRegion", lit.str("after"));
    expect(build(h, grouped(h, rows)).option.series[0].markArea.data[0][0].xAxis).toBe(25);
  });

  it("the trend line takes a dash pattern and a cap, and the columns a gap from the layout card", () => {
    const v = mk("lineChart");
    fmt(v, "trend", "show", lit.bool(true));
    fmt(v, "trend", "dashArray", lit.str("8 2"));
    fmt(v, "trend", "dashCap", lit.str("round"));
    const t = build(v, grouped(v, rows)).option.series[1].lineStyle;
    expect(t.type).toEqual([8, 2]);
    expect(t.cap).toBe("round");
    const c = mk();
    expect(build(c, grouped(c, rows)).option.series[0].barCategoryGap).toBeUndefined();
    fmt(c, "layout", "clusteredGapSize", lit.num(80));
    expect(build(c, grouped(c, rows)).option.series[0].barCategoryGap).toBe("80%");
  });

  it("draws only the constant line on 100% stacked charts, and the axis grows to it when asked", () => {
    const v = mk("hundredPercentStackedColumnChart");
    ref(v, "average", "show", lit.bool(true));
    expect(build(v, grouped(v, rows)).option.series[0].markLine).toBeUndefined();
    ref(v, "constant", "show", lit.bool(true));
    ref(v, "constant", "value", lit.num(120));
    ref(v, "constant", "autoScale", lit.bool(true));
    const o = build(v, grouped(v, rows)).option;
    expect(o.series[0].markLine.data).toHaveLength(1);
    expect(o.series[0].markLine.data[0].yAxis).toBe(120);
    expect(o.yAxis[0].max).toBe(120);
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

describe("layout and ribbon bands of stacked charts", () => {
  const stackedRows = [[c("A"), c("France"), c(10)], [c("A"), c("Canada"), c(30)], [c("B"), c("France"), c(20)], [c("B"), c("Canada"), c(25)]];
  const mkStack = () => visualOf("columnChart", { Category: [Cat], Series: [Country], Y: [Qty] });

  it("joins the stacked segments with bands when asked, with the gap, color and transparency of the card", () => {
    const v = mkStack();
    expect(build(v, grouped(v, stackedRows)).option.series.some((s: { type: string }) => s.type === "custom")).toBe(false);
    fmt(v, "ribbonBands", "show", lit.bool(true));
    fmt(v, "ribbonBands", "fillMatchColor", lit.bool(false));
    fmt(v, "ribbonBands", "fillColor", lit.str("#123456"));
    fmt(v, "ribbonBands", "fillTransparency", lit.num(30));
    fmt(v, "layout", "ribbonGapSize", lit.num(5));
    const bands = build(v, grouped(v, stackedRows)).option.series.filter((s: { type: string }) => s.type === "custom");
    expect(bands).toHaveLength(2);
    expect(bands[0].bandLook).toMatchObject({ fill: "#123456", opacity: 0.7 });
    expect(bands[0].bandGap).toBe(5);
    // the second series stacks on the first: its span in category A starts at the first series' top
    const byName = (n: string) => bands.find((b: { name: string }) => b.name === n).data;
    expect(byName("Canada")[0][1]).toBe(byName("France")[0][2]);
  });

  it("sorts the series by total and draws the gap between segments", () => {
    const v = mkStack();
    fmt(v, "layout", "seriesOrderSorted", lit.bool(true));
    fmt(v, "layout", "stackedGapSize", lit.num(3));
    const o = build(v, grouped(v, stackedRows)).option;
    expect(o.series.map((s: { name: string }) => s.name)).toEqual(["Canada", "France"]);
    expect(o.series[0].itemStyle.borderWidth).toBe(3);
  });
});

describe("small multiples layout", () => {
  const Ch = column("Sales", "Channel");
  const rows4 = [[c("A"), c("France"), c("Online"), c(30)], [c("A"), c("France"), c("Store"), c(10)], [c("A"), c("Canada"), c("Phone"), c(50)], [c("B"), c("Canada"), c("Web"), c(70)]];
  const mkSm = () => visualOf("clusteredColumnChart", { Category: [Cat], Series: [Country], Rows: [Ch], Y: [Qty] });

  it("draws grid lines on the cell edges with the card's color and style, and leaves them out otherwise", () => {
    const v = mkSm();
    const plain = build(v, grouped(v, rows4)).option;
    fmt(v, "smallMultiplesLayout", "gridLineShow", lit.bool(true));
    fmt(v, "smallMultiplesLayout", "gridLineType", lit.str("innerVertical"));
    fmt(v, "smallMultiplesLayout", "gridLineStyle", lit.str("dashed"));
    fmt(v, "smallMultiplesLayout", "gridLineColor", lit.str("#102030"));
    const o = build(v, grouped(v, rows4)).option;
    expect(o.grid).toHaveLength(plain.grid.length + 1);
    const x = o.xAxis[o.xAxis.length - 1];
    const y = o.yAxis[o.yAxis.length - 1];
    expect(x.splitLine).toMatchObject({ show: true, lineStyle: { color: "#102030", type: "dashed" } });
    expect(y.splitLine.show).toBe(false);
  });

  it("a custom layout without counts has three columns, and counts replace that", () => {
    const v = mkSm();
    fmt(v, "smallMultiplesLayout", "layoutType", lit.str("custom"));
    const left = (o: Record<string, unknown>) => new Set((o.grid as { left: string }[]).map((g) => g.left)).size;
    expect(left(build(v, grouped(v, rows4)).option)).toBe(3);
    fmt(v, "smallMultiplesLayout", "columnCount", lit.num(4));
    expect(left(build(v, grouped(v, rows4)).option)).toBe(4);
  });
});

describe("underlined chart text", () => {
  it("puts a combining low line after each character of the legend, labels and axis text when the card asks for it", () => {
    const v = visualOf("clusteredColumnChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    const rows = [[c("A"), c("France"), c(10)], [c("A"), c("Canada"), c(30)]];
    const plain = build(v, grouped(v, rows)).option;
    expect(plain.legend.formatter).toBeUndefined();
    fmt(v, "legend", "underline", lit.bool(true));
    fmt(v, "categoryAxis", "underline", lit.bool(true));
    const o = build(v, grouped(v, rows)).option;
    expect(o.legend.formatter("Ab")).toBe("A̲b̲");
    expect(o.xAxis.axisLabel.formatter("A")).toBe("A̲");
  });
});

describe("total labels of stacked charts", () => {
  const rows = [[c("A"), c("France"), c(10)], [c("A"), c("Canada"), c(30)], [c("B"), c("France"), c(20)], [c("B"), c("Canada"), c(-5)]];
  it("adds an invisible line through the top of each stack, labelled with the sum, and a second one for the negative sums", () => {
    const v = visualOf("columnChart", { Category: [Cat], Series: [Country], Y: [Qty] });
    const none = build(v, grouped(v, rows)).option.series.length;
    fmt(v, "totals", "show", lit.bool(true));
    const one = build(v, grouped(v, rows)).option.series;
    expect(one).toHaveLength(none + 1);
    const carrier = one[one.length - 1];
    expect(carrier.name).toBe("");
    expect(carrier.lineStyle.opacity).toBe(0);
    expect(carrier.data.map((d: { raw: number }) => d.raw)).toEqual([40, 20]);
    fmt(v, "totals", "showPositiveAndNegative", lit.bool(true));
    const two = build(v, grouped(v, rows)).option.series;
    expect(two).toHaveLength(none + 2);
    expect(two[two.length - 1].data.map((d: { raw: number }) => d.raw)).toEqual([0, -5]);
  });
});
