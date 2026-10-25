// Edits of the report part of a Project draft. All functions mutate the draft passed in and throw ReportError
// on invalid input; DocumentStore.transact discards the draft on error, so a failed edit changes nothing.
import type { Project } from "../model/types";
import { sameField, type FieldRef, type Lit } from "./fields";
import { readFilters, writeFilters, type FilterDef } from "./filters";
import { fieldToPbir, litExpr, readLitProp, type J } from "./pbir";
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
  entryProps,
  mobileKey,
  MOBILE_SCHEMA,
  setFormat,
  setGroupFormat as setGroupFormatJson,
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
import { writeTextbox } from "./staticVisuals";
import { alignBoxes, distributeBoxes, type AlignMode, type Box, type DistributeAxis, type Moves } from "./arrange";
import { modelInfo } from "./modelInfo";

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

/** Sets (or, with null, removes) one property of a page object: "background" (canvas background) or "outspace" (wallpaper). */
export function setPageFormat(p: Project, page: string, object: "background" | "outspace" | "displayArea", prop: string, value: Lit | null): void {
  const j = pageJson(p, page);
  const objects = (j.objects ??= {});
  const bag = ((objects[object] ??= [{ properties: {} }])[0].properties ??= {});
  if (value === null) delete bag[prop];
  else bag[prop] = litExpr(value);
  if (Object.keys(bag).length === 0) delete objects[object];
  if (Object.keys(objects).length === 0) delete j.objects;
}

/** The picture of the canvas background or wallpaper: stored as a data address, like the image visual. */
export function setPageImage(p: Project, page: string, object: "background" | "outspace", uri: string | null, name = "image"): void {
  const j = pageJson(p, page);
  if (uri === null) {
    setPageFormat(p, page, object, "image", null);
    return;
  }
  const objects = (j.objects ??= {});
  const bag = ((objects[object] ??= [{ properties: {} }])[0].properties ??= {});
  const prev = bag.image?.image?.scaling;
  bag.image = { image: { name: litExpr({ t: "string", v: name }), url: litExpr({ t: "string", v: uri }), scaling: prev ?? litExpr({ t: "string", v: "Normal" }) } };
}

export function setPageImageFit(p: Project, page: string, object: "background" | "outspace", fit: "Normal" | "Fit" | "Fill"): void {
  const j = pageJson(p, page);
  const img = j.objects?.[object]?.[0]?.properties?.image?.image;
  if (!img) throw new ReportError("Choose a picture first.");
  img.scaling = litExpr({ t: "string", v: fit });
}

export function setPageDisplayOption(p: Project, page: string, option: "FitToPage" | "FitToWidth" | "ActualSize"): void {
  pageJson(p, page).displayOption = option;
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
  if (typeId === "textbox") writeTextbox(json, { text: "Text box" });
  files(p)[visualKey(page, name)] = json;
  for (const { role, field } of opt.fields ?? []) addField(p, page, name, role, field);
  return name;
}

/** Edits a visual of a given type through `fn` (used by objects that keep their content in the visual JSON). */
export function editStatic(p: Project, page: string, visual: string, typeId: string, fn: (json: J) => void): void {
  const j = visualJson(p, page, visual);
  if (j.visual?.visualType !== typeId) throw new ReportError(`Visual "${visual}" is not a ${typeId}.`);
  fn(j);
}

// ---- several visuals at once -----------------------------------------------------------------

function boxesOf(p: Project, page: string, names: string[]): Box[] {
  return names.map((n) => {
    const pos = visualJson(p, page, n).position ?? {};
    return { name: n, x: pos.x ?? 0, y: pos.y ?? 0, width: pos.width ?? 0, height: pos.height ?? 0 };
  });
}

const applyMoves = (p: Project, page: string, moves: Moves) => {
  for (const [name, m] of Object.entries(moves)) setPosition(p, page, name, m);
};

export function setPositions(p: Project, page: string, items: { visual: string; position: Partial<Position> }[]): void {
  for (const it of items) setPosition(p, page, it.visual, it.position);
}

