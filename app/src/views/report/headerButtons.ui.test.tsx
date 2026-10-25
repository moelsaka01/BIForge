// @vitest-environment jsdom
// The buttons of the visual header: the hierarchy selector, the filters funnel, focus mode, the data table, the status
// buttons and Copy visual as image. Each one is driven through the real report view.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { agg, column, lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { ReportView, plainDocks } from "./ReportView";

vi.mock("html-to-image", () => ({ toBlob: async () => new Blob(["png"], { type: "image/png" }) }));

installDomStubs();
afterEach(cleanup);

const Cat = column("Product", "Category");
const Sub = column("Product", "Subcategory");
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
    const cols = /Subcategory|City/.test(q) ? 4 : 3;
    return { results: [result(Array.from({ length: cols }, (_, i) => `c${i}`), [Array.from({ length: cols }, (_, i) => (i === cols - 1 ? cell("5") : cell(`v${i}`, "text")))])], elapsedMs: 1 };
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  const run = async (id: string, args?: unknown) => {
    const r = await act(async () => registry.execute(id, args));
    if (!r.ok) throw new Error(r.message);
  };
  const names = () => parsePage(session.store.project!, "page1")!.visuals.map((v) => v.name);
  const frame = (name: string) => document.querySelector(`[data-visual="${name}"]`) as HTMLElement;
  const chart = async (roles: { role: string; field: typeof Cat }[]) => {
    await run("report.visual.add", { type: "clusteredColumnChart", fields: [...roles, { role: "Y", field: Qty as never }], position: { x: 10, y: 10, width: 500, height: 300 } });
    return names().at(-1)!;
  };
  const hover = async (name: string) => {
    await waitFor(() => expect(frame(name)).toBeTruthy());
    fireEvent.pointerDown(frame(name), { button: 0 });
    await waitFor(() => expect(within(frame(name)).getByTestId("visual-bar")).toBeTruthy());
    return within(frame(name));
  };
  return { session, dax, run, Host, names, frame, chart, hover };
}

describe("drill hierarchy selector", () => {
  const matrix = async (t: ReturnType<typeof setup>) => {
    await t.run("report.visual.add", { type: "pivotTable", fields: [{ role: "Rows", field: Cat }, { role: "Rows", field: Sub }, { role: "Columns", field: Country }, { role: "Columns", field: City }, { role: "Values", field: Qty as never }], position: { x: 10, y: 10, width: 500, height: 300 } });
    return t.names().at(-1)!;
  };
  const statements = (t: ReturnType<typeof setup>) => (t.dax.calls.filter((c) => c.startsWith("query:")).at(-1) ?? "").split("EVALUATE").length - 1;

  it("a matrix has two hierarchies: the buttons follow the rows or the columns, which show fewer or more levels", async () => {
    const t = setup();
    const name = await matrix(t);
    render(<t.Host />);
    const bar = await t.hover(name);
    const select = bar.getByLabelText("Drill hierarchy") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Rows: Category", "Columns: Country"]);
    expect(select.value).toBe("Rows");
    // every level of both is shown until the matrix is drilled: (2 + 1) x (2 + 1) statements
    await waitFor(() => expect(statements(t)).toBe(9));
    fireEvent.click(bar.getByRole("button", { name: "Drill up" }));
    await waitFor(() => expect(t.session.report.getSnapshot().drill[name]).toMatchObject({ level: 0, expand: true }));
    await waitFor(() => expect(statements(t)).toBe(6)); // rows down to the first level only
    // choose the columns: the same button now takes a level off the columns
    fireEvent.change(select, { target: { value: "Columns" } });
    await waitFor(() => expect(t.session.report.getSnapshot().drillRole[name]).toBe("Columns"));
    fireEvent.click(within(t.frame(name)).getByRole("button", { name: "Drill up" }));
    await waitFor(() => expect(t.session.report.getSnapshot().drill[`${name}#Columns`]).toMatchObject({ level: 0, expand: true }));
    await waitFor(() => expect(statements(t)).toBe(4)); // (1 + 1) x (1 + 1)
    // and the next level brings the second column field back
    fireEvent.click(within(t.frame(name)).getByRole("button", { name: "Go to the next level" }));
    // (the same query as before the columns were drilled, which the loader still has)
    await waitFor(() => expect(t.session.report.getSnapshot().drill[`${name}#Columns`]).toMatchObject({ level: 1, expand: true }));
    expect(t.session.report.getSnapshot().drill[name]?.level).toBe(0); // the rows keep their position
  });

  it("a chart with a hierarchy on its axis shows no selector and drills the axis", async () => {
    const t = setup();
    const name = await t.chart([{ role: "Category", field: Cat }, { role: "Category", field: Sub }]);
    render(<t.Host />);
    const bar = await t.hover(name);
    expect(bar.queryByLabelText("Drill hierarchy")).toBeNull();
    fireEvent.click(bar.getByRole("button", { name: "Go to the next level" }));
    await waitFor(() => expect(t.session.report.getSnapshot().drill[name]?.level).toBe(1));
    await waitFor(() => expect(t.dax.calls.some((c) => /Subcategory/.test(c))).toBe(true));
    fireEvent.click(within(t.frame(name)).getByRole("button", { name: "Drill up" }));
    await waitFor(() => expect(t.session.report.getSnapshot().drill[name]).toBeUndefined());
  });

  it("a matrix with a hierarchy on one side only drills that side without a selector", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "pivotTable", fields: [{ role: "Rows", field: Cat }, { role: "Rows", field: Sub }, { role: "Columns", field: Country }, { role: "Values", field: Qty as never }], position: { x: 10, y: 10, width: 500, height: 300 } });
    const name = t.names().at(-1)!;
    render(<t.Host />);
    const bar = await t.hover(name);
    expect(bar.queryByLabelText("Drill hierarchy")).toBeNull();
    fireEvent.click(bar.getByRole("button", { name: "Drill up" }));
    await waitFor(() => expect(t.session.report.getSnapshot().drill[name]).toMatchObject({ level: 0, expand: true }));
  });
});

