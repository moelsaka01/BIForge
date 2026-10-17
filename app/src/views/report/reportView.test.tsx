// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { listBookmarks } from "../../core/report/bookmarks";
import { agg, column, lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { getFormat, listPages, parsePage, visualKey } from "../../core/report/visualDoc";
import { ReportView, type ReportViewProps } from "./ReportView";
import { BookmarksPane } from "./BookmarksPane";
import { FIELD_MIME, VisualizationsPane } from "./VisualizationsPane";
import * as echartsLib from "echarts/core";

installDomStubs();
afterEach(cleanup);

const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Qty = agg("Sales", "Quantity", 0);
const text = (v: string) => cell(v, "text");
const rows = (...r: [string, number][]) => r.map(([a, b]) => [text(a), cell(String(b))]);

function setup(docks?: ReportViewProps["docks"], readOnly = false) {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  const dax = new FakeDax();
  const errors: string[] = [];
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return (
      <ReportView
        project={doc.project!}
        runtime={session.report}
        dax={dax}
        dispatch={(id, a) =>
          void registry.execute(id, a).then((r) => {
            if (!r.ok) errors.push(r.message);
          })
        }
        dataEpoch={0}
        docks={docks}
        readOnly={readOnly}
      />
    );
  }
  const page = () => parsePage(session.store.project!, "page1")!;
  const answer = (match: string, ...results: ReturnType<typeof result>[]) => dax.answers.push({ match, outcome: { results, elapsedMs: 1 } });
  return { session, registry, dax, run, Host, page, errors, answer };
}

describe("ReportView: drawing", () => {
  it("draws a column chart from the engine's answer", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    t.answer("SUMMARIZECOLUMNS(Product[Category]", result(["a", "b"], rows(["Accessories", 278], ["Bikes", 270])));
    render(<t.Host />);
    const chart = await screen.findByTestId("chart");
    await waitFor(() => expect(chart.textContent).toContain("Accessories"));
    expect(chart.textContent).toContain("Bikes");
    expect(screen.getByRole("group", { name: /Visual: Sum of Quantity by Category/ })).toBeTruthy();
  });

  it("shows the engine's error inside the visual instead of failing the page", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "card", fields: [{ role: "Values", field: Qty }] });
    t.dax.handler = () => new Error("The function XIRR is not implemented");
    render(<t.Host />);
    expect((await screen.findByRole("alert")).textContent).toContain("XIRR is not implemented");
  });

  it("a visual without fields explains what to do", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart" });
    await t.run("report.visual.add", { page: "page1", type: "map" });
    render(<t.Host />);
    expect((await screen.findAllByText(/Add fields to this visual/)).length).toBeGreaterThan(0);
  });

  it("table and card render values; the table shows a totals row", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "tableEx", fields: [{ role: "Values", field: Cat }, { role: "Values", field: Qty }] });
    await t.run("report.visual.add", { page: "page1", type: "card", position: { x: 600 }, fields: [{ role: "Values", field: Qty }] });
    t.answer("SUMMARIZECOLUMNS(Product[Category]", result(["a", "b"], rows(["Bikes", 270], ["Clothing", 181])));
    t.answer("SUMMARIZECOLUMNS(\"m0\"", result(["m"], [[cell("451")]]));
    render(<t.Host />);
    const table = await screen.findByRole("table", { name: "Table" });
    await waitFor(() => expect(within(table).getByText("Clothing")).toBeTruthy());
    expect(within(table).getByTestId("table-totals").textContent).toContain("451");
    expect((await screen.findByTestId("card-value")).textContent).toBe("451");
  });

  it("the theme colors the page", async () => {
    const t = setup();
    await t.run("report.theme.apply", { builtin: "BIForge Dark" });
    render(<t.Host />);
    const region = await screen.findByRole("region", { name: /Page Page 1/ });
    expect(region.style.background).toMatch(/rgb\(17, 17, 17\)|#111111/);
  });
});

