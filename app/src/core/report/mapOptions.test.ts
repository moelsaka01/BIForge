import { beforeAll, describe, expect, it } from "vitest";
import { decodeCell } from "./cells";
import { buildChart } from "./chartOptions";
import type { Loaded } from "./dataLoader";
import { agg, column, lit } from "./fields";
import { loadGazetteer } from "./geo";
import { fitView, mixColor } from "./mapOptions";
import { buildVisualQuery } from "./queryBuilder";
import { fixtureModel, visualOf } from "./testFixture";
import { DEFAULT_THEME } from "./theme";
import { setFormat as set, type VisualModel } from "./visualDoc";

const model = fixtureModel();
const City = column("Customer", "City");
const Country = column("Customer", "Country");
const Qty = agg("Sales", "Quantity", 0);
const Price = agg("Sales", "UnitPrice", 1);

type Cell = [string, string];
const c = (v: string | number): Cell => [typeof v === "string" ? "text" : "int", String(v)];
function grouped(v: VisualModel, rows: Cell[][]): Extract<Loaded, { kind: "grouped" }> {
  const query = buildVisualQuery(v, model, { filters: [] })!;
  return { kind: "grouped", query, rows: rows.map((r) => r.map(([t, x]) => decodeCell({ t: t as never, v: x }))), highlightRows: null, totals: null, truncated: false, ms: 0 };
}
const build = (v: VisualModel, rows: Cell[][]) => buildChart({ visual: v, loaded: grouped(v, rows), theme: DEFAULT_THEME, selected: [] })!;

/** A copy of the visual with one more setting. */
function setFormat(v: VisualModel, object: string, prop: string, value: Parameters<typeof set>[3]): VisualModel {
  const copy = { ...v, json: structuredClone(v.json) };
  set(copy.json, object, prop, value);
  return copy;
}

beforeAll(async () => {
  await loadGazetteer();
});

describe("heat map and map tools", () => {
  const rows = [[c("Seattle"), c(30)], [c("Lyon"), c(50)], [c("Paris"), c(70)]];
  const v = () => visualOf("map", { Category: [City], Size: [Qty] });

  it("the heat map replaces the bubbles with one density series colored by the three heat colors, sized in pixels or meters", () => {
    const off = build(v(), rows);
    expect(off.option.series[0].type).toBe("scatter");
    let m = setFormat(v(), "heatMap", "show", lit.bool(true));
    m = setFormat(m, "heatMap", "filterRadius", lit.num(33));
    m = setFormat(m, "heatMap", "color0", lit.str("#000001"));
    m = setFormat(m, "heatMap", "color50", lit.str("#000002"));
    m = setFormat(m, "heatMap", "color100", lit.str("#000003"));
    const on = build(m, rows);
    expect(on.option.series.map((s: { type: string }) => s.type)).toEqual(["heatmap"]);
    expect(on.option.series[0].coordinateSystem).toBe("geo");
    expect(on.option.series[0].pointSize).toBe(33);
    expect(on.option.series[0].data).toHaveLength(3);
    expect(on.option.visualMap.inRange.color).toEqual(["#000001", "#000002", "#000003"]);
    expect(on.option.visualMap.min).toBe(30);
    expect(on.option.visualMap.max).toBe(70);
    expect(on.option.legend.show).toBe(false);
    const meters = build(setFormat(m, "heatMap", "unit", lit.str("meters")), rows);
    expect(meters.option.series[0].pointSize).toBeLessThan(33); // 33 m on the ground is a fraction of a pixel on a world map
    expect(build(setFormat(m, "heatMap", "transparency", lit.num(50)), rows).option.series[0].itemStyle.opacity).toBeCloseTo(0.5, 2);
  });

  it("the map tools exist only when asked for and list where the points are", () => {
    expect(build(v(), rows).mapTools).toBeUndefined();
    const t = build(setFormat(setFormat(v(), "mapControls", "showZoomButtons", lit.bool(true)), "mapControls", "showLassoButton", lit.bool(true)), rows).mapTools!;
    expect(t.zoom && t.lasso).toBe(true);
    expect(t.points).toHaveLength(3);
    expect(t.points[0]).toMatchObject({ series: 0, index: 0 });
    expect(t.points[0].lon).toBeCloseTo(-122.34, 1);
    expect(build(setFormat(v(), "mapControls", "showZoomButtons", lit.bool(true)), rows).mapTools).toMatchObject({ zoom: true, lasso: false });
  });
});

