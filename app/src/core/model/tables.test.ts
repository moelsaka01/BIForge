import { describe, expect, it } from "vitest";
import { sampleProject } from "../testing/fakes";
import { applyImport, getTableSource, importedTables } from "./tables";
import { partitionM } from "./partitionM";
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
      { name: "Id", dataType: "int64", summarizeBy: null },
      { name: "Name", dataType: "string", summarizeBy: "none" },
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

describe("import partitions (M source)", () => {
  const cols = (...c: [string, TableInfo["columns"][0]["biType"], string?][]): TableInfo => ({
    name: "Orders",
    rowCount: 1,
    columns: c.map(([n, t, d]) => ({ name: n, biType: t, duckdbType: d ?? "X" })),
  });
  const partitionOf = (p: ReturnType<typeof sampleProject>, table: string) =>
    p.model.tmdl[Object.keys(p.model.tmdl).find((k) => k.endsWith(`${table}.tmdl`))!].nodes[0].children.filter((c) => c.kind === "partition");
  const sourceText = (n: ReturnType<typeof partitionOf>[0]) => {
    const v = n.props.find((x) => x.key === "source")!.value as { Expr: { text: string } };
    return v.Expr.text;
  };

  it("adds a partition named after the table with the M query of a CSV file", () => {
    const p = sampleProject();
    applyImport(p, cols(["Id", "int64", "BIGINT"], ["Name", "string", "VARCHAR"], ["When", "dateTime", "DATE"], ["Amt", "double", "DOUBLE"]), csv, ids());
    const parts = partitionOf(p, "Orders");
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("Orders");
    expect(parts[0].default?.text).toBe("m");
    expect(parts[0].props.find((x) => x.key === "mode")?.value).toEqual({ Text: "import" });
    expect(sourceText(parts[0])).toBe(
      [
        "let",
        '\tSource = Csv.Document(File.Contents("C:' + "\\data\\a" + ' ""q"".csv"), [Delimiter=",", Columns=4, Encoding=65001, QuoteStyle=QuoteStyle.Csv]),',
        '\t#"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),',
        '\t#"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers", {{"Id", Int64.Type}, {"Name", type text}, {"When", type date}, {"Amt", type number}}, "en-US")',
        "in",
        '\t#"Changed Type"',
      ].join("\n"),
    );
  });

  it("a CSV whose header names have spaces gets an explicit Trimmed Column Names step before the type step", () => {
    const p = sampleProject();
    const info = { ...cols(["order_id", "int64", "BIGINT"], ["region", "string", "VARCHAR"]), headerPadded: true };
    applyImport(p, info, csv, ids());
    expect(sourceText(partitionOf(p, "Orders")[0])).toBe(
      [
        "let",
        '\tSource = Csv.Document(File.Contents("C:' + "\\data\\a" + ' ""q"".csv"), [Delimiter=",", Columns=2, Encoding=65001, QuoteStyle=QuoteStyle.Csv]),',
        '\t#"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),',
        '\t#"Trimmed Column Names" = Table.TransformColumnNames(#"Promoted Headers", Text.Trim),',
        '\t#"Changed Type" = Table.TransformColumnTypes(#"Trimmed Column Names", {{"order_id", Int64.Type}, {"region", type text}}, "en-US")',
        "in",
        '\t#"Changed Type"',
      ].join("\n"),
    );
    // no padding, no extra step
    const q = sampleProject();
    applyImport(q, cols(["order_id", "int64", "BIGINT"], ["region", "string", "VARCHAR"]), csv, ids());
    expect(sourceText(partitionOf(q, "Orders")[0])).not.toContain("Trimmed Column Names");
  });

  it("a web CSV with padded header names gets the same Trimmed Column Names step", () => {
    const p = sampleProject();
    const info = { ...cols(["order_id", "int64", "BIGINT"], ["region", "string", "VARCHAR"]), headerPadded: true };
    applyImport(p, info, { kind: "web", url: "http://x/a.csv", format: "csv" }, ids());
    const m = sourceText(partitionOf(p, "Orders")[0]);
    expect(m).toContain('#"Trimmed Column Names" = Table.TransformColumnNames(#"Promoted Headers", Text.Trim)');
    expect(m).toContain('Table.TransformColumnTypes(#"Trimmed Column Names"');
    const q = sampleProject();
    applyImport(q, cols(["order_id", "int64", "BIGINT"]), { kind: "web", url: "http://x/a.csv", format: "csv" }, ids());
    expect(sourceText(partitionOf(q, "Orders")[0])).not.toContain("Trimmed Column Names");
  });

  it("refresh rebuilds a generated partition but keeps one the user edited", () => {
    const p = sampleProject();
    applyImport(p, cols(["Id", "int64"]), csv, ids());
    applyImport(p, cols(["Id", "int64"], ["B", "string"]), csv, ids());
    expect(partitionOf(p, "Orders")).toHaveLength(1);
    expect(sourceText(partitionOf(p, "Orders")[0])).toContain("Columns=2");

    const part = partitionOf(p, "Orders")[0];
    part.children = []; // marker removed = the user edited the query
    part.props = part.props.map((x) => (x.key === "source" ? { key: "source", value: { Expr: { text: "let Source = 1 in Source", verbatim: false } } } : x));
    applyImport(p, cols(["Id", "int64"], ["B", "string"], ["C", "string"]), csv, ids());
    expect(partitionOf(p, "Orders")).toHaveLength(1);
    expect(sourceText(partitionOf(p, "Orders")[0])).toBe("let Source = 1 in Source");
  });

  it("covers every source kind", () => {
    const c = cols(["A", "int64"]).columns;
    const m = (s: SourceSpec) => partitionM(s, c);
    expect(m({ kind: "excel", path: "C:\b.xlsx", sheet: "Sheet 1" })).toContain('Source{[Item="Sheet 1", Kind="Sheet"]}[Data]');
    expect(m({ kind: "excel", path: "C:\b.xlsx" })).toContain("Source{0}[Data]");
    expect(m({ kind: "json", path: "C:\b.json" })).toContain("Table.FromRecords(Source)");
    expect(m({ kind: "parquet", path: "C:\b.parquet" })).toContain("Parquet.Document(File.Contents(");
    expect(m({ kind: "postgres", host: "h", database: "d", user: "u", schema: "s", table: "t" })).toContain('PostgreSQL.Database("h:5432", "d")');
    expect(m({ kind: "postgres", host: "h", database: "d", user: "u", schema: "s", table: "t" })).toContain('[Schema="s", Item="t"]');
    expect(m({ kind: "sqlite", path: "C:/x.db", table: "t" })).toContain("Odbc.Query(");
    expect(m({ kind: "csv", path: "C:/x.txt", delimiter: ";", header: false })).toContain('Table.RenameColumns(Source, {{"Column1", "A"}})');
  });
});