describe("ReportView: interactions", () => {
  async function twoVisuals() {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "tableEx", fields: [{ role: "Values", field: Cat }, { role: "Values", field: Qty }] });
    await t.run("report.visual.add", { page: "page1", type: "tableEx", position: { x: 600 }, fields: [{ role: "Values", field: Country }, { role: "Values", field: Qty }] });
    t.dax.handler = (q) =>
      q.includes("TREATAS")
        ? { results: [result(["a", "b"], rows(["France", 5]))], elapsedMs: 1 }
        : q.includes("Customer[Country]")
          ? { results: [result(["a", "b"], rows(["France", 50], ["Canada", 30]))], elapsedMs: 1 }
          : q.includes("SUMMARIZECOLUMNS(\"m0\"")
            ? { results: [result(["m"], [[cell("80")]])], elapsedMs: 1 }
            : { results: [result(["a", "b"], rows(["Bikes", 270], ["Clothing", 181]))], elapsedMs: 1 };
    return t;
  }

  it("clicking a row filters the other visuals and clicking it again clears the filter", async () => {
    const t = await twoVisuals();
    render(<t.Host />);
    const tables = await screen.findAllByRole("table", { name: "Table" });
    await waitFor(() => expect(within(tables[0]).getByText("Bikes")).toBeTruthy());
    fireEvent.click(within(tables[0]).getByText("Bikes"));
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes('TREATAS({"Bikes"}, Product[Category])'))).toBe(true));
    await waitFor(() => expect(within(screen.getAllByRole("table", { name: "Table" })[1]).getByText("5")).toBeTruthy());
    expect(t.session.report.getSnapshot().selection?.points).toHaveLength(1);
    fireEvent.click(within(screen.getAllByRole("table", { name: "Table" })[0]).getByText("Bikes"));
    expect(t.session.report.getSnapshot().selection).toBeNull();
    await waitFor(() => expect(within(screen.getAllByRole("table", { name: "Table" })[1]).getByText("France")).toBeTruthy());
  });

  it("Edit interactions: turning a visual off stops the filtering", async () => {
    const t = await twoVisuals();
    const [a, b] = t.page().visuals;
    await t.run("report.interaction.set", { page: "page1", source: a.name, target: b.name, type: "NoFilter" });
    render(<t.Host />);
    const tables = await screen.findAllByRole("table", { name: "Table" });
    await waitFor(() => expect(within(tables[0]).getByText("Bikes")).toBeTruthy());
    fireEvent.click(within(tables[0]).getByText("Bikes"));
    await waitFor(() => expect(t.session.report.getSnapshot().selection).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(t.dax.calls.every((c) => !c.includes("TREATAS") || !c.includes("Customer[Country]"))).toBe(true);
  });

  it("edit-interactions mode shows filter, highlight and none on the other visuals", async () => {
    const t = await twoVisuals();
    const [a, b] = t.page().visuals;
    render(<t.Host />);
    await screen.findAllByRole("table", { name: "Table" });
    await t.run("report.interaction.edit", { source: a.name });
    const target = await waitFor(() => {
      const el = document.querySelector(`[data-visual="${b.name}"]`)!;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const group = await within(target).findByRole("group", { name: /Interaction from the selected visual/ });
    fireEvent.click(within(group).getByRole("button", { name: "None" }));
    await waitFor(() => expect(t.page().interactions).toEqual([{ source: a.name, target: b.name, type: "NoFilter" }]));
    expect(within(group).getByRole("button", { name: "Highlight" }).hasAttribute("disabled")).toBe(true);
  });

  it("a list slicer filters the page and remembers its selection in the document", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "slicer", fields: [{ role: "Values", field: Country }] });
    await t.run("report.visual.add", { page: "page1", type: "card", position: { x: 600 }, fields: [{ role: "Values", field: Qty }] });
    t.dax.handler = (q) =>
      q.includes("VALUES(Customer[Country])")
        ? { results: [result(["c"], [[text("Canada")], [text("France")]])], elapsedMs: 1 }
        : { results: [result(["m"], [[cell(q.includes("France") ? "50" : "80")]])], elapsedMs: 1 };
    render(<t.Host />);
    await waitFor(() => expect(screen.getByTestId("card-value").textContent).toBe("80"));
    fireEvent.click(await screen.findByLabelText("France"));
    await waitFor(() => expect(screen.getByTestId("card-value").textContent).toBe("50"));
    const slicer = t.page().visuals.find((v) => v.visualType === "slicer")!;
    expect(slicer.filters.defs[0].cond).toEqual({ kind: "in", values: [lit.str("France")] });
    await t.run("edit.undo");
    await waitFor(() => expect(screen.getByTestId("card-value").textContent).toBe("80"));
  });
});

