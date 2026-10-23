import { describe, expect, it } from "vitest";
import { modelDialogFor, type ModelDialogCtx } from "./modelDialogs";
import type { DialogDef, Values } from "../queries/dialogs";

const col = (name: string, dataType: string) => ({ name, dataType, summarizeBy: null });
const ctx: ModelDialogCtx = {
  tables: [
    { name: "Sales", columns: [col("Qty", "int64"), col("Day", "dateTime"), col("Region", "string")], measures: [{ name: "Total", expression: "SUM(Sales[Qty])" }] },
    { name: "My Dates", columns: [col("Date", "dateTime")], measures: [] },
  ],
  table: "Sales",
};
const run = (def: DialogDef, v: Values) => {
  const values: Values = {};
  for (const f of def.fields) if ("default" in f && f.default !== undefined) values[f.key] = f.default;
  return def.build({ ...values, ...v });
};

describe("modeling dialogs", () => {
  it("new column takes the formula with or without 'Name ='", () => {
    const d = modelDialogFor("newColumn", ctx);
    expect(run(d, { name: "Big", expression: "Big = Sales[Qty] > 5" })).toEqual({ command: "model.addCalculatedColumn", args: { table: "Sales", name: "Big", expression: "Sales[Qty] > 5" } });
    expect(run(d, { name: "Big", expression: "Sales[Qty] > 5", table: "My Dates" })).toMatchObject({ args: { table: "My Dates" } });
    expect(() => run(d, { name: "", expression: "1" })).toThrow("name");
    expect(() => run(d, { name: "A", expression: " " })).toThrow("formula");
    const e = modelDialogFor("editColumn", { ...ctx, column: { name: "Big", expression: "1" } });
    expect(run(e, { expression: "2" })).toMatchObject({ command: "model.editCalculatedColumn", args: { name: "Big", expression: "2" } });
    expect(() => modelDialogFor("editColumn", ctx)).toThrow("Select a calculated column");
  });

  it("calculated table: name and expression; editing keeps the name", () => {
    expect(run(modelDialogFor("newCalculatedTable", ctx), { name: "Dates", expression: "Dates = CALENDAR(1, 2)" })).toEqual({ command: "model.setCalculatedTable", args: { name: "Dates", expression: "CALENDAR(1, 2)" } });
    const e = modelDialogFor("editCalculatedTable", { ...ctx, calculated: { name: "Dates", expression: "X" } });
    expect(() => run(e, { name: "Other", expression: "Y" })).toThrow("Rename the table");
  });

  it("hierarchy checks the level names", () => {
    const d = modelDialogFor("newHierarchy", ctx);
    expect(run(d, { name: "H", levels: "region\nQty" })).toEqual({ command: "model.addHierarchy", args: { table: "Sales", name: "H", columns: ["Region", "Qty"] } });
    expect(() => run(d, { name: "H", levels: "Region\nNope" })).toThrow('no column "Nope"');
    expect(() => run(d, { name: "H", levels: "Region" })).toThrow("at least two");
    expect(() => modelDialogFor("newHierarchy", { ...ctx, table: "My Dates" })).toThrow("at least two columns");
  });

  it("quick measure builds the DAX and hosts the measure in the base column's table", () => {
    const d = modelDialogFor("quickMeasure", ctx);
    expect(run(d, { kind: "ytd", base: "Sales[Qty]", date: "Sales[Day]" })).toEqual({ command: "model.addMeasure", args: { table: "Sales", name: "Qty YTD", expression: "TOTALYTD(SUM(Sales[Qty]), Sales[Day])" } });
    expect(run(d, { kind: "percentOfTotal", base: "[Total]" })).toMatchObject({ args: { table: "Sales", name: "Total % of grand total" } });
    expect(run(d, { kind: "sameLastYear", base: "Sales[Qty]", date: "'My Dates'[Date]" })).toMatchObject({ args: { expression: "CALCULATE(SUM(Sales[Qty]), SAMEPERIODLASTYEAR('My Dates'[Date]))" } });
    expect(() => run(d, { kind: "sum", base: "Sales[Qty]", category: "" })).toThrow("category");
  });
});

describe("what-if parameter", () => {
  it("checks the range and passes the values on", () => {
    const d = modelDialogFor("whatIf", ctx);
    expect(run(d, { name: "Discount", min: 0, max: 50, step: 5, default: 10 })).toEqual({ command: "model.addWhatIf", args: { name: "Discount", min: 0, max: 50, step: 5, default: 10 } });
    expect(run(d, { name: "D", min: 1, max: 3, step: 1 })).toMatchObject({ args: { default: 1 } });
    expect(() => run(d, { name: "D", min: 5, max: 1, step: 1 })).toThrow("maximum");
    expect(() => run(d, { name: "D", min: 0, max: 5, step: 0 })).toThrow("above zero");
    expect(() => run(d, { name: "D", min: 0, max: 5, step: 0.5, type: "int" })).toThrow("whole");
    expect(() => run(d, { name: "D", min: 0, max: 5, step: 1, default: 9 })).toThrow("default");
    expect(() => run(d, { name: "", min: 0, max: 5, step: 1 })).toThrow("name");
  });
});

describe("calculation group dialog", () => {
  it("needs named items with expressions", () => {
    const d = modelDialogFor("calculationGroup", ctx);
    expect(run(d, { name: "TI", column: "", items: [{ name: "YTD", expression: "SELECTEDMEASURE()" }] })).toEqual({ command: "model.setCalculationGroup", args: { name: "TI", column: "Name", items: [{ name: "YTD", expression: "SELECTEDMEASURE()" }] } });
    expect(() => run(d, { name: "TI", items: [] })).toThrow("name");
    expect(() => run(d, { name: "TI", items: [{ name: "A", expression: "" }] })).toThrow("expression");
  });
});
