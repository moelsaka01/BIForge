// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DataView } from "./DataView";
import { ModelView, layoutCards } from "./ModelView";
import { listTables } from "../core/model/ops";
import { DataPane } from "./DataPane";
import { buildSpec, defaultTableName, emptyForm } from "./importForm";
import { FakeEngine, col } from "../core/testing/fakeEngine";
import { FakeDialogs, FakeIO } from "../core/testing/fakes";
import { Session } from "../core/session/session";
import { createRegistry } from "../core/commands/builtin";
import { listRelationships } from "../core/model/relationships";

afterEach(cleanup);

function bigEngine(n: number) {
  const e = new FakeEngine();
  e.tables.set("Big", {
    columns: [col("id", "int64"), col("name")],
    rows: Array.from({ length: n }, (_, i) => [String(i), `row ${i}`]),
  });
  return e;
}

describe("DataView", () => {
  it("renders only a window of a 100,000-row table, with column types", async () => {
    const e = bigEngine(100_000);
    render(<DataView engine={e} table="Big" reloadKey={0} />);
    await screen.findByText(/100,000 rows/);
    await waitFor(() => expect(screen.getByText("row 0")).toBeTruthy());
    const rendered = document.querySelectorAll("[data-row]").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
    expect(screen.getAllByText("Whole number").length).toBe(1);
    expect(screen.getAllByText("Text").length).toBe(1);
  });

  it("Find in table goes to the next matching cell, wrapping around, and says when there is none", async () => {
    const e = bigEngine(3000);
    render(<DataView engine={e} table="Big" reloadKey={0} />);
    await screen.findByText(/3,000 rows/);
    const box = screen.getByLabelText("Find in table");
    fireEvent.change(box, { target: { value: "row 25" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Found in row 26");
    await waitFor(() => expect(document.querySelector("[data-match=true]")?.textContent).toBe("row 25"));
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Found in row 251"); // "row 250" is the next cell that contains the text
    await waitFor(() => expect(document.querySelector("[data-match=true]")?.textContent).toBe("row 250"));
    // far down: scrolled to the row
    fireEvent.change(box, { target: { value: "row 2999" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Found in row 3,000");
    expect(screen.getByTestId("grid-scroll").scrollTop).toBeGreaterThan(28 * 2900);
    // after the last match it wraps to the first
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Found in row 3,000");
    fireEvent.change(box, { target: { value: "zzz" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Not found");
    expect(document.querySelector("[data-match=true]")).toBeNull();
    // #n goes to a row by number
    fireEvent.change(box, { target: { value: "#1200" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Went to row 1,200");
    expect(screen.getByTestId("grid-scroll").scrollTop).toBe(28 * 1199 - 56);
    fireEvent.change(box, { target: { value: "#9999" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText(/There is no row 9999/);
  });

  it("hidden columns are drawn faded and marked; Show hidden columns leaves them out and brings them back, cells staying with their columns", async () => {
    const e = new FakeEngine();
    e.tables.set("T", { columns: [col("a"), col("secret"), col("c")], rows: [["1", "s1", "3"]] });
    render(<DataView engine={e} table="T" reloadKey={0} hiddenColumns={new Set(["secret"])} />);
    await screen.findByText("s1");
    const header = (name: string) => screen.getAllByRole("columnheader").find((h) => h.textContent!.startsWith(name))!;
    expect(header("secret").getAttribute("data-hidden")).toBe("true");
    expect(header("secret").style.opacity).toBe("0.5");
    expect(header("a").getAttribute("data-hidden")).toBe("false");
    fireEvent.click(screen.getByLabelText("Show hidden columns"));
    expect(screen.queryByText("s1")).toBeNull();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent!.replace(/Text$/, ""))).toEqual(["a", "c"]);
    // the values under "c" are still c's, not the hidden column's
    expect(screen.getByText("3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show hidden columns"));
    expect(screen.getByText("s1")).toBeTruthy();
  });

  it("shows dates the way the model language writes them", async () => {
    const e = new FakeEngine();
    e.tables.set("T", { columns: [col("when", "dateTime")], rows: [["2024-05-06"], ["2024-12-31 23:59:59"]] });
    render(<DataView engine={e} table="T" reloadKey={0} culture="de-DE" />);
    await screen.findByText("6.5.2024");
    expect(screen.getByText(/31\.12\.2024/)).toBeTruthy();
  });

  it("scrolling loads and shows later rows", async () => {
    const e = bigEngine(100_000);
    render(<DataView engine={e} table="Big" reloadKey={0} />);
    await screen.findByText(/100,000 rows/);
    const scroller = screen.getByTestId("grid-scroll");
    scroller.scrollTop = 28 * 50_000;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByText("row 50000")).toBeTruthy());
    expect(e.calls.some((c) => c.startsWith("page:Big:50000"))).toBe(true);
    expect(screen.queryByText("row 0")).toBeNull();
  });

  it("clicking a header sorts ascending, then descending, then clears", async () => {
    const e = new FakeEngine();
    e.tables.set("T", { columns: [col("n", "int64")], rows: [["2"], ["10"], ["1"]] });
    render(<DataView engine={e} table="T" reloadKey={0} />);
    const header = await screen.findByRole("columnheader", { name: /^n/ });
    const firstCell = () => document.querySelector('[data-row="0"] [role="gridcell"]')?.textContent;
    await waitFor(() => expect(firstCell()).toBe("2"));
    fireEvent.click(header);
    await waitFor(() => expect(firstCell()).toBe("1"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(header);
    await waitFor(() => expect(firstCell()).toBe("10"));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(header);
    await waitFor(() => expect(firstCell()).toBe("2"));
    expect(header.getAttribute("aria-sort")).toBe("none");
  });

  it("shows decimal numbers in Power BI's default format (no trailing .0)", async () => {
    const e = new FakeEngine();
    e.tables.set("D", { columns: [col("amount", "double")], rows: [["1504210000000.0"], ["2.50"], [null]] });
    render(<DataView engine={e} table="D" reloadKey={0} />);
    const cell = (r: number) => document.querySelector(`[data-row="${r}"] [role="gridcell"]`)?.textContent;
    await waitFor(() => expect(cell(0)).toBe("1504210000000"));
    expect(cell(1)).toBe("2.5");
    expect(cell(2)).toBe("");
  });

  it("explains when no table is selected or no data is loaded", async () => {
    const e = new FakeEngine();
    const { rerender } = render(<DataView engine={e} table={null} reloadKey={0} />);
    expect(screen.getByText(/Select a table/)).toBeTruthy();
    rerender(<DataView engine={e} table="Gone" reloadKey={0} />);
    await screen.findByText(/No data is loaded/);
  });
});

async function modelSetup(_withData: boolean) {
  const engine = new FakeEngine();
  engine.sources.set("f", {
    columns: [col("cust", "int64"), col("amt", "double")],
    rows: [
      ["1", "5"],
      ["1", "6"],
      ["2", "7"],
    ],
  });
  engine.sources.set("d", {
    columns: [col("id", "int64"), col("name")],
    rows: [
      ["1", "a"],
      ["2", "b"],
    ],
  });
  const session = new Session(new FakeIO(), new FakeDialogs(), engine);
  const registry = createRegistry(session);
  await session.newProject("C:/p", "Demo");
  session.store.transact("clear", (p) => {
    p.model.tmdl["relationships.tmdl"].nodes = [];
  });
  await session.importTable("Fact", { kind: "csv", path: "f" });
  await session.importTable("Dim", { kind: "csv", path: "d" });
  return { engine, session, registry };
}

function renderModel(s: Awaited<ReturnType<typeof modelSetup>>, withData: boolean) {
  const errors: (string | null)[] = [];
  const view = render(
    <ModelView
      project={s.session.store.project!}
      session={s.session}
      registry={s.registry}
      engine={withData ? s.engine : null}
      onError={(m) => errors.push(m)}
    />,
  );
  return { view, errors };
}

const drag = (from: string, to: string) => {
  const src = screen.getByTestId(`col-${from}`);
  const dst = screen.getByTestId(`col-${to}`);
  fireEvent.dragStart(src);
  fireEvent.dragOver(dst);
  fireEvent.drop(dst);
  fireEvent.dragEnd(src);
};

describe("DataView: column width and Copy table", () => {
  it("dragging the right edge of a header resizes that column in the header and every row, and no less than a minimum", async () => {
    const e = bigEngine(30);
    render(<DataView engine={e} table="Big" reloadKey={0} />);
    await screen.findByText(/30 rows/);
    await waitFor(() => expect(screen.getByText("row 0")).toBeTruthy());
    const width = (el: HTMLElement) => el.style.width;
    const header = () => screen.getAllByRole("columnheader")[1];
    const cell = () => document.querySelector("[data-row='0']")!.querySelectorAll<HTMLElement>("[role=gridcell]")[1];
    expect(width(header())).toBe("170px");
    const handle = screen.getByLabelText("Resize name");
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 160 });
    fireEvent.pointerUp(window);
    expect(width(header())).toBe("230px");
    expect(width(cell())).toBe("230px");
    expect(width(screen.getAllByRole("columnheader")[0])).toBe("170px");
    fireEvent.pointerDown(handle, { clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window);
    expect(width(header())).toBe("50px");
  });

  it("Copy table puts the header and all rows on the clipboard as tab-separated text, in the current sort order", async () => {
    const e = new FakeEngine();
    e.tables.set("T", { columns: [col("id", "int64"), col("note")], rows: [["1", "a\tb"], ["2", null], ["3", 'say "hi"']] });
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void (copied = t) } });
    render(<DataView engine={e} table="T" reloadKey={0} />);
    await screen.findByText(/3 rows/);
    fireEvent.click(screen.getByRole("button", { name: "Copy table" }));
    await screen.findByText("Copied 3 rows");
    expect(copied).toBe('id\tnote\r\n1\t"a\tb"\r\n2\t\r\n3\t"say ""hi"""');
    fireEvent.click(screen.getAllByRole("columnheader")[0]);
    fireEvent.click(screen.getAllByRole("columnheader")[0]);
    await waitFor(() => expect(screen.getByTestId("data-status").textContent).toMatch(/descending/));
    fireEvent.click(screen.getByRole("button", { name: "Copy table" }));
    await waitFor(() => expect(copied.split("\r\n")[1]).toMatch(/^3\t/));
  });

  it("Shift+click on a header adds a further sort key (its direction turns, then it drops out); a plain click starts over", async () => {
    const e = new FakeEngine();
    e.tables.set("S", { columns: [col("g"), col("n", "int64")], rows: [["b", "1"], ["a", "2"], ["b", "3"], ["a", "1"], ["b", "2"]] });
    render(<DataView engine={e} table="S" reloadKey={0} />);
    await screen.findByText(/5 rows/);
    const header = (name: string) => screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith(name))!;
    const order = () => [...document.querySelectorAll("[data-row]")].map((r) => [...r.querySelectorAll("[role=gridcell]")].map((c) => c.textContent).join(""));
    const status = () => screen.getByTestId("data-status").textContent ?? "";
    fireEvent.click(header("g"));
    fireEvent.click(header("n"), { shiftKey: true });
    await waitFor(() => expect(status()).toMatch(/sorted by g ascending, then n ascending/));
    await waitFor(() => expect(order()).toEqual(["a1", "a2", "b1", "b2", "b3"]));
    expect(header("g").textContent).toContain("▲1");
    expect(header("n").textContent).toContain("▲2");
    fireEvent.click(header("n"), { shiftKey: true });
    await waitFor(() => expect(order()).toEqual(["a2", "a1", "b3", "b2", "b1"]));
    expect(status()).toMatch(/then n descending/);
    expect(e.calls.at(-1)).toMatch(/:g\+,n-$/);
    fireEvent.click(header("n"), { shiftKey: true });
    await waitFor(() => expect(status()).toMatch(/sorted by g ascending(?!, then)/));
    fireEvent.click(header("n"));
    await waitFor(() => expect(status()).toMatch(/sorted by n ascending(?!, then)/));
    await waitFor(() => expect(order()).toEqual(["b1", "a1", "a2", "b2", "b3"]));
  });

  it("selecting cells (click, Shift+click, drag) and Copy values (Ctrl+C or right-click) put the shown values on the clipboard, in the sort order", async () => {
    const e = new FakeEngine();
    e.tables.set("C", { columns: [col("id", "int64"), col("note"), col("when", "dateTime")], rows: [["1", "a\tb", "2024-03-05"], ["2", null, "2024-03-06"], ["3", 'say "hi"', null]] });
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void (copied = t) } });
    render(<DataView engine={e} table="C" reloadKey={0} culture="en-US" />);
    await screen.findByText(/3 rows/);
    const cell = (row: number, c: number) => document.querySelector(`[data-row="${row}"]`)!.querySelectorAll("[role=gridcell]")[c] as HTMLElement;
    await waitFor(() => expect(cell(2, 0).textContent).toBe("3"));
    const grid = screen.getByRole("grid");
    // a rectangle from a click to a Shift+click
    fireEvent.mouseDown(cell(0, 1));
    fireEvent.mouseDown(cell(1, 2), { shiftKey: true });
    fireEvent.mouseUp(grid);
    expect(document.querySelectorAll("[aria-selected=true]")).toHaveLength(4);
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    await screen.findByText("Copied 4 values");
    expect(copied).toBe('"a\tb"\t3/5/2024\r\n\t3/6/2024');
    // a drag selects too
    fireEvent.mouseDown(cell(0, 0));
    fireEvent.mouseEnter(cell(2, 0));
    fireEvent.mouseUp(grid);
    fireEvent.contextMenu(cell(2, 0));
    expect(screen.getByRole("menuitem").textContent).toBe("Copy values");
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy values" }));
    await waitFor(() => expect(copied).toBe("1\r\n2\r\n3"));
    // a right-click on a cell outside the selection selects that one cell first
    fireEvent.contextMenu(cell(1, 1));
    expect(screen.getByRole("menuitem").textContent).toBe("Copy value");
    fireEvent.click(screen.getByRole("menuitem"));
    await waitFor(() => expect(copied).toBe(""));
    // select all, in the sorted order
    fireEvent.click(screen.getAllByRole("columnheader")[0]);
    fireEvent.click(screen.getAllByRole("columnheader")[0]);
    await waitFor(() => expect(screen.getByTestId("data-status").textContent).toMatch(/descending/));
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "c", ctrlKey: true });
    await screen.findByText("Copied 9 values");
    expect(copied.split("\r\n")[0]).toMatch(/^3\t/);
  });
});

describe("ModelView", () => {
  it("shows a card per table with its columns", async () => {
    const s = await modelSetup(false);
    renderModel(s, false);
    const card = screen.getByTestId("card-Fact");
    expect(within(card).getByText("cust")).toBeTruthy();
    expect(screen.getByTestId("card-Dim")).toBeTruthy();
  });

  it("a card folds to its header and unfolds; Alt+Shift+1 folds every card, Alt+Shift+9 unfolds every card", async () => {
    const s = await modelSetup(false);
    renderModel(s, false);
    const card = (n: string) => screen.getByTestId(`card-${n}`);
    expect(card("Fact").getAttribute("data-collapsed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Collapse Fact" }));
    expect(card("Fact").getAttribute("data-collapsed")).toBe("true");
    expect(within(card("Fact")).queryByText("cust")).toBeNull();
    expect(card("Dim").getAttribute("data-collapsed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Expand Fact" }));
    expect(within(card("Fact")).getByText("cust")).toBeTruthy();
    const canvas = screen.getByTestId("model-canvas");
    fireEvent.keyDown(canvas, { key: "!", code: "Digit1", altKey: true, shiftKey: true });
    expect(card("Fact").getAttribute("data-collapsed")).toBe("true");
    expect(card("Dim").getAttribute("data-collapsed")).toBe("true");
    fireEvent.keyDown(canvas, { key: "(", code: "Digit9", altKey: true, shiftKey: true });
    expect(card("Fact").getAttribute("data-collapsed")).toBe("false");
    expect(card("Dim").getAttribute("data-collapsed")).toBe("false");
  });

  it("a hierarchy appears in its table's card, and the card is tall enough for it", async () => {
    const s = await modelSetup(false);
    const before = layoutCards(listTables(s.session.store.project!).map((t) => ({ ...t, hierarchies: [] }))).get("Dim")!.h;
    await s.registry.execute("model.addHierarchy", { table: "Dim", name: "Naming", columns: ["id", "name"] });
    renderModel(s, false);
    const row = screen.getByTestId("hierarchy-Dim.Naming");
    expect(within(screen.getByTestId("card-Dim")).getByText("Naming")).toBeTruthy();
    expect(row.getAttribute("title")).toBe("Hierarchy: id > name");
    const after = parseFloat((screen.getByTestId("card-Dim") as HTMLElement).style.height);
    expect(after).toBe(before + 22);
  });

  it("hidden columns and measures stay in the card, drawn faded and marked hidden; unhiding restores them", async () => {
    const s = await modelSetup(false);
    const { view } = renderModel(s, false);
    const col = () => screen.getByTestId("col-Dim.name");
    expect(col().getAttribute("data-hidden")).toBe("false");
    const rerender = () => view.rerender(<ModelView project={s.session.store.project!} session={s.session} registry={s.registry} engine={null} onError={() => undefined} />);
    await s.registry.execute("model.setProperty", { target: { kind: "column", table: "Dim", column: "name" }, key: "isHidden", value: true });
    rerender();
    expect(col().getAttribute("data-hidden")).toBe("true");
    expect(col().style.opacity).toBe("0.5");
    expect(screen.getByTestId("col-Dim.id").getAttribute("data-hidden")).toBe("false");
    await s.registry.execute("model.setProperty", { target: { kind: "column", table: "Dim", column: "name" }, key: "isHidden", value: false });
    rerender();
    expect(col().getAttribute("data-hidden")).toBe("false");
    expect(col().style.opacity).toBe("");
  });

  it("fields with a display folder are listed under a heading for the folder, once, and the card grows for it", async () => {
    const s = await modelSetup(false);
    const heightBefore = parseFloat(renderModel(s, false).view.container.querySelector<HTMLElement>("[data-testid=card-Dim]")!.style.height);
    cleanup();
    for (const column of ["id", "name"]) await s.registry.execute("model.setProperty", { target: { kind: "column", table: "Dim", column }, key: "displayFolder", value: "Keys" });
    renderModel(s, false);
    const card = screen.getByTestId("card-Dim");
    expect(within(card).getAllByText("Keys")).toHaveLength(1);
    expect(screen.getByTestId("folder-Dim.Keys")).toBeTruthy();
    // the heading comes right before the fields of the folder
    const order = [...card.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")).filter((x) => /^(folder|col)-/.test(x!));
    expect(order).toEqual(["folder-Dim.Keys", "col-Dim.id", "col-Dim.name"]);
    expect(parseFloat(card.style.height)).toBe(heightBefore + 22);
  });

  it("a relationship line shows the cardinality at both ends and the filter direction, and changes when the direction changes", async () => {
    const s = await modelSetup(false);
    const { view } = renderModel(s, false);
    drag("Fact.cust", "Dim.id");
    await waitFor(() => expect(listRelationships(s.session.store.project!)).toHaveLength(1));
    const rel = listRelationships(s.session.store.project!)[0];
    const rerender = () => view.rerender(<ModelView project={s.session.store.project!} session={s.session} registry={s.registry} engine={null} onError={() => undefined} />);
    rerender();
    const texts = () => [...screen.getByTestId(`rel-${rel.id}`).querySelectorAll("text")].map((t) => t.textContent);
    // many on the dragged (Fact) side, one on Dim; the filter runs one way
    expect(texts().filter((t) => t === "*")).toHaveLength(1);
    expect(texts().filter((t) => t === "1")).toHaveLength(1);
    expect(texts().some((t) => t === "◄" || t === "►")).toBe(true);
    await s.registry.execute("model.updateRelationship", { id: rel.id, patch: { crossFilter: "both" } });
    rerender();
    expect(texts()).toContain("◄►");
  });

  it("selecting a table highlights the tables it is related to", async () => {
    const s = await modelSetup(false);
    const { view } = renderModel(s, false);
    drag("Fact.cust", "Dim.id");
    await waitFor(() => expect(listRelationships(s.session.store.project!)).toHaveLength(1));
    view.rerender(<ModelView project={s.session.store.project!} session={s.session} registry={s.registry} engine={null} onError={() => undefined} />);
    expect(screen.getByTestId("card-Dim").getAttribute("data-related")).toBe("false");
    fireEvent.click(screen.getByTestId("card-head-Fact"));
    expect(screen.getByTestId("card-Dim").getAttribute("data-related")).toBe("true");
    expect(screen.getByTestId("card-Fact").getAttribute("data-related")).toBe("false");
  });

  it("dragging a column onto another table's column creates a many-to-one relationship (no data: defaults)", async () => {
    const s = await modelSetup(false);
    const { view } = renderModel(s, false);
    drag("Fact.cust", "Dim.id");
    await waitFor(() => expect(listRelationships(s.session.store.project!).some((r) => r.fromTable === "Fact" && r.toTable === "Dim")).toBe(true));
    const r = listRelationships(s.session.store.project!).find((x) => x.fromTable === "Fact")!;
    expect(r).toMatchObject({ fromCardinality: "many", toCardinality: "one", crossFilter: "single", isActive: true });
    view.rerender(<ModelView project={s.session.store.project!} session={s.session} registry={s.registry} engine={null} onError={() => undefined} />);
    await screen.findByTestId(`rel-${r.id}`);
  });

  it("detects cardinality from the data and keeps the many side as 'from'", async () => {
    const s = await modelSetup(true);
    renderModel(s, true);
    drag("Dim.id", "Fact.cust"); // dragged from the unique side
    await waitFor(() => expect(listRelationships(s.session.store.project!).length).toBe(1));
    expect(listRelationships(s.session.store.project!)[0]).toMatchObject({
      fromTable: "Fact",
      fromColumn: "cust",
      toTable: "Dim",
      toColumn: "id",
      fromCardinality: "many",
      toCardinality: "one",
    });
  });

  it("dropping on the same table does nothing; duplicates are reported", async () => {
    const s = await modelSetup(false);
    const { errors } = renderModel(s, false);
    drag("Fact.cust", "Fact.amt");
    expect(listRelationships(s.session.store.project!)).toHaveLength(0);
    drag("Fact.cust", "Dim.id");
    await waitFor(() => expect(listRelationships(s.session.store.project!)).toHaveLength(1));
    drag("Fact.cust", "Dim.id");
    await waitFor(() => expect(errors.some((m) => m?.includes("already exists"))).toBe(true));
  });

  it("selecting a relationship lets you change cardinality, direction and active state, and delete it", async () => {
    const s = await modelSetup(false);
    const { view } = renderModel(s, false);
    drag("Fact.cust", "Dim.id");
    await waitFor(() => expect(listRelationships(s.session.store.project!)).toHaveLength(1));
    const id = listRelationships(s.session.store.project!)[0].id;
    const rerender = () =>
      view.rerender(
        <ModelView project={s.session.store.project!} session={s.session} registry={s.registry} engine={null} onError={() => undefined} />,
      );
    rerender();
    fireEvent.click(screen.getByTestId(`rel-item-${id}`));
    const editor = screen.getByTestId("rel-editor");
    fireEvent.change(within(editor).getByLabelText("Cross-filter direction"), { target: { value: "both" } });
    await waitFor(() => expect(listRelationships(s.session.store.project!)[0].crossFilter).toBe("both"));
    rerender();
    fireEvent.click(within(screen.getByTestId("rel-editor")).getByLabelText(/Make this relationship active/));
    await waitFor(() => expect(listRelationships(s.session.store.project!)[0].isActive).toBe(false));
    rerender();
    expect(screen.getByTestId(`rel-${id}`).getAttribute("data-active")).toBe("false");
    fireEvent.change(within(screen.getByTestId("rel-editor")).getByLabelText("To cardinality"), { target: { value: "many" } });
    await waitFor(() => expect(listRelationships(s.session.store.project!)[0].toCardinality).toBe("many"));
    rerender();
    fireEvent.click(within(screen.getByTestId("rel-editor")).getByText("Delete"));
    await waitFor(() => expect(listRelationships(s.session.store.project!)).toHaveLength(0));
  });
});

describe("DataPane", () => {
  it("lists tables, columns and measures, filters by search, and flags tables with no data", async () => {
    const s = await modelSetup(false);
    const calls: string[] = [];
    render(
      <DataPane
        project={s.session.store.project!}
        dataTables={["Fact"]}
        selected="Fact"
        canImport
        onSelect={(t) => calls.push(`select:${t}`)}
        onRefresh={(t) => calls.push(`refresh:${t}`)}
        onRefreshAll={() => calls.push("all")}
        onImport={() => calls.push("import")}
      />,
    );
    expect(screen.getByText("Fact")).toBeTruthy();
    expect(screen.getByText(/Dim \(no data loaded\)/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Refresh Dim"));
    fireEvent.click(screen.getByText("Import data"));
    fireEvent.click(screen.getByText("Refresh all"));
    expect(calls).toEqual(["refresh:Dim", "import", "all"]);
    fireEvent.change(screen.getByLabelText("Search fields"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching fields.")).toBeTruthy();
  });
});

describe("import form", () => {
  it("builds sources and validates required fields", () => {
    expect(buildSpec(emptyForm("csv"))).toEqual({ error: "Choose a file." });
    expect(buildSpec({ ...emptyForm("csv"), path: " C:\\a.csv ", delimiter: ";" })).toEqual({
      spec: { kind: "csv", path: "C:\\a.csv", delimiter: ";", header: true },
    });
    expect(buildSpec({ ...emptyForm("sqlite"), path: "x.db" })).toEqual({ error: "Choose a table." });
    expect(buildSpec({ ...emptyForm("postgres"), database: "d", user: "u", pgTable: "t", port: "abc" })).toEqual({
      error: "Port must be a number between 1 and 65535.",
    });
    const pg = buildSpec({ ...emptyForm("postgres"), database: "d", user: "u", pgTable: "t" });
    expect(pg).toEqual({ spec: { kind: "postgres", host: "localhost", port: 5432, database: "d", user: "u", schema: "public", table: "t" } });
    expect(JSON.stringify(pg)).not.toMatch(/password/i);
  });
  it("derives default table names", () => {
    expect(defaultTableName({ kind: "csv", path: "C:\\data\\Sales 2024.csv" })).toBe("Sales 2024");
    expect(defaultTableName({ kind: "excel", path: "b.xlsx", sheet: "Orders" })).toBe("Orders");
    expect(defaultTableName({ kind: "sqlite", path: "x.db", table: "cust" })).toBe("cust");
  });
});
