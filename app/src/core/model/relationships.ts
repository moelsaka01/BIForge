// Relationship edits and views. TMDL: `relationship <id>` with fromColumn/toColumn, optional
// fromCardinality/toCardinality (default many -> one), crossFilteringBehavior (default oneDirection), isActive (default true).
import type { Project, TmdlNode } from "./types";
import { ModelError, allTables, parseColumnRef, textProp } from "./ops";

const REL_FILE = "relationships.tmdl";

export type EndCardinality = "one" | "many";
export type CrossFilter = "single" | "both";

export interface Relationship {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  fromCardinality: EndCardinality;
  toCardinality: EndCardinality;
  crossFilter: CrossFilter;
  isActive: boolean;
  /** "Apply security filter in both directions": a row-level security filter on the many side also hides the one side rows it leaves without a visible row. It applies only together with the cross-filter direction Both (BIForge keeps the setting when the direction changes). */
  securityBoth: boolean;
  /** "Assume referential integrity": kept for Power BI Desktop (it uses it for DirectQuery sources only); it does not change a result in BIForge. */
  assumeRI: boolean;
}

export interface NewRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  fromCardinality?: EndCardinality;
  toCardinality?: EndCardinality;
  crossFilter?: CrossFilter;
  isActive?: boolean;
  securityBoth?: boolean;
  assumeRI?: boolean;
}

