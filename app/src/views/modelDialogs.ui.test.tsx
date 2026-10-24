// @vitest-environment jsdom
// The Modeling-tab dialogs, filled in through their forms: what-if parameter, field parameter, calculation group, mark as date table.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDomStubs } from "../core/testing/domStubs";
import { col } from "../core/testing/fakeEngine";
import { calculatedTables, listFieldParameters } from "../core/model/modeling";
import { listRelationships } from "../core/model/relationships";
import { listTables } from "../core/model/ops";
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

describe("What-if parameter", () => {
  it("creates the table of values and the measure that reads the chosen one", async () => {
    const a = await open();
    a.engine.calcTables.set("Discount", { name: "Discount", columns: [col("Discount", "int64")], rowCount: 11 });
    await act(async () => void a.registry.execute("model.whatIfDialog"));
    const dlg = await dialog();
    expect(within(dlg).getByText("What-if parameter")).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText("Name"), { target: { value: "Discount" } });
    fireEvent.change(within(dlg).getByLabelText("Minimum"), { target: { value: "0" } });
    fireEvent.change(within(dlg).getByLabelText("Maximum"), { target: { value: "50" } });
    fireEvent.change(within(dlg).getByLabelText("Increment"), { target: { value: "5" } });
    fireEvent.change(within(dlg).getByLabelText("Default"), { target: { value: "10" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calculatedTables(a.session.store.project!).map((t) => t.name)).toContain("Discount"));
    expect(calculatedTables(a.session.store.project!).find((t) => t.name === "Discount")!.expression).toContain("GENERATESERIES(0, 50, 5)");
    const table = listTables(a.session.store.project!).find((t) => t.name === "Discount")!;
    expect(table.measures.map((m) => m.name)).toContain("Discount Value");
    expect(table.measures.find((m) => m.name === "Discount Value")!.expression).toContain("SELECTEDVALUE('Discount'[Discount], 10)");
  });

  it("refuses an increment of zero and a default outside the range, and changes nothing", async () => {
    const a = await open();
    await act(async () => void a.registry.execute("model.whatIfDialog"));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText("Increment"), { target: { value: "0" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    expect(await within(dlg).findByText(/increment must be above zero/)).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText("Increment"), { target: { value: "5" } });
    fireEvent.change(within(dlg).getByLabelText("Default"), { target: { value: "500" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    expect(await within(dlg).findByText(/default must be between/)).toBeTruthy();
    expect(a.session.store.getSnapshot().isDirty).toBe(false);
  });
});

describe("Calculation group", () => {
  it("creates the group with its items and the SELECTEDMEASURE expressions", async () => {
    const a = await open();
    await act(async () => void a.registry.execute("model.calculationGroupDialog"));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText("Calculation group name"), { target: { value: "Time calc" } });
    fireEvent.change(within(dlg).getAllByLabelText("Item name")[0], { target: { value: "Double" } });
    fireEvent.change(within(dlg).getAllByLabelText("DAX expression")[0], { target: { value: "SELECTEDMEASURE() * 2" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add calculation item" }));
    fireEvent.change(within(dlg).getAllByLabelText("Item name")[1], { target: { value: "Half" } });
    fireEvent.change(within(dlg).getAllByLabelText("DAX expression")[1], { target: { value: "SELECTEDMEASURE() / 2" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(listTables(a.session.store.project!).map((t) => t.name)).toContain("Time calc"));
    expect(JSON.stringify(a.session.store.project!.model.tmdl)).toContain("SELECTEDMEASURE() * 2");
    expect(JSON.stringify(a.session.store.project!.model.tmdl)).toContain("calculationItem");
    expect(JSON.stringify(a.session.store.project!.model.tmdl)).toContain("SELECTEDMEASURE() / 2");
  });
});

describe("Field parameter", () => {
  it("creates a parameter table that lists the chosen fields in order", async () => {
    const a = await open();
    a.engine.calcTables.set("Metric", { name: "Metric", columns: [col("Metric"), col("Metric Fields"), col("Metric Order", "int64")], rowCount: 2 });
    await act(async () => void a.registry.execute("model.fieldParameterDialog"));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText("Name"), { target: { value: "Metric" } });
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /Sales\[Quantity\]$/ }));
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /Sales\[UnitPrice\]$/ }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(listFieldParameters(a.session.store.project!).map((f) => f.table)).toContain("Metric"));
    const fp = listFieldParameters(a.session.store.project!).find((f) => f.table === "Metric")!;
    expect(fp.entries.map((e) => `${e.table}[${e.name}]`)).toEqual(["Sales[Quantity]", "Sales[UnitPrice]"]);
  });
});

describe("New relationship", () => {
  it("creates the relationship with the chosen columns, cardinality, direction and state", async () => {
    const a = await open();
    const before = listRelationships(a.session.store.project!).length;
    await act(async () => void a.registry.execute("model.newRelationshipDialog"));
    const dlg = await dialog();
    expect(within(dlg).getByText("Create relationship")).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText("From table"), { target: { value: "Customer" } });
    fireEvent.change(within(dlg).getByLabelText("From column"), { target: { value: "CustomerKey" } });
    fireEvent.change(within(dlg).getByLabelText("To table"), { target: { value: "Product" } });
    fireEvent.change(within(dlg).getByLabelText("To column"), { target: { value: "ProductKey" } });
    fireEvent.change(within(dlg).getByLabelText("Cardinality"), { target: { value: "oneToOne" } });
    fireEvent.change(within(dlg).getByLabelText("Cross-filter direction"), { target: { value: "both" } });
    fireEvent.click(within(dlg).getByLabelText("Make this relationship active"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(listRelationships(a.session.store.project!)).toHaveLength(before + 1));
    const made = listRelationships(a.session.store.project!).find((r) => r.fromTable === "Customer" && r.toTable === "Product")!;
    expect(made).toMatchObject({ fromColumn: "CustomerKey", toColumn: "ProductKey", fromCardinality: "one", toCardinality: "one", crossFilter: "both", isActive: false });
  });

  it("refuses the same table on both sides and changes nothing", async () => {
    const a = await open();
    const before = listRelationships(a.session.store.project!).length;
    await act(async () => void a.registry.execute("model.newRelationshipDialog"));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText("From table"), { target: { value: "Customer" } });
    fireEvent.change(within(dlg).getByLabelText("To table"), { target: { value: "Customer" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(await within(dlg).findByText(/two different tables/)).toBeTruthy();
    expect(listRelationships(a.session.store.project!)).toHaveLength(before);
  });
});
