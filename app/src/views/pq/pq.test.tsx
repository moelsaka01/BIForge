// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PowerQueryEditor } from "./PowerQueryEditor";
import { layoutDependencies } from "./DependenciesView";
import { Session } from "../../core/session/session";
import { createRegistry } from "../../core/commands/builtin";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { FakeEngine, col } from "../../core/testing/fakeEngine";
import { FakeM } from "../../core/testing/fakeM";
import type { EditorFactory } from "../../core/dax/editorTypes";

afterEach(cleanup);

// Fluent UI observes sizes; jsdom has no ResizeObserver
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const failingFactory: EditorFactory = () => Promise.reject(new Error("no editor in tests"));

async function setup(extra: (m: FakeM, engine: FakeEngine) => void = () => undefined) {
  const engine = new FakeEngine();
  const m = new FakeM();
  const dialogs = new FakeDialogs();
  const session = new Session(new FakeIO(), dialogs, engine, m);
  const registry = createRegistry(session);
  await session.newProject("C:/p", "Demo");
  engine.sources.set("C:/o.csv", { columns: [col("Id", "int64"), col("Name")], rows: [["1", "a"], ["2", "b"]] });
  await registry.execute("data.import", { name: "Orders", spec: { kind: "csv", path: "C:/o.csv" } });
  m.tables.set("Orders", {
    columns: [col("Id", "int64"), col("Name"), col("Score", "double")],
    rows: [["1", "Ann", "2.50"], ["2", "Bob", null], ["3", "Cy", "7"]],
  });
  extra(m, engine);
  session.openQueryEditor("Orders");
  const view = render(<PowerQueryEditor session={session} registry={registry} factory={failingFactory} />);
  await screen.findByText("Ann");
  return { engine, m, session, registry, dialogs, view };
}

const headerOf = (name: string) => screen.getByRole("columnheader", { name: new RegExp(`^.*${name}`) });
const settings = () => within(screen.getByLabelText("Query settings"));
const stepNames = () => settings().getAllByRole("option").map((x) => x.textContent);

