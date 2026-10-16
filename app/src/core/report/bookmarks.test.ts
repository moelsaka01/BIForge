import { describe, expect, it } from "vitest";
import { applyBookmark, createBookmark, deleteBookmark, listBookmarks, moveBookmark, renameBookmark, setBookmarkOptions, updateBookmark } from "./bookmarks";
import { agg, column, lit } from "./fields";
import { ReportRuntime } from "./runtime";
import * as ops from "./reportOps";
import { fixtureProject } from "./testFixture";
import { parsePage } from "./visualDoc";

const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Qty = agg("Sales", "Quantity", 0);
let n = 0;
const id = () => `b${++n}`;

function setup() {
  n = 0;
  const p = fixtureProject();
  const chart = ops.addVisual(p, "page1", "clusteredColumnChart", { newId: id, fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
  const slicer = ops.addVisual(p, "page1", "slicer", { newId: id, fields: [{ role: "Values", field: Country }] });
  const pick = (v: string) => ({ name: "sl", field: Country, cond: { kind: "in" as const, values: [lit.str(v)] } });
  return { p, chart, slicer, pick };
}
const rt = { selection: null, drill: {} };

describe("bookmarks", () => {
  it("captures slicer selections and hidden visuals, and applies them again", () => {
    const s = setup();
    ops.upsertFilter(s.p, { level: "visual", page: "page1", visual: s.slicer }, s.pick("France"));
    ops.upsertFilter(s.p, { level: "page", page: "page1" }, { name: "pf", field: Cat, cond: { kind: "in", values: [lit.str("Bikes")] } });
    const b = createBookmark(s.p, "France view", "page1", rt, undefined, id);
    // change everything
    ops.upsertFilter(s.p, { level: "visual", page: "page1", visual: s.slicer }, s.pick("Japan"));
    ops.removeFilter(s.p, { level: "page", page: "page1" }, "pf");
    ops.setHidden(s.p, "page1", s.chart, true);
    const applied = applyBookmark(s.p, b, "page1");
    expect(applied.page).toBe("page1");
    expect(ops.getFilters(s.p, { level: "visual", page: "page1", visual: s.slicer })[0].cond).toEqual({ kind: "in", values: [lit.str("France")] });
    expect(ops.getFilters(s.p, { level: "page", page: "page1" }).map((f) => f.name)).toEqual(["pf"]);
    expect(parsePage(s.p, "page1")!.visuals.find((v) => v.name === s.chart)!.hidden).toBe(false);
  });

  it("stores the bookmark in the PBIR layout with the hidden visuals in the display state", () => {
    const s = setup();
    ops.setHidden(s.p, "page1", s.chart, true);
    const b = createBookmark(s.p, "Hidden chart", "page1", rt, undefined, id);
    const f = s.p.report.files[`bookmarks/${b}.bookmark.json`] as { displayName: string; explorationState: { activeSection: string; sections: Record<string, { visualContainers: Record<string, { singleVisual: { display: { mode: string } } }> }> } };
    expect(f.displayName).toBe("Hidden chart");
    expect(f.explorationState.activeSection).toBe("page1");
    expect(f.explorationState.sections.page1.visualContainers[s.chart].singleVisual.display.mode).toBe("hidden");
    expect((s.p.report.files["bookmarks/bookmarks.json"] as { items: { name: string }[] }).items).toEqual([{ name: b }]);
    expect(listBookmarks(s.p)).toEqual([{ id: b, name: "Hidden chart", page: "page1", options: { data: true, display: true, currentPage: false } }]);
  });

  it("restores drill and selection into the runtime", () => {
    const s = setup();
    const runtime = new ReportRuntime();
    runtime.goToPage("page1");
    runtime.drillDown(s.chart, 2, lit.str("Bikes"));
    runtime.select("page1", s.slicer, { fields: [Cat], values: [lit.str("Bikes")] }, false);
    const b = createBookmark(s.p, "Drilled", "page1", { selection: runtime.getSnapshot().selection, drill: runtime.getSnapshot().drill }, undefined, id);
    runtime.clearSelection();
    runtime.resetDrill(s.chart);
    const a = applyBookmark(s.p, b, "page1");
    runtime.restore({ page: a.page, selection: a.runtime!.selection, drill: a.runtime!.drill });
    expect(runtime.getSnapshot().selection?.points[0].values).toEqual([lit.str("Bikes")]);
    expect(runtime.drillOf(s.chart)).toEqual({ level: 1, path: [lit.str("Bikes")], expand: false });
  });

  it("options: data only, display only, stay on the current page", () => {
    const s = setup();
    const p2 = ops.addPage(s.p, "Other", { newId: id });
    ops.upsertFilter(s.p, { level: "visual", page: "page1", visual: s.slicer }, s.pick("France"));
    const b = createBookmark(s.p, "A", "page1", rt, { data: false, display: true, currentPage: false }, id);
    ops.upsertFilter(s.p, { level: "visual", page: "page1", visual: s.slicer }, s.pick("Japan"));
    const a = applyBookmark(s.p, b, "page1");
    expect(a.runtime).toBeNull();
    expect(ops.getFilters(s.p, { level: "visual", page: "page1", visual: s.slicer })[0].cond).toEqual({ kind: "in", values: [lit.str("Japan")] });
    setBookmarkOptions(s.p, b, { data: true, display: false, currentPage: true });
    expect(applyBookmark(s.p, b, p2).page).toBe(p2);
    expect(listBookmarks(s.p)[0].options).toEqual({ data: true, display: false, currentPage: true });
    expect(ops.getFilters(s.p, { level: "visual", page: "page1", visual: s.slicer })[0].cond).toEqual({ kind: "in", values: [lit.str("France")] });
  });

  it("rename, order, update, delete, and name checks", () => {
    const s = setup();
    const a = createBookmark(s.p, "One", "page1", rt, undefined, id);
    const b = createBookmark(s.p, "Two", "page1", rt, undefined, id);
    expect(() => createBookmark(s.p, "one", "page1", rt, undefined, id)).toThrow(/already exists/);
    expect(createBookmark(s.p, "", "page1", rt, undefined, id) && listBookmarks(s.p).map((x) => x.name)).toEqual(["One", "Two", "Bookmark 3"]);
    renameBookmark(s.p, b, "Second");
    expect(() => renameBookmark(s.p, b, "ONE")).toThrow(/already exists/);
    expect(() => renameBookmark(s.p, b, " ")).toThrow(/needs a name/);
    moveBookmark(s.p, b, 0);
    expect(listBookmarks(s.p).map((x) => x.name)).toEqual(["Second", "One", "Bookmark 3"]);
    ops.upsertFilter(s.p, { level: "visual", page: "page1", visual: s.slicer }, s.pick("Canada"));
    updateBookmark(s.p, a, "page1", rt);
    ops.removeFilter(s.p, { level: "visual", page: "page1", visual: s.slicer }, "sl");
    applyBookmark(s.p, a, "page1");
    expect(ops.getFilters(s.p, { level: "visual", page: "page1", visual: s.slicer })).toHaveLength(1);
    deleteBookmark(s.p, a);
    deleteBookmark(s.p, b);
    expect(listBookmarks(s.p).map((x) => x.name)).toEqual(["Bookmark 3"]);
    expect(() => applyBookmark(s.p, a, "page1")).toThrow(/does not exist/);
    expect(Object.keys(s.p.report.files).filter((k) => k.includes(a))).toEqual([]);
    expect((s.p.report.files["report.json"] as { annotations: { name: string }[] }).annotations).toHaveLength(1);
  });

  it("deleting a page removes its bookmarks; applying one whose page is gone fails clearly", () => {
    const s = setup();
    const p2 = ops.addPage(s.p, "Two", { newId: id });
    const b = createBookmark(s.p, "On two", p2, rt, undefined, id);
    ops.deletePage(s.p, p2);
    expect(listBookmarks(s.p)).toEqual([]);
    expect(() => applyBookmark(s.p, b, "page1")).toThrow(/does not exist/);
  });
});

describe("runtime state", () => {
  const sel = { fields: [Cat], values: [lit.str("Bikes")] };
  it("drill down, up, next level and expand", () => {
    const r = new ReportRuntime();
    r.drillDown("v", 3, lit.str("A"));
    r.drillDown("v", 3, lit.str("B"));
    expect(r.drillOf("v")).toEqual({ level: 2, path: [lit.str("A"), lit.str("B")], expand: false });
    r.drillDown("v", 3, lit.str("C")); // already at the last level
    expect(r.drillOf("v").level).toBe(2);
    r.drillUp("v");
    expect(r.drillOf("v")).toEqual({ level: 1, path: [lit.str("A")], expand: false });
    r.resetDrill("v");
    r.nextLevel("v", 3);
    expect(r.drillOf("v")).toEqual({ level: 1, path: [null], expand: false });
    r.expandAll("v", 3);
    expect(r.drillOf("v")).toEqual({ level: 2, path: [null], expand: true });
    r.resetDrill("v");
    expect(r.getSnapshot().drill).toEqual({});
  });

  it("selection clears when its page changes, when its visual drills, or when it is reconciled away", () => {
    const r = new ReportRuntime();
    r.goToPage("p1");
    r.select("p1", "v", sel, false);
    r.drillDown("v", 2, lit.str("x"));
    expect(r.getSnapshot().selection).toBeNull();
    r.select("p1", "w", sel, false);
    r.goToPage("p2");
    expect(r.getSnapshot().selection).toBeNull();
    r.select("p2", "w", sel, false);
    r.reconcile([{ name: "p2", visuals: [] }]);
    expect(r.getSnapshot().selection).toBeNull();
    expect(r.getSnapshot().drill).toEqual({});
  });

  it("drillthrough remembers where it came from and back restores it", () => {
    const r = new ReportRuntime();
    r.goToPage("p1");
    r.select("p1", "v", sel, false);
    r.drillThrough("p2", "p1", [{ name: "d", field: Cat, cond: { kind: "in", values: [lit.str("Bikes")] } }]);
    expect(r.getSnapshot().page).toBe("p2");
    expect(r.getSnapshot().drillthrough?.filters).toHaveLength(1);
    expect(r.getSnapshot().selection).toBeNull();
    r.back();
    expect(r.getSnapshot().page).toBe("p1");
    expect(r.getSnapshot().selection?.visual).toBe("v");
    expect(r.getSnapshot().drillthrough).toBeNull();
  });

  it("matrix collapse toggles and notifies listeners", () => {
    const r = new ReportRuntime();
    let calls = 0;
    const off = r.subscribe(() => calls++);
    r.toggleCollapsed("m", "k1");
    expect(r.getSnapshot().collapsed.m).toEqual(["k1"]);
    r.toggleCollapsed("m", "k1");
    expect(r.getSnapshot().collapsed.m).toEqual([]);
    off();
    r.toggleCollapsed("m", "k2");
    expect(calls).toBe(2);
    r.refreshData();
    expect(r.getSnapshot().epoch).toBe(1);
  });
});
