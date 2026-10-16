// Edits of the report part of a Project draft. All functions mutate the draft passed in and throw ReportError
// on invalid input; DocumentStore.transact discards the draft on error, so a failed edit changes nothing.
import type { Project } from "../model/types";
import { sameField, type FieldRef, type Lit } from "./fields";
import { readFilters, writeFilters, type FilterDef } from "./filters";
import { fieldToPbir, type J } from "./pbir";
import {
  activePageName,
  hasField,
  listPageNames,
  newName,
  PAGE_SCHEMA,
  PAGES_SCHEMA,
  pageKey,
  pagesKey,
  parsePage,
  parseVisual,
  setFormat,
  setRawProp,
  setRole,
  visualKey,
  visualPrefix,
  VISUAL_SCHEMA,
  type Position,
  type Projection,
  type SortSpec,
  type VisualModel,
} from "./visualDoc";
import { defaultRole, roleDef, visualType } from "./visualTypes";

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

const files = (p: Project) => p.report.files as Record<string, J>;

function pagesDoc(p: Project): J {
  const f = files(p);
  f[pagesKey] ??= { $schema: PAGES_SCHEMA, pageOrder: [], activePageName: "" };
  return f[pagesKey];
}

function pageJson(p: Project, page: string): J {
  const j = files(p)[pageKey(page)];
  if (!j) throw new ReportError(`Page "${page}" does not exist.`);
  return j;
}

function visualJson(p: Project, page: string, visual: string): J {
  const j = files(p)[visualKey(page, visual)];
  if (!j) throw new ReportError(`Visual "${visual}" does not exist on page "${page}".`);
  return j;
}

// ---- pages -----------------------------------------------------------------------------------