describe("Power Query editor", () => {
  it("shows the queries, the applied steps of the selected query and a preview of its rows", async () => {
    const { m } = await setup();
    const list = screen.getByRole("listbox", { name: "Query list" });
    expect(within(list).getByText("Orders")).toBeTruthy();
    expect(stepNames()).toEqual(["Source", "Promoted Headers", "Changed Type"]);
    // the last step is selected and the grid shows its rows, nulls and numbers formatted
    expect(settings().getByRole("option", { name: /Changed Type/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText("2.5")).toBeTruthy();
    expect(screen.getByText("null")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("3 columns, 3 rows");
    await waitFor(() => expect((screen.getByLabelText("Formula bar") as HTMLInputElement).value).toContain("Table.TransformColumnTypes"));
    // choosing another step asks for that step's preview
    fireEvent.click(settings().getByText("Promoted Headers"));
    await waitFor(() => expect(m.calls).toContain("preview:Orders:Promoted Headers:1000"));
    await waitFor(() => expect((screen.getByLabelText("Formula bar") as HTMLInputElement).value).toContain("Table.PromoteHeaders"));
  });

  it("selecting a column and using the ribbon adds a step", async () => {
    const { m, session } = await setup();
    fireEvent.click(headerOf("Name"));
    expect(headerOf("Name").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Remove Columns/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove Columns" }));
    await waitFor(() => expect(m.calls).toContain("transform:removeColumns:end"));
    await waitFor(() => expect(stepNames()).toContain("RemoveColumns"));
    expect(session.queries.dirty).toBe(true);
    expect(screen.getByText(/1 change not applied/)).toBeTruthy();
  });

  it("ribbon buttons say why they are disabled and mark features that are not implemented", async () => {
    await setup();
    const remove = screen.getByRole("button", { name: /Remove Columns/ });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect(remove.getAttribute("title")).toContain("Select a column first.");
    fireEvent.click(screen.getByRole("tab", { name: "Transform" }));
    const dur = screen.getByRole("button", { name: /Duration/ });
    expect((dur as HTMLButtonElement).disabled).toBe(true);
    expect(dur.getAttribute("title")).toContain("Not implemented");
    fireEvent.click(screen.getByRole("tab", { name: "Add Column" }));
    expect((screen.getByRole("button", { name: /Column From Examples/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the filter dialog validates input and sends the transform", async () => {
    const { m } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Filter Rows" }));
    const dlg = await screen.findByRole("dialog", { name: "Filter Rows", hidden: true });
    fireEvent.change(within(dlg).getByLabelText("Column"), { target: { value: "Id" } });
    fireEvent.change(within(dlg).getByLabelText("Operator"), { target: { value: "gt" } });
    fireEvent.change(within(dlg).getByLabelText("Value"), { target: { value: "abc" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "OK", hidden: true }));
    // "Id" is a whole-number column, so text is refused before anything is sent
    await within(dlg).findByText(/"abc" is not a number/);
    expect(m.calls.filter((c) => c.startsWith("transform"))).toEqual([]);
    fireEvent.change(within(dlg).getByLabelText("Value"), { target: { value: "1" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "OK", hidden: true }));
    await waitFor(() => expect(m.calls).toContain("transform:filterRows:end"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter Rows" })).toBeNull());
  });

  it("step buttons delete, rename and move steps, and a typed formula replaces a step", async () => {
    const { m, session } = await setup();
    fireEvent.click(settings().getByText("Promoted Headers"));
    fireEvent.click(settings().getByRole("button", { name: "Rename" }));
    const input = settings().getByLabelText("New step name");
    fireEvent.change(input, { target: { value: "Headers" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(stepNames()).toEqual(["Source", "Headers", "Changed Type"]));
    expect(session.queries.getSnapshot().step).toBe("Headers");

    // formula bar: Enter stores the typed expression for the selected step
    const bar = screen.getByLabelText("Formula bar") as HTMLInputElement;
    await waitFor(() => expect(bar.value).toContain("Table.PromoteHeaders"));
    fireEvent.change(bar, { target: { value: "Table.PromoteHeaders(Source)" } });
    fireEvent.keyDown(bar, { key: "Enter" });
    await waitFor(() => expect(session.queries.get("Orders")!.text).toContain("Headers = Table.PromoteHeaders(Source),"));

    fireEvent.click(settings().getByRole("button", { name: "Move down" }));
    await waitFor(() => expect(stepNames()).toEqual(["Source", "Changed Type", "Headers"]));
    fireEvent.click(settings().getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(stepNames()).toEqual(["Source", "Changed Type"]));
    expect(m.calls.filter((c) => c.startsWith("edit:"))).toEqual(["edit:rename", "edit:setExpr", "edit:move", "edit:delete"]);
    // the first step cannot be moved up or removed together with what follows
    fireEvent.click(settings().getByText("Source"));
    expect((settings().getByRole("button", { name: "Move up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((settings().getByRole("button", { name: "Delete until end" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a step with an error shows it in the step list and instead of the preview", async () => {
    cleanup();
    const engine = new FakeEngine();
    const m = new FakeM();
    const session = new Session(new FakeIO(), new FakeDialogs(), engine, m);
    const registry = createRegistry(session);
    await session.newProject("C:/p", "Demo");
    engine.sources.set("C:/o.csv", { columns: [col("Id", "int64")], rows: [["1"]] });
    await registry.execute("data.import", { name: "Orders", spec: { kind: "csv", path: "C:/o.csv" } });
    m.tables.set("Orders", { columns: [col("Id", "int64"), col("Name")], rows: [["1", "Ann"]] });
    m.stepErrors.set("Orders/Changed Type", "The column 'Nope' of the table wasn't found.");
    session.openQueryEditor("Orders");
    render(<PowerQueryEditor session={session} registry={registry} factory={failingFactory} />);
    const err = await screen.findByTestId("preview-error");
    expect(err.textContent).toContain("'Nope'");
    expect(settings().getByRole("img", { name: "Step has an error" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Data preview" })).toBeNull();
    // an earlier step still shows data
    fireEvent.click(settings().getByText("Promoted Headers"));
    await screen.findByText("Ann");
  });

  it("the column header menu runs the same actions as the ribbon", async () => {
    const { m } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Menu for Score" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await waitFor(() => expect(m.calls).toContain("transform:removeColumns:end"));
  });

  it("Close & Apply runs the changed query and closes; closing with unapplied changes asks first", async () => {
    const { m, session } = await setup();
    fireEvent.click(headerOf("Name"));
    fireEvent.click(screen.getByRole("button", { name: /Remove Columns/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove Columns" }));
    await waitFor(() => expect(session.queries.dirty).toBe(true));
    // Close asks for confirmation; keeping the editor open leaves everything as it was
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const ask = await screen.findByRole("dialog", { name: "Discard changes?", hidden: true });
    fireEvent.click(within(ask).getByRole("button", { name: "Keep editing", hidden: true }));
    expect(session.queries.getSnapshot().open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close & Apply" }));
    await waitFor(() => expect(session.queries.getSnapshot().open).toBe(false));
    expect(m.calls).toContain("load:Orders->Orders");
    expect(screen.queryByRole("dialog", { name: "Power Query Editor" })).toBeNull();
    expect(session.getSnapshot().lastMessage).toContain("Applied query changes");
  });

  it("discarding closes without touching the document", async () => {
    const { m, session } = await setup();
    fireEvent.click(screen.getByRole("tab", { name: "Add Column" }));
    fireEvent.click(screen.getByRole("button", { name: /Index Column/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "From 1" }));
    await waitFor(() => expect(session.queries.dirty).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard changes?", hidden: true })).getByRole("button", { name: "Discard", hidden: true }));
    await waitFor(() => expect(session.queries.getSnapshot().open).toBe(false));
    expect(m.calls.some((c) => c.startsWith("load:"))).toBe(false);
  });

  it("the Advanced Editor edits the whole query and refuses text with syntax errors", async () => {
    const { session } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Advanced Editor" }));
    const dlg = await screen.findByRole("dialog", { name: /Advanced Editor/, hidden: true });
    const box = (await within(dlg).findByLabelText("Query text")) as HTMLTextAreaElement;
    expect(box.value).toContain("Csv.Document");
    fireEvent.change(box, { target: { value: "let\n    Source = (((\nin\n    Source" } });
    await within(dlg).findByText(/1 syntax error/, {}, { timeout: 2000 });
    expect((within(dlg).getByRole("button", { name: "Done", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "let\n    Source = 1\nin\n    Source" } });
    await waitFor(() => expect((within(dlg).getByRole("button", { name: "Done", hidden: true }) as HTMLButtonElement).disabled).toBe(false), { timeout: 2000 });
    fireEvent.click(within(dlg).getByRole("button", { name: "Done", hidden: true }));
    await waitFor(() => expect(session.queries.get("Orders")!.text).toBe("let\n    Source = 1\nin\n    Source"));
    expect(screen.queryByRole("dialog", { name: /Advanced Editor/ })).toBeNull();
  });

  it("new queries: enter data, and merge needs the other query's columns", async () => {
    const { session, m } = await setup((fm) => fm.tables.set("Cust", { columns: [col("Id", "int64"), col("City")], rows: [["1", "Rome"]] }));
    fireEvent.click(screen.getByRole("button", { name: "Enter Data" }));
    const dlg = await screen.findByRole("dialog", { name: "Create Table", hidden: true });
    fireEvent.change(within(dlg).getByLabelText("Query name"), { target: { value: "Cust" } });
    fireEvent.change(within(dlg).getByLabelText(/Column names in the first line/), { target: { value: "Id,City\n1,Rome" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "OK", hidden: true }));
    await waitFor(() => expect(session.queries.get("Cust")).toBeTruthy());
    expect(session.queries.get("Cust")!.text).toContain('#table({"Id", "City"}, {{"1", "Rome"}})');
    // select Orders again and merge with Cust
    fireEvent.click(within(screen.getByRole("listbox", { name: "Query list" })).getByText("Orders"));
    await screen.findByText("Ann");
    fireEvent.click(screen.getByRole("button", { name: "Merge Queries" }));
    const merge = await screen.findByRole("dialog", { name: "Merge Queries", hidden: true });
    const right = within(merge).getByLabelText("Matching column in the second query") as HTMLSelectElement;
    expect([...right.options].map((o) => o.value)).toEqual(["Id", "City"]);
    fireEvent.change(within(merge).getByLabelText("Matching column in Orders"), { target: { value: "Id" } });
    fireEvent.click(within(merge).getByRole("button", { name: "OK", hidden: true }));
    await waitFor(() => expect(m.calls).toContain("transform:merge:end"));
  });

  it("View > Column quality, distribution and profile show statistics of the selected step", async () => {
    const { m } = await setup();
    fireEvent.click(screen.getByRole("tab", { name: "View" }));
    // nothing is calculated until one of the three views is switched on
    expect(m.calls.some((c) => c.startsWith("profile:"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Column quality" }));
    await waitFor(() => expect(m.calls).toContain("profile:Orders:end:1000"));
    // Score has one null of three rows
    expect((await screen.findByLabelText(/^Quality of Score/)).getAttribute("aria-label")).toBe("Quality of Score: Valid 67%, Error 0%, Empty 33%");
    expect(screen.getByLabelText(/^Quality of Id/).getAttribute("aria-label")).toBe("Quality of Id: Valid 100%, Error 0%, Empty 0%");
    expect(screen.queryByLabelText(/^Distribution of/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Column distribution" }));
    expect((await screen.findByLabelText(/^Distribution of Name/)).getAttribute("aria-label")).toBe("Distribution of Name: 3 distinct, 3 unique");
    // the profile pane waits for a selected column, then lists its statistics and values
    fireEvent.click(screen.getByRole("button", { name: "Column profile" }));
    expect((await screen.findByLabelText("Column profile")).textContent).toContain("Select a column");
    fireEvent.click(headerOf("Score"));
    const stats = within(await screen.findByLabelText("Column statistics"));
    expect(stats.getByText("Empty").nextElementSibling?.textContent).toBe("1");
    expect(stats.getByText("Average").nextElementSibling?.textContent).toBe("4.75");
    expect(screen.getByLabelText("Value distribution").textContent).toContain("null");
    expect(screen.getByLabelText("Column profile").textContent).toContain("based on top 1000 rows");
    // the whole data set on request
    fireEvent.click(screen.getByRole("switch", { name: /entire data set/ }));
    await waitFor(() => expect(m.calls).toContain("profile:Orders:end:all"));
    // switching all three off stops asking
    for (const n of ["Column quality", "Column distribution", "Column profile"]) fireEvent.click(screen.getByRole("button", { name: n }));
    await waitFor(() => expect(screen.queryByLabelText(/^Quality of/)).toBeNull());
  });

  it("the dependency view draws queries and what uses them", async () => {
    const { registry } = await setup();
    await registry.execute("query.add", { name: "Lookup", text: "let\n    Source = 1\nin\n    Source", loaded: false });
    await registry.execute("query.setText", { query: "Orders", text: "let\n    Source = Lookup\nin\n    Source" });
    fireEvent.click(screen.getByRole("tab", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Query Dependencies" }));
    const svg = await screen.findByRole("img", { name: "Query dependencies" });
    await waitFor(() => expect(svg.querySelector('[data-edge="Lookup>Orders"]')).toBeTruthy());
    expect(svg.querySelector('[data-node="Lookup"]')).toBeTruthy();
  });

  it("the query list can duplicate, rename (new or not loaded ones only) and delete queries", async () => {
    const { session } = await setup();
    const pane = () => within(screen.getByLabelText("Queries"));
    fireEvent.click(pane().getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(session.queries.get("Orders (2)")).toBeTruthy());
    // the duplicate is new, so it can be renamed; the loaded original cannot
    expect((pane().getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(pane().getByText("Orders"));
    await waitFor(() => expect((pane().getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(pane().getByText(/Orders \(2\)/));
    fireEvent.click(pane().getByRole("button", { name: "Rename" }));
    const input = pane().getByLabelText("New query name");
    fireEvent.change(input, { target: { value: "Copy" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(session.queries.get("Copy")).toBeTruthy());
    fireEvent.click(pane().getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(session.queries.get("Copy")).toBeUndefined());
  });
});

describe("dependency layout", () => {
  it("places a query one level right of what it uses and survives cycles", () => {
    const l = layoutDependencies({ A: [], B: ["A"], C: ["B", "A"], D: [] });
    const level = (n: string) => l.nodes.find((x) => x.name === n)!.level;
    expect([level("A"), level("B"), level("C"), level("D")]).toEqual([0, 1, 2, 0]);
    expect(l.edges).toContainEqual({ from: "A", to: "C" });
    const cyc = layoutDependencies({ X: ["Y"], Y: ["X"] });
    expect(cyc.nodes).toHaveLength(2);
    expect(layoutDependencies({}).nodes).toEqual([]);
  });
});
