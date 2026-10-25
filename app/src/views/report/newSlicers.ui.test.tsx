// @vitest-environment jsdom
// The new slicers (Slicer (new), List slicer, Text slicer): they select through the same pipeline as the slicer and
// filter the other visuals of the page.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column, lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
import { defaultSlicerStyle, slicerMode } from "../../core/report/slicerSettings";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

const Country = column("Customer", "Country");
const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);
const text = (v: string) => cell(v, "text");

function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = (q) => (q.includes("VALUES(") || q.includes("DISTINCT(") ? { results: [result(["c"], [[text("Canada")], [text("France")], [text("Japan")]])], elapsedMs: 1 } : { results: [result(["a", "b"], [[text("Bikes"), cell("1")]])], elapsedMs: 1 });
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  const visuals = () => parsePage(session.store.project!, "page1")!.visuals;
  return { session, dax, run, Host, visuals };
}

describe("the new slicers", () => {
  it("start in their own style: buttons, a drop-down list, a vertical list", () => {
    expect(slicerMode(defaultSlicerStyle("advancedSlicerVisual", false), false)).toBe("Tile");
    expect(slicerMode(defaultSlicerStyle("listSlicer", false), false)).toBe("Dropdown");
    expect(slicerMode(defaultSlicerStyle("slicer", false), false)).toBe("Basic");
    expect(slicerMode(defaultSlicerStyle("textSlicer", true), false)).toBe("Between");
  });

  it("Slicer (new) shows the values as buttons; clicking one filters the other visuals", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "advancedSlicerVisual", fields: [{ role: "Values", field: Country }] });
    await t.run("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    render(<t.Host />);
    const france = await screen.findByRole("option", { name: "France" });
    fireEvent.click(france);
    await waitFor(() => expect(t.visuals().find((v) => v.visualType === "advancedSlicerVisual")!.filters.defs[0].cond).toEqual({ kind: "in", values: [lit.str("France")] }));
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes("Customer[Country]") && c.includes('"France"') && c.includes("Product[Category]"))).toBe(true));
  });

  it("List slicer is a drop-down: the button shows the selection, the list opens below", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "listSlicer", fields: [{ role: "Values", field: Country }] });
    render(<t.Host />);
    const open = await screen.findByRole("button", { name: "Open the list of values" });
    expect(open.textContent).toMatch(/All/);
    fireEvent.click(open);
    fireEvent.click(await screen.findByLabelText("Japan"));
    await waitFor(() => expect(t.visuals()[0].filters.defs[0].cond).toEqual({ kind: "in", values: [lit.str("Japan")] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open the list of values" }).textContent).toMatch(/Japan/));
  });

  it("Text slicer: typing text and pressing Enter keeps the rows that match; clearing removes the filter", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "textSlicer", fields: [{ role: "Values", field: Country }] });
    await t.run("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    render(<t.Host />);
    const box = await screen.findByLabelText("Text to match in Country");
    fireEvent.change(box, { target: { value: " fra " } });
    fireEvent.keyDown(box, { key: "Enter" });
    const filterOf = () => t.visuals().find((v) => v.visualType === "textSlicer")!.filters.defs[0]?.cond;
    await waitFor(() => expect(filterOf()).toEqual({ kind: "text", op: "contains", value: "fra" }));
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes("CONTAINSSTRING(Customer[Country], \"fra\")"))).toBe(true));
    fireEvent.change(screen.getByLabelText("Match"), { target: { value: "startsWith" } });
    await waitFor(() => expect(filterOf()).toEqual({ kind: "text", op: "startsWith", value: "fra" }));
    fireEvent.click(screen.getByLabelText("Clear the text"));
    await waitFor(() => expect(filterOf()).toBeUndefined());
  });
});