function uniqueDisplayName(p: Project, base: string): string {
  const taken = new Set(listPageNames(p).map((n) => String(files(p)[pageKey(n)]?.displayName ?? n).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export function addPage(p: Project, displayName?: string, opt: { newId?: () => string; type?: "Drillthrough" | "Tooltip"; afterPage?: string } = {}): string {
  const names = listPageNames(p);
  const name = (opt.newId ?? newName)();
  const base = displayName?.trim() || (opt.type === "Tooltip" ? "Tooltip" : opt.type === "Drillthrough" ? "Drillthrough" : `Page ${names.length + 1}`);
  const json: J = {
    $schema: PAGE_SCHEMA,
    name,
    displayName: uniqueDisplayName(p, base),
    displayOption: "FitToPage",
    height: opt.type === "Tooltip" ? 240 : 720,
    width: opt.type === "Tooltip" ? 320 : 1280,
  };
  if (opt.type) json.type = opt.type;
  if (opt.type === "Tooltip") json.pageBinding = { name: newName(), type: "Tooltip", referenceScope: "Default" };
  files(p)[pageKey(name)] = json;
  const doc = pagesDoc(p);
  const at = opt.afterPage ? names.indexOf(opt.afterPage) + 1 : names.length;
  const order = [...names];
  order.splice(at <= 0 ? order.length : at, 0, name);
  doc.pageOrder = order;
  if (!doc.activePageName || !names.length) doc.activePageName = name;
  return name;
}

export function renamePage(p: Project, page: string, displayName: string): void {
  const j = pageJson(p, page);
  const n = displayName.trim();
  if (!n) throw new ReportError("A page needs a name.");
  const clash = listPageNames(p).find((o) => o !== page && String(files(p)[pageKey(o)]?.displayName).toLowerCase() === n.toLowerCase());
  if (clash) throw new ReportError(`A page named "${n}" already exists.`);
  j.displayName = n;
}

export function deletePage(p: Project, page: string): void {
  pageJson(p, page);
  const names = listPageNames(p);
  if (names.length <= 1) throw new ReportError("A report needs at least one page.");
  for (const k of Object.keys(files(p))) if (k.startsWith(`pages/${page}/`)) delete files(p)[k];
  const doc = pagesDoc(p);
  const rest = names.filter((n) => n !== page);
  doc.pageOrder = rest;
  if (doc.activePageName === page) doc.activePageName = rest[Math.max(0, names.indexOf(page) - 1)] ?? rest[0];
  removeBookmarksOf(p, page);
}

export function movePage(p: Project, page: string, toIndex: number): void {
  pageJson(p, page);
  const names = listPageNames(p).filter((n) => n !== page);
  names.splice(Math.max(0, Math.min(names.length, toIndex)), 0, page);
  pagesDoc(p).pageOrder = names;
}

export function setActivePage(p: Project, page: string): void {
  pageJson(p, page);
  pagesDoc(p).activePageName = page;
}

export function duplicatePage(p: Project, page: string, newId: () => string = newName): string {
  const src = pageJson(p, page);
  const copy = addPage(p, `${src.displayName ?? page} (copy)`, { newId, afterPage: page, ...(src.type ? { type: src.type } : {}) });
  const dst = files(p)[pageKey(copy)];
  const keep = dst.displayName;
  Object.assign(dst, structuredClone(src), { name: copy, displayName: keep });
  delete dst.pageBinding; // a binding id must stay unique across the report
  if (src.pageBinding) dst.pageBinding = { ...structuredClone(src.pageBinding), name: newId() };
  dst.visualInteractions = [];
  const renamed = new Map<string, string>();
  for (const k of Object.keys(files(p))) {
    const m = k.startsWith(visualPrefix(page)) && /^pages\/[^/]+\/visuals\/([^/]+)\/visual\.json$/.exec(k);
    if (!m) continue;
    const nv = newId();
    renamed.set(m[1], nv);
    const v = structuredClone(files(p)[k]);
    v.name = nv;
    files(p)[visualKey(copy, nv)] = v;
  }
  if (Array.isArray(src.visualInteractions)) {
    dst.visualInteractions = src.visualInteractions
      .filter((i: J) => renamed.has(i.source) && renamed.has(i.target))
      .map((i: J) => ({ ...i, source: renamed.get(i.source), target: renamed.get(i.target) }));
  }
  return copy;
}

export function setPageSize(p: Project, page: string, width: number, height: number): void {
  const j = pageJson(p, page);
  if (!(width >= 100 && height >= 100 && width <= 10000 && height <= 10000)) throw new ReportError("A page must be between 100 and 10000 pixels in each direction.");
  j.width = Math.round(width);
  j.height = Math.round(height);
}

export function setPageHidden(p: Project, page: string, hidden: boolean): void {
  const j = pageJson(p, page);
  if (hidden) j.visibility = "HiddenInViewMode";
  else delete j.visibility;
}

export function setPageType(p: Project, page: string, type: "Drillthrough" | "Tooltip" | null): void {
  const j = pageJson(p, page);
  if (!type) {
    delete j.type;
    delete j.pageBinding;
    return;
  }
  j.type = type;
  j.pageBinding = { name: j.pageBinding?.name ?? newName(), type, referenceScope: "Default", ...(type === "Drillthrough" ? { parameters: j.pageBinding?.parameters ?? [] } : {}) };
  if (type === "Tooltip" && j.width === 1280 && j.height === 720) {
    j.width = 320;
    j.height = 240;
  }
}

/** Fields whose values a drillthrough page accepts. Each field is bound to a page filter of the same field. */
export function setDrillthroughFields(p: Project, page: string, fields: FieldRef[]): void {
  const j = pageJson(p, page);
  if (j.type !== "Drillthrough") throw new ReportError("Only a drillthrough page has drillthrough fields.");
  const r = readFilters(j);
  const defs = r.defs.filter((d) => !d.name.startsWith("dt_") || fields.some((f) => sameField(f, d.field)));
  for (const f of fields) {
    if (!defs.some((d) => sameField(d.field, f))) defs.push({ name: `dt_${newName()}`, field: f, cond: { kind: "in", values: [] } });
  }
  writeFilters(j, defs, r.opaque);
  const bound = readFilters(j).defs.filter((d) => fields.some((f) => sameField(f, d.field)));
  j.pageBinding = {
    ...(j.pageBinding ?? { name: newName(), type: "Drillthrough", referenceScope: "Default" }),
    parameters: bound.map((d) => ({ name: `p_${d.name}`, boundFilter: d.name, fieldExpr: filterField(d.field) })),
  };
}

function filterField(f: FieldRef): J {
  return f.kind === "column" ? { Column: { Expression: { SourceRef: { Entity: f.table } }, Property: f.name } } : {};
}

// ---- visuals ---------------------------------------------------------------------------------

export function addVisual(p: Project, page: string, typeId: string, opt: { position?: Partial<Position>; fields?: { role: string; field: FieldRef }[]; newId?: () => string } = {}): string {
  pageJson(p, page);
  const t = visualType(typeId);
  if (!t) throw new ReportError(`Unknown visual type "${typeId}".`);
  const name = (opt.newId ?? newName)();
  const existing = Object.keys(files(p)).filter((k) => k.startsWith(visualPrefix(page)) && k.endsWith("/visual.json"));
  const z = Math.max(-1, ...existing.map((k) => files(p)[k].position?.z ?? 0)) + 1000;
  const n = existing.length;
  const json: J = {
    $schema: VISUAL_SCHEMA,
    name,
    position: { x: 40 + (n % 6) * 24, y: 40 + (n % 6) * 24, z, width: t.size.width, height: t.size.height, tabOrder: z, ...opt.position },
    visual: { visualType: typeId, drillFilterOtherVisuals: true },
  };
  files(p)[visualKey(page, name)] = json;
  for (const { role, field } of opt.fields ?? []) addField(p, page, name, role, field);
  return name;
}

export function deleteVisual(p: Project, page: string, visual: string): void {
  visualJson(p, page, visual);
  delete files(p)[visualKey(page, visual)];
  for (const k of Object.keys(files(p))) if (k.startsWith(`pages/${page}/visuals/${visual}/`)) delete files(p)[k];
  const pj = pageJson(p, page);
  if (Array.isArray(pj.visualInteractions)) pj.visualInteractions = pj.visualInteractions.filter((i: J) => i.source !== visual && i.target !== visual);
}

export function duplicateVisual(p: Project, page: string, visual: string, newId: () => string = newName): string {
  const src = visualJson(p, page, visual);
  const copy = structuredClone(src);
  copy.name = newId();
  const top = Math.max(0, ...Object.keys(files(p)).filter((k) => k.startsWith(visualPrefix(page)) && k.endsWith("/visual.json")).map((k) => files(p)[k].position?.z ?? 0));
  copy.position = { ...copy.position, x: (copy.position.x ?? 0) + 24, y: (copy.position.y ?? 0) + 24, z: top + 1000 };
  files(p)[visualKey(page, copy.name)] = copy;
  return copy.name;
}

export function setPosition(p: Project, page: string, visual: string, pos: Partial<Position>): void {
  const j = visualJson(p, page, visual);
  const next = { ...j.position, ...pos };
  if (!(next.width >= 20 && next.height >= 20)) throw new ReportError("A visual must be at least 20 by 20 pixels.");
  j.position = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 100) / 100 : v]));
}

