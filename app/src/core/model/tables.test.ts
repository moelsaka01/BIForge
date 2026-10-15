import { describe, expect, it } from "vitest";
import { sampleProject } from "../testing/fakes";
import { applyImport, getTableSource, importedTables } from "./tables";
import { listRelationships } from "./relationships";
import { listTables } from "./ops";
import type { SourceSpec, TableInfo } from "../data/types";

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

const info = (name: string, cols: [string, TableInfo["columns"][0]["biType"]][]): TableInfo => ({
  name,
  rowCount: 1,
  columns: cols.map(([n, t]) => ({ name: n, biType: t, duckdbType: "X" })),
});
const csv: SourceSpec = { kind: "csv", path: 'C:\\data\\a "q".csv' };

describe("applyImport", () => {
  it("creates a table with typed columns and a source annotation", () => {
    const p = sampleProject();
    const r = applyImport(p, info("Orders", [["Id", "int64"], ["Name", "string"]]), csv, ids());
    expect(r).toEqual({ created: true, removedRelationships: [] });
    const t = listTables(p).find((x) => x.name === "Orders")!;
    expect(t.columns).toEqual([
      { name: "Id", dataType: "int64" },
      { name: "Name", dataType: "string" },
    ]);
    expect(getTableSource(p, "Orders")).toEqual(csv);
    expect(importedTables(p)).toEqual(["Orders"]);
    expect(p.model.tmdl["model.tmdl"].nodes.some((n) => n.kind === "ref table" && n.name === "Orders")).toBe(true);
  });

  it("refresh keeps user edits, updates types, adds columns and drops relationships on vanished columns", () => {
    const p = sampleProject();
    applyImport(p, info("Sales", [["ProductKey", "int64"], ["DateKey", "int64"], ["Amount", "double"]]), csv, ids());
    const sales = p.model.tmdl["tables/Sales.tmdl"].nodes[0];
    sales.children.find((c) => c.name === "Amount")!.props.push({ key: "formatString", value: { Text: "0.00" } });
    expect(sales.children.some((c) => c.kind === "measure")).toBe(true);

    const r = applyImport(p, info("Sales", [["ProductKey", "string"], ["Amount", "double"], ["Region", "string"]]), csv, ids());
    expect(r.created).toBe(false);
    expect(r.removedRelationships).toHaveLength(1); // Sales.DateKey -> Calendar
    expect(listRelationships(p)).toHaveLength(1);
    const cols = listTables(p).find((t) => t.name === "Sales")!;
    expect(cols.columns.map((c) => c.name)).toEqual(["ProductKey", "Amount", "Region"]);
    expect(cols.columns[0].dataType).toBe("string");
    const kept = sales.children.find((c) => c.name === "Amount")!;
    expect(kept.props.some((x) => x.key === "formatString")).toBe(true);
    expect(cols.measures).toHaveLength(1);
    expect(sales.children.filter((c) => c.kind === "annotation")).toHaveLength(1);
  });

  it("tables without a source are not refreshable", () => {
    const p = sampleProject();
    expect(importedTables(p)).toEqual([]);
    expect(getTableSource(p, "Sales")).toBeNull();
  });
});
