// @vitest-environment jsdom
// The decomposition tree and key influencers, over the fixture data (queries answered from the CSV files).
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { csvDax } from "../../core/testing/csvDax";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column } from "../../core/report/fields";
import { fixtureProject, loadCsv } from "../../core/report/testFixture";
import { formatCompact } from "../../core/report/numberFormat";
import { parsePage } from "../../core/report/visualDoc";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Channel = column("Sales", "Channel");
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
  return { session, run, Host, dax, visual: () => parsePage(session.store.project!, "page1")!.visuals[0] };
}

// expected values, from the CSV files
const sales = loadCsv("Sales");
const productCategory = new Map(loadCsv("Product").map((p) => [p.ProductKey, p.Category]));
const customerCountry = new Map(loadCsv("Customer").map((c) => [c.CustomerKey, c.Country]));
const sum = (rows: typeof sales) => rows.reduce((a, r) => a + Number(r.Quantity), 0);
const byCategory = (rows: typeof sales) => {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = productCategory.get(r.ProductKey) || "(Blank)";
    m.set(k, (m.get(k) ?? 0) + Number(r.Quantity));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const compact = (n: number) => formatCompact(n, "auto", 1, null);

describe("decomposition tree", () => {
  it("shows the total, splits by a chosen field largest first, and one more level under the chosen node", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "decompositionTreeVisual", position: { width: 800, height: 500 }, fields: [{ role: "Analyze", field: Qty }, { role: "ExplainBy", field: Cat }, { role: "ExplainBy", field: Country }, { role: "ExplainBy", field: Channel }] });
    render(<t.Host />);
    const root = await screen.findByTestId("tree-root");
    await waitFor(() => expect(root.textContent).toContain(compact(sum(sales))));
    // the first split: by Category
    fireEvent.click(await screen.findByRole("button", { name: "Split by (level 1)" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Category" }));
    const level1 = await screen.findByTestId("tree-level-1");
    const cats = byCategory(sales);
    await waitFor(() => expect(within(level1).getAllByRole("treeitem").map((n) => n.getAttribute("data-node"))).toEqual(cats.map(([c]) => c)));
    expect(within(level1).getAllByRole("treeitem")[0].textContent).toContain(compact(cats[0][1]));
    // the bars are relative to the largest of the level by default
    expect(within(level1).getAllByTestId("tree-bar")[0].style.width).toBe("100%");
    // choose the top node and split it by Country: the next level only counts that category
    fireEvent.click(within(level1).getAllByRole("treeitem")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Split by (level 2)" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Country" }));
    const level2 = await screen.findByTestId("tree-level-2");
    const inTop = sales.filter((r) => (productCategory.get(r.ProductKey) || "(Blank)") === cats[0][0]);
    const byCountry = new Map<string, number>();
    for (const r of inTop) {
      const k = customerCountry.get(r.CustomerKey) || "(Blank)";
      byCountry.set(k, (byCountry.get(k) ?? 0) + Number(r.Quantity));
    }
    const expected = [...byCountry.entries()].sort((a, b) => b[1] - a[1]);
    await waitFor(() => expect(within(level2).getAllByRole("treeitem").map((n) => n.getAttribute("data-node"))).toEqual(expected.map(([c]) => c)));
    expect(within(level2).getAllByRole("treeitem")[0].textContent).toContain(compact(expected[0][1]));
    // removing level 1 removes the levels below it
    fireEvent.click(within(level1).getByRole("button", { name: "Remove level 1" }));
    await waitFor(() => expect(screen.queryByTestId("tree-level-1")).toBeNull());
  });

  it("High value splits by the field whose top group stands out and selects that group", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "decompositionTreeVisual", position: { width: 800, height: 500 }, fields: [{ role: "Analyze", field: Qty }, { role: "ExplainBy", field: Cat }, { role: "ExplainBy", field: Country }] });
    render(<t.Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Split by (level 1)" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "High value" }));
    const level1 = await screen.findByTestId("tree-level-1");
    await waitFor(() => expect(within(level1).getAllByRole("treeitem").length).toBeGreaterThan(1));
    expect(level1.textContent).toMatch(/\(high value\)/);
    // the group the split highlights is open, so a second level (or its "+") follows
    const selected = within(level1).getAllByRole("treeitem").filter((n) => n.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
  });

  it("asks for fields while Analyze is empty, and a slicer on the page filters the tree", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "decompositionTreeVisual", position: { width: 800, height: 500 } });
    render(<t.Host />);
    expect(await screen.findByText(/Add a measure to Analyze/)).toBeTruthy();
    cleanup();
    const u = setup();
    await u.run("report.visual.add", { type: "decompositionTreeVisual", position: { width: 800, height: 500 }, fields: [{ role: "Analyze", field: Qty }, { role: "ExplainBy", field: Cat }] });
    await u.run("report.visual.add", { type: "slicer", fields: [{ role: "Values", field: Country }] });
    const slicer = parsePage(u.session.store.project!, "page1")!.visuals.find((v) => v.visualType === "slicer")!;
    await u.run("report.slicer.select", { page: "page1", visual: slicer.name, field: Country, cond: { kind: "in", values: [{ t: "string", v: "France" }] } });
    render(<u.Host />);
    const france = sales.filter((r) => customerCountry.get(r.CustomerKey) === "France");
    await waitFor(() => expect(screen.getByTestId("tree-root").textContent).toContain(compact(sum(france))));
  });
});

describe("key influencers", () => {
  it("a categorical target: the outcome can be chosen, the list is ranked and a detail shows the groups", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "keyDriversVisual", position: { width: 600, height: 500 }, fields: [{ role: "Target", field: Channel }, { role: "ExplainBy", field: Cat }, { role: "ExplainBy", field: Country }] });
    render(<t.Host />);
    const view = await screen.findByTestId("key-influencers");
    await waitFor(() => expect(within(view).getAllByRole("combobox").length).toBeGreaterThan(0));
    const outcome = within(view).getByLabelText("Outcome") as HTMLSelectElement;
    const channels = [...new Set(sales.map((r) => r.Channel).filter(Boolean))].sort();
    await waitFor(() => expect(Array.from(outcome.options).map((o) => o.value).sort()).toEqual(channels));
    fireEvent.change(outcome, { target: { value: channels[0] } });
    await waitFor(() => expect(view.textContent).toMatch(new RegExp(`${channels[0]} is [\\d.]+% of ${sales.filter((r) => r.Channel).length} cases`)));
    // every listed influence is a group where the outcome is more likely than outside it
    const items = await within(view).findAllByRole("listitem");
    for (const li of items) expect(li.textContent).toMatch(/is [\d.]+× more likely to be|is far more likely to be/);
    expect(within(view).getByRole("group", { name: /^Detail of / })).toBeTruthy();
  });

  it("a numeric target (average of a column): influences are the values with a higher average", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "keyDriversVisual", position: { width: 600, height: 500 }, fields: [{ role: "Target", field: agg("Sales", "UnitPrice", 1) }, { role: "ExplainBy", field: Cat }, { role: "ExplainBy", field: Channel }] });
    render(<t.Host />);
    const view = await screen.findByTestId("key-influencers");
    await waitFor(() => expect(view.textContent).toMatch(/The average of Average of UnitPrice is/));
    const items = within(view).queryAllByRole("listitem");
    for (const li of items) expect(li.textContent).toMatch(/the average of .* is [\d.]+× higher/);
  });
});