describe("ReportView: editing", () => {
  it("moving and resizing with the pointer is one undo step each", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "card", position: { x: 100, y: 100, width: 200, height: 120 }, fields: [{ role: "Values", field: Qty }] });
    t.dax.handler = () => ({ results: [result(["m"], [[cell("5")]])], elapsedMs: 1 });
    render(<t.Host />);
    const v = t.page().visuals[0];
    const frame = await waitFor(() => document.querySelector(`[data-visual="${v.name}"]`) as HTMLElement);
    fireEvent.pointerDown(frame, { button: 0 });
    const bar = await screen.findByTestId("visual-bar");
    const region = screen.getByRole("region", { name: /Page Page 1/ });
    // the zoom is "fit", so use the real scale from the transform
    const scale = Number(/scale\(([\d.]+)\)/.exec(region.style.transform)![1]);
    fireEvent.pointerDown(bar, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(region, { clientX: 50 * scale, clientY: 30 * scale, pointerId: 1 });
    fireEvent.pointerUp(region, { pointerId: 1 });
    await waitFor(() => expect(t.page().visuals[0].position).toMatchObject({ x: 150, y: 130, width: 200, height: 120 }));
    const handle = document.querySelector(`[data-visual="${v.name}"] [data-handle="se"]`)!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(region, { clientX: 40 * scale, clientY: 20 * scale, pointerId: 1 });
    fireEvent.pointerUp(region, { pointerId: 1 });
    await waitFor(() => expect(t.page().visuals[0].position).toMatchObject({ x: 150, y: 130, width: 240, height: 140 }));
    await t.run("edit.undo");
    expect(t.page().visuals[0].position).toMatchObject({ width: 200, height: 120 });
    await t.run("edit.undo");
    expect(t.page().visuals[0].position).toMatchObject({ x: 100, y: 100 });
  });

  it("keyboard: arrows nudge, Delete removes the selected visual", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "card", position: { x: 100, y: 100 }, fields: [{ role: "Values", field: Qty }] });
    t.dax.handler = () => ({ results: [result(["m"], [[cell("5")]])], elapsedMs: 1 });
    render(<t.Host />);
    const v = t.page().visuals[0];
    const frame = await waitFor(() => document.querySelector(`[data-visual="${v.name}"]`) as HTMLElement);
    fireEvent.pointerDown(frame, { button: 0 });
    const region = screen.getByRole("region", { name: /Page Page 1/ });
    fireEvent.keyDown(region, { key: "ArrowRight" });
    fireEvent.keyDown(region, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(t.page().visuals[0].position).toMatchObject({ x: 101, y: 110 }));
    fireEvent.keyDown(region, { key: "Delete" });
    await waitFor(() => expect(t.page().visuals).toHaveLength(0));
    expect(await screen.findByText(/This page is empty/)).toBeTruthy();
  });

  it("the Visualizations pane adds a visual of the chosen type and changes the type of the selected one", async () => {
    const t = setup();
    t.dax.handler = () => ({ results: [result(["a", "b"], rows(["Bikes", 1]))], elapsedMs: 1 });
    render(<t.Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Pie chart" }));
    await waitFor(() => expect(t.page().visuals.map((v) => v.visualType)).toEqual(["pieChart"]));
    const frame = document.querySelector(`[data-visual="${t.page().visuals[0].name}"]`)!;
    fireEvent.pointerDown(frame, { button: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Donut chart" }));
    await waitFor(() => expect(t.page().visuals.map((v) => v.visualType)).toEqual(["donutChart"]));
  });

  it("dropping a Data-pane field on a well adds it; the field can be removed again", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart" });
    t.dax.handler = () => ({ results: [result(["a", "b"], rows(["Bikes", 1]))], elapsedMs: 1 });
    render(<t.Host />);
    const frame = await waitFor(() => document.querySelector(`[data-visual="${t.page().visuals[0].name}"]`) as HTMLElement);
    fireEvent.pointerDown(frame, { button: 0 });
    const well = await waitFor(() => document.querySelector('[data-well="Y"]') as HTMLElement);
    fireEvent.drop(well, { dataTransfer: { getData: (m: string) => (m === FIELD_MIME ? JSON.stringify({ kind: "column", table: "Sales", name: "Quantity" }) : "") } });
    await waitFor(() => expect(t.page().visuals[0].roles.Y?.[0].field).toEqual(Qty));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Sum of Quantity" }));
    await waitFor(() => expect(t.page().visuals[0].roles.Y).toBeUndefined());
  });

  it("page tabs: add, rename by double-click, delete from the menu", async () => {
    const t = setup();
    render(<t.Host />);
    fireEvent.click(await screen.findByRole("button", { name: "New page" }));
    await waitFor(() => expect(listPages(t.session.store.project!)).toHaveLength(2));
    const tab = screen.getByRole("tab", { name: "Page 2" });
    fireEvent.doubleClick(tab);
    const input = await screen.findByLabelText("Page name");
    fireEvent.change(input, { target: { value: "Overview" } });
    fireEvent.blur(input);
    await waitFor(() => expect(listPages(t.session.store.project!).map((p) => p.displayName)).toEqual(["Page 1", "Overview"]));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Overview" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete page" }));
    await waitFor(() => expect(listPages(t.session.store.project!)).toHaveLength(1));
  });
});

