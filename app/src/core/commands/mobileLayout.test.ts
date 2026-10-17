import { describe, expect, it } from "vitest";
import { createRegistry } from "./builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { fixtureProject } from "../report/testFixture";
import { parsePage, mobileKey } from "../report/visualDoc";
import { MOBILE_WIDTH } from "../report/reportOps";

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
  const add = async (type: string, x: number, y: number, w: number, h: number) => {
    await run("report.visual.add", { type, position: { x, y, width: w, height: h } });
    return page().visuals.at(-1)!.name;
  };
  return { session, run, fail, page, add };
}

describe("phone layout", () => {
  it("adding a visual puts it phone-wide below the others, in a mobile.json of its own", async () => {
    const t = setup();
    const a = await t.add("shape", 0, 0, 400, 200);
    const b = await t.add("shape", 500, 0, 200, 200);
    await t.run("report.mobile.place", { page: "page1", visual: a });
    await t.run("report.mobile.place", { page: "page1", visual: b });
    const [va, vb] = [t.page().visuals.find((v) => v.name === a)!, t.page().visuals.find((v) => v.name === b)!];
    expect(va.mobile).toMatchObject({ x: 8, y: 8, width: MOBILE_WIDTH - 16, height: 152 }); // the 2:1 shape keeps its ratio
    expect(vb.mobile!.y).toBe(8 + 152 + 8);
    expect(vb.mobile!.height).toBe(304); // a square stays square
    expect(t.session.store.project!.report.files[mobileKey("page1", a)]).toMatchObject({ position: { width: MOBILE_WIDTH - 16 } });
    // the desktop position is untouched
    expect(va.position).toMatchObject({ x: 0, y: 0, width: 400, height: 200 });
    // adding twice changes nothing
    await t.run("report.mobile.place", { page: "page1", visual: a });
    expect(t.page().visuals.find((v) => v.name === a)!.mobile).toEqual(va.mobile);
  });

  it("move, resize and remove are separate from the page, and each is one undo step", async () => {
    const t = setup();
    const a = await t.add("shape", 100, 100, 300, 200);
    await t.run("report.mobile.place", { page: "page1", visual: a });
    await t.run("report.mobile.setPositions", { page: "page1", items: [{ visual: a, position: { x: 20, y: 40, width: 200, height: 100 } }] });
    expect(t.page().visuals[0].mobile).toMatchObject({ x: 20, y: 40, width: 200, height: 100 });
    expect(t.page().visuals[0].position).toMatchObject({ x: 100, y: 100 });
    expect(await t.fail("report.mobile.setPositions", { page: "page1", items: [{ visual: a, position: { width: 5 } }] })).toMatch(/at least 20/);
    await t.run("edit.undo");
    expect(t.page().visuals[0].mobile).toMatchObject({ x: 8, y: 8 });
    await t.run("report.mobile.remove", { page: "page1", visuals: [a] });
    expect(t.page().visuals[0].mobile).toBeUndefined();
    expect(t.page().visuals).toHaveLength(1); // removed from the phone, not from the report
    expect(await t.fail("report.mobile.setPositions", { page: "page1", items: [{ visual: a, position: { x: 1 } }] })).toMatch(/not on the phone layout/);
  });

  it("auto-create lays out the visible visuals in reading order and leaves hidden ones and the navigator out", async () => {
    const t = setup();
    const low = await t.add("shape", 0, 300, 400, 100);
    const high = await t.add("shape", 0, 0, 400, 100);
    const hidden = await t.add("shape", 0, 150, 400, 100);
    await t.run("report.visual.setHidden", { page: "page1", visual: hidden, hidden: true });
    await t.add("pageNavigator", 0, 500, 400, 50);
    await t.run("report.mobile.auto", { page: "page1" });
    const placed = t.page().visuals.filter((v) => v.mobile).sort((a, b) => a.mobile!.y - b.mobile!.y).map((v) => v.name);
    expect(placed).toEqual([high, low]);
  });

  it("the phone layout can be switched on and off for the canvas; deleting a visual deletes its phone position; a group cannot be added", async () => {
    const t = setup();
    expect(t.session.report.getSnapshot().mobile).toBe(false);
    await t.run("view.mobileLayout");
    expect(t.session.report.getSnapshot().mobile).toBe(true);
    await t.run("view.mobileLayout");
    expect(t.session.report.getSnapshot().mobile).toBe(false);
    const a = await t.add("shape", 0, 0, 100, 100);
    const b = await t.add("shape", 200, 0, 100, 100);
    await t.run("report.mobile.place", { page: "page1", visual: a });
    await t.run("report.visuals.delete", { visuals: [a] });
    expect(t.session.store.project!.report.files[mobileKey("page1", a)]).toBeUndefined();
    const c = await t.add("shape", 400, 0, 100, 100);
    await t.run("report.visuals.group", { visuals: [b, c] });
    const g = t.page().groups[0].name;
    expect(await t.fail("report.mobile.place", { page: "page1", visual: g })).toMatch(/Groups are not part/);
  });
});
