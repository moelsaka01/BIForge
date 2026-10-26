// @vitest-environment jsdom
// Card (new): a tile for each field of the Data well, with the value, a caption and an optional accent bar.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

describe("Card (new)", () => {
  it("shows a tile for each field with its value and caption; the label can move above and an accent bar is drawn", async () => {
    const session = new Session(new FakeIO(), new FakeDialogs());
    session.store.load(fixtureProject());
    const registry = createRegistry(session);
    session.report.goToPage("page1");
    const dax = new FakeDax();
    dax.handler = () => ({ results: [result(["a", "b"], [[cell("1234"), cell("56")]])], elapsedMs: 1 });
    const run = async (id: string, args?: unknown) => {
      const r = await registry.execute(id, args);
      if (!r.ok) throw new Error(r.message);
    };
    function Host() {
      const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
      return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
    }
    await run("report.visual.add", { type: "cardVisual", fields: [{ role: "Data", field: agg("Sales", "Quantity", 0) }, { role: "Data", field: agg("Sales", "UnitPrice", 1) }] });
    const name = parsePage(session.store.project!, "page1")!.visuals[0].name;
    expect(parsePage(session.store.project!, "page1")!.visuals[0].roles.Data).toHaveLength(2);
    render(<Host />);
    const tiles = await screen.findAllByTestId("new-card-tile");
    expect(tiles).toHaveLength(2);
    expect(within(tiles[0]).getByTestId("new-card-value").textContent).toMatch(/1[.,]?2?3?4|1\.2K|1234/);
    expect(within(tiles[0]).getByTestId("new-card-label").textContent).toMatch(/Quantity/);
    expect(within(tiles[1]).getByTestId("new-card-label").textContent).toMatch(/UnitPrice|Unit/);
    expect(tiles[0].style.borderLeft).toBe("");
    await run("report.format.set", { page: "page1", visual: name, object: "accentBar", prop: "show", value: lit.bool(true) });
    await run("report.format.set", { page: "page1", visual: name, object: "label", prop: "position", value: lit.str("aboveValue") });
    await waitFor(() => expect((screen.getAllByTestId("new-card-tile")[0] as HTMLElement).style.borderLeft).toMatch(/4px solid/));
    const first = screen.getAllByTestId("new-card-tile")[0];
    expect(first.firstElementChild?.getAttribute("data-testid")).toBe("new-card-label");
  });
});

describe("Smart narrative", () => {
  it("writes the summary of its fields into the visual", async () => {
    const session = new Session(new FakeIO(), new FakeDialogs());
    session.store.load(fixtureProject());
    const registry = createRegistry(session);
    session.report.goToPage("page1");
    const dax = new FakeDax();
    dax.handler = () => ({ results: [result(["a", "b"], [[cell("Bikes", "text"), cell("70")], [cell("Clothing", "text"), cell("30")]])], elapsedMs: 1 });
    function Host() {
      const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
      return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
    }
    const r = await registry.execute("report.visual.add", { type: "aiNarratives", fields: [{ role: "Values", field: { kind: "column", table: "Product", name: "Category" } }, { role: "Values", field: agg("Sales", "Quantity", 0) }] });
    expect(r.ok).toBe(true);
    render(<Host />);
    const box = await screen.findByTestId("narrative");
    await waitFor(() => expect(box.textContent).toMatch(/Bikes has the highest Sum of Quantity \(70\), 70% of the total\./));
    expect(box.textContent).toMatch(/Clothing has the lowest \(30\)/);
    expect(box.querySelectorAll("strong").length).toBeGreaterThan(3);
  });
});
