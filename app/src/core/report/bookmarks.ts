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

export function listBookmarks(p: Project): BookmarkInfo[] {
  const order: string[] = (files(p)[INDEX]?.items ?? []).map((i: J) => i.name);
  return order.flatMap((id) => {
    const f = files(p)[fileKey(id)];
    if (!f) return [];
    const o = f.options ?? {};
    return [
      {
        id,
        name: f.displayName ?? id,
        page: f.explorationState?.activeSection ?? "",
        options: { data: !o.suppressData, display: !o.suppressDisplay, currentPage: !!o.suppressActiveSection },
      },
    ];
  });
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
  const idx = index(p);
  idx.items = idx.items.filter((i: J) => i.name !== id);
  const r = files(p)["report.json"];
  r.annotations = (r.annotations ?? []).filter((a: J) => a.name !== ANN + id);
  if (!r.annotations.length) delete r.annotations;
  if (!idx.items.length) delete files(p)[INDEX];
}

export function moveBookmark(p: Project, id: string, toIndex: number): void {
  const idx = index(p);
  const items = idx.items.filter((i: J) => i.name !== id);
  if (items.length === idx.items.length) throw new ReportError("That bookmark does not exist.");
  items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, { name: id });
  idx.items = items;
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
