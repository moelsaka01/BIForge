import { describe, expect, it } from "vitest";
import { columnCommand, columnMetaOf } from "./Frame";
import { addCalculatedColumn } from "../../core/model/modeling";
import { setProperty } from "../../core/model/modeling";
import { fixtureProject } from "../../core/report/testFixture";

describe("Table view column menu → model commands", () => {
  it("hide, unhide, rename, new column and edit formula become the right commands", async () => {
    const calls: [string, unknown][] = [];
    const run = async (id: string, args?: unknown) => void calls.push([id, args]);
    await columnCommand(run, "Sales", "hide", "Quantity");
    await columnCommand(run, "Sales", "unhide", "Quantity");
    await columnCommand(run, "Sales", "rename", "Quantity");
    await columnCommand(run, "Sales", "newColumn");
    await columnCommand(run, "Sales", "editFormula", "Double");
    expect(calls).toEqual([
      ["model.setProperty", { target: { kind: "column", table: "Sales", column: "Quantity" }, key: "isHidden", value: true }],
      ["model.setProperty", { target: { kind: "column", table: "Sales", column: "Quantity" }, key: "isHidden", value: false }],
      ["model.renameDialog", { kind: "column", table: "Sales", name: "Quantity" }],
      ["model.newColumnDialog", { table: "Sales" }],
      ["model.editCalculatedDialog", { kind: "column", table: "Sales", column: "Double" }],
    ]);
  });
  it("the model tells the Table view the format, data category and formula of each column", () => {
    const p = fixtureProject();
    addCalculatedColumn(p, "Sales", "Double", "[Quantity] * 2");
    setProperty(p, { kind: "column", table: "Sales", column: "UnitPrice" }, "formatString", "#,0.00");
    setProperty(p, { kind: "column", table: "Customer", column: "City" }, "dataCategory", "City");
    const sales = columnMetaOf(p, "Sales");
    expect(sales.Double).toEqual({ formula: "[Quantity] * 2" });
    expect(sales.UnitPrice).toEqual({ format: "#,0.00" });
    expect(columnMetaOf(p, "Customer").City).toEqual({ category: "City" });
    expect(columnMetaOf(p, null)).toEqual({});
  });
});
