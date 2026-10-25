import { describe, expect, it } from "vitest";
import { createRegistry } from "./builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { agg, column, lit } from "../report/fields";
import { fixtureProject } from "../report/testFixture";
import { resolveTheme } from "../report/theme";
import { listBookmarks } from "../report/bookmarks";
import { activePageName, getFormat, listPageNames, parsePage, visualKey } from "../report/visualDoc";

const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);

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
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.message;
  };
  return { session, reg, run, fail, project: () => session.store.project! };
}

describe("report commands", () => {
  it("are all registered, with unique ids, and unavailable without a project", () => {
    const s = new Session(new FakeIO(), new FakeDialogs());
    const reg = createRegistry(s);
    const ids = reg.all().map((c) => c.id).filter((i) => i.startsWith("report."));
    expect(ids.length).toBeGreaterThanOrEqual(50);
    expect(reg.isEnabled("report.page.add")).toBe(false);
    s.store.load(fixtureProject());
    expect(reg.isEnabled("report.page.add")).toBe(true);
  });

  it("build a visual page through commands, each edit one undo step", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Sales" });
    const pages = listPageNames(t.project());
    expect(pages).toHaveLength(2);
    expect(t.session.report.getSnapshot().page).toBe(pages[1]);
    await t.run("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    const page = parsePage(t.project(), pages[1])!;
    expect(page.visuals).toHaveLength(1);
    expect(page.visuals[0].roles.Y[0].field).toEqual(Qty);
    const v = page.visuals[0].name;
    await t.run("report.format.set", { page: pages[1], visual: v, object: "title", prop: "text", value: lit.str("Quantity by category") });
    expect(getFormat(t.project().report.files[visualKey(pages[1], v)], "title", "text")).toEqual(lit.str("Quantity by category"));
    await t.run("edit.undo");
    expect(getFormat(t.project().report.files[visualKey(pages[1], v)], "title", "text")).toBeNull();
    await t.run("report.visual.setType", { page: pages[1], visual: v, type: "pieChart" });
    expect(parsePage(t.project(), pages[1])!.visuals[0].visualType).toBe("pieChart");
    await t.run("report.visual.duplicate", { page: pages[1], visual: v });
    expect(parsePage(t.project(), pages[1])!.visuals).toHaveLength(2);
  });

  it("errors come back as messages and leave the document unchanged", async () => {
    const t = setup();
    const before = t.session.store.getSnapshot().revision;
    expect(await t.fail("report.visual.add", { type: "nope" })).toMatch(/Unknown visual type/);
    expect(await t.fail("report.field.add", { page: "page1", visual: "ghost", field: Cat })).toMatch(/does not exist/);
    expect(await t.fail("report.page.rename", { page: "page1" })).toMatch(/Missing value: name/);
    expect(await t.fail("report.page.delete", { page: "page1" })).toMatch(/at least one page/);
    expect(t.session.store.getSnapshot().revision).toBe(before);
  });

  it("slicer selections are filters of the slicer visual; clearing removes them", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "slicer", fields: [{ role: "Values", field: column("Customer", "Country") }] });
    const v = parsePage(t.project(), "page1")!.visuals[0].name;
    const field = column("Customer", "Country");
    await t.run("report.slicer.select", { page: "page1", visual: v, field, cond: { kind: "in", values: [lit.str("France")] } });
    expect(parsePage(t.project(), "page1")!.visuals[0].filters.defs[0].cond).toEqual({ kind: "in", values: [lit.str("France")] });
    await t.run("report.slicer.select", { page: "page1", visual: v, field, cond: null });
    expect(parsePage(t.project(), "page1")!.visuals[0].filters.defs).toEqual([]);
  });

  it("view actions change the runtime, not the document", async () => {
    const t = setup();
    const rev = t.session.store.getSnapshot().revision;
    await t.run("report.view.select", { page: "page1", visual: "v", point: { fields: [Cat], values: [lit.str("Bikes")] } });
    expect(t.session.report.getSnapshot().selection?.visual).toBe("v");
    await t.run("report.view.drillDown", { visual: "w", levels: 2, value: lit.str("Bikes") });
    expect(t.session.report.drillOf("w").level).toBe(1);
    await t.run("report.view.drillMode", { visual: "w" });
    expect(t.session.report.getSnapshot().drillMode).toBe("w");
    await t.run("report.view.drillMode", { visual: "w" });
    expect(t.session.report.getSnapshot().drillMode).toBeNull();
    await t.run("report.view.clearSelection");
    expect(t.session.store.getSnapshot().revision).toBe(rev);
    expect(t.session.store.getSnapshot().canUndo).toBe(false);
  });

  it("bookmarks restore the page and the view state", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    const v = parsePage(t.project(), "page1")!.visuals[0].name;
    await t.run("report.view.drillDown", { visual: v, levels: 2, value: lit.str("Bikes") });
    await t.run("report.bookmark.add", { name: "Drilled" });
    const [b] = listBookmarks(t.project());
    await t.run("report.page.add", {});
    await t.run("report.view.resetDrill", { visual: v });
    await t.run("report.bookmark.apply", { id: b.id });
    expect(t.session.report.getSnapshot().page).toBe("page1");
    expect(t.session.report.drillOf(v).level).toBe(1);
    await t.run("report.bookmark.rename", { id: b.id, name: "Renamed" });
    expect(listBookmarks(t.project())[0].name).toBe("Renamed");
    await t.run("report.bookmark.delete", { id: b.id });
    expect(listBookmarks(t.project())).toEqual([]);
  });

  it("Ctrl+Shift+F11 shows the selected visuals as tables and back", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    const name = parsePage(t.project(), "page1")!.visuals[0].name;
    expect(await t.fail("report.view.asTableSelected")).toMatch(/Select a visual/);
    t.session.report.setCanvasSelection([name]);
    const cmd = t.reg.byShortcut("Ctrl+Shift+F11");
    expect(cmd?.id).toBe("report.view.asTableSelected");
    await t.run(cmd!.id);
    expect(t.session.report.getSnapshot().asTable).toEqual([name]);
    await t.run(cmd!.id);
    expect(t.session.report.getSnapshot().asTable).toEqual([]);
  });

  it("themes: built-in, imported with warnings, reset", async () => {
    const t = setup();
    await t.run("report.theme.apply", { builtin: "BIForge Dark" });
    expect(resolveTheme(t.project()).name).toBe("BIForge Dark");
    expect(await t.fail("report.theme.apply", { builtin: "Nope" })).toMatch(/no built-in theme/);
    await t.run("report.theme.apply", { json: JSON.stringify({ name: "Mine", dataColors: ["#102030"], extra: true }) });
    expect(resolveTheme(t.project()).dataColors).toEqual(["#102030"]);
    expect(t.session.getSnapshot().lastMessage).toMatch(/1 setting\(s\).*extra/);
    expect(await t.fail("report.theme.apply", { json: "{ not json" })).toBeTruthy();
    await t.run("report.theme.reset");
    expect(resolveTheme(t.project()).name).toBe("BIForge Default");
    expect(activePageName(t.project())).toBe("page1");
  });

  it("drillthrough navigates with the point's filter and back returns", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Detail", type: "Drillthrough" });
    const d = t.session.report.getSnapshot().page!;
    await t.run("report.page.setDrillthroughFields", { page: d, fields: [Cat] });
    await t.run("report.page.go", { page: "page1" });
    await t.run("report.view.drillthrough", { page: "page1", target: d, point: { fields: [Cat], values: [lit.str("Bikes")] } });
    expect(t.session.report.getSnapshot().page).toBe(d);
    expect(t.session.report.getSnapshot().drillthrough?.filters[0].cond).toEqual({ kind: "in", values: [lit.str("Bikes")] });
    await t.run("report.view.back");
    expect(t.session.report.getSnapshot().page).toBe("page1");
    expect(await t.fail("report.view.drillthrough", { page: "page1", target: d, point: { fields: [column("Customer", "City")], values: [lit.str("Paris")] } })).toMatch(/cannot drill through/);
  });
});
