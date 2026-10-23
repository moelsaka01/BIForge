// @vitest-environment jsdom
// Phase 10: calculated columns and tables, hierarchies and editable properties, through the whole app frame over fakes.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDomStubs } from "../core/testing/domStubs";
import { col } from "../core/testing/fakeEngine";
import { calculatedColumns, calculatedTables, getProperty, listHierarchies, listRoles } from "../core/model/modeling";
import { PBIP, makeApp } from "./shell/testApp";

installDomStubs();
afterEach(cleanup);

async function open() {
  const a = makeApp();
  render(a.element);
  await act(async () => void a.registry.execute("file.open", { path: PBIP }));
  return a;
}

const dialog = () => screen.findByRole("dialog", { hidden: true });

describe("calculated columns", () => {
  it("New column asks for a table, a name and a formula, computes it first, and stores it with its type", async () => {
    const a = await open();
    a.engine.tables.set("Sales", { columns: [col("Quantity", "int64"), col("Double", "int64")], rows: [] });
    await act(async () => void a.registry.execute("model.newColumnDialog"));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText("Column name"), { target: { value: "Double" } });
    fireEvent.change(within(dlg).getByLabelText(/DAX formula/), { target: { value: "Double = Sales[Quantity] * 2" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(a.engine.calls).toContain("calcColumns:Sales"));
    await waitFor(() => expect(calculatedColumns(a.session.store.project!, "Sales")).toEqual([{ name: "Double", expression: "Sales[Quantity] * 2" }]));
    // the engine's data type is written to the model
    expect(getProperty(a.session.store.project!, { kind: "column", table: "Sales", column: "Double" }, "summarizeBy")).toBe("sum");
    expect(a.session.store.getSnapshot().isDirty).toBe(true);
    // one undo removes it
    await act(async () => void a.registry.execute("edit.undo"));
    expect(calculatedColumns(a.session.store.project!, "Sales")).toEqual([]);
  });

  it("a formula the engine rejects shows its message and changes nothing", async () => {
    const a = await open();
    a.engine.calcError = "The calculated column Sales[Bad] failed: Column 'Sales[Nope]' not found.";
    await act(async () => void a.registry.execute("model.newColumnDialog"));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText("Column name"), { target: { value: "Bad" } });
    fireEvent.change(within(dlg).getByLabelText(/DAX formula/), { target: { value: "Sales[Nope]" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    expect(await within(dlg).findByText(/not found/)).toBeTruthy();
    expect(calculatedColumns(a.session.store.project!, "Sales")).toEqual([]);
    expect(a.session.store.getSnapshot().isDirty).toBe(false);
  });
});

describe("calculated tables", () => {
  it("New table takes a DAX expression, stores the rows the engine returns and records the expression", async () => {
    const a = await open();
    a.engine.calcTables.set("Regions", { name: "Regions", columns: [col("Region"), col("Total", "int64")], rowCount: 3 });
    await act(async () => void a.registry.execute("model.newCalculatedTableDialog"));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText("Table name"), { target: { value: "Regions" } });
    fireEvent.change(within(dlg).getByLabelText(/DAX table expression/), { target: { value: "Regions = SUMMARIZE(Sales, Sales[Region])" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calculatedTables(a.session.store.project!)).toEqual([{ name: "Regions", expression: "SUMMARIZE(Sales, Sales[Region])" }]));
    expect(a.engine.calls).toContain("calcTable:Regions:SUMMARIZE(Sales, Sales[Region])");
    expect(a.session.getSnapshot().dataTables).toContain("Regions");
    // refresh recalculates it
    a.engine.calls.length = 0;
    await act(async () => void a.registry.execute("model.recalculate"));
    expect(a.engine.calls).toContain("calcTable:Regions:SUMMARIZE(Sales, Sales[Region])");
  });
});

describe("Model view: hierarchies and editable properties", () => {
  it("sets format, summarization, sort by column and hidden from the Properties pane, one undoable change each", async () => {
    const a = await open();
    await act(async () => void a.registry.execute("view.model"));
    const pane = await screen.findByLabelText("Properties");
    fireEvent.click(screen.getByTestId("col-Sales.Quantity"));
    fireEvent.change(within(pane).getByLabelText("Format"), { target: { value: "#,0.00" } });
    await waitFor(() => expect(getProperty(a.session.store.project!, { kind: "column", table: "Sales", column: "Quantity" }, "formatString")).toBe("#,0.00"));
    fireEvent.click(within(pane).getByLabelText("Hidden"));
    await waitFor(() => expect(getProperty(a.session.store.project!, { kind: "column", table: "Sales", column: "Quantity" }, "isHidden")).toBe(true));
    fireEvent.change(within(pane).getByLabelText("Summarize by"), { target: { value: "average" } });
    await waitFor(() => expect(getProperty(a.session.store.project!, { kind: "column", table: "Sales", column: "Quantity" }, "summarizeBy")).toBe("average"));
    fireEvent.change(within(pane).getByLabelText("Sort by column"), { target: { value: "ProductKey" } });
    await waitFor(() => expect(getProperty(a.session.store.project!, { kind: "column", table: "Sales", column: "Quantity" }, "sortByColumn")).toBe("ProductKey"));
    await act(async () => void a.registry.execute("edit.undo"));
    expect(getProperty(a.session.store.project!, { kind: "column", table: "Sales", column: "Quantity" }, "sortByColumn")).toBe("");
  });

  it("New hierarchy lists the levels in the table's properties and deletes again", async () => {
    const a = await open();
    await act(async () => void a.registry.execute("view.model"));
    fireEvent.click(await screen.findByTestId("card-head-Sales"));
    const pane = await screen.findByLabelText("Properties");
    fireEvent.click(within(pane).getByRole("button", { name: "New hierarchy" }));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText(/Levels/), { target: { value: "ProductKey\nQuantity" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(listHierarchies(a.session.store.project!, "Sales").map((h) => h.levels.map((l) => l.column))).toEqual([["ProductKey", "Quantity"]]));
    const list = await within(pane).findByLabelText("Hierarchies");
    expect(list.textContent).toContain("ProductKey > Quantity");
    fireEvent.click(within(list).getByRole("button", { name: /Delete hierarchy/ }));
    await waitFor(() => expect(listHierarchies(a.session.store.project!, "Sales")).toEqual([]));
  });
});

describe("security roles and View as", () => {
  it("Manage roles saves a role; View as makes the report queries carry the roles", async () => {
    const a = await open();
    await act(async () => void a.registry.execute("model.manageRolesDialog"));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText("Role name"), { target: { value: "East" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add table filter" }));
    fireEvent.change(within(dlg).getByLabelText("Filter expression 1"), { target: { value: 'Sales[Quantity] > 0' } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save role" }));
    await waitFor(() => expect(listRoles(a.session.store.project!)).toEqual([{ name: "East", filters: [{ table: "Sales", expression: "Sales[Quantity] > 0" }] }]));
    fireEvent.click(within(dlg).getByRole("button", { name: "Close" }));
    // View as
    await act(async () => void a.registry.execute("model.viewAsDialog"));
    const v = await dialog();
    fireEvent.click(within(v).getByLabelText("East"));
    fireEvent.change(within(v).getByLabelText("User name"), { target: { value: "ann@x.com" } });
    fireEvent.click(within(v).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(a.session.shell.getSnapshot().viewAs).toEqual({ roles: ["East"], identity: "ann@x.com" }));
    expect(await screen.findByRole("region", { name: "Viewing as roles" })).toBeTruthy();
    // a query now carries the roles, and Stop returns to the author's view
    await a.dax.query([], "EVALUATE ROW(1)", a.session.shell.getSnapshot().viewAs ?? undefined);
    fireEvent.click(within(screen.getByRole("region", { name: "Viewing as roles" })).getByRole("button", { name: /Stop viewing/ }));
    await waitFor(() => expect(a.session.shell.getSnapshot().viewAs).toBeNull());
  });
});
