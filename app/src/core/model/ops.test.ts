import { describe, expect, it } from "vitest";
import * as ops from "./ops";
import { sampleProject } from "../testing/fakes";
import type { Project } from "./types";

const fresh = (): Project => structuredClone(sampleProject());
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe("sanitizeFileName (mirrors the Rust function)", () => {
  it.each([
    ["Sales", "Sales"],
    ["a/b:c", "a_b_c"],
    ["CON", "_CON"],
    ["name. ", "name"],
    ["", "_"],
  ])("%j -> %j", (input, expected) => {
    expect(ops.sanitizeFileName(input)).toBe(expected);
  });
});

describe("parseColumnRef", () => {
  it("parses plain and quoted references", () => {
    expect(ops.parseColumnRef("Sales.ProductKey")).toEqual({ table: "Sales", column: "ProductKey" });
    expect(ops.parseColumnRef("'Product Info'.'Key 1'")).toEqual({ table: "Product Info", column: "Key 1" });
    expect(ops.parseColumnRef("'It''s'.x")).toEqual({ table: "It's", column: "x" });
  });
  it("returns null for malformed references", () => {
    expect(ops.parseColumnRef("NoDot")).toBeNull();
    expect(ops.parseColumnRef("'unterminated.x")).toBeNull();
  });
});

describe("tables", () => {
  it("adds a table file and a ref after the existing refs", () => {
    const p = fresh();
    ops.addTable(p, "  Orders ", ids());
    expect(p.model.tmdl["tables/Orders.tmdl"].nodes[0]).toMatchObject({ kind: "table", name: "Orders" });
    expect(p.model.tmdl["tables/Orders.tmdl"].nodes[0].props[0]).toEqual({ key: "lineageTag", value: { Text: "id-1" } });
    expect(p.model.tmdl["model.tmdl"].nodes.map((n) => `${n.kind}:${n.name}`)).toEqual([
      "model:Model",
      "ref table:Sales",
      "ref table:Product Info",
      "ref table:Orders",
    ]);
  });

  it("rejects empty and duplicate names (case-insensitive) without changing anything", () => {
    const p = fresh();
    const before = structuredClone(p);
    expect(() => ops.addTable(p, "   ")).toThrow(/empty/);
    expect(() => ops.addTable(p, "sales")).toThrow(/already exists/);
    expect(() => ops.addTable(p, "a\tb")).toThrow(/tabs/);
    expect(p).toEqual(before);
  });

  it("gives different files to names that sanitize to the same file name", () => {
    const p = fresh();
    ops.addTable(p, "a/b", ids());
    ops.addTable(p, "a?b", ids());
    expect(Object.keys(p.model.tmdl).filter((k) => k.startsWith("tables/a"))).toEqual(["tables/a_b.tmdl", "tables/a_b (2).tmdl"]);
  });

  it("deleting a table removes its file, its ref and relationships that use it", () => {
    const p = fresh();
    ops.deleteTable(p, "Product Info");
    expect(p.model.tmdl["tables/Product Info.tmdl"]).toBeUndefined();
    expect(p.model.tmdl["model.tmdl"].nodes.map((n) => n.name)).toEqual(["Model", "Sales"]);
    expect(p.model.tmdl["relationships.tmdl"].nodes.map((n) => n.name)).toEqual(["r2"]);
    ops.deleteTable(p, "Calendar");
    expect(p.model.tmdl["relationships.tmdl"]).toBeUndefined(); // empty file is dropped
  });

  it("deleting an unknown table fails", () => {
    expect(() => ops.deleteTable(fresh(), "Nope")).toThrow(/does not exist/);
  });
});

describe("measures", () => {
  it("adds, edits and deletes a measure", () => {
    const p = fresh();
    ops.addMeasure(p, "Sales", "Avg", "AVERAGE(Sales[Amount])\r\n  ");
    expect(ops.listTables(p).find((t) => t.name === "Sales")!.measures).toEqual([
      { name: "Total", expression: "SUM(Sales[Amount])" },
      { name: "Avg", expression: "AVERAGE(Sales[Amount])" },
    ]);
    ops.setMeasureExpression(p, "avg", "MAX(Sales[Amount])");
    expect(ops.listTables(p)[0].measures[1].expression).toBe("MAX(Sales[Amount])");
    ops.deleteMeasure(p, "Avg");
    expect(ops.listTables(p)[0].measures.map((m) => m.name)).toEqual(["Total"]);
  });

  it("measure names are unique across the whole model and must not clash with columns", () => {
    const p = fresh();
    expect(() => ops.addMeasure(p, "Product Info", "total", "1")).toThrow(/already exists \(in table "Sales"\)/);
    expect(() => ops.addMeasure(p, "Sales", "ProductKey", "1")).toThrow(/already has a column/);
    expect(() => ops.addMeasure(p, "Missing", "X", "1")).toThrow(/does not exist/);
    expect(() => ops.setMeasureExpression(p, "Nope", "1")).toThrow(/does not exist/);
    expect(() => ops.deleteMeasure(p, "Nope")).toThrow(/does not exist/);
  });

  it("lists columns with their data types", () => {
    const t = ops.listTables(fresh()).find((x) => x.name === "Sales")!;
    expect(t.columns).toEqual([
      { name: "ProductKey", dataType: "int64", summarizeBy: null },
      { name: "DateKey", dataType: "int64", summarizeBy: null },
    ]);
  });
});
