// Bookmarks: a saved view of a page (its filters and slicer selections, which visuals are hidden, drill position and
// selected data points). The bookmark file keeps what the PBIR bookmark schema describes (the page and the hidden
// visuals); the rest of the state is stored as a BIForge annotation on the report, which Power BI ignores.
import type { Project } from "../model/types";
import { readFilters, writeFilters, type FilterDef } from "./filters";
import type { Selection } from "./interactions";
import type { J } from "./pbir";
import type { DrillState } from "./queryBuilder";
import { ReportError } from "./reportOps";
import { listPageNames, newName, visualKey, visualPrefix } from "./visualDoc";

const SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/bookmark/2.1.0/schema.json";
const INDEX_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/bookmarksMetadata/1.0.0/schema.json";
const INDEX = "bookmarks/bookmarks.json";
const ANN = "biforge.bookmark.";

export interface BookmarkOptions {
  /** Apply filters, slicer selections, drill position and selection. */
  data: boolean;
  /** Apply which visuals are shown or hidden. */
  display: boolean;
  /** Stay on the page that is open instead of switching to the bookmark's page. */
  currentPage: boolean;
}

export const DEFAULT_OPTIONS: BookmarkOptions = { data: true, display: true, currentPage: false };

export interface RuntimeState {
  selection: Selection | null;
  drill: Record<string, DrillState>;
}

interface BookmarkData {
  report: FilterDef[];
  pageFilters: FilterDef[];
  visuals: Record<string, { filters: FilterDef[]; hidden: boolean }>;
  runtime: RuntimeState;
}

export interface BookmarkInfo {
  id: string;
  name: string;
  page: string;
  options: BookmarkOptions;
  /** The bookmark group this bookmark is in (its name in the index), if any. */
  group?: string;
}

export interface BookmarkGroup {
  id: string;
  name: string;
  /** Bookmark ids in order. */
  children: string[];
}

const files = (p: Project) => p.report.files as Record<string, J>;
const fileKey = (id: string) => `bookmarks/${id}.bookmark.json`;

function annotations(p: Project): { name: string; value: string }[] {
  const r = (files(p)["report.json"] ??= {});
  return (r.annotations ??= []);
}

function getData(p: Project, id: string): BookmarkData | null {
  const a = annotations(p).find((x) => x.name === ANN + id);
  if (!a) return null;
  try {
    return JSON.parse(a.value) as BookmarkData;
  } catch {
    return null;
  }
}

function setData(p: Project, id: string, data: BookmarkData): void {
  const anns = annotations(p);
  const i = anns.findIndex((x) => x.name === ANN + id);
  const a = { name: ANN + id, value: JSON.stringify(data) };
  if (i >= 0) anns[i] = a;
  else anns.push(a);
}

function index(p: Project): J {
  return (files(p)[INDEX] ??= { $schema: INDEX_SCHEMA, items: [] });
}

const isGroup = (i: J) => Array.isArray(i?.children);

/** Bookmarks in display order: groups are flattened in place, each member carrying its group. */
export function listBookmarks(p: Project): BookmarkInfo[] {
  const order: { id: string; group?: string }[] = (files(p)[INDEX]?.items ?? []).flatMap((i: J) =>
    isGroup(i) ? (i.children as string[]).map((id) => ({ id, group: i.name as string })) : [{ id: i.name as string }],
  );
  return order.flatMap(({ id, group }) => {
    const f = files(p)[fileKey(id)];
    if (!f) return [];
    const o = f.options ?? {};
    return [
      {
        id,
        name: f.displayName ?? id,
        page: f.explorationState?.activeSection ?? "",
        options: { data: !o.suppressData, display: !o.suppressDisplay, currentPage: !!o.suppressActiveSection },
        ...(group ? { group } : {}),
      },
    ];
  });
}

export function listBookmarkGroups(p: Project): BookmarkGroup[] {
  return (files(p)[INDEX]?.items ?? []).filter(isGroup).map((g: J) => ({ id: g.name, name: g.displayName ?? g.name, children: [...g.children] }));
}

const groupItem = (p: Project, id: string): J => {
  const g = (files(p)[INDEX]?.items ?? []).find((i: J) => isGroup(i) && i.name === id);
  if (!g) throw new ReportError("That bookmark group does not exist.");
  return g;
};

/** Removes the bookmark from wherever it is in the index (top level or a group); an emptied group disappears. */
function detach(p: Project, id: string): void {
  const idx = index(p);
  idx.items = idx.items
    .map((i: J) => (isGroup(i) ? { ...i, children: i.children.filter((c: string) => c !== id) } : i))
    .filter((i: J) => (isGroup(i) ? i.children.length > 0 : i.name !== id));
}