describe("bubble map", () => {
  const rows = [[c("Seattle"), c(30)], [c("Lyon"), c(50)], [c("Atlantis"), c(99)], [c("Paris"), c(70)]];

  it("places each city at its location, sizes bubbles by value, and lists the places it could not find", () => {
    const v = visualOf("map", { Category: [City], Size: [Qty] });
    const b = build(v, rows);
    const s = b.option.series[0];
    expect(s.type).toBe("scatter");
    expect(s.coordinateSystem).toBe("geo");
    expect(b.count).toBe(3);
    expect(s.data.map((d: unknown[]) => d[3])).toEqual(["Seattle", "Lyon", "Paris"]);
    expect(s.data[0][0]).toBeCloseTo(-122.34, 1);
    expect(s.data[0][1]).toBeCloseTo(47.57, 1);
    expect(b.notice).toMatch(/1 location not drawn.*Atlantis/);
    // the largest value has the largest bubble
    const size = s.symbolSize as (d: number[]) => number;
    expect(size(s.data[2])).toBeGreaterThan(size(s.data[1]));
    expect(size(s.data[1])).toBeGreaterThan(size(s.data[0]));
    // a click selects the location
    expect(b.pointAt(0, 1)).toEqual({ fields: [City], values: [lit.str("Lyon")] });
    expect(b.pointAt(0, 9)).toBeNull();
  });

  it("bubble size scales the bubbles, and series split into colored groups", () => {
    const v = visualOf("map", { Category: [City], Series: [Country], Size: [Qty] });
    const b = build(v, [[c("Seattle"), c("United States"), c(30)], [c("Lyon"), c("France"), c(50)], [c("Paris"), c("France"), c(70)]]);
    expect(b.option.series.map((s: { name: string }) => s.name)).toEqual(["United States", "France"]);
    expect(b.pointAt(1, 1)).toEqual({ fields: [City, Country], values: [lit.str("Paris"), lit.str("France")] });
    const small = setFormat(v, "bubbles", "bubbleSize", lit.num(5));
    const big = setFormat(v, "bubbles", "bubbleSize", lit.num(40));
    const sizeOf = (x: VisualModel) => build(x, [[c("Lyon"), c("France"), c(50)]]).option.series[0].symbolSize([0, 0, 50]) as number;
    expect(sizeOf(big)).toBeGreaterThan(sizeOf(small) * 4);
  });

  it("longitude and latitude values place the points without a name", () => {
    const v = visualOf("map", { Category: [City], X: [Qty], Y: [Price] });
    const b = build(v, [[c("Somewhere"), c(10), c(50)], [c("Nowhere"), c(500), c(50)]]);
    expect(b.count).toBe(1); // 500 is not a longitude and the name is unknown
    expect(b.option.series[0].data[0].slice(0, 2)).toEqual([10, 50]);
    expect(b.notice).toMatch(/Nowhere/);
  });

  it("the view fits the points, unless the zoom is chosen", () => {
    const fit = fitView([{ lon: 2, lat: 48 }, { lon: 4.8, lat: 45.7 }]);
    expect(fit.zoom).toBeGreaterThan(5);
    expect(fit.center[0]).toBeCloseTo(3.4, 1);
    expect(fitView([]).zoom).toBe(1);
    const v = visualOf("map", { Category: [City], Size: [Qty] });
    const auto = build(v, [[c("Lyon"), c(1)], [c("Paris"), c(2)]]).option.geo;
    expect(auto.zoom).toBeGreaterThan(5);
    const fixed = setFormat(setFormat(v, "mapControls", "autoZoom", lit.bool(false)), "mapControls", "zoomLevel", lit.num(2));
    expect(build(fixed, [[c("Lyon"), c(1)]]).option.geo.zoom).toBe(2);
  });

  it("the map style sets sea and land colors", () => {
    const v = visualOf("map", { Category: [City], Size: [Qty] });
    const dark = build(setFormat(v, "mapStyles", "mapTheme", lit.str("canvasDark")), [[c("Lyon"), c(1)]]).option;
    const light = build(v, [[c("Lyon"), c(1)]]).option;
    expect(dark.backgroundColor).not.toBe(light.backgroundColor);
    expect(dark.geo.itemStyle.areaColor).not.toBe(light.geo.itemStyle.areaColor);
  });
});

