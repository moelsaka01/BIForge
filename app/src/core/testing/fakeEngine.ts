// Test double for EngineApi. It does not parse files: tests register what each path "contains".
import type { Cardinality, ColumnInfo, EngineApi, RelationshipHint, RowPage, SortSpec, SourceSpec, TableInfo } from "../data/types";
import type { TmdlDocument } from "../model/types";

export interface FakeSource {
  columns: ColumnInfo[];
  rows: (string | null)[][];
}

export class FakeEngine implements EngineApi {
  sources = new Map<string, FakeSource>(); // keyed by path (or table for sqlite/postgres)
  tables = new Map<string, FakeSource>();
  calls: string[] = [];
  fail: string | null = null;

  async openStore(root: string): Promise<string[]> {
    this.calls.push(`open:${root}`);
    return [...this.tables.keys()];
  }
  async copyStore(srcRoot: string, dstRoot: string): Promise<string[]> {
    this.calls.push(`copy:${srcRoot}->${dstRoot}`);
    if (this.fail) throw new Error(this.fail);
    return [...this.tables.keys()];
  }
  async importSource(table: string, spec: SourceSpec): Promise<TableInfo> {
    this.calls.push(`import:${table}`);
    if (this.fail) throw new Error(this.fail);
    if (spec.kind === "inline") {
      const cols = spec.columns.map((c) => col(c.name, c.type === "whole" ? "int64" : c.type === "decimal" ? "double" : c.type === "logical" ? "boolean" : c.type.startsWith("date") ? "dateTime" : "string"));
      this.tables.set(table, { columns: cols, rows: spec.rows.map((r) => [...r]) });
      return { name: table, columns: cols, rowCount: spec.rows.length };
    }
    const key = "path" in spec ? spec.path : "url" in spec ? spec.url : "table" in spec && spec.table ? spec.table : "connection" in spec ? spec.connection : "";
    const src = this.sources.get(key);
    if (!src) throw new Error(`File not found: ${key}`);
    this.tables.set(table, structuredClone(src));
    return { name: table, columns: src.columns, rowCount: src.rows.length };
  }
  async tableInfo(table: string): Promise<TableInfo | null> {
    const t = this.tables.get(table);
    return t ? { name: table, columns: t.columns, rowCount: t.rows.length } : null;
  }
  async dropTable(table: string): Promise<void> {
    this.calls.push(`drop:${table}`);
    this.tables.delete(table);
  }
  async fetchPage(table: string, offset: number, limit: number, sort?: SortSpec | null): Promise<RowPage> {
    this.calls.push(`page:${table}:${offset}:${limit}:${sort ? sort.column + (sort.descending ? "-" : "+") : ""}`);
    const t = this.tables.get(table);
    if (!t) throw new Error(`Table "${table}" does not exist in the data store.`);
    let rows = [...t.rows];
    if (sort) {
      const i = t.columns.findIndex((c) => c.name === sort.column);
      const numeric = t.columns[i].biType === "int64" || t.columns[i].biType === "double";
      rows.sort((a, b) => {
        const x = a[i];
        const y = b[i];
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // NULLs last
        const c = numeric ? Number(x) - Number(y) : x.localeCompare(y);
        return sort.descending ? -c : c;
      });
    }
    rows = rows.slice(offset, offset + limit);
    return { columns: t.columns, rows, total: t.rows.length };
  }
  async suggestRelationship(from: [string, string], to: [string, string]): Promise<RelationshipHint> {
    const unique = (tbl: string, c: string) => {
      const t = this.tables.get(tbl)!;
      const i = t.columns.findIndex((x) => x.name === c);
      const vals = t.rows.map((r) => r[i]);
      return new Set(vals).size === vals.length;
    };
    const fromUnique = unique(...from);
    const toUnique = unique(...to);
    const cardinality: Cardinality = fromUnique ? (toUnique ? "oneToOne" : "oneToMany") : toUnique ? "manyToOne" : "manyToMany";
    return { fromUnique, toUnique, cardinality };
  }
  async excelSheets(): Promise<string[]> {
    return ["Sheet1"];
  }
  async sqliteTables(): Promise<string[]> {
    return [];
  }
  async postgresTables(): Promise<string[]> {
    return [];
  }
  async sqlserverTables(): Promise<string[]> {
    return [];
  }
  choices = new Map<string, string[]>();
  previews = new Map<string, RowPage>();
  drivers: string[] = [];
  async sourceChoices(spec: SourceSpec): Promise<string[]> {
    this.calls.push(`choices:${spec.kind}`);
    if (this.fail) throw new Error(this.fail);
    return this.choices.get(spec.kind) ?? [];
  }
  async sourcePreview(spec: SourceSpec, limit: number): Promise<RowPage> {
    this.calls.push(`preview:${spec.kind}:${limit}`);
    const key = "table" in spec && spec.table ? spec.table : "path" in spec ? spec.path : "";
    return this.previews.get(key) ?? { columns: [], rows: [], total: 0 };
  }
  /** What calcTable answers, by table name (default: one column "Value"). */
  calcTables = new Map<string, TableInfo>();
  /** When set, calcColumns / calcTable fail with this message. */
  calcError: string | null = null;
  async calcTable(documents: TmdlDocument[], name: string, expression: string): Promise<TableInfo> {
    this.calls.push(`calcTable:${name}:${expression}`);
    if (this.calcError) throw new Error(this.calcError);
    const info = this.calcTables.get(name) ?? { name, columns: [col("Value", "int64")], rowCount: 1 };
    this.tables.set(name, { columns: info.columns, rows: [] });
    return info;
  }
  async calcColumns(documents: TmdlDocument[], table: string): Promise<string[]> {
    this.calls.push(`calcColumns:${table}`);
    if (this.calcError) throw new Error(this.calcError);
    const node = documents.flatMap((d) => d.nodes).find((n) => n.kind === "table" && n.name === table);
    return (node?.children ?? []).filter((c) => c.kind === "column" && c.default).map((c) => c.name!);
  }
  stored = new Set<string>();
  async credentialExists(spec: SourceSpec): Promise<boolean> {
    return this.stored.has(JSON.stringify(spec));
  }
  async clearCredential(spec: SourceSpec): Promise<void> {
    this.calls.push(`clear:${spec.kind}`);
    this.stored.delete(JSON.stringify(spec));
  }
  async odbcDrivers(): Promise<string[]> {
    return this.drivers;
  }
  async setHeaderSecret(spec: SourceSpec, name: string, value: string): Promise<void> {
    this.calls.push(`header-secret:${spec.kind}:${name}:${value.length}`);
  }
  async setCredential(spec: SourceSpec, secret: string): Promise<void> {
    this.calls.push(`cred:${spec.kind}:${secret.length}`);
    this.stored.add(JSON.stringify(spec));
  }
}

export const col = (name: string, biType: ColumnInfo["biType"] = "string"): ColumnInfo => ({ name, biType, duckdbType: biType.toUpperCase() });