export function quoteIdent(s: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

const ref = (t: string, c: string) => `${quoteIdent(t)}.${quoteIdent(c)}`;

function relNodes(p: Project): TmdlNode[] {
  return Object.values(p.model.tmdl).flatMap((d) => d.nodes.filter((n) => n.kind === "relationship"));
}

function toView(n: TmdlNode): Relationship | null {
  const f = parseColumnRef(textProp(n, "fromColumn") ?? "");
  const t = parseColumnRef(textProp(n, "toColumn") ?? "");
  if (!f || !t) return null;
  const card = (v: string | null, d: EndCardinality): EndCardinality => (v === "one" || v === "many" ? v : d);
  return {
    id: n.name ?? "",
    fromTable: f.table,
    fromColumn: f.column,
    toTable: t.table,
    toColumn: t.column,
    fromCardinality: card(textProp(n, "fromCardinality"), "many"),
    toCardinality: card(textProp(n, "toCardinality"), "one"),
    crossFilter: textProp(n, "crossFilteringBehavior") === "bothDirections" ? "both" : "single",
    isActive: textProp(n, "isActive") !== "false",
    securityBoth: textProp(n, "securityFilteringBehavior") === "bothDirections",
    assumeRI: n.props.some((x) => x.key === "relyOnReferentialIntegrity" && (x.value === "Flag" || (typeof x.value === "object" && "Text" in x.value && x.value.Text === "true"))),
  };
}

export function listRelationships(p: Project): Relationship[] {
  return relNodes(p).flatMap((n) => {
    const v = toView(n);
    return v ? [v] : [];
  });
}

function setProp(n: TmdlNode, key: string, value: string | null): void {
  n.props = n.props.filter((x) => x.key !== key);
  if (value !== null) n.props.push({ key, value: { Text: value } });
}

/** Writes the relationship's properties in canonical order, omitting defaults. */
function writeProps(n: TmdlNode, r: Relationship): void {
  n.props = [];
  setProp(n, "fromCardinality", r.fromCardinality === "many" ? null : r.fromCardinality);
  setProp(n, "toCardinality", r.toCardinality === "one" ? null : r.toCardinality);
  setProp(n, "crossFilteringBehavior", r.crossFilter === "both" ? "bothDirections" : null);
  setProp(n, "isActive", r.isActive ? null : "false");
  if (r.assumeRI) n.props.push({ key: "relyOnReferentialIntegrity", value: "Flag" });
  setProp(n, "securityFilteringBehavior", r.securityBoth ? "bothDirections" : null);
  setProp(n, "fromColumn", ref(r.fromTable, r.fromColumn));
  setProp(n, "toColumn", ref(r.toTable, r.toColumn));
}

function columnExists(p: Project, table: string, column: string): { table: string; column: string } {
  const t = allTables(p).find((x) => x.name?.toLowerCase() === table.toLowerCase());
  if (!t) throw new ModelError("not-found", `Table "${table}" does not exist.`);
  const c = t.children.find((x) => x.kind === "column" && x.name?.toLowerCase() === column.toLowerCase());
  if (!c) throw new ModelError("not-found", `Column "${column}" does not exist in table "${t.name}".`);
  return { table: t.name!, column: c.name! };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** True if activating an edge between the two tables would give the model two paths between some pair of tables. */
function wouldBeAmbiguous(active: Relationship[], a: string, b: string): boolean {
  const adj = new Map<string, string[]>();
  for (const r of active) {
    const x = r.fromTable.toLowerCase();
    const y = r.toTable.toLowerCase();
    adj.set(x, [...(adj.get(x) ?? []), y]);
    adj.set(y, [...(adj.get(y) ?? []), x]);
  }
  const target = b.toLowerCase();
  const seen = new Set<string>([a.toLowerCase()]);
  const stack = [a.toLowerCase()];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    for (const nx of adj.get(cur) ?? []) {
      if (!seen.has(nx)) {
        seen.add(nx);
        stack.push(nx);
      }
    }
  }
  return false;
}

function normalize(r: Relationship): void {
  if (r.fromCardinality === "one" && r.toCardinality === "one") r.crossFilter = "both"; // one-to-one is always bidirectional
}

export interface AddResult {
  id: string;
  /** The relationship was created inactive because an active one already connects these tables (directly or indirectly). */
  createdInactive: boolean;
}

export function addRelationship(p: Project, spec: NewRelationship, newId: () => string = () => crypto.randomUUID()): AddResult {
  const from = columnExists(p, spec.fromTable, spec.fromColumn);
  const to = columnExists(p, spec.toTable, spec.toColumn);
  if (same(from.table, to.table)) {
    throw new ModelError("invalid-name", "A relationship must connect two different tables.");
  }
  const existing = listRelationships(p);
  const dup = existing.find(
    (r) =>
      (same(r.fromTable, from.table) && same(r.fromColumn, from.column) && same(r.toTable, to.table) && same(r.toColumn, to.column)) ||
      (same(r.fromTable, to.table) && same(r.fromColumn, to.column) && same(r.toTable, from.table) && same(r.toColumn, from.column)),
  );
  if (dup) throw new ModelError("duplicate-name", "A relationship between these two columns already exists.");

  const rel: Relationship = {
    id: newId(),
    fromTable: from.table,
    fromColumn: from.column,
    toTable: to.table,
    toColumn: to.column,
    fromCardinality: spec.fromCardinality ?? "many",
    toCardinality: spec.toCardinality ?? "one",
    crossFilter: spec.crossFilter ?? "single",
    isActive: spec.isActive ?? true,
    securityBoth: spec.securityBoth ?? false,
    assumeRI: spec.assumeRI ?? false,
  };
  let createdInactive = false;
  if (rel.isActive && wouldBeAmbiguous(existing.filter((r) => r.isActive), from.table, to.table)) {
    rel.isActive = false;
    createdInactive = true;
  }
  normalize(rel);
  const node: TmdlNode = { description: [], kind: "relationship", name: rel.id, default: null, props: [], children: [] };
  writeProps(node, rel);
  const doc = (p.model.tmdl[REL_FILE] ??= { nodes: [] });
  doc.nodes.push(node);
  return { id: rel.id, createdInactive };
}

export type RelationshipPatch = Partial<Pick<Relationship, "fromCardinality" | "toCardinality" | "crossFilter" | "isActive" | "securityBoth" | "assumeRI">>;

export function updateRelationship(p: Project, id: string, patch: RelationshipPatch): void {
  const n = relNodes(p).find((x) => x.name === id);
  const cur = n ? toView(n) : null;
  if (!n || !cur) throw new ModelError("not-found", "That relationship does not exist.");
  const next: Relationship = { ...cur, ...patch };
  if (patch.isActive === true && !cur.isActive) {
    const others = listRelationships(p).filter((r) => r.isActive && r.id !== id);
    if (wouldBeAmbiguous(others, cur.fromTable, cur.toTable)) {
      throw new ModelError(
        "duplicate-name",
        `Cannot make this relationship active: ${cur.fromTable} and ${cur.toTable} are already connected by another active path. Deactivate that one first.`,
      );
    }
  }
  if (next.fromCardinality === "one" && next.toCardinality === "one") next.crossFilter = "both";
  else if (patch.crossFilter === undefined && cur.fromCardinality === "one" && cur.toCardinality === "one") next.crossFilter = "single";
  writeProps(n, next);
}

export function deleteRelationship(p: Project, id: string): void {
  let found = false;
  for (const [k, d] of Object.entries(p.model.tmdl)) {
    const before = d.nodes.length;
    d.nodes = d.nodes.filter((n) => !(n.kind === "relationship" && n.name === id));
    if (d.nodes.length !== before) found = true;
    if (k.endsWith(REL_FILE) && d.nodes.length === 0) delete p.model.tmdl[k];
  }
  if (!found) throw new ModelError("not-found", "That relationship does not exist.");
}

/** Removes relationships that use any of the given columns of `table`; returns their ids. */
export function removeRelationshipsOnColumns(p: Project, table: string, columns: string[]): string[] {
  if (columns.length === 0) return [];
  const cols = new Set(columns.map((c) => c.toLowerCase()));
  const hit = listRelationships(p).filter(
    (r) =>
      (same(r.fromTable, table) && cols.has(r.fromColumn.toLowerCase())) || (same(r.toTable, table) && cols.has(r.toColumn.toLowerCase())),
  );
  for (const r of hit) deleteRelationship(p, r.id);
  return hit.map((r) => r.id);
}