/** Moves a visual to the front (above all others) or the back of the stacking order. */
export function arrange(p: Project, page: string, visual: string, where: "front" | "back"): void {
  const v = visualJson(p, page, visual);
  const others = Object.keys(files(p))
    .filter((k) => k.startsWith(visualPrefix(page)) && k.endsWith("/visual.json") && files(p)[k] !== v)
    .map((k) => files(p)[k].position?.z ?? 0);
  v.position.z = where === "front" ? Math.max(0, ...others) + 1000 : Math.min(0, ...others) - 1000;
}

export function setHidden(p: Project, page: string, visual: string, hidden: boolean): void {
  const j = visualJson(p, page, visual);
  if (hidden) j.isHidden = true;
  else delete j.isHidden;
}

/** Changes the visual type and keeps each field in the same-named role (or the first role that can hold it). */
export function setVisualType(p: Project, page: string, visual: string, typeId: string): void {
  const j = visualJson(p, page, visual);
  const t = visualType(typeId);
  if (!t) throw new ReportError(`Unknown visual type "${typeId}".`);
  const m = parseVisual(page, j)!;
  const old = Object.entries(m.roles).flatMap(([role, list]) => list.map((pr) => ({ role, pr })));
  j.visual.visualType = typeId;
  delete j.visual.query?.queryState;
  const placed: Record<string, Projection[]> = {};
  for (const { role, pr } of old) {
    const kind = pr.field.kind === "column" ? "column" : "value";
    const same = roleDef(typeId, role);
    const free = (r: string | null) => r !== null && (placed[r]?.length ?? 0) < (roleDef(typeId, r)?.max ?? 0);
    const target = same && (same.accepts === "any" || same.accepts === kind) && free(role) ? role : defaultRole(typeId, kind, placed);
    if (free(target)) (placed[target!] ??= []).push(pr);
  }
  for (const [role, list] of Object.entries(placed)) setRole(j, role, list);
}