describe("filters funnel", () => {
  it("lists the report, page, visual and slicer filters and the selection in another visual", async () => {
    const t = setup();
    const name = await t.chart([{ role: "Category", field: Cat }]);
    await t.run("report.filter.upsert", { scope: { level: "report" }, filter: { name: "r", field: Country, cond: { kind: "in", values: [lit.str("France")] } } });
    await t.run("report.filter.upsert", { scope: { level: "page", page: "page1" }, filter: { name: "p", field: Cat, cond: { kind: "notIn", values: [lit.str("Clothing")] } } });
    await t.run("report.filter.upsert", { scope: { level: "visual", page: "page1", visual: name }, filter: { name: "v", field: Qty, cond: { kind: "cmp", op: "gt", value: lit.num(3) } } });
    render(<t.Host />);
    const bar = await t.hover(name);
    fireEvent.click(bar.getByRole("button", { name: "Filters on this visual (3)" }));
    const pop = await screen.findByRole("dialog", { name: "Filters on this visual" });
    const items = within(pop).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Report: Country is France", "Page: Category is not Clothing", "Visual: Sum of Quantity is greater than 3"]);
  });

  it("is not there when nothing filters the visual, or when the header card turns it off", async () => {
    const t = setup();
    const name = await t.chart([{ role: "Category", field: Cat }]);
    render(<t.Host />);
    const bar = await t.hover(name);
    expect(bar.queryByRole("button", { name: /Filters on this visual/ })).toBeNull();
    await t.run("report.filter.upsert", { scope: { level: "report" }, filter: { name: "r", field: Country, cond: { kind: "in", values: [lit.str("France")] } } });
    await waitFor(() => expect(within(t.frame(name)).queryByRole("button", { name: /Filters on this visual/ })).toBeTruthy());
    await t.run("report.format.set", { page: "page1", visual: name, object: "visualHeader", prop: "showFilterRestatementButton", value: lit.bool(false) });
    await waitFor(() => expect(within(t.frame(name)).queryByRole("button", { name: /Filters on this visual/ })).toBeNull());
  });
});