describe("ReportView: format, filters, bookmarks", () => {
  it("the Format pane writes title and legend settings and offers only supported controls", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    t.dax.handler = () => ({ results: [result(["a", "b"], rows(["Bikes", 1]))], elapsedMs: 1 });
    render(<t.Host />);
    const v = t.page().visuals[0];
    fireEvent.pointerDown(await waitFor(() => document.querySelector(`[data-visual="${v.name}"]`) as HTMLElement), { button: 0 });
    fireEvent.click(await screen.findByRole("tab", { name: "Format visual" }));
    fireEvent.click(await screen.findByRole("tab", { name: "General" }));
    const titleCard = (await waitFor(() => document.querySelector('[data-card="title"]'))) as HTMLElement;
    const title = within(titleCard).getByLabelText("Text");
    fireEvent.change(title, { target: { value: "Quantity by category" } });
    await waitFor(() => expect(getFormat(t.session.store.project!.report.files[visualKey("page1", v.name)], "title", "text")).toEqual(lit.str("Quantity by category")));
    await waitFor(() => expect(screen.getByText("Quantity by category")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));
    await screen.findByText("Legend");
    // the cards of the schema for this chart, not those of other visual types
    expect(screen.queryByText("Slices")).toBeNull();
  });

  it("a visual-level filter from the Filters pane narrows the query", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    t.dax.handler = (q) => (q.includes("VALUES(Product[Category])") ? { results: [result(["c"], [[text("Bikes")], [text("Clothing")]])], elapsedMs: 1 } : { results: [result(["a", "b"], rows(["Bikes", 1]))], elapsedMs: 1 });
    render(<t.Host />);
    const v = t.page().visuals[0];
    fireEvent.pointerDown(await waitFor(() => document.querySelector(`[data-visual="${v.name}"]`) as HTMLElement), { button: 0 });
    const add = await screen.findByLabelText("Add a field to Filters on this visual");
    fireEvent.change(add, { target: { value: "Product.Category" } });
    const card = await screen.findByRole("region", { name: "Filter on Category" });
    fireEvent.click(await within(card).findByLabelText("Bikes"));
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes('FILTER(ALL(Product[Category]), Product[Category] IN {"Bikes"})'))).toBe(true));
    expect(t.page().visuals[0].filters.defs[0].cond).toEqual({ kind: "in", values: [lit.str("Bikes")] });
  });

  it("bookmarks: add and apply", async () => {
    const t = setup((api) => ({ right: <><div style={{ width: 240 }}><VisualizationsPane page={api.page} visual={api.visual} onAdded={api.onAdded} /></div><div style={{ width: 230 }}><BookmarksPane /></div></> }));
    await t.run("report.visual.add", { page: "page1", type: "slicer", fields: [{ role: "Values", field: Country }] });
    t.dax.handler = (q) => (q.includes("VALUES(") ? { results: [result(["c"], [[text("Canada")], [text("France")]])], elapsedMs: 1 } : { results: [result(["m"], [[cell("1")]])], elapsedMs: 1 });
    render(<t.Host />);
    fireEvent.change(await screen.findByLabelText("Bookmark name"), { target: { value: "Before" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(listBookmarks(t.session.store.project!).map((b) => b.name)).toEqual(["Before"]));
    fireEvent.click(await screen.findByLabelText("France"));
    await waitFor(() => expect(t.page().visuals[0].filters.defs).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Apply bookmark Before" }));
    await waitFor(() => expect(t.page().visuals[0].filters.defs).toHaveLength(0));
  });

  it("errors from a command are not thrown into the UI", async () => {
    const t = setup();
    render(<t.Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Pie chart" }));
    await waitFor(() => expect(t.page().visuals).toHaveLength(1));
    expect(t.errors).toEqual([]);
  });
});

describe("ReportView: chart data points", () => {
  function pointerAt(chart: HTMLElement, cat: string, value: number) {
    const inst = echartsLib.getInstanceByDom(chart)!;
    const px = inst.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [cat, value]) as number[];
    const root = chart.querySelector("svg")!;
    return { x: px[0], y: px[1], root };
  }

  it("clicking a column selects its data point and filters a table", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", position: { x: 20, y: 20, width: 500, height: 300 }, fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    await t.run("report.visual.add", { page: "page1", type: "tableEx", position: { x: 600, y: 20, width: 400, height: 300 }, fields: [{ role: "Values", field: Country }, { role: "Values", field: Qty }] });
    t.dax.handler = (q) =>
      q.includes("TREATAS") ? { results: [result(["a", "b"], rows(["France", 7]))], elapsedMs: 1 } : q.includes("Customer[Country]") ? { results: [result(["a", "b"], rows(["France", 50], ["Canada", 30]))], elapsedMs: 1 } : q.includes("SUMMARIZECOLUMNS(\"m0\"") ? { results: [result(["m"], [[cell("80")]])], elapsedMs: 1 } : { results: [result(["a", "b"], rows(["Accessories", 278], ["Bikes", 270]))], elapsedMs: 1 };
    render(<t.Host />);
    const chart = await screen.findByTestId("chart");
    await waitFor(() => expect(chart.textContent).toContain("Bikes"));
    const { x, y, root } = pointerAt(chart, "Bikes", 100);
    fireEvent.mouseMove(root, { clientX: x, clientY: y });
    fireEvent.mouseDown(root, { clientX: x, clientY: y });
    fireEvent.mouseUp(root, { clientX: x, clientY: y });
    fireEvent.click(root, { clientX: x, clientY: y });
    await waitFor(() => expect(t.session.report.getSnapshot().selection?.points[0].values).toEqual([lit.str("Bikes")]));
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes('TREATAS({"Bikes"}, Product[Category])'))).toBe(true));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Table" })).getByText("7")).toBeTruthy());
  });

  it("right-click offers drillthrough to a page that accepts the point", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Category detail", type: "Drillthrough" });
    const detail = t.session.report.getSnapshot().page!;
    await t.run("report.page.setDrillthroughFields", { page: detail, fields: [Cat] });
    await t.run("report.page.go", { page: "page1" });
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", position: { x: 20, y: 20, width: 500, height: 300 }, fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    t.dax.handler = () => ({ results: [result(["a", "b"], rows(["Accessories", 278], ["Bikes", 270]))], elapsedMs: 1 });
    render(<t.Host />);
    const chart = await screen.findByTestId("chart");
    await waitFor(() => expect(chart.textContent).toContain("Bikes"));
    const { x, y, root } = pointerAt(chart, "Bikes", 100);
    fireEvent.mouseMove(root, { clientX: x, clientY: y });
    fireEvent.contextMenu(root, { clientX: x, clientY: y });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Drill through to Category detail" }));
    await waitFor(() => expect(t.session.report.getSnapshot().page).toBe(detail));
    expect(t.session.report.getSnapshot().drillthrough?.filters[0].cond).toEqual({ kind: "in", values: [lit.str("Bikes")] });
    expect(await screen.findByText(/Drillthrough from another page/)).toBeTruthy();
  });

  it("hovering a point whose tooltip is a report page shows that page filtered to the point", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Tip", type: "Tooltip" });
    const tip = t.session.report.getSnapshot().page!;
    await t.run("report.visual.add", { page: tip, type: "card", position: { x: 10, y: 10, width: 120, height: 80 }, fields: [{ role: "Values", field: Qty }] });
    await t.run("report.page.go", { page: "page1" });
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", position: { x: 20, y: 20, width: 500, height: 300 }, fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    const v = t.page().visuals[0].name;
    await t.run("report.format.set", { page: "page1", visual: v, object: "visualTooltip", prop: "type", value: lit.str("Canvas") });
    await t.run("report.format.set", { page: "page1", visual: v, object: "visualTooltip", prop: "section", value: lit.str(tip) });
    t.dax.handler = (q) => (q.includes("TREATAS") || q.includes('Product[Category] IN {"Bikes"}') ? { results: [result(["m"], [[cell("270")]])], elapsedMs: 1 } : q.includes("SUMMARIZECOLUMNS(Product[Category]") ? { results: [result(["a", "b"], rows(["Accessories", 278], ["Bikes", 270]))], elapsedMs: 1 } : { results: [result(["m"], [[cell("730")]])], elapsedMs: 1 });
    render(<t.Host />);
    const chart = await screen.findByTestId("chart");
    await waitFor(() => expect(chart.textContent).toContain("Bikes"));
    const { x, y, root } = pointerAt(chart, "Bikes", 100);
    fireEvent.mouseMove(root, { clientX: x, clientY: y });
    const overlay = await screen.findByTestId("tooltip-page");
    await waitFor(() => expect(within(overlay).getByTestId("card-value").textContent).toBe("270"));
    fireEvent.mouseOut(root, { clientX: 0, clientY: 0, relatedTarget: document.body });
  });

  it("viewing mode: right-click on a visual shows no editing items", async () => {
    const edit = setup();
    await edit.run("report.visual.add", { page: "page1", type: "card", position: { x: 20, y: 20, width: 200, height: 120 }, fields: [{ role: "Values", field: Qty }] });
    const view = setup(undefined, true);
    const one = () => ({ results: [result(["m"], [[cell("730")]])], elapsedMs: 1 });
    view.dax.handler = one;
    edit.dax.handler = one;
    view.session.store.load(edit.session.store.project!);
    render(<view.Host />);
    const card = await screen.findByTestId("card-value");
    fireEvent.contextMenu(card);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    cleanup();
    render(<edit.Host />);
    fireEvent.contextMenu(await screen.findByTestId("card-value"));
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });
});