export function addField(p: Project, page: string, visual: string, role: string | null, field: FieldRef, index?: number): string {
  const j = visualJson(p, page, visual);
  const m = parseVisual(page, j)!;
  const kind = field.kind === "column" ? "column" : "value";
  const target = role ?? defaultRole(m.visualType, kind, m.roles);
  if (!target) throw new ReportError("This visual has no field well for that field.");
  const def = roleDef(m.visualType, target);
  if (!def) throw new ReportError(`"${m.visualType}" has no field well "${target}".`);
  if (def.accepts !== "any" && def.accepts !== kind) throw new ReportError(def.accepts === "column" ? `${def.label} takes grouping fields, not measures.` : `${def.label} takes measures or aggregated columns.`);
  const list = [...(m.roles[target] ?? [])];
  if (hasField(list, field)) throw new ReportError("That field is already in this well.");
  if (list.length >= def.max) {
    if (def.max === 1) list.length = 0;
    else throw new ReportError(`${def.label} holds at most ${def.max} fields.`);
  }
  list.splice(index ?? list.length, 0, { field });
  setRole(j, target, list);
  return target;
}

export function removeField(p: Project, page: string, visual: string, role: string, index: number): void {
  const j = visualJson(p, page, visual);
  const m = parseVisual(page, j)!;
  const list = [...(m.roles[role] ?? [])];
  if (index < 0 || index >= list.length) throw new ReportError("No such field.");
  const [gone] = list.splice(index, 1);
  setRole(j, role, list);
  if (m.sort && sameField(m.sort.field, gone.field)) delete j.visual.query.sortDefinition;
}

export function moveField(p: Project, page: string, visual: string, role: string, from: number, to: number): void {
  const j = visualJson(p, page, visual);
  const list = [...(parseVisual(page, j)!.roles[role] ?? [])];
  if (from < 0 || from >= list.length) throw new ReportError("No such field.");
  const [x] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, x);
  setRole(j, role, list);
}

/** Changes how an aggregated column is summarized (Sum, Average, ...). */
export function setAggregation(p: Project, page: string, visual: string, role: string, index: number, fn: number): void {
  const j = visualJson(p, page, visual);
  const m = parseVisual(page, j)!;
  const list = [...(m.roles[role] ?? [])];
  const cur = list[index]?.field;
  if (!cur || cur.kind === "measure") throw new ReportError("Only columns can be summarized.");
  if (!Number.isInteger(fn) || fn < 0 || fn > 8) throw new ReportError("Unknown summarization.");
  list[index] = { ...list[index], field: { kind: "agg", table: cur.table, name: cur.name, fn: fn as 0 } };
  setRole(j, role, list);
}