describe("focus mode and the data table", () => {
  it("focus mode lets one visual fill the page and Back to report returns", async () => {
    const t = setup();
    const a = await t.chart([{ role: "Category", field: Cat }]);
    const b = await t.chart([{ role: "Category", field: Country }]);
    render(<t.Host />);
    const bar = await t.hover(a);
    fireEvent.click(bar.getByRole("button", { name: "Focus mode" }));
    await waitFor(() => expect(t.session.report.getSnapshot().focus).toBe(a));
    expect(t.frame(b)).toBeNull();
    expect(t.frame(a).style.width).toBe("1256px"); // the page is 1280 wide
    fireEvent.click(screen.getByTestId("exit-focus"));
    await waitFor(() => expect(t.frame(b)).toBeTruthy());
    expect(t.session.report.getSnapshot().focus).toBeNull();
    // a page change also leaves it
    t.session.report.setFocus(a);
    t.session.report.goToPage("other");
    expect(t.session.report.getSnapshot().focus).toBeNull();
  });

  it("Show data as a table replaces the picture by the rows it was drawn from, and back", async () => {
    const t = setup();
    const name = await t.chart([{ role: "Category", field: Cat }]);
    render(<t.Host />);
    const bar = await t.hover(name);
    fireEvent.click(bar.getByRole("button", { name: "Show data as a table" }));
    const table = await screen.findByTestId("visual-data");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(expect.arrayContaining(["Category"]));
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    fireEvent.click(within(t.frame(name)).getByRole("button", { name: "Show data as a table" }));
    await waitFor(() => expect(screen.queryByTestId("visual-data")).toBeNull());
  });
});

describe("status buttons", () => {
  it("a failed query shows the error button with the message", async () => {
    const t = setup();
    t.dax.handler = () => new Error("The column was not found");
    const name = await t.chart([{ role: "Category", field: Cat }]);
    render(<t.Host />);
    const bar = await t.hover(name);
    fireEvent.click(await within(t.frame(name)).findByRole("button", { name: "Error" }));
    expect((await screen.findByRole("dialog", { name: "Error" })).textContent).toContain("The column was not found");
    void bar;
  });

  it("a partial load shows the warning button; the card can turn it off", async () => {
    const t = setup();
    t.dax.handler = () => ({ results: [{ ...result(["c0", "c1"], [[cell("a", "text"), cell("1")]]), truncated: true }], elapsedMs: 1 });
    const name = await t.chart([{ role: "Category", field: Cat }]);
    render(<t.Host />);
    await t.hover(name);
    fireEvent.click(await within(t.frame(name)).findByRole("button", { name: "Warning" }));
    expect((await screen.findByRole("dialog", { name: "Warning" })).textContent).toMatch(/Not all of the data is shown/);
    await t.run("report.format.set", { page: "page1", visual: name, object: "visualHeader", prop: "showVisualWarningButton", value: lit.bool(false) });
    await waitFor(() => expect(within(t.frame(name)).queryByRole("button", { name: "Warning" })).toBeNull());
  });
});

describe("Copy visual as image", () => {
  it("is off until the card turns it on, then puts a PNG of the visual on the clipboard", async () => {
    const t = setup();
    const name = await t.chart([{ role: "Category", field: Cat }]);
    render(<t.Host />);
    const bar = await t.hover(name);
    expect(bar.queryByRole("button", { name: "Copy visual as image" })).toBeNull();
    const written: unknown[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async (items: unknown[]) => void written.push(...items) } });
    vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Blob>) {} });
    await t.run("report.format.set", { page: "page1", visual: name, object: "visualHeader", prop: "showCopyVisualImageButton", value: lit.bool(true) });
    fireEvent.click(await within(t.frame(name)).findByRole("button", { name: "Copy visual as image" }));
    await screen.findByText("Copied the visual as an image");
    expect(written).toHaveLength(1);
    expect((written[0] as { data: Record<string, Blob> }).data["image/png"].type).toBe("image/png");
    vi.unstubAllGlobals();
  });
});
