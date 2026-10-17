import { describe, expect, it } from "vitest";
import { createRegistry } from "./builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { ancestorChain, descendantNames, effectivelyHidden, previewPosition, selectionTarget, treeRows } from "../report/groups";
import { fixtureProject } from "../report/testFixture";
import { parsePage } from "../report/visualDoc";

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
  const page = () => parsePage(session.store.project!, "page1")!;
  const add = async (x: number, y: number, w = 100, h = 60) => {
    await run("report.visual.add", { type: "shape", position: { x, y, width: w, height: h } });
    return page().visuals.at(-1)!.name;
  };
  const pos = (name: string) => {
    const i = page().visuals.find((v) => v.name === name) ?? page().groups.find((g) => g.name === name)!;
    return [i.position.x, i.position.y, i.position.width, i.position.height];
  };
  return { session, run, fail, page, add, pos, reg };
}

describe("groups", () => {
  it("group two visuals: a group file covering them, members name it as parent, undo is one step", async () => {
    const t = setup();
    const a = await t.add(10, 20);
    const b = await t.add(200, 100);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0];
    expect(g.displayName).toBe("Group 1");
    expect(g.mode).toBe("ScaleMode");
    expect(g.position).toMatchObject({ x: 10, y: 20, width: 290, height: 140 });
    expect(t.page().visuals.map((v) => v.parent)).toEqual([g.name, g.name]);
    expect(t.session.report.getSnapshot().canvas).toEqual([g.name]);
    await t.run("edit.undo");
    expect(t.page().groups).toHaveLength(0);
    expect(t.page().visuals.every((v) => v.parent === undefined)).toBe(true);
  });

  it("needs two items at the same level", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    expect(await t.fail("report.visuals.group", { visuals: [a] })).toMatch(/at least two/);
    const b = await t.add(200, 0);
    const c = await t.add(400, 0);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0].name;
    expect(await t.fail("report.visuals.group", { visuals: [a, c] })).toMatch(/same level/);
    // a group can be grouped with another visual (nested groups)
    await t.run("report.visuals.group", { visuals: [g, c] });
    const outer = t.page().groups.find((x) => !x.parent)!;
    expect(t.page().groups.find((x) => x.name === g)!.parent).toBe(outer.name);
    expect(ancestorChain(t.page(), a)).toEqual([outer.name, g]);
    expect(descendantNames(t.page(), outer.name).sort()).toEqual([a, b, c, g].sort());
  });

  it("moving a group moves its members; resizing scales them (ScaleMode) or keeps their size (ScrollMode)", async () => {
    const t = setup();
    const a = await t.add(0, 0, 100, 100);
    const b = await t.add(100, 100, 100, 100);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0].name;
    await t.run("report.visual.setPosition", { page: "page1", visual: g, position: { x: 50, y: 30 } });
    expect(t.pos(a)).toEqual([50, 30, 100, 100]);
    expect(t.pos(b)).toEqual([150, 130, 100, 100]);
    await t.run("report.visual.setPosition", { page: "page1", visual: g, position: { width: 400, height: 400 } });
    expect(t.pos(a)).toEqual([50, 30, 200, 200]);
    expect(t.pos(b)).toEqual([250, 230, 200, 200]);
    await t.run("report.group.setMode", { page: "page1", group: g, mode: "ScrollMode" });
    await t.run("report.visual.setPosition", { page: "page1", visual: g, position: { x: 0, y: 0, width: 800, height: 800 } });
    expect(t.pos(a)).toEqual([0, 0, 200, 200]); // moved with the group, same size
    expect(t.pos(g)).toEqual([0, 0, 800, 800]);
  });

  it("moving or resizing a member refits the group; deleting the last member removes the group", async () => {
    const t = setup();
    const a = await t.add(0, 0, 100, 100);
    const b = await t.add(100, 100, 100, 100);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0].name;
    await t.run("report.visual.setPosition", { page: "page1", visual: b, position: { x: 300, y: 300 } });
    expect(t.pos(g)).toEqual([0, 0, 400, 400]);
    await t.run("report.visuals.delete", { visuals: [b] });
    expect(t.pos(g)).toEqual([0, 0, 100, 100]);
    await t.run("report.visuals.delete", { visuals: [a] });
    expect(t.page().groups).toHaveLength(0);
  });

  it("ungroup returns the members to the next level; delete takes the members with the group", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0].name;
    await t.run("report.group.ungroup", { visuals: [g] });
    expect(t.page().groups).toHaveLength(0);
    expect(t.page().visuals.every((v) => v.parent === undefined)).toBe(true);
    expect(t.session.report.getSnapshot().canvas.sort()).toEqual([a, b].sort());
    await t.run("report.visuals.group", { visuals: [a, b] });
    await t.run("report.visuals.delete", { visuals: [t.page().groups[0].name, a] }); // the member listed too: no error
    expect(t.page().visuals).toHaveLength(0);
    expect(t.page().groups).toHaveLength(0);
  });

  it("rename, hide (members are hidden with it), copy and paste keep the grouping", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0].name;
    await t.run("report.group.rename", { page: "page1", group: g, name: "KPIs" });
    expect(t.page().groups[0].displayName).toBe("KPIs");
    expect(await t.fail("report.group.rename", { page: "page1", group: g, name: "  " })).toMatch(/needs a name/);
    await t.run("report.visual.setHidden", { page: "page1", visual: g, hidden: true });
    expect(effectivelyHidden(t.page(), a)).toBe(true);
    await t.run("report.visual.setHidden", { page: "page1", visual: g, hidden: false });
    await t.run("report.visuals.copy", { visuals: [g] });
    await t.run("report.visuals.paste", { page: "page1" });
    expect(t.page().groups).toHaveLength(2);
    expect(t.page().visuals).toHaveLength(4);
    const copy = t.page().groups.find((x) => x.name !== g)!;
    expect(t.page().visuals.filter((v) => v.parent === copy.name)).toHaveLength(2);
    expect(copy.position.x).toBe(24); // shifted so that it does not sit exactly on the original
  });

  it("a click selects the group first, then the member; Ctrl+click semantics come from the selection", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0].name;
    expect(selectionTarget(t.page(), a, [])).toBe(g);
    expect(selectionTarget(t.page(), a, [g])).toBe(a);
    expect(selectionTarget(t.page(), b, [a])).toBe(b); // a member of the group is selected: stay inside it
    const c = await t.add(400, 0);
    expect(selectionTarget(t.page(), c, [g])).toBe(c);
  });

  it("the Selection pane rows list a group before its members, front first", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    const c = await t.add(400, 0);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0].name;
    const rows = treeRows(t.page());
    expect(rows.map((r) => [r.kind, r.depth])).toEqual([["visual", 0], ["group", 0], ["visual", 1], ["visual", 1]]);
    expect(rows[0].name).toBe(c);
    expect(treeRows(t.page(), new Set([g])).map((r) => r.name)).toEqual([c, g]);
  });

  it("members follow their group's preview while it is dragged", async () => {
    const t = setup();
    const a = await t.add(0, 0, 100, 100);
    const b = await t.add(100, 100, 100, 100);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0];
    const moved = { ...g.position, x: 50, y: 50 };
    expect(previewPosition(t.page(), a, { [g.name]: moved })).toMatchObject({ x: 50, y: 50, width: 100, height: 100 });
    expect(previewPosition(t.page(), b, { [g.name]: moved })).toMatchObject({ x: 150, y: 150 });
    const scaled = { ...g.position, width: 400, height: 400 };
    expect(previewPosition(t.page(), b, { [g.name]: scaled })).toMatchObject({ x: 200, y: 200, width: 200, height: 200 });
    expect(previewPosition(t.page(), a, {})).toBeUndefined();
  });

  it("align and distribute treat a group as one box", async () => {
    const t = setup();
    const a = await t.add(0, 0, 100, 100);
    const b = await t.add(100, 50, 100, 100);
    const c = await t.add(500, 300, 100, 100);
    await t.run("report.visuals.group", { visuals: [a, b] });
    const g = t.page().groups[0].name;
    await t.run("report.visuals.align", { visuals: [g, c], mode: "left" });
    expect(t.pos(c)[0]).toBe(0);
    expect(t.pos(b)[0]).toBe(100); // the group did not move, so its members stay
  });
});