const groupNameTaken = (p: Project, name: string, except?: string) => listBookmarkGroups(p).some((g) => g.id !== except && g.name.toLowerCase() === name.toLowerCase());

/** Puts the bookmarks (in the order given) into a new group at the position of the first of them. */
export function createGroup(p: Project, displayName: string, ids: string[], newId: () => string = newName): string {
  const n = displayName.trim();
  if (!n) throw new ReportError("A bookmark group needs a name.");
  if (groupNameTaken(p, n)) throw new ReportError(`A bookmark group named "${n}" already exists.`);
  const known = new Set(listBookmarks(p).map((b) => b.id));
  const members = ids.filter((id) => known.has(id));
  if (members.length === 0) throw new ReportError("Choose at least one bookmark for the group.");
  const idx = index(p);
  const at = idx.items.findIndex((i: J) => (isGroup(i) ? i.children.some((c: string) => members.includes(c)) : members.includes(i.name)));
  members.forEach((m) => detach(p, m)); // nothing before position `at` held a member, so `at` is still the right place
  const gid = newId();
  const items: J[] = index(p).items;
  items.splice(Math.min(Math.max(at, 0), items.length), 0, { name: gid, displayName: n, children: members });
  return gid;
}

export function renameGroup(p: Project, id: string, displayName: string): void {
  const g = groupItem(p, id);
  const n = displayName.trim();
  if (!n) throw new ReportError("A bookmark group needs a name.");
  if (groupNameTaken(p, n, id)) throw new ReportError(`A bookmark group named "${n}" already exists.`);
  g.displayName = n;
}

/** Dissolves the group; its bookmarks stay, in the same place, at the top level. */
export function ungroup(p: Project, id: string): void {
  const g = groupItem(p, id);
  const idx = index(p);
  idx.items = idx.items.flatMap((i: J) => (i === g ? g.children.map((c: string) => ({ name: c })) : [i]));
}

/** Deletes the group and the bookmarks in it. */
export function deleteGroup(p: Project, id: string): void {
  const g = groupItem(p, id);
  for (const c of [...g.children]) deleteBookmark(p, c);
}

/** Moves a bookmark into a group (at the end) or, with null, out of its group to the end of the list. */
export function moveToGroup(p: Project, id: string, group: string | null): void {
  if (!files(p)[fileKey(id)]) throw new ReportError("That bookmark does not exist.");
  const target = group ? groupItem(p, group) : null;
  detach(p, id);
  const items: J[] = index(p).items;
  if (target) (items.find((i: J) => i.name === target.name) as J).children.push(id);
  else items.push({ name: id });
}

function capture(p: Project, page: string, runtime: RuntimeState): BookmarkData {
  const pj = files(p)[`pages/${page}/page.json`];
  if (!pj) throw new ReportError(`Page "${page}" does not exist.`);
  const visuals: BookmarkData["visuals"] = {};
  for (const k of Object.keys(files(p))) {
    const m = k.startsWith(visualPrefix(page)) && /\/visuals\/([^/]+)\/visual\.json$/.exec(k);
    if (!m) continue;
    const v = files(p)[k];
    visuals[m[1]] = { filters: readFilters(v).defs, hidden: v.isHidden === true };
  }
  return { report: readFilters(files(p)["report.json"]).defs, pageFilters: readFilters(pj).defs, visuals, runtime: structuredClone(runtime) };
}

function writeFile(p: Project, id: string, name: string, page: string, options: BookmarkOptions, data: BookmarkData): void {
  const visualContainers: J = {};
  for (const [v, st] of Object.entries(data.visuals)) {
    const vt = files(p)[visualKey(page, v)]?.visual?.visualType;
    if (st.hidden && vt) visualContainers[v] = { singleVisual: { visualType: vt, display: { mode: "hidden" } } };
  }
  files(p)[fileKey(id)] = {
    $schema: SCHEMA,
    displayName: name,
    name: id,
    options: { ...(options.data ? {} : { suppressData: true }), ...(options.display ? {} : { suppressDisplay: true }), ...(options.currentPage ? { suppressActiveSection: true } : {}) },
    explorationState: { version: "1.3", activeSection: page, sections: { [page]: { visualContainers } } },
  };
}

