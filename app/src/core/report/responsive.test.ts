import { describe, expect, it } from "vitest";
import { decodeCell } from "./cells";
import { buildChart } from "./chartOptions";
import type { Loaded } from "./dataLoader";
import { agg, column, lit } from "./fields";
import { buildVisualQuery } from "./queryBuilder";
import { fixtureModel, visualOf } from "./testFixture";
import { DEFAULT_THEME } from "./theme";
import { setFormat, type VisualModel } from "./visualDoc";

const model = fixtureModel();
const rows = [["Accessories", "France", "30"], ["Bikes", "Canada", "50"]];

function build(size: { width: number; height: number } | undefined, set: (v: VisualModel) => void = () => undefined, type = "clusteredColumnChart") {
  const v = visualOf(type, { Category: [column("Product", "Category")], Series: [column("Customer", "Country")], Y: [agg("Sales", "Quantity", 0)] });
  setFormat(v.json, "legend", "show", lit.bool(true));
  setFormat(v.json, "categoryAxis", "showAxisTitle", lit.bool(true));
  setFormat(v.json, "valueAxis", "showAxisTitle", lit.bool(true));
  set(v);
  const loaded: Extract<Loaded, { kind: "grouped" }> = { kind: "grouped", query: buildVisualQuery(v, model, { filters: [] })!, rows: rows.map(([a, b, c]) => [decodeCell({ t: "text", v: a }), decodeCell({ t: "text", v: b }), decodeCell({ t: "int", v: c })]), highlightRows: null, totals: null, truncated: false, ms: 0 };
  return buildChart({ visual: v, loaded, theme: DEFAULT_THEME, selected: [], size })!.option;
}
const axisShown = (o: ReturnType<typeof build>, axis: "xAxis" | "yAxis") => ([] as { show?: boolean }[]).concat(o[axis])[0].show !== false;

describe("General > Responsive", () => {
  it("drops the legend, the axis titles and the axes of a small visual, as Desktop does", () => {
    const big = build({ width: 600, height: 400 });
    expect(big.legend.show).toBe(true);
    expect(axisShown(big, "xAxis")).toBe(true);
    const narrow = build({ width: 200, height: 400 });
    expect(([] as { name?: string }[]).concat(narrow.yAxis)[0].name ?? "").toBe("");
    expect(([] as { name?: string }[]).concat(big.yAxis)[0].name).toBeTruthy();
    const tiny = build({ width: 70, height: 60 });
    expect(tiny.legend.show).toBe(false);
    expect(axisShown(tiny, "xAxis")).toBe(false);
    expect(axisShown(tiny, "yAxis")).toBe(false);
  });
  it("moves a side legend to the top in a visual that is narrow", () => {
    const side = (size: { width: number; height: number }) => build(size, (v) => setFormat(v.json, "legend", "position", lit.str("Right")));
    expect(side({ width: 600, height: 400 }).legend.right).toBe(0);
    expect(side({ width: 200, height: 400 }).legend.top).toBe(0);
    expect(side({ width: 200, height: 400 }).legend.right).toBeUndefined();
  });
  it("does nothing when it is off, or when the size is not known", () => {
    expect(build({ width: 70, height: 60 }, (v) => setFormat(v.json, "general", "responsive", lit.bool(false))).legend.show).toBe(true);
    expect(build(undefined).legend.show).toBe(true);
  });
  it("applies the legacy rules, with their own thresholds, when Responsive is off and Responsive (legacy) on", () => {
    const legacy = (size: { width: number; height: number }) => build(size, (v) => { setFormat(v.json, "general", "responsive", lit.bool(false)); setFormat(v.json, "general", "responsiveLegacy", lit.bool(true)); });
    // the legend stays (legacy keeps it), the axes go at 58 px / 76 px
    expect(legacy({ width: 70, height: 60 }).legend.show).toBe(true);
    expect(axisShown(legacy({ width: 70, height: 60 }), "yAxis")).toBe(false);
    expect(axisShown(legacy({ width: 70, height: 60 }), "xAxis")).toBe(true);
    expect(axisShown(legacy({ width: 300, height: 50 }), "xAxis")).toBe(false);
  });
});
