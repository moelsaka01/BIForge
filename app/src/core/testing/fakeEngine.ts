// Test double for EngineApi. It does not parse files: tests register what each path "contains".
import type { Cardinality, ColumnInfo, EngineApi, RelationshipHint, RowPage, SortSpec, SourceSpec, TableInfo } from "../data/types";

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
    const key = "path" in spec ? spec.path : spec.table;
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
  async setCredential(spec: SourceSpec, secret: string): Promise<void> {
    this.calls.push(`cred:${spec.kind}:${secret.length}`);
  }
}

export const col = (name: string, biType: ColumnInfo["biType"] = "string"): ColumnInfo => ({ name, biType, duckdbType: biType.toUpperCase() });
