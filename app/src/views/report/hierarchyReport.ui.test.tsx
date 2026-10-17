// @vitest-environment jsdom
// A slicer with two fields in the report view: it loads the combinations, shows the tree and writes the selection as a filter
// that another visual's query then carries.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
const text = (v: string) => cell(v, "text");
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

const Country = column("Customer", "Country");
const City = column("Customer", "City");
const Qty = agg("Sales", "Quantity", 0);

function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = (q) => {
    if (q.includes("SUMMARIZECOLUMNS(Customer[Country], Customer[City]")) {
      return { results: [result(["Country", "City"], [[text("Canada"), text("Toronto")], [text("France"), text("Lyon")], [text("France"), text("Paris")]])], elapsedMs: 1 };
    }
    return { results: [result(["m"], [[cell("1")]])], elapsedMs: 1 };
  };
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  return { run, Host, session, dax };
}

describe("hierarchy slicer in the report", () => {
  it("two fields make a tree; ticking a branch stores a hierarchy filter and the card's query carries it", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "slicer", position: { x: 10, y: 10, width: 240, height: 280 }, fields: [{ role: "Values", field: Country }, { role: "Values", field: City }] });
    await t.run("report.visual.add", { type: "card", position: { x: 300, y: 10, width: 200, height: 100 }, fields: [{ role: "Values", field: Qty }] });
    render(<t.Host />);
    const tree = await screen.findByRole("tree", { name: "Hierarchy values" });
    expect(within(tree).getAllByRole("treeitem")).toHaveLength(2); // Canada, France; cities appear on Expand
    fireEvent.click(within(tree).getByRole("button", { name: "Expand France" }));
    expect(within(tree).getByText("Paris")).toBeTruthy();
    const slicerFilter = () => parsePage(t.session.store.project!, "page1")!.visuals.find((v) => v.visualType === "slicer")!.filters.defs[0]?.cond;
    // a whole top-level branch is stored as an ordinary list on the first field (what a one-level selection is in PBIR)
    fireEvent.click(within(tree).getByRole("checkbox", { name: "France" }));
    await waitFor(() => expect(slicerFilter()).toEqual({ kind: "in", values: [{ t: "string", v: "France" }] }));
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes('Customer[Country] IN {"France"}') && c.includes("SUM(Sales[Quantity])"))).toBe(true));
    // a leaf is a two-level tuple, filtered through both columns
    fireEvent.click(within(tree).getByRole("checkbox", { name: "France" })); // off
    await waitFor(() => expect(slicerFilter()).toBeUndefined());
    fireEvent.click(within(tree).getByRole("checkbox", { name: "Paris" }));
    await waitFor(() => expect(slicerFilter()).toMatchObject({ kind: "tuples", rows: [[{ t: "string", v: "France" }, { t: "string", v: "Paris" }]] }));
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes('FILTER(ALL(Customer[Country], Customer[City]), (Customer[Country] = "France" && Customer[City] = "Paris"))'))).toBe(true));
  });

  it("fields from two tables are refused with a readable message", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "slicer", position: { x: 10, y: 10, width: 240, height: 200 }, fields: [{ role: "Values", field: Country }, { role: "Values", field: column("Product", "Category") }] });
    render(<t.Host />);
    expect((await screen.findByText(/must come from one table/)).textContent).toMatch(/hierarchy slicer/);
  });
});
