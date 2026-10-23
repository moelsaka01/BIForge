// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { fixtureProject } from "../../core/report/testFixture";
import { listPageNames, parsePage } from "../../core/report/visualDoc";
import { dragGroup } from "./PageCanvas";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

function setup() {
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
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  const vs = () => parsePage(session.store.project!, "page1")!.visuals;
  const add = async (x: number, y: number) => {
    await run("report.visual.add", { type: "shape", position: { x, y, width: 100, height: 60 } });
    return vs().at(-1)!.name;
  };
  const frame = (name: string) => document.querySelector(`[data-visual="${name}"]`) as HTMLElement;
  const click = (name: string, mods: object = {}) => fireEvent.pointerDown(frame(name), { button: 0, ...mods });
  return { session, run, Host, vs, add, frame, click };
}

describe("dragGroup", () => {
  const o = (x: number, y: number) => ({ x, y, z: 0, width: 100, height: 50 });
  it("moves all by the same amount and stops when the first one reaches the page edge", () => {
    const r = dragGroup({ a: o(10, 10), b: o(300, 100) }, 50, 20, 1000, 500);
    expect(r.a).toMatchObject({ x: 60, y: 30 });
    expect(r.b).toMatchObject({ x: 350, y: 120 });
    const edge = dragGroup({ a: o(10, 10), b: o(300, 100) }, -50, -50, 1000, 500);
    expect(edge.a).toMatchObject({ x: 0, y: 0 });
    expect(edge.b).toMatchObject({ x: 290, y: 90 });
    const right = dragGroup({ a: o(10, 10), b: o(850, 100) }, 500, 0, 1000, 500);
    expect(right.b.x).toBe(900);
    expect(right.a.x).toBe(60);
  });
});

