// @vitest-environment jsdom
// Smart guides, gridlines, snap to grid and lock objects on the report canvas.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { DEFAULT_CANVAS, type CanvasOptions } from "../../core/report/canvasOptions";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

function setup(canvas: Partial<CanvasOptions> = {}) {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} canvas={{ ...DEFAULT_CANVAS, ...canvas }} />;
  }
  const vs = () => parsePage(session.store.project!, "page1")!.visuals;
  const add = async (x: number, y: number, w = 100, h = 60) => {
    await run("report.visual.add", { type: "shape", position: { x, y, width: w, height: h } });
    return vs().at(-1)!.name;
  };
  const frame = (name: string) => document.querySelector(`[data-visual="${name}"]`) as HTMLElement;
  return { Host, vs, add, frame };
}

/** Drags a visual by its title bar by (dx, dy) page pixels; returns what the canvas shows before the mouse is released. */
async function drag(t: ReturnType<typeof setup>, name: string, dx: number, dy: number, mods: object = {}) {
  await waitFor(() => expect(t.frame(name)).toBeTruthy());
  fireEvent.pointerDown(t.frame(name), { button: 0 });
  const region = screen.getByRole("region", { name: /^Page / });
  const scale = parseFloat(/scale\(([\d.]+)\)/.exec(region.style.transform)![1]);
  fireEvent.pointerEnter(t.frame(name));
  const bar = t.frame(name).querySelector("[data-testid=visual-bar]") as HTMLElement;
  fireEvent.pointerDown(bar, { button: 0, clientX: 500, clientY: 500 });
  fireEvent.pointerMove(region, { clientX: 500 + dx * scale, clientY: 500 + dy * scale, ...mods });
  const guides = Array.from(document.querySelectorAll("[data-testid=smart-guide]")).map((g) => (g as HTMLElement).dataset.axis);
  fireEvent.pointerUp(region);
  return guides;
}

describe("smart guides on the canvas", () => {
  it("snap the left edge of a dragged visual to another visual and show a vertical guide while dragging", async () => {
    const t = setup();
    await t.add(200, 50);
    const m = await t.add(0, 300);
    render(<t.Host />);
    const guides = await drag(t, m, 197, 0); // left edge at 197, the other visual's left edge is at 200
    expect(guides).toContain("v");
    await waitFor(() => expect(t.vs().find((v) => v.name === m)!.position.x).toBe(200));
    // the guides are gone once the mouse is released
    expect(document.querySelectorAll("[data-testid=smart-guide]")).toHaveLength(0);
  });

  it("are skipped while Alt is held, and when the option is off", async () => {
    const t = setup();
    await t.add(200, 50);
    const m = await t.add(0, 300);
    render(<t.Host />);
    await drag(t, m, 197, 0, { altKey: true });
    await waitFor(() => expect(t.vs().find((v) => v.name === m)!.position.x).toBe(197));
    cleanup();
    const off = setup({ smartGuides: false });
    await off.add(200, 50);
    const m2 = await off.add(0, 300);
    render(<off.Host />);
    const guides = await drag(off, m2, 197, 0);
    expect(guides).toEqual([]);
    await waitFor(() => expect(off.vs().find((v) => v.name === m2)!.position.x).toBe(197));
  });

  it("the grid snaps a move to its cells, and the lines are drawn when Gridlines is on", async () => {
    const t = setup({ smartGuides: false, snapToGrid: true, gridlines: true, gridSize: 20 });
    const m = await t.add(0, 300);
    render(<t.Host />);
    const region = screen.getByRole("region", { name: /^Page / });
    expect(region.style.backgroundSize).toBe("20px 20px");
    await drag(t, m, 47, 13);
    await waitFor(() => expect(t.vs().find((v) => v.name === m)!.position).toMatchObject({ x: 40, y: 320 }));
  });

  it("Lock objects keeps a visual where it is but still selects it", async () => {
    const t = setup({ lockObjects: true });
    const m = await t.add(10, 300);
    render(<t.Host />);
    await drag(t, m, 100, 0);
    expect(t.vs().find((v) => v.name === m)!.position.x).toBe(10);
    expect(t.frame(m).getAttribute("data-selected")).toBe("true");
  });
});
