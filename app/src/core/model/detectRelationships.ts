// Autodetect relationships: columns that carry the same key in two tables. A pair is a candidate when both columns have the
// same name (ignoring case) and the same data type, the name looks like a key (Key, ID, Code, Number), and no relationship
// joins them yet. Which side is the "one" side is decided by the data when it is loaded (the command asks the engine),
// otherwise by the names: the table named like the column (Customer for CustomerKey) is the one side. Pure.
import type { Project } from "./types";
import { allTables, textProp } from "./ops";
import { listRelationships } from "./relationships";

export interface ColumnRef {
  table: string;
  column: string;
}
export interface RelationshipCandidate {
  a: ColumnRef;
  b: ColumnRef;
  /** By the names: which side is probably the "one" side ("a", "b"), or null when the names do not say. */
  oneSide: "a" | "b" | null;
}

const KEY_LIKE = /(key|id|code|number|no)$/i;

export function candidatePairs(p: Project): RelationshipCandidate[] {
  const tables = allTables(p).filter((t) => t.name);
  const existing = listRelationships(p);
  const related = (x: ColumnRef, y: ColumnRef) =>
    existing.some((r) => (eq(r.fromTable, x.table) && eq(r.fromColumn, x.column) && eq(r.toTable, y.table) && eq(r.toColumn, y.column)) || (eq(r.fromTable, y.table) && eq(r.fromColumn, y.column) && eq(r.toTable, x.table) && eq(r.toColumn, x.column)));
  const out: RelationshipCandidate[] = [];
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      for (const ca of tables[i].children.filter((c) => c.kind === "column" && c.name)) {
        if (!KEY_LIKE.test(ca.name!)) continue;
        const cb = tables[j].children.find((c) => c.kind === "column" && c.name && eq(c.name, ca.name!) && (textProp(c, "dataType") ?? "") === (textProp(ca, "dataType") ?? ""));
        if (!cb) continue;
        const a = { table: tables[i].name!, column: ca.name! };
        const b = { table: tables[j].name!, column: cb.name! };
        if (related(a, b)) continue;
        out.push({ a, b, oneSide: oneSideByName(a, b) });
      }
    }
  }
  return out;
}

const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

/** The table whose name starts the column name (Customer, CustomerKey) is the one side. */
function oneSideByName(a: ColumnRef, b: ColumnRef): "a" | "b" | null {
  const starts = (r: ColumnRef) => r.column.toLowerCase().startsWith(r.table.toLowerCase());
  if (starts(a) && !starts(b)) return "a";
  if (starts(b) && !starts(a)) return "b";
  return null;
}
