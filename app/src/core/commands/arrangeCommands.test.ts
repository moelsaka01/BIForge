import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "./builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { fixtureProject } from "../report/testFixture";
import { parsePage, listPageNames } from "../report/visualDoc";
import { visualDisplayName } from "../report/reportOps";

afterEach(() => vi.unstubAllGlobals());

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
  const vs = (page = "page1") => parsePage(session.store.project!, page)!.visuals;
  const add = async (x: number, y: number, w = 100, h = 60) => {
    await run("report.visual.add", { type: "shape", position: { x, y, width: w, height: h } });
    return vs().at(-1)!.name;
  };
  return { session, reg, run, fail, vs, add };
}

describe("selecting several visuals", () => {
  it("the canvas selection is view state: no undo step, cleared on page change, pruned when visuals go", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    const rev = t.session.store.getSnapshot().revision;
    t.session.report.setCanvasSelection([a, b]);
    expect(t.session.report.getSnapshot().canvas).toEqual([a, b]);
    expect(t.session.store.getSnapshot().revision).toBe(rev);
    await t.run("report.visuals.delete", { visuals: [a] });
    t.session.report.reconcile([{ name: "page1", visuals: [b] }]);
    expect(t.session.report.getSnapshot().canvas).toEqual([]);
    t.session.report.setCanvasSelection([b]);
    await t.run("report.page.add", {});
    expect(t.session.report.getSnapshot().canvas).toEqual([]);
  });
});

describe("align, distribute, move, delete", () => {
  it("align and distribute act on the canvas selection in one undo step each", async () => {
    const t = setup();
    const a = await t.add(0, 10, 50, 50);
    const b = await t.add(70, 100, 50, 50);
    const c = await t.add(300, 40, 50, 50);
    t.session.report.setCanvasSelection([a, b, c]);
    await t.run("report.visuals.align", { mode: "top" });
    expect(t.vs().map((v) => v.position.y)).toEqual([10, 10, 10]);
    await t.run("edit.undo");
    expect(t.vs().map((v) => v.position.y)).toEqual([10, 100, 40]);
    await t.run("report.visuals.distribute", { axis: "horizontal" });
    expect(t.vs().map((v) => v.position.x)).toEqual([0, 150, 300]);
    expect(await t.fail("report.visuals.align", { mode: "left", visuals: [a] })).toMatch(/at least two/);
    expect(await t.fail("report.visuals.distribute", { axis: "vertical", visuals: [a, b] })).toMatch(/at least three/);
  });

  it("commands without a selection or names say so", async () => {
    const t = setup();
    expect(await t.fail("report.visuals.align", { mode: "left" })).toMatch(/Select a visual first/);
  });

  it("moving several visuals is one step; deleting several is one step", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    await t.run("report.visuals.setPositions", { page: "page1", items: [{ visual: a, position: { x: 5 } }, { visual: b, position: { x: 205 } }] });
    expect(t.vs().map((v) => v.position.x)).toEqual([5, 205]);
    await t.run("edit.undo");
    expect(t.vs().map((v) => v.position.x)).toEqual([0, 200]);
    t.session.report.setCanvasSelection([a, b]);
    await t.run("report.visuals.delete");
    expect(t.vs()).toHaveLength(0);
    await t.run("edit.undo");
    expect(t.vs()).toHaveLength(2);
  });
});