describe("filled map", () => {
  it("colors the countries by value and registers them by their region name", () => {
    const v = visualOf("filledMap", { Category: [Country], Size: [Qty] });
    const b = build(v, [[c("France"), c(30)], [c("United States"), c(90)], [c("Germany"), c(60)], [c("Narnia"), c(5)]]);
    const s = b.option.series[0];
    expect(s.type).toBe("map");
    expect(s.map).toBe("world");
    expect(s.data.map((d: { name: string }) => d.name)).toEqual(["France", "United States of America", "Germany"]);
    const colorOf = (name: string) => s.data.find((d: { name: string }) => d.name === name).itemStyle.areaColor as string;
    // the smallest value is the lightest color, the largest the darkest
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(colorOf("United States of America"))).toBeLessThan(lum(colorOf("Germany")));
    expect(lum(colorOf("Germany"))).toBeLessThan(lum(colorOf("France")));
    expect(b.notice).toMatch(/Narnia/);
    expect(b.pointAt(0, 1)).toEqual({ fields: [Country], values: [lit.str("United States")] });
  });

  it("states of the US use the states map; a fixed color and the outline are format settings", () => {
    const v = visualOf("filledMap", { Category: [Country], Size: [Qty] });
    const b = build(v, [[c("Washington"), c(30)], [c("Oregon"), c(50)], [c("France"), c(10)]]);
    expect(b.option.series[0].map).toBe("states");
    expect(b.option.series[0].data.map((d: { name: string }) => d.name)).toEqual(["Washington", "Oregon"]);
    expect(b.notice).toMatch(/France/); // a country on a map of states is not drawn, and the person is told
    const styled = setFormat(setFormat(v, "stroke", "strokeColor", lit.str("#aa0000")), "stroke", "strokeWidth", lit.num(3));
    const d = build(styled, [[c("France"), c(1)]]).option.series[0].data[0].itemStyle;
    expect(d.borderColor).toBe("#aa0000");
    expect(d.borderWidth).toBe(3);
    const off = build(setFormat(v, "stroke", "show", lit.bool(false)), [[c("France"), c(1)]]).option.series[0].data[0].itemStyle;
    expect(off.borderWidth).toBe(0);
  });

  it("mixes colors", () => {
    expect(mixColor("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColor("#000", "#ff0000", 1)).toBe("#ff0000");
    expect(mixColor("red", "#ff0000", 0.5)).toBe("#ff0000");
  });
});

describe("tooltip look (Format > General > Tooltips)", () => {
  const v = () => visualOf("map", { Category: [City], Size: [Qty] });
  const rows = [[c("Seattle"), c(30)]];
  const apply = (props: [string, Parameters<typeof set>[3]][]) => props.reduce((m, [p, val]) => setFormat(m, "visualTooltip", p, val), v());

  it("background, transparency, fonts and colors reach the chart tooltip; the switch hides it", () => {
    const plain = build(v(), rows).option.tooltip;
    expect(plain.backgroundColor).toBeUndefined();
    const t = build(apply([["background", lit.str("#102030")], ["transparency", lit.num(50)], ["fontSize", lit.num(18)], ["fontFamily", lit.str("Courier New")], ["bold", lit.bool(true)], ["italic", lit.bool(true)], ["titleFontColor", lit.str("#ff0000")], ["underline", lit.bool(true)]]), rows).option.tooltip;
    expect(t.backgroundColor).toBe("color-mix(in srgb, #102030 50%, transparent)");
    expect(t.textStyle).toEqual({ color: "#ff0000", fontFamily: "Courier New", fontSize: 18, fontWeight: "bold", fontStyle: "italic" });
    expect(t.extraCssText).toContain("underline");
    expect(build(apply([["show", lit.bool(false)]]), rows).option.tooltip).toEqual({ show: false });
  });

  it("values can be un-bolded or colored", () => {
    const sample = { marker: "", data: ["", "", 30, "Seattle"], seriesName: "S" };
    expect(build(v(), rows).option.tooltip.formatter(sample)).toContain("<b>");
    const plain = build(apply([["showValuesInBold", lit.bool(false)]]), rows).option.tooltip.formatter(sample);
    expect(plain).not.toContain("<b>");
    expect(plain).toContain("30");
    expect(build(apply([["valueFontColor", lit.str("#00ff00")]]), rows).option.tooltip.formatter(sample)).toContain('<b style="color:#00ff00">');
  });
});

describe("filled map: Map styles > Show labels", () => {
  it("names the regions in a small label when no data labels are on", () => {
    const v = visualOf("filledMap", { Category: [Country], Size: [Qty] });
    const rows = [[c("France"), c(50)], [c("Canada"), c(10)]];
    const off = build(v, rows).option.series[0].label;
    const on = build(setFormat(v, "mapStyles", "showLabels", lit.bool(true)), rows).option.series[0].label;
    expect(off.show).toBe(false);
    expect(on).toMatchObject({ show: true, fontSize: 9 });
    // a region without data is named by itself
    expect(on.formatter({ name: "Peru" })).toBe("Peru");
  });
});