describe("selecting several visuals on the canvas", () => {
  it("Shift+click adds and removes visuals; a plain click on another visual selects only it", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    const c = await t.add(400, 0);
    render(<t.Host />);
    await waitFor(() => expect(t.frame(a)).toBeTruthy());
    t.click(a);
    t.click(b, { shiftKey: true });
    expect(t.session.report.getSnapshot().canvas).toEqual([a, b]);
    expect(t.frame(a).getAttribute("data-selected")).toBe("true");
    t.click(c, { ctrlKey: true });
    expect(t.session.report.getSnapshot().canvas).toEqual([a, b, c]);
    t.click(b, { shiftKey: true });
    expect(t.session.report.getSnapshot().canvas).toEqual([a, c]);
    t.click(b);
    expect(t.session.report.getSnapshot().canvas).toEqual([b]);
    // no resize handles on a multiple selection
    t.click(a, { shiftKey: true });
    expect(document.querySelectorAll("[data-handle]")).toHaveLength(0);
    t.click(a);
    expect(document.querySelectorAll("[data-handle]")).toHaveLength(8);
  });

  it("pressing the title bar of a selected visual keeps the selection (so the group can be dragged); a plain click on its body selects only it", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    render(<t.Host />);
    await waitFor(() => expect(t.frame(a)).toBeTruthy());
    t.click(a);
    t.click(b, { shiftKey: true });
    fireEvent.pointerEnter(t.frame(a));
    fireEvent.pointerDown(t.frame(a).querySelector("[data-testid=visual-bar]") as HTMLElement, { button: 0 });
    expect(t.session.report.getSnapshot().canvas).toEqual([a, b]);
    t.click(a);
    expect(t.session.report.getSnapshot().canvas).toEqual([a]);
  });

  it("Ctrl+A selects every visible visual; Delete removes the whole selection in one step; Escape clears", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    const c = await t.add(400, 0);
    await t.run("report.visual.setHidden", { page: "page1", visual: c, hidden: true });
    render(<t.Host />);
    const region = await screen.findByRole("region", { name: /^Page / });
    fireEvent.keyDown(region, { key: "a", ctrlKey: true });
    expect(t.session.report.getSnapshot().canvas).toEqual([a, b]);
    fireEvent.keyDown(region, { key: "Escape" });
    expect(t.session.report.getSnapshot().canvas).toEqual([]);
    fireEvent.keyDown(region, { key: "a", ctrlKey: true });
    fireEvent.keyDown(region, { key: "Delete" });
    await waitFor(() => expect(t.vs().map((v) => v.name)).toEqual([c]));
    await t.run("edit.undo");
    expect(t.vs()).toHaveLength(3);
  });

  it("arrow keys nudge the whole selection; Shift moves ten", async () => {
    const t = setup();
    const a = await t.add(10, 10);
    const b = await t.add(300, 100);
    render(<t.Host />);
    const region = await screen.findByRole("region", { name: /^Page / });
    act(() => t.session.report.setCanvasSelection([a, b]));
    fireEvent.keyDown(region, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(t.vs().map((v) => v.position.x)).toEqual([20, 310]));
    fireEvent.keyDown(region, { key: "ArrowDown" });
    await waitFor(() => expect(t.vs().map((v) => v.position.y)).toEqual([11, 101]));
    await t.run("edit.undo");
    expect(t.vs().map((v) => v.position.y)).toEqual([10, 100]);
  });

  it("Ctrl+C and Ctrl+V copy and paste the selection; Ctrl+X cuts it", async () => {
    const t = setup();
    const a = await t.add(10, 10);
    render(<t.Host />);
    const region = await screen.findByRole("region", { name: /^Page / });
    t.click(a);
    fireEvent.keyDown(region, { key: "c", ctrlKey: true });
    await waitFor(() => expect(t.session.report.getSnapshot().clipboard).not.toBeNull());
    fireEvent.keyDown(region, { key: "v", ctrlKey: true });
    await waitFor(() => expect(t.vs()).toHaveLength(2));
    fireEvent.keyDown(region, { key: "x", ctrlKey: true });
    await waitFor(() => expect(t.vs()).toHaveLength(1));
  });

  it("Ctrl+D duplicates every selected visual", async () => {
    const t = setup();
    const a = await t.add(10, 10);
    const b = await t.add(300, 10);
    render(<t.Host />);
    const region = await screen.findByRole("region", { name: /^Page / });
    act(() => t.session.report.setCanvasSelection([a, b]));
    fireEvent.keyDown(region, { key: "d", ctrlKey: true });
    await waitFor(() => expect(t.vs()).toHaveLength(4));
    await t.run("edit.undo");
    await waitFor(() => expect(t.vs()).toHaveLength(3));
  });

  it("Ctrl+Shift+C clears the selected data points", async () => {
    const t = setup();
    const a = await t.add(10, 10);
    render(<t.Host />);
    const region = await screen.findByRole("region", { name: /^Page / });
    act(() => t.session.report.select("page1", a, { field: "Product[Category]", value: "Bikes" } as never, false));
    expect(t.session.report.getSnapshot().selection).not.toBeNull();
    fireEvent.keyDown(region, { key: "C", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(t.session.report.getSnapshot().selection).toBeNull());
  });

  it("the Action card on any visual: Ctrl+click follows the link, the hover text says what it does or why it cannot", async () => {
    const t = setup();
    const a = await t.add(10, 10);
    await t.run("report.page.add");
    const pages = () => listPageNames(t.session.store.project!);
    const second = pages()!.find((n) => n !== "page1")!;
    t.session.report.goToPage("page1");
    const fmt = (prop: string, v: unknown) => t.run("report.format.set", { page: "page1", visual: a, object: "visualLink", prop, value: v });
    render(<t.Host />);
    await waitFor(() => expect(t.frame(a)).toBeTruthy());
    expect(t.frame(a).getAttribute("data-link")).toBeNull();
    await fmt("type", { t: "string", v: "PageNavigation" });
    // no page chosen yet: the tooltip says why the action cannot run, and Ctrl+click does nothing
    await waitFor(() => expect(t.frame(a).getAttribute("title")).toBe("No page is chosen for this button."));
    fireEvent.click(t.frame(a), { ctrlKey: true });
    expect(t.session.report.getSnapshot().page).toBe("page1");
    await fmt("navigationSection", { t: "string", v: second });
    await waitFor(() => expect(t.frame(a).getAttribute("title")).toBe("Ctrl+click to go to the page"));
    await fmt("enabledTooltip", { t: "string", v: "Open the details page" });
    await waitFor(() => expect(t.frame(a).getAttribute("title")).toBe("Open the details page"));
    fireEvent.click(t.frame(a));
    expect(t.session.report.getSnapshot().page).toBe("page1"); // a plain click only selects
    fireEvent.click(t.frame(a), { ctrlKey: true });
    await waitFor(() => expect(t.session.report.getSnapshot().page).toBe(second));
  });

  it("a rubber band over empty canvas selects the visuals it touches; Shift adds to the selection", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(200, 0);
    const c = await t.add(600, 400);
    render(<t.Host />);
    const region = await screen.findByRole("region", { name: /^Page / });
    // the page is drawn at a scale; the canvas rectangle is empty in jsdom, so client coordinates are scaled page coordinates
    const scale = parseFloat(/scale\(([\d.]+)\)/.exec(region.style.transform)![1]);
    const at = (x: number, y: number) => ({ clientX: x * scale, clientY: y * scale, button: 0 });
    fireEvent.pointerDown(region, at(50, 30));
    fireEvent.pointerMove(region, at(250, 100));
    expect(screen.getByTestId("rubber-band")).toBeTruthy();
    fireEvent.pointerUp(region, at(250, 100));
    expect(t.session.report.getSnapshot().canvas).toEqual([a, b]);
    expect(screen.queryByTestId("rubber-band")).toBeNull();
    fireEvent.pointerDown(region, { ...at(550, 350), shiftKey: true });
    fireEvent.pointerMove(region, at(700, 480));
    fireEvent.pointerUp(region, at(700, 480));
    expect(t.session.report.getSnapshot().canvas).toEqual([a, b, c]);
    // a plain click on empty canvas clears
    fireEvent.pointerDown(region, at(1000, 600));
    fireEvent.pointerUp(region, at(1000, 600));
    expect(t.session.report.getSnapshot().canvas).toEqual([]);
  });

  it("dragging the title bar of one selected visual moves all selected visuals in one step", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(300, 100);
    render(<t.Host />);
    await waitFor(() => expect(t.frame(a)).toBeTruthy());
    t.click(a);
    t.click(b, { shiftKey: true });
    const region = screen.getByRole("region", { name: /^Page / });
    const scale = parseFloat(/scale\(([\d.]+)\)/.exec(region.style.transform)![1]);
    fireEvent.pointerEnter(t.frame(b));
    const bar = t.frame(b).querySelector("[data-testid=visual-bar]") as HTMLElement;
    fireEvent.pointerDown(bar, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(region, { clientX: 100 + 50 * scale, clientY: 100 + 20 * scale });
    fireEvent.pointerUp(region);
    await waitFor(() => expect(t.vs().map((v) => [v.position.x, v.position.y])).toEqual([[50, 20], [350, 120]]));
    await t.run("edit.undo");
    expect(t.vs().map((v) => v.position.x)).toEqual([0, 300]);
  });
});
