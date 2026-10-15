// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DataView } from "./DataView";
import { ModelView } from "./ModelView";
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

describe("ModelView", () => {
  it("shows a card per table with its columns", async () => {
    const s = await modelSetup(false);
    renderModel(s, false);
    const card = screen.getByTestId("card-Fact");
    expect(within(card).getByText("cust")).toBeTruthy();
    expect(screen.getByTestId("card-Dim")).toBeTruthy();
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