export function deleteVisuals(p: Project, page: string, names: string[]): void {
  for (const n of names) visualJson(p, page, n);
  // a group takes its members with it, so a member listed as well may already be gone
  for (const n of names) if (files(p)[visualKey(page, n)]) deleteVisual(p, page, n);
}

export function alignVisuals(p: Project, page: string, names: string[], mode: AlignMode): void {
  applyMoves(p, page, alignBoxes(boxesOf(p, page, names), mode));
}

export function distributeVisuals(p: Project, page: string, names: string[], axis: DistributeAxis): void {
  applyMoves(p, page, distributeBoxes(boxesOf(p, page, names), axis));
}

/** What Copy puts on the clipboard: the visual documents with the page they came from. */
export interface VisualClipboard {
  kind: "biforge.visuals";
  version: 1;
  page: string;
  visuals: J[];
}

export function copyVisuals(p: Project, page: string, names: string[]): VisualClipboard {
  if (names.length === 0) throw new ReportError("Select a visual to copy.");
  return { kind: "biforge.visuals", version: 1, page, visuals: withDescendants(p, page, names).map((n) => structuredClone(visualJson(p, page, n))) };
}

export function isVisualClipboard(x: unknown): x is VisualClipboard {
  const c = x as VisualClipboard | null;
  return !!c && c.kind === "biforge.visuals" && c.version === 1 && Array.isArray(c.visuals) && c.visuals.every((v) => v && typeof v === "object" && ((v.visual && typeof v.visual.visualType === "string") || v.visualGroup));
}

/** Tables a copied visual refers to that this report's model does not have. */
function missingTables(p: Project, json: J): string[] {
  const have = new Set(modelInfo(p).tables().map((t) => t.toLowerCase()));
  const found = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      const o = x as J;
      if (typeof o.Entity === "string") found.add(o.Entity);
      Object.values(o).forEach(walk);
    }
  };
  walk(json);
  return [...found].filter((t) => !have.has(t.toLowerCase()));
}

/** Pastes copied visuals on a page: same position on another page, shifted when pasted over the original. Groups keep their members. */
export function pasteVisuals(p: Project, page: string, clip: VisualClipboard, newId: () => string = newName): { names: string[]; missing: string[] } {
  pageJson(p, page);
  const names: string[] = [];
  const missing = new Set<string>();
  const existing = () => itemsOf(p, page);
  const renamed = new Map<string, string>(clip.visuals.map((v) => [v.name as string, newId()]));
  const copies = clip.visuals.map((src) => {
    const copy = structuredClone(src);
    copy.name = renamed.get(src.name)!;
    if (typeof copy.parentGroupName === "string" && renamed.has(copy.parentGroupName)) copy.parentGroupName = renamed.get(copy.parentGroupName);
    else delete copy.parentGroupName;
    return copy;
  });
  // one shift for the whole paste, chosen so that no top-level copy lands exactly on an existing item
  const topLevel = copies.filter((c) => !c.parentGroupName);
  let shift = 0;
  const clash = (d: number) =>
    topLevel.some((c) => existing().some((v) => v.position?.x === (c.position?.x ?? 0) + d && v.position?.y === (c.position?.y ?? 0) + d && v.position?.width === c.position?.width && v.position?.height === c.position?.height));
  while (clash(shift)) shift += 24;
  const top = Math.max(0, ...existing().map((v) => v.position?.z ?? 0));
  let order = 0;
  for (const copy of copies) {
    const pos = { ...(copy.position ?? { x: 0, y: 0, width: 200, height: 150 }) };
    pos.x = (pos.x ?? 0) + shift;
    pos.y = (pos.y ?? 0) + shift;
    order++;
    copy.position = { ...pos, z: top + 1000 * order, tabOrder: top + 1000 * order };
    files(p)[visualKey(page, copy.name)] = copy;
    if (!copy.parentGroupName) names.push(copy.name);
    if (copy.visual) missingTables(p, copy).forEach((t) => missing.add(t));
  }
  return { names, missing: [...missing] };
}

