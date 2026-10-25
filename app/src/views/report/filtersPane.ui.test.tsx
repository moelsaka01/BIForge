// @vitest-environment jsdom
// Filters pane: relative date type, include / exclude, lock and hide, collapse, search, clear all.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { column, lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

function setup(readOnly = false) {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = () => ({ results: [result(["c"], [])], elapsedMs: 1 });
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} readOnly={readOnly} />;
  }
  const defs = () => parsePage(session.store.project!, "page1")!.filters.defs;
  return { session, dax, run, Host, defs };
}
const addFilter = (t: ReturnType<typeof setup>, name: string, field = column("Sales", "OrderDate")) =>
  t.run("report.filter.upsert", { scope: { level: "page", page: "page1" }, filter: { name, field, cond: { kind: "in", values: [] } } });

describe("Filters pane", () => {
  it("a date filter can switch to Relative date and stores the condition", async () => {
    const t = setup();
    await addFilter(t, "fd");
    render(<t.Host />);
    const card = await screen.findByRole("region", { name: "Filter on OrderDate" });
    fireEvent.change(within(card).getByLabelText("Filter type for OrderDate"), { target: { value: "relative" } });
    fireEvent.change(within(card).getByLabelText("Relative date: number"), { target: { value: "3" } });
    fireEvent.change(within(card).getByLabelText("Relative date: unit"), { target: { value: "months" } });
    fireEvent.click(within(card).getByRole("button", { name: "Apply filter" }));
    await waitFor(() => expect(t.defs()[0].cond).toEqual({ kind: "relativeDate", op: "last", n: 3, unit: "months", includeToday: true }));
    expect(card.textContent).toMatch(/last 3 months/);
  });

  it("Include / Exclude turns the selection into 'all except'", async () => {
    const t = setup();
    await addFilter(t, "fc", column("Product", "Category"));
    t.dax.handler = (q) => (q.includes("VALUES(") ? { results: [result(["c"], [])], elapsedMs: 1 } : { results: [result(["a"], [])], elapsedMs: 1 });
    render(<t.Host />);
    const card = await screen.findByRole("region", { name: "Filter on Category" });
    fireEvent.change(within(card).getByLabelText("Include or exclude"), { target: { value: "exclude" } });
    await waitFor(() => expect(t.defs()[0].cond).toEqual({ kind: "notIn", values: [] }));
    fireEvent.change(within(card).getByLabelText("Include or exclude"), { target: { value: "include" } });
    await waitFor(() => expect(t.defs()[0].cond).toEqual({ kind: "in", values: [] }));
  });

  it("lock and hide are stored on the filter; a card collapses; the search narrows; Clear all empties every filter", async () => {
    const t = setup();
    await addFilter(t, "fd");
    await addFilter(t, "fc", column("Product", "Category"));
    await t.run("report.filter.upsert", { scope: { level: "page", page: "page1" }, filter: { name: "fc", field: column("Product", "Category"), cond: { kind: "in", values: [lit.str("Bikes")] } } });
    render(<t.Host />);
    const card = await screen.findByRole("region", { name: "Filter on OrderDate" });
    fireEvent.click(within(card).getByRole("button", { name: "Lock filter on OrderDate" }));
    await waitFor(() => expect(t.defs().find((d) => d.name === "fd")!.locked).toBe(true));
    fireEvent.click(within(card).getByRole("button", { name: "Hide filter on OrderDate" }));
    await waitFor(() => expect(t.defs().find((d) => d.name === "fd")!.hidden).toBe(true));
    // collapse hides the body, keeps the header
    const body = () => within(card).getByLabelText("Filter type for OrderDate").closest("fieldset") as HTMLElement;
    expect(body().style.display).not.toBe("none");
    fireEvent.click(within(card).getByRole("button", { name: "Collapse filter on OrderDate" }));
    expect(body().style.display).toBe("none");
    fireEvent.click(within(card).getByRole("button", { name: "Expand filter on OrderDate" }));
    expect(body().style.display).not.toBe("none");
    // search
    fireEvent.change(screen.getByLabelText("Search filters"), { target: { value: "categ" } });
    expect(screen.queryByRole("region", { name: "Filter on OrderDate" })).toBeNull();
    expect(screen.getByRole("region", { name: "Filter on Category" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search filters"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    await waitFor(() => expect(t.defs().find((d) => d.name === "fc")!.cond).toEqual({ kind: "in", values: [] }));
  });

  it("readers of the report (view mode) do not see hidden filters and cannot change locked ones", async () => {
    const t = setup(true);
    await t.run("report.filter.upsert", { scope: { level: "page", page: "page1" }, filter: { name: "fd", field: column("Sales", "OrderDate"), cond: { kind: "in", values: [] }, locked: true } });
    await t.run("report.filter.upsert", { scope: { level: "page", page: "page1" }, filter: { name: "fc", field: column("Product", "Category"), cond: { kind: "in", values: [] }, hidden: true } });
    render(<t.Host />);
    const card = await screen.findByRole("region", { name: "Filter on OrderDate" });
    expect(screen.queryByRole("region", { name: "Filter on Category" })).toBeNull();
    expect((within(card).getByLabelText("Filter type for OrderDate") as HTMLSelectElement).closest("fieldset")!.disabled).toBe(true);
    expect((within(card).getByRole("button", { name: "Remove filter on OrderDate" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
