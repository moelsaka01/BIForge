// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { column } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { listPageNames, parsePage } from "../../core/report/visualDoc";
import { syncGroupOf, visualDisplayName } from "../../core/report/reportOps";
import { ReportView } from "./ReportView";
import { SelectionPane } from "./SelectionPane";
import { SyncSlicersPane } from "./SyncSlicersPane";

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
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={() => ({ right: <><SelectionPane /><SyncSlicersPane /></> })} />;
  }
  const vs = (page = "page1") => parsePage(session.store.project!, page)!.visuals;
  return { session, run, Host, vs };
}

describe("Selection pane", () => {
  it("lists visuals front first; select, hide, reorder and rename work and each is one document step", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "textbox" });
    await t.run("report.visual.add", { type: "shape" });
    render(<t.Host />);
    const pane = await screen.findByLabelText("Selection pane");
    const names = () => within(pane).getAllByRole("listitem").map((li) => li.textContent);
    await waitFor(() => expect(within(pane).getAllByRole("listitem")).toHaveLength(2));
    expect(names()[0]).toMatch(/Shape/);
    fireEvent.click(within(pane).getByRole("button", { name: "Select Text box" }));
    expect(t.session.report.getSnapshot().canvas).toEqual([t.vs().find((v) => v.visualType === "textbox")!.name]);
    fireEvent.click(within(pane).getByRole("button", { name: "Bring Text box forward" }));
    await waitFor(() => expect(names()[0]).toMatch(/Text box/));
    fireEvent.click(within(pane).getByRole("button", { name: "Hide Shape" }));
    await waitFor(() => expect(t.vs().find((v) => v.visualType === "shape")!.hidden).toBe(true));
    fireEvent.doubleClick(within(pane).getByRole("button", { name: "Select Text box" }));
    const input = within(pane).getByLabelText("Visual name");
    fireEvent.change(input, { target: { value: "Headline" } });
    fireEvent.blur(input);
    await waitFor(() => expect(visualDisplayName(t.vs().find((v) => v.visualType === "textbox")!.json)).toBe("Headline"));
    expect(within(pane).getByRole("button", { name: "Select Headline" })).toBeTruthy();
  });
});

describe("Sync slicers pane", () => {
  it("asks for a slicer first; Apply syncs the chosen pages and Stop syncing ends it", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Two" });
    const [p1, p2] = listPageNames(t.session.store.project!);
    await t.run("report.page.go", { page: p1 });
    await t.run("report.visual.add", { type: "slicer", fields: [{ role: "Values", field: column("Customer", "Country") }] });
    render(<t.Host />);
    const pane = await screen.findByLabelText("Sync slicers pane");
    expect(pane.textContent).toMatch(/Select a slicer/);
    act(() => t.session.report.setCanvasSelection([t.vs(p1)[0].name]));
    fireEvent.click(await screen.findByLabelText("Sync on Two"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(t.vs(p2)).toHaveLength(1));
    expect(syncGroupOf(t.vs(p1)[0].json)).toBe("Country");
    fireEvent.click(await screen.findByRole("button", { name: "Stop syncing" }));
    await waitFor(() => expect(syncGroupOf(t.vs(p1)[0].json)).toBeNull());
  });
});