const NAME_ANNOTATION = "biforge.displayName";

/** The name shown in the Selection pane: a user-given name, else the visual type. */
export function visualDisplayName(json: J): string | null {
  const a = (json.annotations ?? []).find((x: J) => x.name === NAME_ANNOTATION);
  return typeof a?.value === "string" && a.value !== "" ? a.value : null;
}

export function renameVisual(p: Project, page: string, visual: string, name: string): void {
  const j = visualJson(p, page, visual);
  const rest = (j.annotations ?? []).filter((x: J) => x.name !== NAME_ANNOTATION);
  const trimmed = name.trim();
  if (trimmed) rest.push({ name: NAME_ANNOTATION, value: trimmed });
  if (rest.length) j.annotations = rest;
  else delete j.annotations;
}

/** Moves a visual one step up (towards the front) or down in the stacking order, by swapping with its neighbour. */
export function moveInOrder(p: Project, page: string, visual: string, dir: "up" | "down"): void {
  const target = visualJson(p, page, visual);
  // the stacking order is kept within one level: among the members of the same group, or the top level
  const all = Object.keys(files(p))
    .filter((k) => k.startsWith(visualPrefix(page)) && k.endsWith("/visual.json"))
    .map((k) => files(p)[k])
    .filter((j) => (j.parentGroupName ?? "") === (target.parentGroupName ?? ""))
    .sort((a, b) => (a.position?.z ?? 0) - (b.position?.z ?? 0) || String(a.name).localeCompare(String(b.name)));
  const i = all.indexOf(target);
  const j = dir === "up" ? i + 1 : i - 1;
  if (j < 0 || j >= all.length) return;
  const za = all[i].position.z ?? 0;
  const zb = all[j].position.z ?? 0;
  if (za === zb) {
    all[i].position.z = dir === "up" ? zb + 1 : zb - 1;
    return;
  }
  all[i].position.z = zb;
  all[j].position.z = za;
}

/** The keyboard (Tab) order of a page: the visuals sorted by their tab order, the stacking order where none is stored. */
export function tabOrderSorted<T extends { name: string; position: { z: number; tabOrder?: number } }>(visuals: T[]): T[] {
  return [...visuals].sort((a, b) => (a.position.tabOrder ?? a.position.z) - (b.position.tabOrder ?? b.position.z) || a.name.localeCompare(b.name));
}

/** The visual after (or before) the current one in the tab order; wraps around. */
export function nextInTabOrder<T extends { name: string; position: { z: number; tabOrder?: number } }>(visuals: T[], current: string | null, back = false): T | null {
  const list = tabOrderSorted(visuals);
  if (list.length === 0) return null;
  const at = list.findIndex((v) => v.name === current);
  if (at < 0) return back ? list[list.length - 1] : list[0];
  return list[(at + (back ? -1 : 1) + list.length) % list.length];
}

/** Moves a visual one step in the tab order; every visual of the page gets a consecutive number. */
export function moveInTabOrder(p: Project, page: string, visual: string, dir: "up" | "down"): void {
  const js = Object.keys(files(p))
    .filter((k) => k.startsWith(visualPrefix(page)) && k.endsWith("/visual.json"))
    .map((k) => files(p)[k])
    .sort((a, b) => (a.position?.tabOrder ?? a.position?.z ?? 0) - (b.position?.tabOrder ?? b.position?.z ?? 0) || String(a.name).localeCompare(String(b.name)));
  const i = js.findIndex((j) => j.name === visual);
  if (i < 0) throw new Error("No such visual.");
  const j = dir === "up" ? i - 1 : i + 1;
  if (j >= 0 && j < js.length) [js[i], js[j]] = [js[j], js[i]];
  js.forEach((x, n) => {
    x.position = { ...(x.position ?? {}), tabOrder: n };
  });
}

// ---- sync slicers ------------------------------------------------------------------------------

