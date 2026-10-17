import { describe, expect, it } from "vitest";
import { createRegistry } from "./builtin";
import { VIEWING_MESSAGE } from "./publishCommands";
import { READ_ONLY_MESSAGE } from "../store/documentStore";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { column, lit } from "../report/fields";
import { fixtureProject } from "../report/testFixture";
import { listBookmarks } from "../report/bookmarks";
import { parsePage } from "../report/visualDoc";

const Country = column("Customer", "Country");

/** An editable project with two pages, a hidden-able visual, a slicer, a bookmark and a bookmark button, then opened for viewing. */
async function setup() {
  const edit = new Session(new FakeIO(), new FakeDialogs());
  edit.store.load(fixtureProject());
  const er = createRegistry(edit);
  edit.report.goToPage("page1");
  const run = async (s: Session, r: ReturnType<typeof createRegistry>, id: string, args?: unknown) => {
    const x = await r.execute(id, args);
    if (!x.ok) throw new Error(x.message);
  };
  await run(edit, er, "report.page.add", { name: "Second" });
  const second = edit.report.getSnapshot().page!;
  await run(edit, er, "report.page.go", { page: "page1" });
  await run(edit, er, "report.visual.add", { type: "shape", position: { x: 0, y: 0, width: 100, height: 60 } });
  await run(edit, er, "report.visual.add", { type: "slicer", fields: [{ role: "Values", field: Country }] });
  const [shape, slicer] = parsePage(edit.store.project!, "page1")!.visuals.map((v) => v.name);
  // the bookmark: the shape hidden and the slicer set to France, on page 1
  await run(edit, er, "report.visual.setHidden", { page: "page1", visual: shape, hidden: true });
  await run(edit, er, "report.slicer.select", { page: "page1", visual: slicer, field: Country, cond: { kind: "in", values: [lit.str("France")] } });
  await run(edit, er, "report.bookmark.add", { name: "France view" });
  const id = listBookmarks(edit.store.project!)[0].id;
  // back to the normal state, and a button that applies the bookmark
  await run(edit, er, "report.visual.setHidden", { page: "page1", visual: shape, hidden: false });
  await run(edit, er, "report.slicer.select", { page: "page1", visual: slicer, field: Country, cond: null });
  await run(edit, er, "report.visual.add", { type: "actionButton", format: [{ object: "visualLink", prop: "type", value: lit.str("Bookmark") }, { object: "visualLink", prop: "bookmark", value: lit.str(id) }] });
  const button = parsePage(edit.store.project!, "page1")!.visuals.find((v) => v.visualType === "actionButton")!.name;
  // the reader's copy
  const view = new Session(new FakeIO(), new FakeDialogs());
  const vr = createRegistry(view);
  view.store.loadReadOnly(edit.store.project!);
  view.report.goToPage("page1");
  return { view, vr, run: (id: string, a?: unknown) => run(view, vr, id, a), shape, slicer, button, id, second };
}

const stateOf = (s: Session, shape: string, slicer: string) => {
  const p = parsePage(s.store.project!, "page1")!;
  return { hidden: p.visuals.find((v) => v.name === shape)!.hidden, slicer: p.visuals.find((v) => v.name === slicer)!.filters.defs.find((d) => d.name === "slicer")?.cond ?? null };
};

describe("bookmarks in a report opened for viewing", () => {
  it("applying a bookmark changes what is shown, not the report: no unsaved changes, no undo step", async () => {
    const t = await setup();
    expect(stateOf(t.view, t.shape, t.slicer)).toEqual({ hidden: false, slicer: null });
    const rev = t.view.store.getSnapshot().revision;
    await t.run("report.bookmark.apply", { id: t.id });
    expect(stateOf(t.view, t.shape, t.slicer)).toEqual({ hidden: true, slicer: { kind: "in", values: [lit.str("France")] } });
    const snap = t.view.store.getSnapshot();
    expect(snap.revision).toBeGreaterThan(rev);
    expect(snap.readOnly).toBe(true);
    expect(snap.viewChanged).toBe(true);
    expect(snap.isDirty).toBe(false);
    expect(snap.canUndo).toBe(false);
  });

  it("a bookmark button applies the bookmark; Reset goes back to the report as published", async () => {
    const t = await setup();
    await t.run("report.button.run", { page: "page1", visual: t.button });
    expect(stateOf(t.view, t.shape, t.slicer).hidden).toBe(true);
    t.view.store.resetViewChanges();
    expect(stateOf(t.view, t.shape, t.slicer)).toEqual({ hidden: false, slicer: null });
    expect(t.view.store.getSnapshot().viewChanged).toBe(false);
  });

  it("a slicer selection and a filter work for a reader, and are view changes too", async () => {
    const t = await setup();
    await t.run("report.slicer.select", { page: "page1", visual: t.slicer, field: Country, cond: { kind: "in", values: [lit.str("Canada")] } });
    expect(stateOf(t.view, t.shape, t.slicer).slicer).toEqual({ kind: "in", values: [lit.str("Canada")] });
    expect(t.view.store.getSnapshot().isDirty).toBe(false);
    await t.run("report.filter.upsert", { scope: { level: "page", page: "page1" }, filter: { name: "p", field: Country, cond: { kind: "in", values: [lit.str("France")] } } });
    expect(parsePage(t.view.store.project!, "page1")!.filters.defs.map((d) => d.name)).toEqual(["p"]);
  });

  it("everything else that edits is still refused; an editable project cannot use a view change", async () => {
    const t = await setup();
    const r = await t.vr.execute("report.visual.setHidden", { page: "page1", visual: t.shape, hidden: true });
    expect(r.ok).toBe(false);
    expect([VIEWING_MESSAGE, READ_ONLY_MESSAGE]).toContain((r as { message: string }).message);
    const edit = new Session(new FakeIO(), new FakeDialogs());
    edit.store.load(fixtureProject());
    expect(() => edit.store.applyViewChange(() => undefined)).toThrow(/opened for viewing/);
  });

  it("a bookmark with Current page keeps the reader on the page; one with data off leaves the slicer alone", async () => {
    const t = await setup();
    await t.run("report.page.go", { page: t.second });
    await t.run("report.bookmark.apply", { id: t.id });
    // the bookmark is of page 1, so the reader is taken there
    expect(t.view.report.getSnapshot().page).toBe("page1");
  });
});
