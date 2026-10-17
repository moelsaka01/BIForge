import { describe, expect, it } from "vitest";
import { createRegistry } from "./builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { column, lit } from "../report/fields";
import { fixtureProject } from "../report/testFixture";
import { listPageNames, parsePage } from "../report/visualDoc";
import { syncGroupOf } from "../report/reportOps";

const Country = column("Customer", "Country");

function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const reg = createRegistry(session);
  session.report.goToPage("page1");
  const run = async (id: string, args?: unknown) => {
    const r = await reg.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  const fail = async (id: string, args?: unknown) => {
    const r = await reg.execute(id, args);
    return r.ok ? "" : r.message;
  };
  const vs = (page: string) => parsePage(session.store.project!, page)!.visuals;
  return { session, run, fail, vs };
}

describe("sync slicers", () => {
  it("adds the slicer to the chosen pages (hidden where it is not shown) and a selection follows everywhere", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Two" });
    await t.run("report.page.add", { name: "Three" });
    const [p1, p2, p3] = listPageNames(t.session.store.project!);
    await t.run("report.page.go", { page: p1 });
    await t.run("report.visual.add", { type: "slicer", fields: [{ role: "Values", field: Country }] });
    const s1 = t.vs(p1)[0].name;
    await t.run("report.slicer.setSync", { page: p1, visual: s1, group: "Country", pages: [{ page: p2, sync: true, visible: true }, { page: p3, sync: true, visible: false }] });
    expect(syncGroupOf(t.vs(p1)[0].json)).toBe("Country");
    expect(t.vs(p2)).toHaveLength(1);
    expect(t.vs(p2)[0].hidden).toBe(false);
    expect(t.vs(p3)[0].hidden).toBe(true);
    await t.run("report.slicer.select", { page: p1, visual: s1, field: Country, cond: { kind: "in", values: [lit.str("France")] } });
    for (const pg of [p2, p3]) expect(t.vs(pg)[0].filters.defs[0].cond).toEqual({ kind: "in", values: [lit.str("France")] });
    await t.run("report.slicer.select", { page: p2, visual: t.vs(p2)[0].name, field: Country, cond: null });
    expect(t.vs(p1)[0].filters.defs).toEqual([]);
    expect(t.vs(p3)[0].filters.defs).toEqual([]);
    await t.run("edit.undo");
    expect(t.vs(p1)[0].filters.defs).toHaveLength(1);
  });

  it("taking a page out removes its hidden copy; stopping the sync leaves independent slicers", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Two" });
    await t.run("report.page.add", { name: "Three" });
    const [p1, p2, p3] = listPageNames(t.session.store.project!);
    await t.run("report.page.go", { page: p1 });
    await t.run("report.visual.add", { type: "slicer", fields: [{ role: "Values", field: Country }] });
    const s1 = t.vs(p1)[0].name;
    await t.run("report.slicer.setSync", { page: p1, visual: s1, group: "g", pages: [{ page: p2, sync: true, visible: true }, { page: p3, sync: true, visible: false }] });
    await t.run("report.slicer.setSync", { page: p1, visual: s1, group: "g", pages: [{ page: p2, sync: true, visible: true }, { page: p3, sync: false, visible: false }] });
    expect(t.vs(p3)).toHaveLength(0);
    await t.run("report.slicer.setSync", { page: p1, visual: s1, group: null, pages: [] });
    expect(syncGroupOf(t.vs(p1)[0].json)).toBeNull();
    expect(t.vs(p2)).toHaveLength(1);
    expect(syncGroupOf(t.vs(p2)[0].json)).toBeNull();
    await t.run("report.slicer.select", { page: p1, visual: s1, field: Country, cond: { kind: "in", values: [lit.str("Canada")] } });
    expect(t.vs(p2)[0].filters.defs).toEqual([]);
  });

  it("only slicers can be synced", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "shape" });
    expect(await t.fail("report.slicer.setSync", { page: "page1", visual: t.vs("page1")[0].name, group: "x", pages: [] })).toMatch(/Only a slicer/);
  });
});
