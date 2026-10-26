import { describe, expect, it } from "vitest";
import * as ops from "./ops";
import * as mod from "./modeling";
import { sampleProject } from "../testing/fakes";
import type { Project } from "./types";

const fresh = (): Project => structuredClone(sampleProject());
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const col = (t: string, c: string): mod.Target => ({ kind: "column", table: t, column: c });

function withColumns(): Project {
  const p = fresh();
  const t = ops.requireTable(p, "Sales").node;
  const mk = (name: string, dataType: string) => ({ description: [], kind: "column", name, default: null, props: [{ key: "dataType", value: { Text: dataType } }], children: [] });
  t.children.push(mk("Month", "string"), mk("MonthNumber", "int64"), mk("Country", "string"), mk("City", "string"), mk("Day", "dateTime"));
  return p;
}

describe("properties of tables, columns and measures", () => {
  it("sets and clears text, flag and enum properties", () => {
    const p = withColumns();
    mod.setProperty(p, col("Sales", "MonthNumber"), "formatString", "0.00");
    mod.setProperty(p, col("Sales", "MonthNumber"), "isHidden", true);
    mod.setProperty(p, col("Sales", "MonthNumber"), "summarizeBy", "SUM");
    mod.setProperty(p, col("Sales", "MonthNumber"), "displayFolder", "Calendar");
    expect(mod.getProperty(p, col("Sales", "MonthNumber"), "formatString")).toBe("0.00");
    expect(mod.getProperty(p, col("Sales", "MonthNumber"), "isHidden")).toBe(true);
    expect(mod.getProperty(p, col("Sales", "MonthNumber"), "summarizeBy")).toBe("sum");
    mod.setProperty(p, col("Sales", "MonthNumber"), "isHidden", false);
    mod.setProperty(p, col("Sales", "MonthNumber"), "formatString", "");
    expect(mod.getProperty(p, col("Sales", "MonthNumber"), "isHidden")).toBe(false);
    expect(mod.getProperty(p, col("Sales", "MonthNumber"), "formatString")).toBe("");
    // a measure and its format; a description of several lines
    mod.setProperty(p, { kind: "measure", table: "Sales", name: "Total" }, "formatString", "$#,0");
    expect(mod.getProperty(p, { kind: "measure", table: "Sales", name: "Total" }, "formatString")).toBe("$#,0");
    mod.setProperty(p, { kind: "table", table: "Sales" }, "description", "Orders\nof the shop");
    expect(ops.requireTable(p, "Sales").node.description).toEqual(["Orders", "of the shop"]);
    // refused values
    expect(() => mod.setProperty(p, col("Sales", "Month"), "summarizeBy", "median")).toThrow("not a valid");
    expect(() => mod.setProperty(p, col("Sales", "Month"), "dataCategory", "Planet")).toThrow("not a valid");
    expect(() => mod.setProperty(p, { kind: "measure", table: "Sales", name: "Total" }, "summarizeBy", "sum")).toThrow("no \"summarizeBy\"");
    expect(() => mod.setProperty(p, col("Sales", "Nope"), "isHidden", true)).toThrow("does not exist");
  });

  it("sort by column needs another column of the table and refuses loops", () => {
    const p = withColumns();
    mod.setProperty(p, col("Sales", "Month"), "sortByColumn", "monthnumber");
    expect(mod.getProperty(p, col("Sales", "Month"), "sortByColumn")).toBe("MonthNumber");
    expect(() => mod.setProperty(p, col("Sales", "Month"), "sortByColumn", "Month")).toThrow("itself");
    expect(() => mod.setProperty(p, col("Sales", "Month"), "sortByColumn", "Missing")).toThrow("does not exist");
    expect(() => mod.setProperty(p, col("Sales", "MonthNumber"), "sortByColumn", "Month")).toThrow("already sorted by");
    mod.setProperty(p, col("Sales", "Month"), "sortByColumn", null);
    expect(mod.getProperty(p, col("Sales", "Month"), "sortByColumn")).toBe("");
  });

  it("data categories on columns, and a date table needs a date column that becomes its key", () => {
    const p = withColumns();
    mod.setProperty(p, col("Sales", "City"), "dataCategory", "city");
    expect(mod.getProperty(p, col("Sales", "City"), "dataCategory")).toBe("City");
    expect(() => mod.setProperty(p, { kind: "table", table: "Sales" }, "dataCategory", "City")).toThrow("only have the data category Time");
    mod.setProperty(p, { kind: "table", table: "Sales" }, "dataCategory", "Time");
    expect(mod.getProperty(p, col("Sales", "Day"), "isKey")).toBe(true);
    const q = fresh();
    expect(() => mod.setProperty(q, { kind: "table", table: "Sales" }, "dataCategory", "Time")).toThrow("Date/Time");
  });
});

