import { describe, expect, it } from "vitest";
import { DocumentStore } from "../store/documentStore";
import { agg, column, lit, measure } from "./fields";
import { fixtureProject } from "./testFixture";
import * as ops from "./reportOps";
import { activePageName, getFormat, listPageNames, listPages, parsePage, parseVisual, visualKey } from "./visualDoc";

let n = 0;
const id = () => `id${++n}`;
const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);

const fresh = () => {
  n = 0;
  return fixtureProject();
};
const vis = (p: ReturnType<typeof fresh>, v: string) => parseVisual("page1", p.report.files[visualKey("page1", v)])!;

describe("pages", () => {
  it("adds, renames, orders, activates and deletes pages", () => {
    const p = fresh();
    const b = ops.addPage(p, undefined, { newId: id });
    expect(listPageNames(p)).toEqual(["page1", b]);
    expect(parsePage(p, b)!.displayName).toBe("Page 2");
    ops.addPage(p, "Page 2", { newId: id });
    expect(listPages(p).map((x) => x.displayName)).toEqual(["Page 1", "Page 2", "Page 2 2"]);
    ops.renamePage(p, b, "Overview");
    expect(() => ops.renamePage(p, "page1", "overview")).toThrow(/already exists/);
    expect(() => ops.renamePage(p, "page1", "  ")).toThrow(/needs a name/);
    ops.movePage(p, b, 0);
    expect(listPageNames(p)[0]).toBe(b);
    ops.setActivePage(p, b);
    expect(activePageName(p)).toBe(b);
    ops.deletePage(p, b);
    expect(activePageName(p)).toBe("page1");
    ops.deletePage(p, listPageNames(p)[1]);
    expect(() => ops.deletePage(p, "page1")).toThrow(/at least one page/);
    expect(() => ops.setActivePage(p, "nope")).toThrow(/does not exist/);
  });

  it("deleting a page removes its visuals and files", () => {
    const p = fresh();
    const pg = ops.addPage(p, "Two", { newId: id });
    ops.addVisual(p, pg, "card", { newId: id });
    ops.deletePage(p, pg);
    expect(Object.keys(p.report.files).filter((k) => k.includes(pg))).toEqual([]);
  });

  it("duplicates a page with new visual names and remapped interactions", () => {
    const p = fresh();
    const a = ops.addVisual(p, "page1", "clusteredColumnChart", { newId: id, fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    const b = ops.addVisual(p, "page1", "card", { newId: id });
    ops.setInteraction(p, "page1", a, b, "NoFilter");
    const copy = ops.duplicatePage(p, "page1", id);
    const pg = parsePage(p, copy)!;
    expect(pg.displayName).toBe("Page 1 (copy)");
    expect(pg.visuals).toHaveLength(2);
    expect(pg.visuals.map((v) => v.name)).not.toContain(a);
    expect(pg.visuals.find((v) => v.visualType === "clusteredColumnChart")!.roles.Y[0].field).toEqual(Qty);
    expect(pg.interactions).toHaveLength(1);
    expect(pg.interactions[0].source).not.toBe(a);
    expect(parsePage(p, "page1")!.interactions[0].source).toBe(a);
  });

  it("tooltip and drillthrough pages", () => {
    const p = fresh();
    const t = ops.addPage(p, undefined, { newId: id, type: "Tooltip" });
    const pj = parsePage(p, t)!;
    expect([pj.type, pj.width, pj.height]).toEqual(["Tooltip", 320, 240]);
    const d = ops.addPage(p, undefined, { newId: id, type: "Drillthrough" });
    ops.setDrillthroughFields(p, d, [Cat]);
    const dj = p.report.files[`pages/${d}/page.json`] as { pageBinding: { type: string; parameters: { boundFilter: string }[] } };
    expect(dj.pageBinding.type).toBe("Drillthrough");
    expect(dj.pageBinding.parameters).toHaveLength(1);
    expect(parsePage(p, d)!.filters.defs.map((f) => f.field)).toEqual([Cat]);
    ops.setDrillthroughFields(p, d, []);
    expect(parsePage(p, d)!.filters.defs).toEqual([]);
    expect(() => ops.setDrillthroughFields(p, "page1", [Cat])).toThrow(/Only a drillthrough/);
    ops.setPageType(p, d, null);
    expect(parsePage(p, d)!.type).toBeUndefined();
    expect(() => ops.setPageSize(p, "page1", 10, 10)).toThrow(/between/);
    ops.setPageSize(p, "page1", 1000, 500.4);
    expect(parsePage(p, "page1")!.height).toBe(500);
  });
});

describe("visuals", () => {
  it("adds fields to the default wells and enforces well rules", () => {
    const p = fresh();
    const v = ops.addVisual(p, "page1", "clusteredColumnChart", { newId: id });
    expect(ops.addField(p, "page1", v, null, Cat)).toBe("Category");
    expect(ops.addField(p, "page1", v, null, Qty)).toBe("Y");
    expect(ops.addField(p, "page1", v, null, column("Customer", "Country"))).toBe("Category");
    expect(() => ops.addField(p, "page1", v, "Category", Cat)).toThrow(/already/);
    expect(() => ops.addField(p, "page1", v, "Y", column("Sales", "Channel"))).toThrow(/measures or aggregated/);
    expect(() => ops.addField(p, "page1", v, "Category", measure("Sales", "Total"))).toThrow(/grouping fields/);
    expect(() => ops.addField(p, "page1", v, "Nope", Cat)).toThrow(/no field well/);
    expect(vis(p, v).roles.Category.map((x) => x.field.name)).toEqual(["Category", "Country"]);
    ops.moveField(p, "page1", v, "Category", 0, 1);
    expect(vis(p, v).roles.Category.map((x) => x.field.name)).toEqual(["Country", "Category"]);
    ops.removeField(p, "page1", v, "Category", 0);
    expect(vis(p, v).roles.Category.map((x) => x.field.name)).toEqual(["Category"]);
    ops.removeField(p, "page1", v, "Category", 0);
    expect(vis(p, v).roles.Category).toBeUndefined();
  });

  it("a single-field well is replaced; a full well refuses", () => {
    const p = fresh();
    const v = ops.addVisual(p, "page1", "card", { newId: id });
    ops.addField(p, "page1", v, null, Qty);
    ops.addField(p, "page1", v, null, agg("Sales", "UnitPrice", 1));
    expect(vis(p, v).roles.Values.map((x) => x.field)).toEqual([agg("Sales", "UnitPrice", 1)]);
    const t = ops.addVisual(p, "page1", "kpi", { newId: id });
    ops.addField(p, "page1", t, "Indicator", Qty);
    ops.addField(p, "page1", t, "Indicator", agg("Sales", "UnitPrice", 1));
    expect(vis(p, t).roles.Indicator).toHaveLength(1);
    const m = ops.addVisual(p, "page1", "pivotTable", { newId: id });
    const cols = ["Category", "Subcategory", "Color", "Product"].map((c) => column("Product", c)).concat([column("Customer", "City"), column("Customer", "Country")]);
    for (const c of cols) ops.addField(p, "page1", m, "Rows", c);
    expect(() => ops.addField(p, "page1", m, "Rows", column("Customer", "Segment"))).toThrow(/at most 6/);
  });

  it("changes the aggregation, display name and sort; removing a field drops its sort", () => {
    const p = fresh();
    const v = ops.addVisual(p, "page1", "clusteredColumnChart", { newId: id, fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    ops.setAggregation(p, "page1", v, "Y", 0, 1);
    ops.renameField(p, "page1", v, "Y", 0, "Avg qty");
    expect(vis(p, v).roles.Y[0]).toEqual({ field: agg("Sales", "Quantity", 1), displayName: "Avg qty" });
    expect(() => ops.setAggregation(p, "page1", v, "Y", 0, 42)).toThrow(/Unknown summarization/);
    expect(() => ops.setAggregation(p, "page1", v, "Category", 5, 1)).toThrow(/Only columns/);
    ops.setSort(p, "page1", v, { field: agg("Sales", "Quantity", 1), dir: "desc" });
    expect(vis(p, v).sort).toEqual({ field: agg("Sales", "Quantity", 1), dir: "desc" });
    ops.removeField(p, "page1", v, "Y", 0);
    expect(vis(p, v).sort).toBeNull();
  });

  it("switching the visual type keeps compatible fields", () => {
    const p = fresh();
    const v = ops.addVisual(p, "page1", "clusteredColumnChart", { newId: id, fields: [{ role: "Category", field: Cat }, { role: "Series", field: column("Customer", "Country") }, { role: "Y", field: Qty }] });
    ops.setVisualType(p, "page1", v, "pieChart");
    expect(vis(p, v).visualType).toBe("pieChart");
    expect(Object.fromEntries(Object.entries(vis(p, v).roles).map(([r, l]) => [r, l.map((x) => x.field.name)]))).toEqual({ Category: ["Category"], Y: ["Quantity"] });
    ops.setVisualType(p, "page1", v, "tableEx");
    expect(vis(p, v).roles.Values.map((x) => x.field.name)).toEqual(["Category", "Quantity"]);
    expect(() => ops.setVisualType(p, "page1", v, "nope")).toThrow(/Unknown visual type/);
  });

  it("moves, resizes and stacks visuals", () => {
    const p = fresh();
    const a = ops.addVisual(p, "page1", "card", { newId: id });
    const b = ops.addVisual(p, "page1", "card", { newId: id });
    ops.setPosition(p, "page1", a, { x: 10.123, y: 20, width: 111, height: 222 });
    expect(vis(p, a).position).toMatchObject({ x: 10.12, y: 20, width: 111, height: 222 });
    expect(() => ops.setPosition(p, "page1", a, { width: 5 })).toThrow(/at least 20/);
    ops.arrange(p, "page1", a, "front");
    expect(vis(p, a).position.z).toBeGreaterThan(vis(p, b).position.z);
    ops.arrange(p, "page1", a, "back");
    expect(vis(p, a).position.z).toBeLessThan(vis(p, b).position.z);
    ops.setHidden(p, "page1", a, true);
    expect(vis(p, a).hidden).toBe(true);
    ops.deleteVisual(p, "page1", a);
    expect(parsePage(p, "page1")!.visuals.map((v) => v.name)).toEqual([b]);
  });

  it("formatting properties go where Power BI keeps them", () => {
    const p = fresh();
    const v = ops.addVisual(p, "page1", "clusteredColumnChart", { newId: id });
    ops.setVisualFormat(p, "page1", v, "title", "text", lit.str("Sales"));
    ops.setVisualFormat(p, "page1", v, "legend", "show", lit.bool(false));
    ops.setVisualFormat(p, "page1", v, "dataPoint", "fill", lit.str("#ff0000"), "Sum(Sales.Quantity)");
    const j = p.report.files[visualKey("page1", v)] as { visual: Record<string, Record<string, unknown>> };
    expect(Object.keys(j.visual.visualContainerObjects)).toEqual(["title"]);
    expect(Object.keys(j.visual.objects).sort()).toEqual(["dataPoint", "legend"]);
    expect(j.visual.objects.dataPoint).toEqual([{ selector: { metadata: "Sum(Sales.Quantity)" }, properties: { fill: { solid: { color: { expr: { Literal: { Value: "'#ff0000'" } } } } } } }]);
    expect(getFormat(j, "title", "text")).toEqual(lit.str("Sales"));
    expect(getFormat(j, "dataPoint", "fill", "Sum(Sales.Quantity)")).toEqual(lit.str("#ff0000"));
    ops.setVisualFormat(p, "page1", v, "legend", "show", null);
    expect(j.visual.objects.legend).toBeUndefined();
  });
});

describe("filters and interactions", () => {
  it("report, page and visual filters are separate", () => {
    const p = fresh();
    const v = ops.addVisual(p, "page1", "card", { newId: id });
    const f = { name: "f", field: Cat, cond: { kind: "in" as const, values: [lit.str("Bikes")] } };
    ops.upsertFilter(p, { level: "report" }, f);
    ops.upsertFilter(p, { level: "page", page: "page1" }, f);
    ops.upsertFilter(p, { level: "visual", page: "page1", visual: v }, f);
    ops.upsertFilter(p, { level: "visual", page: "page1", visual: v }, { ...f, cond: { kind: "in", values: [lit.str("Clothing")] } });
    expect(ops.getFilters(p, { level: "visual", page: "page1", visual: v })[0].cond).toEqual({ kind: "in", values: [lit.str("Clothing")] });
    expect(ops.getFilters(p, { level: "page", page: "page1" })[0].cond).toEqual(f.cond);
    ops.removeFilter(p, { level: "report" }, "f");
    expect(ops.getFilters(p, { level: "report" })).toEqual([]);
    expect(Object.keys(p.report.files["report.json"] as object)).toEqual(["themeCollection"]);
  });

  it("interaction settings; default removes the entry; deleting a visual removes its entries", () => {
    const p = fresh();
    const a = ops.addVisual(p, "page1", "card", { newId: id });
    const b = ops.addVisual(p, "page1", "card", { newId: id });
    ops.setInteraction(p, "page1", a, b, "HighlightFilter");
    ops.setInteraction(p, "page1", a, b, "NoFilter");
    expect(parsePage(p, "page1")!.interactions).toEqual([{ source: a, target: b, type: "NoFilter" }]);
    ops.setInteraction(p, "page1", a, b, "Default");
    expect(parsePage(p, "page1")!.interactions).toEqual([]);
    ops.setInteraction(p, "page1", a, b, "DataFilter");
    ops.deleteVisual(p, "page1", b);
    expect(parsePage(p, "page1")!.interactions).toEqual([]);
    expect(() => ops.setInteraction(p, "page1", a, "ghost", "NoFilter")).toThrow(/does not exist/);
  });
});

describe("through the document store", () => {
  it("a failing edit changes nothing; a good edit is one undo step", () => {
    const store = new DocumentStore();
    store.load(fresh());
    expect(() => store.transact("Bad", (d) => ops.addVisual(d, "page1", "nope"))).toThrow();
    expect(store.getSnapshot().canUndo).toBe(false);
    store.transact("Add visual", (d) => {
      ops.addVisual(d, "page1", "card");
    });
    expect(parsePage(store.project!, "page1")!.visuals).toHaveLength(1);
    store.undo();
    expect(parsePage(store.project!, "page1")!.visuals).toHaveLength(0);
  });
});
