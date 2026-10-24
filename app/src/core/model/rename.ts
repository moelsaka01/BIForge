// Renaming a table, a column or a measure: the object itself and every place that refers to it, in one edit of the project
// (so one undo step): DAX in measures, calculated columns and tables, calculation items and security filters; relationships,
// hierarchies, sort-by columns; the M of other queries; and the fields, filters, sorts and bookmarks of the report.
// Pure edits on a Project draft; the data store is renamed by the session (see Session.renameObject).
import { renameInDax, type RenameOp } from "../dax/rename";
import type { Expr, Project, TmdlNode } from "./types";
import { ModelError, allTables, checkName, findTable, parseColumnRef, requireTable, sanitizeFileName, textProp } from "./ops";
import { quoteIdent } from "./relationships";

export type RenameTarget =
  | { kind: "table"; table: string }
  | { kind: "column"; table: string; name: string }
  | { kind: "measure"; table: string; name: string };

export interface RenameReport {
  /** Number of expressions (DAX) that were rewritten. */
  expressions: number;
  /** Number of places in the report (fields, filters, sorts, bookmarks) that were rewritten. */
  reportReferences: number;
  /** The queries (M) that used the table; the caller rewrites them first. */
  queries: string[];
}

const AUTO_DATE = "BIForge.AutoDate";

// ---- DAX in the model ----

interface Slot {
  get(): string;
  set(t: string): void;
  host: string | null;
}

const isMPartition = (n: TmdlNode) => n.kind === "partition" && n.default?.text.trim().toLowerCase() === "m";

/** Every DAX text of the model with the table it belongs to (the home of unqualified column references). */
function daxSlots(p: Project): Slot[] {
  const slots: Slot[] = [];
  const exprSlot = (e: Expr, host: string | null) => slots.push({ get: () => e.text, set: (t) => void (e.text = t), host });
  const visit = (n: TmdlNode, host: string | null) => {
    if (n.kind === "annotation" || n.kind.startsWith("ref") || n.kind === "expression") return;
    const m = isMPartition(n);
    if (n.default && n.kind !== "partition") exprSlot(n.default, n.kind === "tablePermission" ? (n.name ?? host) : host);
    for (const pr of n.props) if (!m && typeof pr.value === "object" && "Expr" in pr.value) exprSlot(pr.value.Expr, host);
    for (const c of n.children) visit(c, n.kind === "table" ? n.name : host);
  };
  for (const d of Object.values(p.model.tmdl)) for (const n of d.nodes) visit(n, n.kind === "table" ? n.name : null);
  return slots;
}

function measureNames(p: Project): Set<string> {
  return new Set(allTables(p).flatMap((t) => t.children.filter((c) => c.kind === "measure" && c.name).map((c) => c.name!.toLowerCase())));
}

function rewriteDax(p: Project, op: RenameOp): number {
  const measures = measureNames(p);
  let n = 0;
  for (const s of daxSlots(p)) {
    const before = s.get();
    const after = renameInDax(before, op, { host: s.host, measures });
    if (after !== before) {
      s.set(after);
      n++;
    }
  }
  return n;
}

// ---- the report ----

type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** `Table.Name` or `Sum(Table.Name)` of a queryRef, changed when it names the renamed object. */
function renameQueryRef(s: string, op: RenameOp): string {
  const m = /^(\w+\()?(.*?)(\))?$/s.exec(s);
  if (!m) return s;
  const [, open = "", inner, close = ""] = m;
  if (op.kind === "table") return inner.toLowerCase().startsWith(op.from.toLowerCase() + ".") ? `${open}${op.to}${inner.slice(op.from.length)}${close}` : s;
  return inner.toLowerCase() === `${op.table}.${op.from}`.toLowerCase() ? `${open}${inner.slice(0, op.table.length + 1)}${op.to}${close}` : s;
}