describe("calculated columns and tables", () => {
  it("adds a calculated column as a column with an expression, edits it and records its type", () => {
    const p = withColumns();
    mod.addCalculatedColumn(p, "Sales", " Double ", "Sales[MonthNumber] * 2", ids());
    const c = ops.requireTable(p, "Sales").node.children.find((x) => x.name === "Double")!;
    expect(c.default?.text).toBe("Sales[MonthNumber] * 2");
    expect(mod.calculatedColumns(p, "Sales")).toEqual([{ name: "Double", expression: "Sales[MonthNumber] * 2" }]);
    mod.setCalculatedColumn(p, "Sales", "Double", "Sales[MonthNumber] * 3");
    expect(mod.calculatedColumns(p, "Sales")[0].expression).toBe("Sales[MonthNumber] * 3");
    mod.setColumnDataType(p, "Sales", "Double", "int64");
    expect(mod.getProperty(p, col("Sales", "Double"), "summarizeBy")).toBe("sum");
    expect(() => mod.addCalculatedColumn(p, "Sales", "Double", "1")).toThrow("already has");
    expect(() => mod.addCalculatedColumn(p, "Sales", "Total", "1")).toThrow("already has");
    expect(() => mod.addCalculatedColumn(p, "Sales", "X", "  ")).toThrow("formula");
    expect(() => mod.setCalculatedColumn(p, "Sales", "Month", "1")).toThrow("not a calculated column");
  });

  it("a calculated table is a table with a calculated partition and the columns the engine found", () => {
    const p = fresh();
    const info = { name: "Regions", columns: [{ name: "Region", duckdbType: "VARCHAR", biType: "string" as const }, { name: "Total", duckdbType: "BIGINT", biType: "int64" as const }], rowCount: 2 };
    mod.setCalculatedTable(p, "Regions", "SUMMARIZE(Sales, Sales[X])", info, (pr, n) => ops.addTable(pr, n, ids()), ids());
    expect(mod.calculatedTables(p)).toEqual([{ name: "Regions", expression: "SUMMARIZE(Sales, Sales[X])" }]);
    const t = ops.requireTable(p, "Regions").node;
    expect(t.children.filter((c) => c.kind === "column").map((c) => c.name)).toEqual(["Region", "Total"]);
    // a measure added to it survives a recalculation, and the columns follow the new result
    ops.addMeasure(p, "Regions", "N", "COUNTROWS(Regions)");
    mod.setCalculatedTable(p, "Regions", "FILTER(Sales, TRUE())", { ...info, columns: [info.columns[0]] }, (pr, n) => ops.addTable(pr, n, ids()), ids());
    const again = ops.requireTable(p, "Regions").node;
    expect(again.children.filter((c) => c.kind === "column").map((c) => c.name)).toEqual(["Region"]);
    expect(again.children.some((c) => c.kind === "measure" && c.name === "N")).toBe(true);
    expect(mod.calculatedTables(p)[0].expression).toBe("FILTER(Sales, TRUE())");
    // an imported table is not replaced
    expect(() => mod.setCalculatedTable(p, "Sales", "1", info, (pr, n) => ops.addTable(pr, n))).toThrow("not a calculated table");
  });
});

