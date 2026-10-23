// Read-only facts about the model that the report layer needs.
import type { Project, TmdlNode } from "../model/types";
import { allTables, textProp } from "../model/ops";
import type { FieldRef } from "./fields";
import { listFieldParameters, type FieldParam } from "../model/modeling";

export interface ModelInfo {
  tables(): string[];
  columns(table: string): string[];
  measures(table: string): string[];
  /** TMDL dataType of a column: int64, double, decimal, dateTime, string, boolean. */
  columnType(table: string, column: string): string | null;
  /** Column the given column sorts by (sortByColumn), if any. */
  sortByColumn(table: string, column: string): string | null;
  /** formatString of a column or measure. */
  formatString(table: string, name: string): string | null;
  /** The field parameter whose name column is this column, if it is one. */
  fieldParameter(table: string, column: string): FieldParam | null;
}

function child(p: Project, table: string, name: string): TmdlNode | undefined {
  const t = allTables(p).find((x) => x.name?.toLowerCase() === table.toLowerCase());
  return t?.children.find((c) => (c.kind === "column" || c.kind === "measure") && c.name?.toLowerCase() === name.toLowerCase());
}

export function modelInfo(p: Project): ModelInfo {
  return {
    tables: () => allTables(p).map((t) => t.name ?? ""),
    columns: (t) => allTables(p).find((x) => x.name?.toLowerCase() === t.toLowerCase())?.children.filter((c) => c.kind === "column").map((c) => c.name ?? "") ?? [],
    measures: (t) => allTables(p).find((x) => x.name?.toLowerCase() === t.toLowerCase())?.children.filter((c) => c.kind === "measure").map((c) => c.name ?? "") ?? [],
    columnType: (t, c) => {
      const n = child(p, t, c);
      return n && n.kind === "column" ? textProp(n, "dataType") : null;
    },
    sortByColumn: (t, c) => {
      const n = child(p, t, c);
      const s = n && n.kind === "column" ? textProp(n, "sortByColumn") : null;
      return s ? s.replace(/^'(.*)'$/, "$1") : null;
    },
    formatString: (t, n) => {
      const node = child(p, t, n);
      return node ? textProp(node, "formatString") : null;
    },
    fieldParameter: (t, c) => listFieldParameters(p).find((fp) => fp.table.toLowerCase() === t.toLowerCase() && fp.column.toLowerCase() === c.toLowerCase()) ?? null,
  };
}

/** True when the field's values are dates. */
export function isDateField(m: ModelInfo, f: FieldRef): boolean {
  return f.kind === "column" && m.columnType(f.table, f.name) === "dateTime";
}

export function isNumericColumn(m: ModelInfo, f: FieldRef): boolean {
  const t = f.kind === "column" ? m.columnType(f.table, f.name) : null;
  return t === "int64" || t === "double" || t === "decimal";
}

/** Format string that applies to a field's displayed values (measures and columns; sums keep the column's). */
export function fieldFormat(m: ModelInfo, f: FieldRef): string | null {
  if (f.kind === "measure") return m.formatString(f.table, f.name);
  if (f.kind === "agg") return f.fn === 2 || f.fn === 5 ? "0" : m.formatString(f.table, f.name);
  return m.formatString(f.table, f.name);
}