/** The sync group of a slicer: visual.syncGroup in the report format. */
export const syncGroupOf = (json: J): string | null => (typeof json?.visual?.syncGroup?.groupName === "string" ? json.visual.syncGroup.groupName : null);

const slicersOf = (p: Project, page: string): J[] =>
  Object.keys(files(p))
    .filter((k) => k.startsWith(visualPrefix(page)) && k.endsWith("/visual.json"))
    .map((k) => files(p)[k])
    .filter((j) => j.visual?.visualType === "slicer");

/** Every other slicer of the report that is in the same sync group, with its page. */
export function syncedSlicers(p: Project, page: string, visual: string): { page: string; visual: string }[] {
  const group = syncGroupOf(visualJson(p, page, visual));
  if (!group) return [];
  return listPageNames(p).flatMap((pg) => slicersOf(p, pg).filter((j) => syncGroupOf(j) === group && !(pg === page && j.name === visual)).map((j) => ({ page: pg, visual: j.name as string })));
}

/**
 * Sync slicers pane: puts the slicer in a group and, per page, adds it (a copy with the same field and selection, hidden when
 * `visible` is false) or takes it out. A synced slicer that is hidden and taken out is deleted.
 */
export function setSlicerSync(p: Project, page: string, visual: string, group: string | null, pages: { page: string; sync: boolean; visible: boolean }[], newId: () => string = newName): void {
  const src = visualJson(p, page, visual);
  if (src.visual?.visualType !== "slicer") throw new ReportError("Only a slicer can be synced.");
  const old = syncGroupOf(src);
  if (!group) {
    for (const pg of listPageNames(p)) for (const j of slicersOf(p, pg)) if (old && syncGroupOf(j) === old && j !== src) (j.isHidden ? deleteVisual(p, pg, j.name) : delete j.visual.syncGroup);
    delete src.visual.syncGroup;
    return;
  }
  src.visual.syncGroup = { groupName: group, fieldChanges: true, filterChanges: true };
  for (const e of pages) {
    if (e.page === page) continue;
    pageJson(p, e.page);
    const existing = slicersOf(p, e.page).find((j) => syncGroupOf(j) === group);
    if (e.sync) {
      if (existing) {
        if (e.visible) delete existing.isHidden;
        else existing.isHidden = true;
      } else {
        const copy = structuredClone(src);
        copy.name = newId();
        if (e.visible) delete copy.isHidden;
        else copy.isHidden = true;
        files(p)[visualKey(e.page, copy.name)] = copy;
      }
    } else if (existing) {
      if (existing.isHidden) deleteVisual(p, e.page, existing.name);
      else delete existing.visual.syncGroup;
    }
  }
}

export function deleteVisual(p: Project, page: string, visual: string): void {
  const item = visualJson(p, page, visual);
  if (isGroupJson(item)) for (const d of descendantsOf(p, page, visual)) deleteVisual(p, page, d.name);
  delete files(p)[visualKey(page, visual)];
  const parentName = item.parentGroupName as string | undefined;
  const parent = parentName ? files(p)[visualKey(page, parentName)] : undefined;
  if (parent) {
    if (membersOf(p, page, parentName!).length === 0) deleteVisual(p, page, parentName!);
    else refitAncestors(p, page, membersOf(p, page, parentName!)[0]);
  }
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
  const old = { ...j.position };
  const next = { ...j.position, ...pos };
  if (!(next.width >= 20 && next.height >= 20)) throw new ReportError("A visual must be at least 20 by 20 pixels.");
  j.position = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 100) / 100 : v]));
  if (isGroupJson(j)) transformMembers(p, page, j, old);
  else refitAncestors(p, page, j);
}

// ---- personalize visuals -----------------------------------------------------------------------
// A page lets readers personalize its visuals when objects.personalizeVisual.show is true (the report format's own
// object); each visual's header then offers the Personalize button unless visualHeader.showPersonalizeVisualButton is off.

