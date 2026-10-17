// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
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
  const page = () => parsePage(session.store.project!, "page1")!;
  return { session, run, Host, page };
}

describe("the phone layout canvas", () => {
  it("shows only the visuals on the phone, lets you add one, and removes with Delete without deleting the visual", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "shape", position: { x: 0, y: 0, width: 300, height: 200 } });
    await t.run("report.visual.add", { type: "shape", position: { x: 400, y: 0, width: 300, height: 200 } });
    const [a, b] = t.page().visuals.map((v) => v.name);
    await t.run("report.mobile.place", { page: "page1", visual: a });
    render(<t.Host />);
    await waitFor(() => expect(document.querySelector(`[data-visual="${a}"]`)).toBeTruthy());
    expect(document.querySelector(`[data-visual="${b}"]`)).toBeTruthy(); // the page shows both
    act(() => t.session.report.setMobile(true));
    const pane = await screen.findByRole("region", { name: "Phone layout" });
    await waitFor(() => expect(document.querySelector(`[data-visual="${b}"]`)).toBeNull()); // the phone shows what is on it
    expect(document.querySelector(`[data-visual="${a}"]`)).toBeTruthy();
    const canvas = screen.getByRole("region", { name: /phone layout/ });
    void canvas;
    fireEvent.click(within(pane).getByRole("button", { name: /^Add Shape to the phone layout$/ }));
    await waitFor(() => expect(document.querySelector(`[data-visual="${b}"]`)).toBeTruthy());
    expect(t.page().visuals.every((v) => v.mobile)).toBe(true);
    // Delete on the phone canvas takes the visual off the phone layout only
    const region = screen.getAllByRole("region").find((r) => r.getAttribute("data-page") === "page1")!;
    fireEvent.pointerDown(document.querySelector(`[data-visual="${b}"]`) as HTMLElement, { button: 0 });
    fireEvent.keyDown(region, { key: "Delete" });
    await waitFor(() => expect(t.page().visuals.find((v) => v.name === b)!.mobile).toBeUndefined());
    expect(t.page().visuals).toHaveLength(2);
  });

  it("dragging on the phone canvas changes the phone position and not the page position", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "shape", position: { x: 50, y: 60, width: 300, height: 200 } });
    const a = t.page().visuals[0].name;
    await t.run("report.mobile.place", { page: "page1", visual: a });
    render(<t.Host />);
    act(() => t.session.report.setMobile(true));
    await waitFor(() => expect(document.querySelector(`[data-visual="${a}"]`)).toBeTruthy());
    const region = document.querySelector("[data-page=page1]") as HTMLElement;
    const scale = parseFloat(/scale\(([\d.]+)\)/.exec(region.style.transform)![1]);
    fireEvent.pointerEnter(document.querySelector(`[data-visual="${a}"]`) as HTMLElement);
    const bar = document.querySelector(`[data-visual="${a}"] [data-testid=visual-bar]`) as HTMLElement;
    fireEvent.pointerDown(bar, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(region, { clientX: 100 + 4 * scale, clientY: 100 + 30 * scale, altKey: true });
    fireEvent.pointerUp(region);
    await waitFor(() => expect(t.page().visuals[0].mobile).toMatchObject({ x: 12, y: 38 }));
    expect(t.page().visuals[0].position).toMatchObject({ x: 50, y: 60 });
  });
});