export function createBookmark(p: Project, displayName: string, page: string, runtime: RuntimeState, options: BookmarkOptions = DEFAULT_OPTIONS, newId: () => string = newName): string {
  const name = displayName.trim() || `Bookmark ${listBookmarks(p).length + 1}`;
  if (listBookmarks(p).some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new ReportError(`A bookmark named "${name}" already exists.`);
  const id = newId();
  const data = capture(p, page, runtime);
  writeFile(p, id, name, page, options, data);
  setData(p, id, data);
  index(p).items.push({ name: id });
  return id;
}

/** Re-captures the current state into an existing bookmark. */
export function updateBookmark(p: Project, id: string, page: string, runtime: RuntimeState): void {
  const info = listBookmarks(p).find((b) => b.id === id);
  if (!info) throw new ReportError("That bookmark does not exist.");
  const data = capture(p, page, runtime);
  writeFile(p, id, info.name, page, info.options, data);
  setData(p, id, data);
}

export function setBookmarkOptions(p: Project, id: string, options: BookmarkOptions): void {
  const info = listBookmarks(p).find((b) => b.id === id);
  if (!info) throw new ReportError("That bookmark does not exist.");
  const data = getData(p, id);
  if (!data) throw new ReportError("The bookmark has no saved state.");
  writeFile(p, id, info.name, info.page, options, data);
}

export function renameBookmark(p: Project, id: string, displayName: string): void {
  const f = files(p)[fileKey(id)];
  if (!f) throw new ReportError("That bookmark does not exist.");
  const n = displayName.trim();
  if (!n) throw new ReportError("A bookmark needs a name.");
  if (listBookmarks(p).some((b) => b.id !== id && b.name.toLowerCase() === n.toLowerCase())) throw new ReportError(`A bookmark named "${n}" already exists.`);
  f.displayName = n;
}

export function deleteBookmark(p: Project, id: string): void {
  if (!files(p)[fileKey(id)]) throw new ReportError("That bookmark does not exist.");
  delete files(p)[fileKey(id)];
  detach(p, id);
  const idx = index(p);
  const r = files(p)["report.json"];
  r.annotations = (r.annotations ?? []).filter((a: J) => a.name !== ANN + id);
  if (!r.annotations.length) delete r.annotations;
  if (!idx.items.length) delete files(p)[INDEX];
}

/** Moves a bookmark to `toIndex` of the displayed list, within the group (or the top level) it is in. */
export function moveBookmark(p: Project, id: string, toIndex: number): void {
  const flat = listBookmarks(p);
  const me = flat.find((b) => b.id === id);
  if (!me) throw new ReportError("That bookmark does not exist.");
  const idx = index(p);
  const container: string[] | null = me.group ? (groupItem(p, me.group).children as string[]) : null;
  const top: J[] = idx.items;
  const names = container ?? top.filter((i: J) => !isGroup(i)).map((i: J) => i.name as string);
  const peers = flat.filter((b) => (b.group ?? null) === (me.group ?? null)).map((b) => b.id);
  const target = flat[Math.max(0, Math.min(flat.length - 1, toIndex))];
  const local = target && (target.group ?? null) === (me.group ?? null) ? peers.indexOf(target.id) : toIndex < flat.indexOf(me) ? 0 : peers.length - 1;
  const rest = names.filter((n) => n !== id);
  rest.splice(Math.max(0, Math.min(rest.length, local)), 0, id);
  if (container) {
    container.splice(0, container.length, ...rest);
  } else {
    // top-level standalone bookmarks are reordered among themselves; groups keep their positions
    const queue = [...rest];
    idx.items = top.map((i: J) => (isGroup(i) ? i : { name: queue.shift() as string }));
  }
}

export interface Applied {
  page: string;
  runtime: RuntimeState | null;
}

/** Applies the bookmark to the document draft and says which page to show and which view state to restore. */
export function applyBookmark(p: Project, id: string, currentPage: string): Applied {
  const info = listBookmarks(p).find((b) => b.id === id);
  if (!info) throw new ReportError("That bookmark does not exist.");
  const data = getData(p, id);
  const pageNames = listPageNames(p);
  const page = info.options.currentPage ? currentPage : info.page;
  if (!pageNames.includes(page)) throw new ReportError("The page of this bookmark no longer exists.");
  if (!data) return { page, runtime: null };
  const onPage = info.page;
  if (info.options.data) {
    const r = files(p)["report.json"];
    writeFilters(r, data.report, readFilters(r).opaque);
    const pj = files(p)[`pages/${onPage}/page.json`];
    if (pj) writeFilters(pj, data.pageFilters, readFilters(pj).opaque);
  }
  for (const [v, st] of Object.entries(data.visuals)) {
    const vj = files(p)[visualKey(onPage, v)];
    if (!vj) continue;
    if (info.options.data) writeFilters(vj, st.filters, readFilters(vj).opaque);
    if (info.options.display) {
      if (st.hidden) vj.isHidden = true;
      else delete vj.isHidden;
    }
  }
  return { page, runtime: info.options.data ? data.runtime : null };
}
