import { describe, expect, it } from "vitest";
import { column, lit } from "./fields";
import { drillthroughFilters, drillthroughTargets, filtersFor, isSelectable, resolveInteraction, selectionTuples, supportsHighlight, toggleSelection, type SelectedPoint } from "./interactions";
import * as ops from "./reportOps";
import { fixtureProject } from "./testFixture";
import { parsePage, type PageModel } from "./visualDoc";
import { agg } from "./fields";

const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Qty = agg("Sales", "Quantity", 0);
let n = 0;
const id = () => `v${++n}`;

function setup() {
  n = 0;
  const p = fixtureProject();
  const col = ops.addVisual(p, "page1", "clusteredColumnChart", { newId: id, fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
  const table = ops.addVisual(p, "page1", "tableEx", { newId: id, fields: [{ role: "Values", field: Country }] });
  const card = ops.addVisual(p, "page1", "card", { newId: id, fields: [{ role: "Values", field: Qty }] });
  const slicer = ops.addVisual(p, "page1", "slicer", { newId: id, fields: [{ role: "Values", field: Country }] });
  const col2 = ops.addVisual(p, "page1", "lineChart", { newId: id, fields: [{ role: "Category", field: column("Date", "YearMonth") }, { role: "Y", field: Qty }] });
  const page = () => parsePage(p, "page1")!;
  const v = (name: string) => page().visuals.find((x) => x.name === name)!;
  return { p, col, table, card, slicer, col2, page, v };
}

describe("which interaction applies", () => {
  it("charts highlight charts that can, everything else is filtered", () => {
    const s = setup();
    const page = s.page();
    expect(resolveInteraction(page, s.v(s.col), s.v(s.col2))).toBe("highlight");
    expect(resolveInteraction(page, s.v(s.col), s.v(s.table))).toBe("filter");
    expect(resolveInteraction(page, s.v(s.col), s.v(s.card))).toBe("filter");
    expect(resolveInteraction(page, s.v(s.table), s.v(s.col))).toBe("filter");
    expect(resolveInteraction(page, s.v(s.col), s.v(s.col))).toBe("none");
  });

  it("explicit settings win; highlight falls back to filter where it is not supported", () => {
    const s = setup();
    ops.setInteraction(s.p, "page1", s.col, s.col2, "NoFilter");
    ops.setInteraction(s.p, "page1", s.col, s.table, "HighlightFilter");
    ops.setInteraction(s.p, "page1", s.table, s.col, "DataFilter");
    const page = s.page();
    expect(resolveInteraction(page, s.v(s.col), s.v(s.col2))).toBe("none");
    expect(resolveInteraction(page, s.v(s.col), s.v(s.table))).toBe("filter");
    expect(resolveInteraction(page, s.v(s.table), s.v(s.col))).toBe("filter");
    expect(supportsHighlight("pieChart")).toBe(true);
    expect(supportsHighlight("tableEx")).toBe(false);
    expect(isSelectable("tableEx") && isSelectable("pivotTable") && isSelectable("clusteredBarChart")).toBe(true);
    expect(isSelectable("card") || isSelectable("slicer")).toBe(false);
  });
});

describe("filters that reach a visual", () => {
  it("combines report, page, own and slicer filters; a slicer ignores its own selection", () => {
    const s = setup();
    const f = (name: string, field = Cat, v = "x") => ({ name, field, cond: { kind: "in" as const, values: [lit.str(v)] } });
    ops.upsertFilter(s.p, { level: "report" }, f("r", Cat, "R"));
    ops.upsertFilter(s.p, { level: "page", page: "page1" }, f("p", Cat, "P"));
    ops.upsertFilter(s.p, { level: "visual", page: "page1", visual: s.col }, f("v", Cat, "V"));
    ops.upsertFilter(s.p, { level: "visual", page: "page1", visual: s.slicer }, f("s", Country, "S"));
    const page = s.page();
    const names = (vis: string) => filtersFor(s.p, page, s.v(vis), { drillthrough: [] }).map((x) => x.name);
    expect(names(s.col)).toEqual(["r", "p", "v", "s"]);
    expect(names(s.slicer)).toEqual(["r", "p"]);
    ops.setInteraction(s.p, "page1", s.slicer, s.card, "NoFilter");
    expect(filtersFor(s.p, s.page(), s.v(s.card), { drillthrough: [] }).map((x) => x.name)).toEqual(["r", "p"]);
  });

  it("drillthrough filters are added and empty selections are ignored", () => {
    const s = setup();
    const extra = { name: "dt", field: Cat, cond: { kind: "in" as const, values: [lit.str("Bikes")] } };
    expect(filtersFor(s.p, s.page(), s.v(s.col), { drillthrough: [extra] }).map((x) => x.name)).toEqual(["dt"]);
    ops.upsertFilter(s.p, { level: "page", page: "page1" }, { name: "empty", field: Cat, cond: { kind: "in", values: [] } });
    expect(filtersFor(s.p, s.page(), s.v(s.col), { drillthrough: [] })).toEqual([]);
  });
});

describe("selection", () => {
  const pt = (c: string, k = "Bikes"): SelectedPoint => ({ fields: [Cat, Country], values: [lit.str(k), lit.str(c)] });

  it("click selects, ctrl-click toggles, clicking the only selected point clears", () => {
    let sel = toggleSelection(null, "page1", "a", pt("France"), false);
    expect(sel?.points).toHaveLength(1);
    sel = toggleSelection(sel, "page1", "a", pt("Canada"), true);
    expect(sel?.points).toHaveLength(2);
    sel = toggleSelection(sel, "page1", "a", pt("France"), true);
    expect(sel?.points.map((p) => p.values[1])).toEqual([lit.str("Canada")]);
    sel = toggleSelection(sel, "page1", "a", pt("Canada"), false);
    expect(sel).toBeNull();
    expect(toggleSelection(null, "page1", "a", pt("France"), true)?.points).toHaveLength(1);
  });

  it("a click in another visual replaces the selection", () => {
    const sel = toggleSelection(toggleSelection(null, "page1", "a", pt("France"), false), "page1", "b", pt("Canada"), true);
    expect(sel?.visual).toBe("b");
    expect(sel?.points).toHaveLength(1);
  });

  it("tuples for targets", () => {
    const sel = toggleSelection(toggleSelection(null, "page1", "a", pt("France"), false), "page1", "a", pt("Canada"), true);
    expect(selectionTuples(sel, "filter")).toEqual([{ fields: [Cat, Country], rows: [[lit.str("Bikes"), lit.str("France")], [lit.str("Bikes"), lit.str("Canada")]] }]);
    expect(selectionTuples(sel, "none")).toEqual([]);
    expect(selectionTuples(null, "filter")).toEqual([]);
  });
});

describe("drillthrough", () => {
  it("offers pages whose fields the clicked point supplies, and filters by the point's values", () => {
    const s = setup();
    const d1 = ops.addPage(s.p, "Detail", { newId: id, type: "Drillthrough" });
    ops.setDrillthroughFields(s.p, d1, [Country]);
    const d2 = ops.addPage(s.p, "Needs both", { newId: id, type: "Drillthrough" });
    ops.setDrillthroughFields(s.p, d2, [Country, column("Customer", "City")]);
    const names = ["page1", d1, d2];
    const point: SelectedPoint = { fields: [Cat, Country], values: [lit.str("Bikes"), lit.str("France")] };
    const targets = drillthroughTargets(s.p, names, point);
    expect(targets.map((t) => t.displayName)).toEqual(["Detail"]);
    expect(drillthroughFilters(targets[0], point)).toEqual([{ name: "drillthrough0", field: Country, cond: { kind: "in", values: [lit.str("France")] } }]);
    const none = drillthroughTargets(s.p, names, { fields: [Cat], values: [lit.str("Bikes")] });
    expect(none).toEqual([]);
    const p: PageModel = parsePage(s.p, d1)!;
    expect(p.type).toBe("Drillthrough");
  });
});
