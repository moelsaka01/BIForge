// Reading and editing page and visual JSON documents (PBIR layout). Edits mutate the given JSON in place;
// callers pass a draft clone (see DocumentStore.transact). Unknown properties are preserved.
import type { Project } from "../model/types";
import { isContainerProp } from "../format/capabilities";
import { propKind } from "../format/capabilities";
import { fieldFromPbir, fieldToPbir, litExpr, queryRefOf, readLitProp, type J } from "./pbir";
import { fieldLabel, sameField, type FieldRef, type Lit } from "./fields";
import { readFilters, type ReadFilters } from "./filters";

export const VISUAL_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.13.0/schema.json";
export const PAGE_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json";
export const PAGES_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.1.0/schema.json";

export const pagesKey = "pages/pages.json";
export const pageKey = (page: string) => `pages/${page}/page.json`;
export const visualKey = (page: string, visual: string) => `pages/${page}/visuals/${visual}/visual.json`;
export const visualPrefix = (page: string) => `pages/${page}/visuals/`;

/** 20-hex-character object name, like the ones Power BI Desktop generates. */
export function newName(): string {
  const b = new Uint8Array(10);
  (globalThis.crypto ?? { getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export interface Position {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  tabOrder?: number;
}

export interface Projection {
  field: FieldRef;
  displayName?: string;
}

export interface SortSpec {
  field: FieldRef;
  dir: "asc" | "desc";
}

/** A group of visuals (visualGroup in the report format). Positions of its members are page positions. */
export interface GroupModel {
  name: string;
  pageName: string;
  displayName: string;
  /** ScaleMode: members scale when the group is resized; ScrollMode: they keep their size. */
  mode: "ScaleMode" | "ScrollMode";
  position: Position;
  hidden: boolean;
  /** The group this group is in. */
  parent?: string;
  json: J;
}

export interface VisualModel {
  name: string;
  pageName: string;
  visualType: string;
  position: Position;
  roles: Record<string, Projection[]>;
  sort: SortSpec | null;
  hidden: boolean;
  /** The group this visual is in. */
  parent?: string;
  /** Where it is on the phone layout (mobile.json), when it is part of it. */
  mobile?: Position;
  filters: ReadFilters;
  json: J;
}

export interface PageModel {
  name: string;
  displayName: string;
  width: number;
  height: number;
  /** "Drillthrough" or "Tooltip" pages are special; undefined for a normal page. */
  type?: "Drillthrough" | "Tooltip";
  hidden: boolean;
  visuals: VisualModel[];
  groups: GroupModel[];
  filters: ReadFilters;
  interactions: { source: string; target: string; type: "Default" | "DataFilter" | "HighlightFilter" | "NoFilter" }[];
  json: J;
}

export const MOBILE_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainerMobileState/2.8.0/schema.json";
export const mobileKey = (page: string, visual: string) => `pages/${page}/visuals/${visual}/mobile.json`;

export function parseVisual(pageName: string, json: J): VisualModel | null {
  if (!json || typeof json.name !== "string" || !json.visual || typeof json.visual.visualType !== "string") return null;
  const roles: Record<string, Projection[]> = {};
  for (const [role, st] of Object.entries<J>(json.visual.query?.queryState ?? {})) {
    const list: Projection[] = [];
    for (const p of st.projections ?? []) {
      const field = fieldFromPbir(p.field);
      if (field) list.push({ field, ...(p.displayName ? { displayName: p.displayName } : {}) });
    }
    roles[role] = list;
  }
  const s = json.visual.query?.sortDefinition?.sort?.[0];
  const sf = s ? fieldFromPbir(s.field) : null;
  const pos = json.position ?? {};
  return {
    name: json.name,
    pageName,
    visualType: json.visual.visualType,
    position: { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0, width: pos.width ?? 200, height: pos.height ?? 150, ...(pos.tabOrder !== undefined ? { tabOrder: pos.tabOrder } : {}) },
    roles,
    sort: sf ? { field: sf, dir: s.direction === 2 || s.direction === "Descending" ? "desc" : "asc" } : null,
    hidden: json.isHidden === true,
    ...(typeof json.parentGroupName === "string" ? { parent: json.parentGroupName } : {}),
    filters: readFilters(json),
    json,
  };
}

const readPosition = (json: J): Position => {
  const pos = json.position ?? {};
  return { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0, width: pos.width ?? 200, height: pos.height ?? 150, ...(pos.tabOrder !== undefined ? { tabOrder: pos.tabOrder } : {}) };
};

export function parseGroup(pageName: string, json: J): GroupModel | null {
  if (!json || typeof json.name !== "string" || !json.visualGroup) return null;
  return {
    name: json.name,
    pageName,
    displayName: typeof json.visualGroup.displayName === "string" ? json.visualGroup.displayName : "Group",
    mode: json.visualGroup.groupMode === "ScrollMode" ? "ScrollMode" : "ScaleMode",
    position: readPosition(json),
    hidden: json.isHidden === true,
    ...(typeof json.parentGroupName === "string" ? { parent: json.parentGroupName } : {}),
    json,
  };
}

export function listPageNames(p: Project): string[] {
  const order: unknown = (p.report.files[pagesKey] as J)?.pageOrder;
  const known = Object.keys(p.report.files)
    .map((k) => /^pages\/([^/]+)\/page\.json$/.exec(k)?.[1])
    .filter((x): x is string => !!x);
  const ordered = Array.isArray(order) ? order.filter((n): n is string => typeof n === "string" && known.includes(n)) : [];
  return [...ordered, ...known.filter((n) => !ordered.includes(n)).sort()];
}

export function parsePage(p: Project, name: string): PageModel | null {
  const json = p.report.files[pageKey(name)] as J;
  if (!json) return null;
  const prefix = visualPrefix(name);
  const keys = Object.keys(p.report.files).filter((k) => k.startsWith(prefix) && k.endsWith("/visual.json"));
  const visuals = keys
    .map((k) => parseVisual(name, p.report.files[k]))
    .filter((v): v is VisualModel => v !== null)
    .map((v) => {
      const m = p.report.files[mobileKey(name, v.name)] as J | undefined;
      return m?.position ? { ...v, mobile: readPosition(m) } : v;
    })
    .sort((a, b) => a.position.z - b.position.z || a.name.localeCompare(b.name));
  const groups = keys
    .map((k) => parseGroup(name, p.report.files[k]))
    .filter((g): g is GroupModel => g !== null)
    .sort((a, b) => a.position.z - b.position.z || a.name.localeCompare(b.name));
  return {
    name,
    displayName: json.displayName ?? name,
    width: json.width ?? 1280,
    height: json.height ?? 720,
    ...(json.type === "Drillthrough" || json.type === "Tooltip" ? { type: json.type } : {}),
    hidden: json.visibility === "HiddenInViewMode",
    visuals,
    groups,
    filters: readFilters(json),
    interactions: json.visualInteractions ?? [],
    json,
  };
}

export function listPages(p: Project): PageModel[] {
  return listPageNames(p).map((n) => parsePage(p, n)).filter((x): x is PageModel => x !== null);
}

export function activePageName(p: Project): string | null {
  const names = listPageNames(p);
  const a = (p.report.files[pagesKey] as J)?.activePageName;
  return typeof a === "string" && names.includes(a) ? a : (names[0] ?? null);
}

// ---- projections --------------------------------------------------------------------------

export function projectionJson(pr: Projection): J {
  return {
    field: fieldToPbir(pr.field),
    queryRef: queryRefOf(pr.field),
    nativeQueryRef: pr.field.kind === "agg" ? fieldLabel(pr.field) : pr.field.name,
    ...(pr.displayName ? { displayName: pr.displayName } : {}),
  };
}

export function setRole(json: J, role: string, list: Projection[]): void {
  json.visual.query ??= { queryState: {} };
  json.visual.query.queryState ??= {};
  if (list.length === 0) {
    delete json.visual.query.queryState[role];
    return;
  }
  json.visual.query.queryState[role] = { projections: list.map(projectionJson) };
}

export function hasField(list: Projection[], f: FieldRef): boolean {
  return list.some((x) => sameField(x.field, f));
}

// ---- formatting objects ---------------------------------------------------------------------

/**
 * Where a formatting object lives. PBIR keeps the general container settings (title, background, border, shadow,
 * tooltip, alt text, ...) in visual.visualContainerObjects and everything else in visual.objects.
 */
export { CONTAINER_OBJECTS } from "../format/capabilities";

const bagKey = (object: string, prop: string) => (isContainerProp(object, prop) ? "visualContainerObjects" : "objects");

function bag(json: J, object: string, prop: string): J {
  const key = bagKey(object, prop);
  json.visual ??= {};
  json.visual[key] ??= {};
  return json.visual[key];
}

/**
 * A selector argument: a field's queryRef (stored as selector.metadata, the series an entry formats) or "id:<name>"
 * (stored as selector.id, a user-defined instance such as one reference line).
 */
export function selectorOf(selector: string): J {
  return selector.startsWith("id:") ? { id: selector.slice(3) } : { metadata: selector };
}

function entryFor(list: J[] | undefined, selector?: string): J | undefined {
  if (selector === undefined) return (list ?? []).find((e) => !e.selector);
  const want = selectorOf(selector);
  return (list ?? []).find((e) => (want.id !== undefined ? e.selector?.id === want.id : e.selector?.metadata === want.metadata));
}

/** Reads a literal formatting property; selector is a queryRef for per-series settings. */
export function getFormat(json: J, object: string, prop: string, selector?: string): Lit | null {
  const e = entryFor(json?.visual?.[bagKey(object, prop)]?.[object], selector);
  return e ? readLitProp(e.properties?.[prop]) : null;
}

/**
 * A group keeps its formatting in visualGroup.objects (background, lock aspect, alt text) with the same entry shape as
 * the container objects of a visual; these read and write through that shape.
 */
const groupBag = (group: J, create: boolean): J => {
  if (create) group.visualGroup.objects ??= {};
  return { visual: { visualContainerObjects: group.visualGroup?.objects ?? {} } };
};

export function getGroupFormat(group: J, object: string, prop: string): Lit | null {
  return getFormat(groupBag(group, false), object, prop);
}

export function setGroupFormat(group: J, object: string, prop: string, value: Lit | null): void {
  const wrapper = groupBag(group, true);
  setFormat(wrapper, object, prop, value);
  if (Object.keys(group.visualGroup.objects).length === 0) delete group.visualGroup.objects;
}

/** Names of the properties set on one entry of an object (the entry a property of the given name would be written to). */
export function entryProps(json: J, object: string, prop: string, selector?: string): string[] {
  const e = entryFor(json?.visual?.[bagKey(object, prop)]?.[object], selector);
  return e ? Object.keys(e.properties ?? {}) : [];
}

const isColorProp = (prop: string) => /color$/i.test(prop) || prop === "fill" || prop === "defaultColor";

/** Whether a property holds a color (stored as a solid fill): by the schema when the visual type is known, else by name. */
function colorProp(json: J, object: string, prop: string): boolean {
  const k = propKind(json?.visual?.visualType ?? "", object, prop);
  return k ? k[0] === "c" : isColorProp(prop);
}

/** Sets (or, with null, removes) a literal formatting property. */
export function setFormat(json: J, object: string, prop: string, value: Lit | null, selector?: string): void {
  const b = bag(json, object, prop);
  const list: J[] = (b[object] ??= []);
  let e = entryFor(list, selector);
  if (value === null) {
    if (!e) {
      if (list.length === 0) delete b[object];
      return;
    }
    delete e.properties[prop];
    if (Object.keys(e.properties).length === 0) list.splice(list.indexOf(e), 1);
    if (list.length === 0) delete b[object];
    return;
  }
  if (!e) {
    e = { ...(selector !== undefined ? { selector: selectorOf(selector) } : {}), properties: {} };
    list.push(e);
  }
  e.properties[prop] = colorProp(json, object, prop) && value.t === "string" ? { solid: { color: litExpr(value) } } : litExpr(value);
}

export function getBool(json: J, object: string, prop: string, dflt: boolean, selector?: string): boolean {
  const l = getFormat(json, object, prop, selector);
  return l?.t === "bool" ? l.v : dflt;
}
export function getNum(json: J, object: string, prop: string, dflt: number, selector?: string): number {
  const l = getFormat(json, object, prop, selector);
  return l?.t === "number" ? l.v : dflt;
}
export function getStr(json: J, object: string, prop: string, dflt: string, selector?: string): string {
  const l = getFormat(json, object, prop, selector);
  return l?.t === "string" ? l.v : dflt;
}

/** Raw property node (for conditional-format expressions that are not plain literals). */
export function getRawProp(json: J, object: string, prop: string, selector?: string): J | undefined {
  return entryFor(json?.visual?.[bagKey(object, prop)]?.[object], selector)?.properties?.[prop];
}

export function setRawProp(json: J, object: string, prop: string, node: J | null, selector?: string): void {
  const b = bag(json, object, prop);
  const list: J[] = (b[object] ??= []);
  let e = entryFor(list, selector);
  if (node === null) {
    if (!e) {
      if (list.length === 0) delete b[object];
      return;
    }
    delete e.properties[prop];
    if (Object.keys(e.properties).length === 0) list.splice(list.indexOf(e), 1);
    if (list.length === 0) delete b[object];
    return;
  }
  if (!e) {
    e = { ...(selector !== undefined ? { selector: selectorOf(selector) } : {}), properties: {} };
    list.push(e);
  }
  e.properties[prop] = node;
}