describe("hierarchies", () => {
  it("adds a hierarchy of two or more columns, lists it, prunes it when a column goes", () => {
    const p = withColumns();
    mod.addHierarchy(p, "Sales", "Geography", ["Country", "City"], ids());
    expect(mod.listHierarchies(p, "Sales")).toEqual([{ name: "Geography", levels: [{ name: "Country", column: "Country" }, { name: "City", column: "City" }] }]);
    expect(() => mod.addHierarchy(p, "Sales", "Geography", ["Country", "City"])).toThrow("already has");
    expect(() => mod.addHierarchy(p, "Sales", "One", ["Country"])).toThrow("at least two");
    expect(() => mod.addHierarchy(p, "Sales", "Dup", ["City", "city"])).toThrow("one level only");
    expect(() => mod.addHierarchy(p, "Sales", "Bad", ["City", "Nope"])).toThrow("does not exist");
    mod.addHierarchy(p, "Sales", "Time", ["Month", "Day", "City"], ids());
    const t = ops.requireTable(p, "Sales").node;
    t.children = t.children.filter((c) => c.name !== "Day");
    mod.pruneHierarchies(p, "Sales");
    expect(mod.listHierarchies(p, "Sales").map((h) => [h.name, h.levels.map((l) => l.column)])).toEqual([["Geography", ["Country", "City"]], ["Time", ["Month", "City"]]]);
    t.children = t.children.filter((c) => c.name !== "City");
    mod.pruneHierarchies(p, "Sales");
    expect(mod.listHierarchies(p, "Sales")).toEqual([]);
    expect(() => mod.removeHierarchy(p, "Sales", "Geography")).toThrow("does not exist");
  });
});

describe("security roles", () => {
  it("creates, edits, renames and removes a role with one filter per table", () => {
    const p = fresh();
    mod.setRole(p, { name: "East", filters: [{ table: "Sales", expression: "Sales[Region] = \"East\"" }] });
    expect(mod.listRoles(p)).toEqual([{ name: "East", filters: [{ table: "Sales", expression: "Sales[Region] = \"East\"" }] }]);
    expect(p.model.tmdl["model.tmdl"].nodes.some((n) => n.kind === "ref role" && n.name === "East")).toBe(true);
    mod.setRole(p, { name: "Eastern", filters: [{ table: "Sales", expression: "TRUE()" }] }, "East");
    expect(mod.listRoles(p).map((r) => r.name)).toEqual(["Eastern"]);
    mod.setRole(p, { name: "All", filters: [] });
    expect(() => mod.setRole(p, { name: "all", filters: [] })).toThrow("already exists");
    expect(() => mod.setRole(p, { name: "X", filters: [{ table: "Nope", expression: "1" }] })).toThrow("does not exist");
    expect(() => mod.setRole(p, { name: "X", filters: [{ table: "Sales", expression: " " }] })).toThrow("filter expression");
    expect(() => mod.setRole(p, { name: "X", filters: [{ table: "Sales", expression: "1" }, { table: "sales", expression: "2" }] })).toThrow("two filters");
    mod.removeRole(p, "Eastern");
    expect(mod.listRoles(p).map((r) => r.name)).toEqual(["All"]);
    expect(() => mod.removeRole(p, "Eastern")).toThrow("does not exist");
  });
});

describe("calculation groups", () => {
  it("a calculation group is a table with its items in a calculationGroup object, listed back with its column", () => {
    const p = fresh();
    mod.setCalculationGroup(p, "Time Calc", "Period", [{ name: "YTD", expression: "CALCULATE(SELECTEDMEASURE(), DATESYTD('Date'[Date]))" }, { name: "Current", expression: "SELECTEDMEASURE()" }], (pr, n) => ops.addTable(pr, n, ids()), ids());
    expect(mod.listCalcGroups(p)).toEqual([{ table: "Time Calc", column: "Period", items: [{ name: "YTD", expression: "CALCULATE(SELECTEDMEASURE(), DATESYTD('Date'[Date]))" }, { name: "Current", expression: "SELECTEDMEASURE()" }] }]);
    expect(mod.calcGroupData("Period", [{ name: "YTD" }, { name: 'a"b' }])).toBe('DATATABLE("Period", STRING, "Ordinal", INTEGER, {{"YTD", 0}, {"a""b", 1}})');
    // replacing keeps measures of the table and changes the items
    ops.addMeasure(p, "Time Calc", "Note", "1");
    mod.setCalculationGroup(p, "Time Calc", "Period", [{ name: "Only", expression: "SELECTEDMEASURE()" }], (pr, n) => ops.addTable(pr, n), ids());
    expect(mod.listCalcGroups(p)[0].items.map((i) => i.name)).toEqual(["Only"]);
    expect(ops.requireTable(p, "Time Calc").node.children.some((c) => c.kind === "measure")).toBe(true);
    expect(() => mod.setCalculationGroup(p, "Sales", "N", [{ name: "A", expression: "1" }], (pr, n) => ops.addTable(pr, n))).toThrow("not a calculation group");
    expect(() => mod.setCalculationGroup(p, "G", "N", [], (pr, n) => ops.addTable(pr, n))).toThrow("at least one");
    expect(() => mod.setCalculationGroup(p, "G", "N", [{ name: "A", expression: "1" }, { name: "a", expression: "2" }], (pr, n) => ops.addTable(pr, n))).toThrow("Two calculation items");
    expect(() => mod.setCalculationGroup(p, "G", "N", [{ name: "A", expression: " " }], (pr, n) => ops.addTable(pr, n))).toThrow("expression");
  });
});

