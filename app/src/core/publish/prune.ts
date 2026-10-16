// What leaves the machine when a report is published: the chosen tables and columns, and the model without
// anything else. Pure functions over the project document; the Rust side exports the data snapshot of exactly the
// same selection.
import { allTables, deleteTable, parseColumnRef, textProp } from "../model/ops";
import type { Project, TmdlNode } from "../model/types";
import type { IncludedTable } from "./types";

const lc = (s: string) => s.toLowerCase();

/** Tables and columns that have data in the engine's store (`dataColumns`: table -> column names). */
export function everythingLoaded(dataColumns: Record<string, string[]>): IncludedTable[] {
  return Object.entries(dataColumns)
    .map(([table, columns]) => ({ table, columns: [...columns] }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** Same set regardless of order, for comparing what was shown with what is published. */
export function sameSelection(a: IncludedTable[], b: IncludedTable[]): boolean {
  const norm = (x: IncludedTable[]) => JSON.stringify([...x].map((t) => [t.table, [...t.columns].sort()]).sort((p, q) => String(p[0]).localeCompare(String(q[0]))));
  return norm(a) === norm(b);
}

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mentions(expr: string, table: string, column: string): boolean {
  const t = esc(table);
  const c = esc(column);
  return new RegExp(`('${t.replace(/'/g, "''")}'|\\b${t})\\s*\\[${c}\\]`, "i").test(expr) || new RegExp(`(^|[^\\w'\\]])\\[${c}\\]`, "i").test(expr);
}

function fieldRefs(node: unknown, out: { entity: string; property: string }[]): void {
  if (Array.isArray(node)) return node.forEach((n) => fieldRefs(n, out));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const entity = ((o.Expression as Record<string, unknown> | undefined)?.SourceRef as Record<string, unknown> | undefined)?.Entity;
    if (typeof entity === "string" && typeof o.Property === "string") out.push({ entity, property: o.Property });
    for (const v of Object.values(o)) fieldRefs(v, out);
  }
}

export interface Pruned {
  project: Project;
  /** Things that will not work in the published copy, in plain words. */
  warnings: string[];
}

/**
 * The model that goes into the package: only the selected tables and columns, no data source definitions
 * (partitions and named queries would carry local file paths and connection details; the data travels as the
 * snapshot instead), relationships between kept columns only.
 */
export function pruneForPublishing(project: Project, selection: IncludedTable[]): Pruned {
  const p = structuredClone(project);
  const warnings: string[] = [];
  const keepCols = new Map(selection.map((s) => [lc(s.table), new Set(s.columns.map(lc))]));
  const removedTables: string[] = [];
  const removedCols: { table: string; column: string }[] = [];

  for (const t of allTables(p)) {
    const name = t.name ?? "";
    if (!keepCols.has(lc(name))) {
      removedTables.push(name);
      if (t.children.some((c) => c.kind === "measure")) warnings.push(`Table "${name}" has measures; they are not published because the table is not.`);
    }
  }
  for (const n of removedTables) deleteTable(p, n);

  for (const t of allTables(p)) {
    const keep = keepCols.get(lc(t.name ?? ""))!;
    t.children = t.children.filter((c) => {
      if (c.kind === "partition") return false;
      if (c.kind !== "column") return true;
      const calculated = c.props.some((x) => x.key === "expression") || c.default !== null;
      if (!keep.has(lc(c.name ?? "")) && !calculated) {
        removedCols.push({ table: t.name ?? "", column: c.name ?? "" });
        return false;
      }
      return true;
    });
  }

  // relationships that use a removed column
  const refs = (n: TmdlNode) => ["fromColumn", "toColumn"].map((k) => (textProp(n, k) ? parseColumnRef(textProp(n, k)!) : null));
  for (const d of Object.values(p.model.tmdl)) {
    d.nodes = d.nodes.filter((n) => {
      if (n.kind === "expression") return false;
      if (n.kind !== "relationship") return true;
      return refs(n).every((r) => !r || !removedCols.some((c) => lc(c.table) === lc(r.table) && lc(c.column) === lc(r.column)));
    });
  }

  // measures and calculated columns that use something that is gone
  for (const t of allTables(p)) {
    for (const c of t.children) {
      const text = c.default?.text ?? (c.props.find((x) => x.key === "expression")?.value as { Expr?: { text: string } } | undefined)?.Expr?.text;
      if (!text || (c.kind !== "measure" && c.kind !== "column")) continue;
      for (const r of removedCols) if (mentions(text, r.table, r.column)) warnings.push(`${c.kind === "measure" ? "Measure" : "Calculated column"} "${c.name}" uses the column ${r.table}[${r.column}], which is not published; it will show an error.`);
      for (const rt of removedTables) if (new RegExp(`'${esc(rt).replace(/'/g, "''")}'|\\b${esc(rt)}\\b`, "i").test(text)) warnings.push(`${c.kind === "measure" ? "Measure" : "Calculated column"} "${c.name}" uses the table "${rt}", which is not published; it will show an error.`);
    }
  }

  // visuals that show something that is gone
  const seen = new Set<string>();
  for (const [file, doc] of Object.entries(p.report.files)) {
    const found: { entity: string; property: string }[] = [];
    fieldRefs(doc, found);
    for (const f of found) {
      const gone = removedTables.some((t) => lc(t) === lc(f.entity)) || removedCols.some((c) => lc(c.table) === lc(f.entity) && lc(c.column) === lc(f.property));
      const key = `${f.entity}[${f.property}]`;
      if (gone && !seen.has(file + key)) {
        seen.add(file + key);
        warnings.push(`A visual (${file.split("/").slice(-2).join("/")}) uses ${key}, which is not published; it will be empty.`);
      }
    }
  }
  return { project: p, warnings: [...new Set(warnings)] };
}
