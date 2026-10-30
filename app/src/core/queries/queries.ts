// Queries of a project: loaded queries are tables with an M partition, the others are named expressions.
// Pure edits on a Project draft (they run inside DocumentStore.transact).
import type { Expr, Project, TmdlNode } from "../model/types";
import type { TableInfo } from "../data/types";
import { addTable, findTable } from "../model/ops";
import { columnNode, node, sourceKey, text } from "../model/tables";
import { removeRelationshipsOnColumns } from "../model/relationships";

const GENERATED = "BIForge.GeneratedM";
const SOURCE_ANNOTATION = "BIForge.Source";
const EXPRESSIONS_FILE = "expressions.tmdl";

export interface ProjectQuery {
  name: string;
  text: string;
  /** true: the result is a table of the model. */
  loaded: boolean;
  /** true: BIForge wrote the M from an import source and the user has not edited it. */
  generated: boolean;
  /** The query group (folder) of the query. */
  group: string | null;
  /** Free text of the Query properties dialog (the description of the table or expression). */
  description: string;
  /** Include in report refresh: Refresh all reloads the query (default true). */
  refresh: boolean;
}

const NO_REFRESH = "BIForge.ExcludedFromRefresh";

const descriptionOf = (n: TmdlNode): string => n.description.join("\n");
const refreshOf = (n: TmdlNode): boolean => !n.children.some((a) => a.kind === "annotation" && a.name === NO_REFRESH);

const GROUP_PROP = "queryGroup";

function groupOf(n: TmdlNode): string | null {
  const p = n.props.find((x) => x.key === GROUP_PROP);
  return p && typeof p.value === "object" && "Text" in p.value ? p.value.Text : null;
}

function isMPartition(c: TmdlNode): boolean {
  return c.kind === "partition" && c.default?.text.trim().toLowerCase() === "m";
}

function sourceOf(part: TmdlNode): string | null {
  const p = part.props.find((x) => x.key === "source");
  return p && typeof p.value === "object" && "Expr" in p.value ? p.value.Expr.text : null;
}

function isGenerated(part: TmdlNode): boolean {
  return part.children.some((a) => a.kind === "annotation" && a.name === GENERATED);
}

function allNodes(p: Project): TmdlNode[] {
  return Object.values(p.model.tmdl).flatMap((d) => d.nodes);
}

export function listQueries(p: Project): ProjectQuery[] {
  const out: ProjectQuery[] = [];
  for (const n of allNodes(p)) {
    if (n.kind === "table" && n.name) {
      const part = n.children.find(isMPartition);
      const src = part ? sourceOf(part) : null;
      if (part && src !== null) out.push({ name: n.name, text: src, loaded: true, generated: isGenerated(part), group: groupOf(n), description: descriptionOf(n), refresh: refreshOf(n) });
    } else if (n.kind === "expression" && n.name && n.default) {
      out.push({ name: n.name, text: n.default.text, loaded: false, generated: false, group: groupOf(n), description: descriptionOf(n), refresh: refreshOf(n) });
    }
  }
  return out;
}

/** Writes the description and the refresh flag of queries (a query missing from `assign` keeps its own). */
export function applyQueryProperties(p: Project, assign: Record<string, { description: string; refresh: boolean }>): void {
  for (const n of allNodes(p)) {
    if (!n.name || !(n.name in assign) || (n.kind !== "table" && n.kind !== "expression")) continue;
    const a = assign[n.name];
    n.description = a.description.trim() === "" ? [] : a.description.split(/\r?\n/);
    n.children = n.children.filter((c) => !(c.kind === "annotation" && c.name === NO_REFRESH));
    if (!a.refresh) {
      const ann = node("annotation", NO_REFRESH);
      ann.default = { text: "true", verbatim: false };
      n.children.push(ann);
    }
  }
}

/** The tables whose queries are left out of Refresh all (Query properties > Include in report refresh off). */
export function excludedFromRefresh(p: Project): Set<string> {
  return new Set(listQueries(p).filter((q) => !q.refresh).map((q) => q.name));
}

/** The query groups of the model, in order (the `queryGroup` objects of model.tmdl). */
export function listGroups(p: Project): string[] {
  const model = p.model.tmdl["model.tmdl"]?.nodes.find((n) => n.kind === "model");
  return (model?.children ?? []).filter((c) => c.kind === "queryGroup" && c.name).map((c) => c.name!);
}

/** Writes the query groups and which query is in which group (a query missing from `assign` keeps its group). */
export function applyGroups(p: Project, groups: string[], assign: Record<string, string | null>): void {
  for (const n of allNodes(p)) {
    if (!n.name || !(n.name in assign) || (n.kind !== "table" && n.kind !== "expression")) continue;
    n.props = n.props.filter((x) => x.key !== GROUP_PROP);
    const g = assign[n.name];
    if (g) n.props.push(text(GROUP_PROP, g));
  }
  const model = p.model.tmdl["model.tmdl"]?.nodes.find((n) => n.kind === "model");
  if (!model) return;
  const old = new Map(model.children.filter((c) => c.kind === "queryGroup").map((c) => [c.name, c]));
  model.children = model.children.filter((c) => c.kind !== "queryGroup");
  const fresh = groups.map((g, i) => {
    const n = old.get(g) ?? node("queryGroup", g);
    n.children = n.children.filter((a) => !(a.kind === "annotation" && a.name === "PBI_QueryGroupOrder"));
    const ann = node("annotation", "PBI_QueryGroupOrder");
    ann.default = { text: String(i), verbatim: false };
    n.children.push(ann);
    return n;
  });
  // the groups come before the first annotation or ref of the model
  const at = model.children.findIndex((c) => c.kind === "annotation" || c.kind.startsWith("ref"));
  model.children.splice(at === -1 ? model.children.length : at, 0, ...fresh);
}