function renameInJson(root: J, op: RenameOp): number {
  let count = 0;
  const entityOf = (ref: J, aliases: Record<string, string>): string | null => {
    const sr = ref?.SourceRef;
    if (!sr) return null;
    if (typeof sr.Entity === "string") return sr.Entity;
    if (typeof sr.Source === "string") return aliases[sr.Source] ?? sr.Source;
    return null;
  };
  const visit = (v: J, aliases: Record<string, string>): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x, aliases);
      return;
    }
    if (!v || typeof v !== "object") return;
    let scope = aliases;
    if (Array.isArray(v.From)) {
      scope = { ...aliases };
      for (const f of v.From) if (typeof f?.Name === "string" && typeof f?.Entity === "string") scope[f.Name] = f.Entity;
    }
    // the in-memory shape of a field (bookmarks and relative-date filters keep it in annotations)
    if ((v.kind === "column" || v.kind === "measure" || v.kind === "agg") && typeof v.table === "string" && typeof v.name === "string") {
      if (op.kind === "table" && same(v.table, op.from)) {
        v.table = op.to;
        count++;
      } else if (op.kind !== "table" && same(v.table, op.table) && same(v.name, op.from) && (op.kind === "measure") === (v.kind === "measure")) {
        v.name = op.to;
        count++;
      }
    }
    if (typeof v.Entity === "string" && op.kind === "table" && same(v.Entity, op.from)) {
      v.Entity = op.to;
      count++;
    }
    for (const k of ["Column", "Measure"] as const) {
      const f = v[k];
      if (op.kind !== "table" && f && typeof f.Property === "string" && same(f.Property, op.from) && (op.kind === "measure") === (k === "Measure")) {
        const t = entityOf(f.Expression, scope);
        if (t !== null && same(t, op.table)) {
          f.Property = op.to;
          count++;
        }
      }
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === "queryRef" || k === "metadata") {
        if (typeof x === "string") {
          const r = renameQueryRef(x, op);
          if (r !== x) {
            v[k] = r;
            count++;
            // the label shown when no display name is set follows the field
            if (k === "queryRef" && op.kind !== "table" && v.nativeQueryRef === op.from) v.nativeQueryRef = op.to;
            if (k === "queryRef" && op.kind !== "table" && typeof v.nativeQueryRef === "string" && new RegExp(` of ${op.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(distinct\\))?$`).test(v.nativeQueryRef)) {
              v.nativeQueryRef = v.nativeQueryRef.replace(new RegExp(` of ${op.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), ` of ${op.to}`);
            }
          }
        }
      } else if (k === "annotations" && Array.isArray(x)) {
        for (const a of x) {
          if (typeof a?.value !== "string" || !/^[{[]/.test(a.value)) continue;
          try {
            const inner = JSON.parse(a.value);
            const c = renameInJson(inner, op);
            if (c > 0) {
              a.value = JSON.stringify(inner);
              count += c;
            }
          } catch {
            /* not JSON: leave the annotation alone */
          }
        }
      } else visit(x, scope);
    }
  };
  visit(root, {});
  return count;
}

function rewriteReport(p: Project, op: RenameOp): number {
  let n = 0;
  for (const f of Object.values(p.report.files as Record<string, J>)) n += renameInJson(f, op);
  return n;
}

// ---- structure ----

const relNodes = (p: Project) => Object.values(p.model.tmdl).flatMap((d) => d.nodes.filter((n) => n.kind === "relationship"));

function setText(n: TmdlNode, key: string, value: string): void {
  const pr = n.props.find((x) => x.key === key);
  if (pr) pr.value = { Text: value };
}

function nameTaken(p: Project, name: string, except: string): boolean {
  const l = name.toLowerCase();
  if (allTables(p).some((t) => t.name && t.name.toLowerCase() === l && t.name.toLowerCase() !== except.toLowerCase())) return true;
  return Object.values(p.model.tmdl).some((d) => d.nodes.some((n) => n.kind === "expression" && n.name?.toLowerCase() === l));
}

function uniqueKey(p: Project, name: string): string {
  const taken = new Set(Object.keys(p.model.tmdl).map((k) => k.toLowerCase()));
  const base = sanitizeFileName(name);
  let key = `tables/${base}.tmdl`;
  for (let i = 2; taken.has(key.toLowerCase()); i++) key = `tables/${base} (${i}).tmdl`;
  return key;
}

/** Table names the queries (M) of the project use for it: a rename must also rewrite those. */
export function renameTable(p: Project, from: string, rawTo: string, queryUsers: string[] = []): RenameReport {
  const to = checkName(rawTo, "Table");
  const { key, node } = requireTable(p, from);
  const old = node.name!;
  if (to === old) return { expressions: 0, reportReferences: 0, queries: [] };
  if (nameTaken(p, to, old)) throw new ModelError("duplicate-name", `A table or query named "${to}" already exists.`);
  const op: RenameOp = { kind: "table", from: old, to };
  const expressions = rewriteDax(p, op);
  const reportReferences = rewriteReport(p, op);
  node.name = to;
  for (const c of node.children) if (c.kind === "partition" && c.name?.toLowerCase() === old.toLowerCase()) c.name = to;
  // the file of the table follows its name
  const doc = p.model.tmdl[key];
  delete p.model.tmdl[key];
  p.model.tmdl[uniqueKey(p, to)] = doc;
  for (const d of Object.values(p.model.tmdl)) {
    for (const n of d.nodes) {
      if (n.kind === "ref table" && n.name?.toLowerCase() === old.toLowerCase()) n.name = to;
      if (n.kind === "role") for (const tp of n.children) if (tp.kind === "tablePermission" && tp.name?.toLowerCase() === old.toLowerCase()) tp.name = to;
    }
  }
  for (const r of relNodes(p)) {
    for (const k of ["fromColumn", "toColumn"]) {
      const ref = parseColumnRef(textProp(r, k) ?? "");
      if (ref && same(ref.table, old)) setText(r, k, `${quoteIdent(to)}.${quoteIdent(ref.column)}`);
    }
  }
  retargetAutoDate(p, (t, c) => (same(t, old) ? [to, c] : null));
  return { expressions, reportReferences, queries: queryUsers };
}

function retargetAutoDate(p: Project, map: (table: string, column: string) => [string, string] | null): void {
  for (const t of allTables(p)) {
    for (const a of t.children) {
      if (a.kind !== "annotation" || a.name !== AUTO_DATE || !a.default) continue;
      const dot = a.default.text.indexOf(".");
      if (dot < 0) continue;
      const m = map(a.default.text.slice(0, dot), a.default.text.slice(dot + 1));
      if (m) a.default = { text: `${m[0]}.${m[1]}`, verbatim: false };
    }
  }
}

function columnOf(p: Project, table: string, name: string): { table: TmdlNode; column: TmdlNode } {
  const t = requireTable(p, table).node;
  const c = t.children.find((x) => x.kind === "column" && x.name?.toLowerCase() === name.toLowerCase());
  if (!c) throw new ModelError("not-found", `Column "${table}[${name}]" does not exist.`);
  return { table: t, column: c };
}

/** Renames a column. An imported column keeps its source name in `sourceColumn`, so a refresh still finds it. */
export function renameColumn(p: Project, table: string, from: string, rawTo: string): RenameReport {
  const to = checkName(rawTo, "Column");
  const { table: t, column: c } = columnOf(p, table, from);
  const old = c.name!;
  if (to === old) return { expressions: 0, reportReferences: 0, queries: [] };
  if (t.children.some((x) => (x.kind === "column" || x.kind === "measure" || x.kind === "hierarchy") && x.name?.toLowerCase() === to.toLowerCase() && x !== c)) {
    throw new ModelError("duplicate-name", `Table "${t.name}" already has a column, measure or hierarchy named "${to}".`);
  }
  const op: RenameOp = { kind: "column", table: t.name!, from: old, to };
  const expressions = rewriteDax(p, op);
  const reportReferences = rewriteReport(p, op);
  if (!c.default && !c.props.some((x) => x.key === "sourceColumn")) c.props.push({ key: "sourceColumn", value: { Text: old } });
  c.name = to;
  for (const x of t.children) {
    if (x.kind === "column" && same(textProp(x, "sortByColumn"), old)) setText(x, "sortByColumn", to);
    if (x.kind === "hierarchy") for (const l of x.children) if (l.kind === "level" && same(textProp(l, "column"), old)) setText(l, "column", to);
  }
  for (const r of relNodes(p)) {
    for (const k of ["fromColumn", "toColumn"]) {
      const ref = parseColumnRef(textProp(r, k) ?? "");
      if (ref && same(ref.table, t.name!) && same(ref.column, old)) setText(r, k, `${quoteIdent(ref.table)}.${quoteIdent(to)}`);
    }
  }
  retargetAutoDate(p, (tn, cn) => (same(tn, t.name!) && same(cn, old) ? [tn, to] : null));
  return { expressions, reportReferences, queries: [] };
}

export function renameMeasure(p: Project, name: string, rawTo: string): RenameReport {
  const to = checkName(rawTo, "Measure");
  let found: { table: TmdlNode; m: TmdlNode } | undefined;
  for (const t of allTables(p)) {
    const m = t.children.find((c) => c.kind === "measure" && c.name?.toLowerCase() === name.toLowerCase());
    if (m) found = { table: t, m };
  }
  if (!found) throw new ModelError("not-found", `Measure "${name}" does not exist.`);
  const old = found.m.name!;
  if (to === old) return { expressions: 0, reportReferences: 0, queries: [] };
  for (const t of allTables(p)) {
    if (t.children.some((c) => (c.kind === "measure" && c !== found!.m && c.name?.toLowerCase() === to.toLowerCase()) || (t === found!.table && c.kind === "column" && c.name?.toLowerCase() === to.toLowerCase()))) {
      throw new ModelError("duplicate-name", `A measure or column named "${to}" already exists.`);
    }
  }
  const op: RenameOp = { kind: "measure", table: found.table.name!, from: old, to };
  const expressions = rewriteDax(p, op);
  const reportReferences = rewriteReport(p, op);
  found.m.name = to;
  return { expressions, reportReferences, queries: [] };
}

/** Dispatches on the kind of object. */
export function renameObject(p: Project, target: RenameTarget, to: string, queryUsers: string[] = []): RenameReport {
  if (target.kind === "table") return renameTable(p, target.table, to, queryUsers);
  if (target.kind === "column") return renameColumn(p, target.table, target.name, to);
  return renameMeasure(p, target.name, to);
}

/** For a table that exists: the stored source name of each renamed imported column (model name to source name). */
export function sourceNames(p: Project, table: string): Map<string, string> {
  const out = new Map<string, string>();
  const t = findTable(p, table)?.node;
  for (const c of t?.children ?? []) {
    if (c.kind !== "column" || !c.name || c.default) continue;
    const s = textProp(c, "sourceColumn");
    if (s && s !== c.name) out.set(c.name, s);
  }
  return out;
}