export function renameField(p: Project, page: string, visual: string, role: string, index: number, displayName: string): void {
  const j = visualJson(p, page, visual);
  const list = [...(parseVisual(page, j)!.roles[role] ?? [])];
  if (!list[index]) throw new ReportError("No such field.");
  list[index] = { ...list[index], displayName: displayName.trim() || undefined };
  setRole(j, role, list);
}

export function setSort(p: Project, page: string, visual: string, sort: SortSpec | null): void {
  const j = visualJson(p, page, visual);
  j.visual.query ??= { queryState: {} };
  if (!sort) {
    delete j.visual.query.sortDefinition;
    return;
  }
  j.visual.query.sortDefinition = { sort: [{ field: fieldToPbir(sort.field), direction: sort.dir === "asc" ? "Ascending" : "Descending" }] };
}

export function setVisualFormat(p: Project, page: string, visual: string, object: string, prop: string, value: Lit | null, selector?: string): void {
  setFormat(visualJson(p, page, visual), object, prop, value, selector);
}

export function setVisualRaw(p: Project, page: string, visual: string, object: string, prop: string, node: J | null, selector?: string): void {
  setRawProp(visualJson(p, page, visual), object, prop, node, selector);
}

// ---- filters ---------------------------------------------------------------------------------

export type FilterScope = { level: "report" } | { level: "page"; page: string } | { level: "visual"; page: string; visual: string };

function holderOf(p: Project, s: FilterScope): J {
  if (s.level === "report") {
    const r = files(p)["report.json"];
    if (!r) throw new ReportError("The report has no report.json.");
    return r;
  }
  return s.level === "page" ? pageJson(p, s.page) : visualJson(p, s.page, s.visual);
}

export function getFilters(p: Project, s: FilterScope): FilterDef[] {
  return readFilters(holderOf(p, s)).defs;
}

export function setFilters(p: Project, s: FilterScope, defs: FilterDef[]): void {
  const holder = holderOf(p, s);
  writeFilters(holder, defs, readFilters(holder).opaque);
}

export function upsertFilter(p: Project, s: FilterScope, def: FilterDef): void {
  const cur = getFilters(p, s);
  const i = cur.findIndex((d) => d.name === def.name);
  if (i >= 0) cur[i] = def;
  else cur.push(def);
  setFilters(p, s, cur);
}

export function removeFilter(p: Project, s: FilterScope, name: string): void {
  setFilters(p, s, getFilters(p, s).filter((d) => d.name !== name));
}

// ---- interactions ----------------------------------------------------------------------------

export type InteractionType = "Default" | "DataFilter" | "HighlightFilter" | "NoFilter";

/** Sets how a selection in `source` affects `target`. "Default" removes the explicit setting. */
export function setInteraction(p: Project, page: string, source: string, target: string, type: InteractionType): void {
  const pj = pageJson(p, page);
  visualJson(p, page, source);
  visualJson(p, page, target);
  const list: J[] = (pj.visualInteractions ?? []).filter((i: J) => !(i.source === source && i.target === target));
  if (type !== "Default") list.push({ source, target, type });
  if (list.length) pj.visualInteractions = list;
  else delete pj.visualInteractions;
}

// ---- bookmarks (see bookmarks.ts for the state they hold) ---------------------------------------

export function removeBookmarksOf(p: Project, page: string): void {
  for (const [k, v] of Object.entries(files(p))) {
    if (k.startsWith("bookmarks/") && k.endsWith(".bookmark.json") && v?.explorationState?.activeSection === page) {
      delete files(p)[k];
      const idx = files(p)["bookmarks/bookmarks.json"];
      if (idx) idx.items = (idx.items ?? []).filter((i: J) => i.name !== v.name);
      const r = files(p)["report.json"];
      if (r?.annotations) r.annotations = r.annotations.filter((a: J) => a.name !== `biforge.bookmark.${v.name}`);
    }
  }
}

export { activePageName, parsePage, parseVisual };
export type { VisualModel };