/** Whether readers may personalize the visuals of a page. */
export function personalizeOn(p: Project, page: string): boolean {
  const l = readLitProp(pageJson(p, page).objects?.personalizeVisual?.[0]?.properties?.show);
  return l?.t === "bool" && l.v;
}

/** Turns personalizing on or off for every page of the report. */
export function setPersonalize(p: Project, enabled: boolean): void {
  for (const name of listPageNames(p)) {
    const pj = pageJson(p, name);
    if (enabled) {
      pj.objects ??= {};
      pj.objects.personalizeVisual = [{ properties: { show: litExpr({ t: "bool", v: true }) } }];
    } else if (pj.objects?.personalizeVisual) {
      delete pj.objects.personalizeVisual;
      if (Object.keys(pj.objects).length === 0) delete pj.objects;
    }
  }
}

// ---- phone layout ------------------------------------------------------------------------------
// A visual is part of the phone layout when it has a mobile.json with its own position; the canvas of the phone layout
// is MOBILE_WIDTH wide and grows downward.

export const MOBILE_WIDTH = 320;
export const MOBILE_MIN_HEIGHT = 568;

function mobileOf(p: Project, page: string, visual: string): J | undefined {
  return files(p)[mobileKey(page, visual)];
}

/** The bottom of the lowest visual of the phone layout. */
function mobileBottom(p: Project, page: string): number {
  return Math.max(0, ...Object.keys(files(p)).filter((k) => k.startsWith(visualPrefix(page)) && k.endsWith("/mobile.json")).map((k) => (files(p)[k].position?.y ?? 0) + (files(p)[k].position?.height ?? 0)));
}

/** Adds a visual to the phone layout below the others, as wide as the phone canvas (or at the given position). */
export function placeMobile(p: Project, page: string, visual: string, pos?: Partial<Position>): void {
  const j = visualJson(p, page, visual);
  if (isGroupJson(j)) throw new ReportError("Groups are not part of the phone layout; place their visuals.");
  if (mobileOf(p, page, visual)) return;
  const d = j.position ?? {};
  const width = MOBILE_WIDTH - 16;
  const ratio = (d.height ?? 150) / Math.max(1, d.width ?? 200);
  const height = Math.round(Math.max(60, Math.min(MOBILE_MIN_HEIGHT - 16, width * ratio)));
  const y = mobileBottom(p, page);
  const z = Math.max(0, ...Object.keys(files(p)).filter((k) => k.startsWith(visualPrefix(page)) && k.endsWith("/mobile.json")).map((k) => files(p)[k].position?.z ?? 0)) + 1000;
  files(p)[mobileKey(page, visual)] = { $schema: MOBILE_SCHEMA, position: { x: 8, y: y + 8, z, width, height, tabOrder: z, ...pos } };
}

export function removeMobile(p: Project, page: string, visual: string): void {
  visualJson(p, page, visual);
  delete files(p)[mobileKey(page, visual)];
}

export function setMobilePosition(p: Project, page: string, visual: string, pos: Partial<Position>): void {
  const m = mobileOf(p, page, visual);
  if (!m) throw new ReportError("This visual is not on the phone layout.");
  const next = { ...m.position, ...pos };
  if (!(next.width >= 20 && next.height >= 20)) throw new ReportError("A visual must be at least 20 by 20 pixels.");
  m.position = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 100) / 100 : v]));
}

/** Builds the phone layout from the desktop one: visible visuals in reading order, one under the other. */
export function autoCreateMobile(p: Project, page: string): number {
  const vs = parsePage(p, page)?.visuals.filter((v) => !v.hidden && !v.parent && !isStaticDecoration(v.visualType)) ?? [];
  for (const v of vs) removeMobile(p, page, v.name);
  const ordered = [...vs].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  for (const v of ordered) placeMobile(p, page, v.name);
  return ordered.length;
}

const isStaticDecoration = (type: string): boolean => type === "pageNavigator" || type === "bookmarkNavigator";

// ---- groups ------------------------------------------------------------------------------------
// A group is a visual file with visualGroup instead of visual; its members name it in parentGroupName. Member
// positions are page positions, so moving a group moves them, and a group always covers its members.