describe("copy, cut and paste", () => {
  it("copy then paste on the same page shifts the copy; on another page it keeps the position; the originals stay", async () => {
    const t = setup();
    const a = await t.add(10, 10, 80, 40);
    t.session.report.setCanvasSelection([a]);
    await t.run("report.visuals.copy");
    await t.run("report.visuals.paste");
    expect(t.vs()).toHaveLength(2);
    const copy = t.vs().find((v) => v.name !== a)!;
    expect(copy.position).toMatchObject({ x: 34, y: 34, width: 80, height: 40 });
    expect(t.session.report.getSnapshot().canvas).toEqual([copy.name]);
    await t.run("report.page.add", { name: "Other" });
    const other = listPageNames(t.session.store.project!).find((n) => n !== "page1")!;
    await t.run("report.visuals.paste", { page: other });
    expect(t.vs(other)[0].position).toMatchObject({ x: 10, y: 10 });
    expect(t.vs(other)[0].name).not.toBe(a);
    // pasting again lands on a free spot
    await t.run("report.visuals.paste", { page: other });
    expect(t.vs(other).map((v) => v.position.x).sort((x, y) => x - y)).toEqual([10, 34]);
  });

  it("cut removes the visual and paste brings it back", async () => {
    const t = setup();
    const a = await t.add(10, 10);
    t.session.report.setCanvasSelection([a]);
    await t.run("report.visuals.cut");
    expect(t.vs()).toHaveLength(0);
    await t.run("report.visuals.paste");
    expect(t.vs()).toHaveLength(1);
    expect(t.vs()[0].position).toMatchObject({ x: 10, y: 10 });
  });

  it("paste reads the system clipboard, so a copy from another report works and missing tables are reported", async () => {
    const t = setup();
    const foreign = {
      kind: "biforge.visuals",
      version: 1,
      page: "elsewhere",
      visuals: [
        {
          name: "x1",
          position: { x: 7, y: 8, z: 0, width: 200, height: 100 },
          visual: { visualType: "clusteredColumnChart", query: { queryState: { Category: { projections: [{ field: { Column: { Expression: { SourceRef: { Entity: "NoSuchTable" } }, Property: "c" } }, queryRef: "NoSuchTable.c" }] } } } },
        },
      ],
    };
    vi.stubGlobal("navigator", { clipboard: { readText: async () => JSON.stringify(foreign), writeText: async () => undefined } });
    await t.run("report.visuals.paste");
    expect(t.vs()[0].name).not.toBe("x1");
    expect(t.vs()[0].position).toMatchObject({ x: 7, y: 8 });
    expect(t.session.getSnapshot().lastMessage).toMatch(/NoSuchTable/);
  });

  it("copy puts JSON on the system clipboard; paste ignores other text and refuses when nothing was copied", async () => {
    const t = setup();
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (s: string) => void written.push(s), readText: async () => "just some text" } });
    const a = await t.add(0, 0);
    t.session.report.setCanvasSelection([a]);
    await t.run("report.visuals.copy");
    expect(JSON.parse(written[0])).toMatchObject({ kind: "biforge.visuals", version: 1, visuals: [{ name: a }] });
    await t.run("report.visuals.paste"); // text on the clipboard is not ours: the copy made in this window is used
    expect(t.vs()).toHaveLength(2);
    const u = setup();
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "nothing" } });
    expect(await u.fail("report.visuals.paste")).toMatch(/no copied visuals/);
  });
});

describe("selection pane operations", () => {
  it("rename keeps the name as an annotation (an empty name removes it); order moves swap neighbours", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(50, 0);
    const c = await t.add(100, 0);
    await t.run("report.visual.rename", { page: "page1", visual: a, name: "  Logo  " });
    expect(visualDisplayName(t.vs().find((v) => v.name === a)!.json)).toBe("Logo");
    await t.run("report.visual.rename", { page: "page1", visual: a, name: "" });
    expect(visualDisplayName(t.vs().find((v) => v.name === a)!.json)).toBeNull();
    expect(t.vs().find((v) => v.name === a)!.json.annotations).toBeUndefined();
    const order = () => [...t.vs()].sort((x, y) => x.position.z - y.position.z).map((v) => v.name);
    expect(order()).toEqual([a, b, c]);
    await t.run("report.visual.moveInOrder", { page: "page1", visual: a, dir: "up" });
    expect(order()).toEqual([b, a, c]);
    await t.run("report.visual.moveInOrder", { page: "page1", visual: c, dir: "up" });
    expect(order()).toEqual([b, a, c]); // already in front
    await t.run("report.visual.moveInOrder", { page: "page1", visual: c, dir: "down" });
    expect(order()).toEqual([b, c, a]);
  });
});
