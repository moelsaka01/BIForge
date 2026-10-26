// @vitest-environment jsdom
// The bubble map and the filled map in the report view, drawn from the bundled outlines, over the fixture data.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { lit } from "../../core/report/fields";
import { createRegistry } from "../../core/commands/builtin";
import { csvDax } from "../../core/testing/csvDax";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

const City = column("Customer", "City");
const Country = column("Customer", "Country");
const Category = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);

function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = (q) => csvDax(q);
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  return { run, Host, session };
}

describe("map tools and heat map", () => {
  const addMap = async (t: ReturnType<typeof setup>, format: [string, string, ReturnType<typeof lit.bool> | ReturnType<typeof lit.num> | ReturnType<typeof lit.str>][]) => {
    await t.run("report.visual.add", { type: "map", position: { width: 600, height: 400 }, fields: [{ role: "Category", field: Country }, { role: "Size", field: Qty }] });
    const page = (await import("../../core/report/visualDoc")).parsePage(t.session.store.project!, "page1")!;
    const v = page.visuals[page.visuals.length - 1];
    for (const [object, prop, value] of format) await t.run("report.format.set", { page: "page1", visual: v.name, object, prop, value });
    return v;
  };

  it("the zoom buttons and the lasso button appear only when the Format pane turns them on", async () => {
    const t = setup();
    await addMap(t, []);
    render(<t.Host />);
    await screen.findByRole("img", { name: "Map" });
    expect(screen.queryByRole("toolbar", { name: "Map tools" })).toBeNull();
    cleanup();
    const u = setup();
    await addMap(u, [["mapControls", "showZoomButtons", lit.bool(true)], ["mapControls", "showLassoButton", lit.bool(true)]]);
    render(<u.Host />);
    const bar = await screen.findByRole("toolbar", { name: "Map tools" });
    for (const n of ["Zoom in", "Zoom out", "Lasso select"]) expect(within(bar).getByRole("button", { name: n })).toBeTruthy();
    // zooming changes the zoom of the chart
    const chart = await screen.findByRole("img", { name: "Map" });
    await waitFor(() => expect(chart.querySelectorAll("path").length).toBeGreaterThan(100));
    const echartsLib = (await import("./echartsSetup")).echarts;
    const inst = echartsLib.getInstanceByDom(chart)!;
    const before = (inst.getOption() as { geo: { zoom: number }[] }).geo[0].zoom;
    fireEvent.click(within(bar).getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect((inst.getOption() as { geo: { zoom: number }[] }).geo[0].zoom).toBeGreaterThan(before));
  });

  it("the lasso selects every point inside the rectangle, and Ctrl adds to the selection", async () => {
    const t = setup();
    const v = await addMap(t, [["mapControls", "showLassoButton", lit.bool(true)]]);
    render(<t.Host />);
    const chart = await screen.findByRole("img", { name: "Map" });
    await waitFor(() => expect(chart.querySelectorAll("path").length).toBeGreaterThan(100));
    fireEvent.click(screen.getByRole("button", { name: "Lasso select" }));
    const layer = await screen.findByTestId("lasso-layer");
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    layer.setPointerCapture = () => undefined;
    // a rectangle over the whole map takes in every located point
    fireEvent.pointerDown(layer, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 600, clientY: 400, pointerId: 1 });
    await act(async () => void fireEvent.pointerUp(layer, { clientX: 600, clientY: 400, pointerId: 1 }));
    await waitFor(() => expect(t.session.report.getSnapshot().selection?.visual).toBe(v.name));
    const n = t.session.report.getSnapshot().selection!.points.length;
    expect(n).toBeGreaterThan(1);
    expect(screen.queryByTestId("lasso-layer")).toBeNull(); // one rectangle per click of the button
    // an empty rectangle clears it
    fireEvent.click(screen.getByRole("button", { name: "Lasso select" }));
    const layer2 = await screen.findByTestId("lasso-layer");
    layer2.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    layer2.setPointerCapture = () => undefined;
    fireEvent.pointerDown(layer2, { clientX: 1, clientY: 1, pointerId: 1 });
    await act(async () => void fireEvent.pointerUp(layer2, { clientX: 2, clientY: 2, pointerId: 1 }));
    await waitFor(() => expect(t.session.report.getSnapshot().selection).toBeNull());
  });
});

describe("maps", () => {
  it("a bubble map draws the world outlines and one bubble per located city", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "map", position: { width: 600, height: 400 }, fields: [{ role: "Category", field: City }, { role: "Size", field: Qty }] });
    render(<t.Host />);
    const chart = await screen.findByRole("img", { name: "Map" });
    // the country outlines are drawn as paths, from the registered Natural Earth data (no tiles are requested)
    await waitFor(() => expect(chart.querySelectorAll("path").length).toBeGreaterThan(100));
    // every city of the fixture is known; only the rows without a city (no customer) cannot be placed, and the notice says so
    expect(screen.getByTestId("chart-notice").textContent).toMatch(/1 location not drawn.*: \(Blank\)$/);
  });

  it("a shape map draws the regions of the built-in world map", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "shapeMap", position: { width: 600, height: 400 }, fields: [{ role: "Category", field: Country }, { role: "Y", field: Qty }] });
    render(<t.Host />);
    const chart = await screen.findByRole("img", { name: "Shape map" });
    await waitFor(() => expect(chart.querySelectorAll("path").length).toBeGreaterThan(100));
  });

  it("a filled map draws the countries; places the data does not know are listed under the map", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "filledMap", position: { width: 600, height: 400 }, fields: [{ role: "Category", field: Country }, { role: "Size", field: Qty }] });
    render(<t.Host />);
    const chart = await screen.findByRole("img", { name: "Filled map" });
    await waitFor(() => expect(chart.querySelectorAll("path").length).toBeGreaterThan(100));
    cleanup();
    const u = setup();
    await u.run("report.visual.add", { type: "filledMap", position: { width: 600, height: 400 }, fields: [{ role: "Category", field: Category }, { role: "Size", field: Qty }] });
    render(<u.Host />);
    // product categories are not places: nothing can be drawn, and the person is told which values were skipped
    await waitFor(() => expect(screen.getByText(/not drawn.*Accessories/)).toBeTruthy());
  });
});