const isGroupJson = (j: J): boolean => !!j?.visualGroup;

const itemsOf = (p: Project, page: string): J[] =>
  Object.keys(files(p))
    .filter((k) => k.startsWith(visualPrefix(page)) && k.endsWith("/visual.json"))
    .map((k) => files(p)[k]);

const membersOf = (p: Project, page: string, group: string): J[] => itemsOf(p, page).filter((j) => j.parentGroupName === group);

/** Every visual and group below a group, at any depth. */
export function descendantsOf(p: Project, page: string, group: string): J[] {
  const out: J[] = [];
  for (const m of membersOf(p, page, group)) {
    out.push(m);
    if (isGroupJson(m)) out.push(...descendantsOf(p, page, m.name));
  }
  return out;
}

function boundsOfJson(js: J[]): { x: number; y: number; width: number; height: number } {
  const x = Math.min(...js.map((j) => j.position?.x ?? 0));
  const y = Math.min(...js.map((j) => j.position?.y ?? 0));
  return { x, y, width: Math.max(...js.map((j) => (j.position?.x ?? 0) + (j.position?.width ?? 0))) - x, height: Math.max(...js.map((j) => (j.position?.y ?? 0) + (j.position?.height ?? 0))) - y };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A group moved or resized: the members follow (ScaleMode scales them with the box, ScrollMode only moves them). */
function transformMembers(p: Project, page: string, group: J, old: { x?: number; y?: number; width?: number; height?: number }): void {
  const n = group.position;
  const ox = old.x ?? 0;
  const oy = old.y ?? 0;
  const scale = group.visualGroup.groupMode !== "ScrollMode";
  const sx = scale && old.width ? n.width / old.width : 1;
  const sy = scale && old.height ? n.height / old.height : 1;
  for (const m of descendantsOf(p, page, group.name)) {
    const mp = m.position ?? {};
    m.position = {
      ...mp,
      x: round2(n.x + ((mp.x ?? 0) - ox) * sx),
      y: round2(n.y + ((mp.y ?? 0) - oy) * sy),
      width: round2((mp.width ?? 0) * sx),
      height: round2((mp.height ?? 0) * sy),
    };
  }
  refitAncestors(p, page, group);
}

/** After a member changed: every group above it covers its members again. */
function refitAncestors(p: Project, page: string, item: J): void {
  let parent = typeof item.parentGroupName === "string" ? files(p)[visualKey(page, item.parentGroupName)] : undefined;
  const guard = new Set<string>();
  while (parent && !guard.has(parent.name)) {
    guard.add(parent.name);
    const members = membersOf(p, page, parent.name);
    if (members.length > 0) {
      const b = boundsOfJson(members);
      parent.position = { ...parent.position, x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) };
    }
    parent = typeof parent.parentGroupName === "string" ? files(p)[visualKey(page, parent.parentGroupName)] : undefined;
  }
}

const groupName = (p: Project, page: string): string => {
  const used = new Set(itemsOf(p, page).filter(isGroupJson).map((j) => j.visualGroup.displayName));
  for (let i = 1; ; i++) if (!used.has(`Group ${i}`)) return `Group ${i}`;
};

/** Groups two or more visuals or groups that are at the same level; returns the new group's name. */
export function groupVisuals(p: Project, page: string, names: string[], newId: () => string = newName): string {
  if (names.length < 2) throw new ReportError("Select at least two visuals to group them.");
  const js = names.map((n) => visualJson(p, page, n));
  if (new Set(js.map((j) => j.parentGroupName ?? "")).size > 1) throw new ReportError("Visuals in different groups cannot be grouped together; select them at the same level.");
  const b = boundsOfJson(js);
  const z = Math.max(...js.map((j) => j.position?.z ?? 0));
  const parent = js[0].parentGroupName;
  const g: J = {
    $schema: VISUAL_SCHEMA,
    name: newId(),
    position: { x: round2(b.x), y: round2(b.y), z, width: round2(b.width), height: round2(b.height), tabOrder: z },
    visualGroup: { displayName: groupName(p, page), groupMode: "ScaleMode" },
    ...(parent ? { parentGroupName: parent } : {}),
  };
  files(p)[visualKey(page, g.name)] = g;
  for (const j of js) j.parentGroupName = g.name;
  return g.name;
}

