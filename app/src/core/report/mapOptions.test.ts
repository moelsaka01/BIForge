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