export function queryTexts(p: Project): Record<string, string> {
  return Object.fromEntries(listQueries(p).map((q) => [q.name, q.text]));
}

/** Loaded tables whose M the user wrote or edited: they refresh by running that M. */
export function userMTables(p: Project): string[] {
  return listQueries(p)
    .filter((q) => q.loaded && !q.generated)
    .map((q) => q.name);
}

const exprOf = (t: string): Expr => ({ text: t.replace(/\r\n/g, "\n").replace(/\s+$/, ""), verbatim: false });

/** Stores the result of running query `name` (its columns come from the engine) and its M text in the model. */
export function applyQueryLoad(
  p: Project,
  info: TableInfo,
  mText: string,
  newId: () => string = () => crypto.randomUUID(),
): { created: boolean; removedRelationships: string[] } {
  let found = findTable(p, info.name);
  const created = !found;
  if (!found) {
    addTable(p, info.name, newId);
    found = findTable(p, info.name)!;
  }
  const t = found.node;
  const oldColumns = new Map(t.children.filter((c) => c.kind === "column").map((c) => [sourceKey(c), c]));
  const fresh = new Set(info.columns.map((c) => c.name.toLowerCase()));
  const gone = [...oldColumns.entries()].filter(([k]) => !fresh.has(k)).map(([, c]) => c.name!);
  const columns = info.columns.map((c) => columnNode(c.name, c.biType, newId, oldColumns.get(c.name.toLowerCase())));
  const oldPart = t.children.find(isMPartition);
  // unchanged M (a table only reloaded because a query it uses changed) keeps its partition, marker and import source as they are
  const sameText = !!oldPart && sourceOf(oldPart) !== null && exprOf(sourceOf(oldPart)!).text === exprOf(mText).text;
  const part: TmdlNode = oldPart ? structuredClone(oldPart) : node("partition", info.name, [text("mode", "import")]);
  if (!sameText) {
    part.default = { text: "m", verbatim: false };
    part.children = part.children.filter((a) => !(a.kind === "annotation" && a.name === GENERATED));
    part.props = part.props.filter((x) => x.key !== "source");
    part.props.push({ key: "source", value: { Expr: exprOf(mText) } });
  }
  const others = t.children.filter(
    (c) => c.kind !== "column" && !isMPartition(c) && !(!sameText && c.kind === "annotation" && c.name === SOURCE_ANNOTATION),
  );
  t.children = [...columns, ...others, part];
  const removedRelationships = removeRelationshipsOnColumns(p, info.name, gone);
  return { created, removedRelationships };
}

function expressionHome(p: Project): string {
  for (const [key, d] of Object.entries(p.model.tmdl)) if (d.nodes.some((n) => n.kind === "expression")) return key;
  return EXPRESSIONS_FILE;
}

/** Creates or updates a named expression (a query that is not loaded into the model). */
export function upsertExpression(p: Project, name: string, mText: string, resultType: string, newId: () => string = () => crypto.randomUUID()): void {
  const existing = allNodes(p).find((n) => n.kind === "expression" && n.name === name);
  if (existing) {
    existing.default = exprOf(mText);
    const ann = existing.children.find((a) => a.kind === "annotation" && a.name === "PBI_ResultType");
    if (ann) ann.default = { text: resultType, verbatim: false };
    return;
  }
  if (findTable(p, name)) throw new Error(`A table named "${name}" already exists.`);
  const n = node("expression", name, [text("lineageTag", newId())]);
  n.default = exprOf(mText);
  const ann = node("annotation", "PBI_ResultType");
  ann.default = { text: resultType, verbatim: false };
  n.children.push(ann);
  const key = expressionHome(p);
  (p.model.tmdl[key] ??= { nodes: [] }).nodes.push(n);
  const model = p.model.tmdl["model.tmdl"];
  if (model) {
    const ref = node("ref expression", name);
    const kinds = model.nodes.map((x) => x.kind);
    const at = Math.max(kinds.lastIndexOf("ref expression"), kinds.lastIndexOf("ref table"));
    model.nodes.splice(at === -1 ? model.nodes.length : at + 1, 0, ref);
  }
}

export function removeExpression(p: Project, name: string): void {
  for (const [key, d] of Object.entries(p.model.tmdl)) {
    d.nodes = d.nodes.filter((n) => !(n.kind === "expression" && n.name === name));
    if (d.nodes.length === 0 && key === EXPRESSIONS_FILE) delete p.model.tmdl[key];
  }
  const model = p.model.tmdl["model.tmdl"];
  if (model) model.nodes = model.nodes.filter((n) => !(n.kind === "ref expression" && n.name === name));
}

export function expressionExists(p: Project, name: string): boolean {
  return allNodes(p).some((n) => n.kind === "expression" && n.name === name);
}

/** Replaces the M text of query `name` (a table's M partition or a named expression); the text is not checked. */
export function setQueryText(p: Project, name: string, mText: string): void {
  for (const n of allNodes(p)) {
    if (n.name !== name) continue;
    if (n.kind === "expression") n.default = exprOf(mText);
    else if (n.kind === "table") {
      const part = n.children.find(isMPartition);
      const src = part?.props.find((x) => x.key === "source");
      if (!part || !src) continue;
      if (typeof src.value === "object" && "Expr" in src.value && src.value.Expr.text === exprOf(mText).text) return;
      src.value = { Expr: exprOf(mText) };
      // text the user's rename touched is no longer the text BIForge generated
      part.children = part.children.filter((a) => !(a.kind === "annotation" && a.name === GENERATED));
    }
  }
}