/** Dissolves a group: its members take its place in the next group up, or on the page. */
export function ungroup(p: Project, page: string, group: string): string[] {
  const g = visualJson(p, page, group);
  if (!isGroupJson(g)) throw new ReportError(`"${group}" is not a group.`);
  const members = membersOf(p, page, group);
  for (const m of members) {
    if (g.parentGroupName) m.parentGroupName = g.parentGroupName;
    else delete m.parentGroupName;
  }
  delete files(p)[visualKey(page, group)];
  const parent = g.parentGroupName ? files(p)[visualKey(page, g.parentGroupName)] : undefined;
  if (parent) refitAncestors(p, page, members[0] ?? g);
  return members.map((m) => m.name as string);
}

export function renameGroup(p: Project, page: string, group: string, displayName: string): void {
  const g = visualJson(p, page, group);
  if (!isGroupJson(g)) throw new ReportError(`"${group}" is not a group.`);
  const name = displayName.trim();
  if (!name) throw new ReportError("A group needs a name.");
  g.visualGroup.displayName = name;
}

export function setGroupFormat(p: Project, page: string, group: string, object: string, prop: string, value: Lit | null): void {
  const g = visualJson(p, page, group);
  if (!isGroupJson(g)) throw new ReportError(`"${group}" is not a group.`);
  setGroupFormatJson(g, object, prop, value);
}

export function setGroupMode(p: Project, page: string, group: string, mode: "ScaleMode" | "ScrollMode"): void {
  const g = visualJson(p, page, group);
  if (!isGroupJson(g)) throw new ReportError(`"${group}" is not a group.`);
  g.visualGroup.groupMode = mode;
}

/** The names of an item and everything below it (for copying and deleting a group with its members). */
export function withDescendants(p: Project, page: string, names: string[]): string[] {
  const all = new Set<string>();
  for (const n of names) {
    const j = visualJson(p, page, n);
    all.add(n);
    if (isGroupJson(j)) for (const d of descendantsOf(p, page, n)) all.add(d.name);
  }
  return [...all];
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

/**
 * Sets (or with null removes) one formatting property. `fixed` properties identify what an entry is (the statistic of a
 * reference line): they are written with any value and removed with the entry's last other property.
 */
export function setVisualFormat(p: Project, page: string, visual: string, object: string, prop: string, value: Lit | null, selector?: string, fixed?: Record<string, string | number | boolean>): void {
  const json = visualJson(p, page, visual);
  setFormat(json, object, prop, value, selector);
  if (!fixed) return;
  const keys = Object.keys(fixed);
  const asLit = (v: string | number | boolean): Lit => (typeof v === "string" ? { t: "string", v } : typeof v === "number" ? { t: "number", v } : { t: "bool", v });
  if (value !== null) {
    for (const k of keys) setFormat(json, object, k, asLit(fixed[k]), selector);
  } else if (entryProps(json, object, keys[0], selector).every((k) => keys.includes(k))) {
    for (const k of keys) setFormat(json, object, k, null, selector);
  }
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
      if (idx) idx.items = (idx.items ?? []).map((i: J) => (Array.isArray(i.children) ? { ...i, children: i.children.filter((c: string) => c !== v.name) } : i)).filter((i: J) => (Array.isArray(i.children) ? i.children.length > 0 : i.name !== v.name));
      const r = files(p)["report.json"];
      if (r?.annotations) r.annotations = r.annotations.filter((a: J) => a.name !== `biforge.bookmark.${v.name}`);
    }
  }
}

export { activePageName, parsePage, parseVisual };
export type { VisualModel };