describe("field parameters", () => {
  it("writes the table expression and reads the entries back, in order", () => {
    const expr = mod.fieldParameterExpression("Pick", [{ label: "Revenue", table: "Sales", name: "Amount" }, { label: "It's", table: "O'Brien Co", name: "Total" }]);
    expect(expr).toBe(`SELECTCOLUMNS({("Revenue", NAMEOF('Sales'[Amount]), 0), ("It's", NAMEOF('O''Brien Co'[Total]), 1)}, "Pick", [Value1], "Pick Fields", [Value2], "Pick Order", [Value3])`);
    expect(mod.parseFieldParameter(expr)).toEqual([{ label: "Revenue", table: "Sales", name: "Amount", order: 0 }, { label: "It's", table: "O'Brien Co", name: "Total", order: 1 }]);
    // Power BI's own form (an unquoted table, a measure without table)
    expect(mod.parseFieldParameter(`{("A", NAMEOF(Sales[X]), 1), ("B", NAMEOF([M]), 0)}`).map((e) => [e.label, e.table, e.name])).toEqual([["B", "", "M"], ["A", "Sales", "X"]]);
  });

  it("a marked calculated table is listed as a field parameter with its name column", () => {
    const p = fresh();
    const expr = mod.fieldParameterExpression("Pick", [{ label: "Qty", table: "Sales", name: "ProductKey" }]);
    const info = { name: "Pick", columns: [{ name: "Pick", duckdbType: "VARCHAR", biType: "string" as const }, { name: "Pick Fields", duckdbType: "VARCHAR", biType: "string" as const }, { name: "Pick Order", duckdbType: "BIGINT", biType: "int64" as const }], rowCount: 1 };
    mod.setCalculatedTable(p, "Pick", expr, info, (pr, n) => ops.addTable(pr, n, ids()), ids());
    expect(mod.listFieldParameters(p)).toEqual([]);
    mod.markFieldParameter(p, "Pick");
    expect(mod.listFieldParameters(p)).toEqual([{ table: "Pick", column: "Pick", entries: [{ label: "Qty", table: "Sales", name: "ProductKey", order: 0 }] }]);
    expect(mod.getProperty(p, { kind: "column", table: "Pick", column: "Pick Fields" }, "isHidden")).toBe(true);
    expect(mod.getProperty(p, { kind: "column", table: "Pick", column: "Pick" }, "sortByColumn")).toBe("Pick Order");
  });
});

import { moveMeasure, addMeasure as addMeasureOp, listTables as listTablesOp } from "./ops";
import { fixtureProject as fixtureProjectForMove } from "../report/testFixture";

describe("home table of a measure", () => {
  it("moves a measure to another table, refuses a name that table already uses, and reports a missing table or measure", () => {
    const p = fixtureProjectForMove();
    addMeasureOp(p, "Sales", "Total", "SUM(Sales[Quantity])");
    moveMeasure(p, "Total", "Customer");
    expect(listTablesOp(p).find((t) => t.name === "Customer")!.measures[0]).toMatchObject({ name: "Total", expression: "SUM(Sales[Quantity])" });
    expect(listTablesOp(p).find((t) => t.name === "Sales")!.measures).toEqual([]);
    moveMeasure(p, "Total", "Customer"); // already there: nothing happens
    addMeasureOp(p, "Sales", "Other", "1");
    addMeasureOp(p, "Product", "Dup", "1");
    addMeasureOp(p, "Sales", "Dup2", "2");
    expect(() => moveMeasure(p, "Missing", "Customer")).toThrow(/does not exist/);
    expect(() => moveMeasure(p, "Other", "Nowhere")).toThrow(/does not exist/);
    // a column with the same name blocks the move
    addMeasureOp(p, "Sales", "City", "3");
    expect(() => moveMeasure(p, "City", "Customer")).toThrow(/already has/);
  });
});
