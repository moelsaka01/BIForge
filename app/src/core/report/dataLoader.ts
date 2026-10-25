// Runs the queries of the visuals on a page through the DAX engine, with caching of identical queries.
import type { DaxApi, QueryResult } from "../dax/types";
import type { Project } from "../model/types";
import { decodeCell, type Value } from "./cells";
import { filtersFor, resolveInteraction, selectionTuples, type RuntimeFilters, type Selection } from "./interactions";
import { modelInfo, type ModelInfo } from "./modelInfo";
import {
  buildMatrixQuery,
  buildRangeQuery,
  buildTotalsQuery,
  buildHierarchyQuery, buildSlicerQuery,
  buildVisualQuery,
  NO_DRILL,
  type BuiltMatrixQuery,
  type BuiltQuery,
  type HierarchyQuery,
  type DrillState,
  type QueryOptions,
  type SlicerQuery,
} from "./queryBuilder";
import type { FilterDef } from "./filters";
import type { PageModel, VisualModel } from "./visualDoc";
import { visualType } from "./visualTypes";
import { drillKey } from "./headerButtons";

/** Everything outside the document that changes what a visual shows. */
export interface ViewState {
  selection: Selection | null;
  drill: Record<string, DrillState>;
  drillthrough: RuntimeFilters["drillthrough"];
  /** Bumped when imported data changes, so cached results are dropped. */
  epoch: number;
}

export const EMPTY_VIEW: ViewState = { selection: null, drill: {}, drillthrough: [], epoch: 0 };

export type Loaded =
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "grouped"; query: BuiltQuery; rows: Value[][]; highlightRows: Value[][] | null; totals: Value[] | null; truncated: boolean; ms: number }
  | { kind: "matrix"; query: BuiltMatrixQuery; parts: Value[][][]; truncated: boolean; ms: number }
  | { kind: "hierarchy"; query: HierarchyQuery; rows: Value[][]; ms: number }
  | { kind: "slicer"; query: SlicerQuery; values: Value[]; range: { min: Value; max: Value } | null; ms: number };

const stampCache = new WeakMap<object, string>();
/** Cheap identity of the model's text, so that cached results are not reused after a model edit. */
function modelStamp(p: Project): string {
  let s = stampCache.get(p.model.tmdl);
  if (s === undefined) {
    const text = JSON.stringify(p.model.tmdl);
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    s = `${text.length}:${h}`;
    stampCache.set(p.model.tmdl, s);
  }
  return s;
}

export class ReportData {
  private cache = new Map<string, Promise<QueryResult[]>>();
  /** Number of queries sent to the engine (cache hits are not counted); used by tests. */
  sent = 0;

  constructor(private dax: DaxApi) {}

  clear(): void {
    this.cache.clear();
  }

  private run(project: Project, epoch: number, query: string): Promise<QueryResult[]> {
    const key = `${epoch}|${modelStamp(project)}|${query}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    this.sent++;
    const docs = Object.values(project.model.tmdl);
    const p = this.dax.query(docs, query).then((o) => o.results);
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value as string);
    return p;
  }

  /**
   * Runs a query of an analysis visual (a node of a decomposition tree, one explaining field of key influencers): the
   * synthetic visual says which fields, the filters are those the real visual is under plus the extra ones.
   */
  async rows(project: Project, page: PageModel, visual: VisualModel, view: ViewState, model: ModelInfo, synthetic: VisualModel, extra: FilterDef[] = []): Promise<{ query: BuiltQuery; rows: Value[][] } | null> {
    const filters = [...filtersFor(project, page, visual, { drillthrough: view.drillthrough }), ...extra];
    const q = buildVisualQuery(synthetic, model, { filters, drill: NO_DRILL });
    if (!q) return null;
    const [res] = await this.run(project, view.epoch, q.dax);
    return { query: q, rows: res.rows.map((r) => r.map(decodeCell)) };
  }

  /** Distinct values of a column (Filters pane lists), ordered like a slicer. */
  async distinct(project: Project, field: import("./fields").FieldRef, epoch: number, model: ModelInfo = modelInfo(project)): Promise<Value[]> {
    const q = buildSlicerQuery(field, model, []);
    const [res] = await this.run(project, epoch, q.dax);
    return res.rows.map((r) => decodeCell(r[0]));
  }

  /** Queries for one visual, given the current view state. Never throws: failures come back as `error`. */
  async load(project: Project, page: PageModel, visual: VisualModel, view: ViewState, model: ModelInfo = modelInfo(project)): Promise<Loaded> {
    try {
      return await this.loadInner(project, page, visual, view, model);
    } catch (e) {
      return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async loadInner(project: Project, page: PageModel, visual: VisualModel, view: ViewState, model: ModelInfo): Promise<Loaded> {
    const type = visualType(visual.visualType);
    if (!type) return { kind: "empty" };
    const started = performance.now();
    const rt: RuntimeFilters = { drillthrough: view.drillthrough };
    const filters = filtersFor(project, page, visual, rt);

    if (type.family === "slicer" && (visual.roles.Values?.length ?? 0) > 1) {
      const fields = visual.roles.Values.map((v) => v.field);
      if (fields.some((f) => f.kind !== "column")) return { kind: "error", message: "A hierarchy slicer takes columns only." };
      if (new Set(fields.map((f) => f.table)).size > 1) return { kind: "error", message: "All fields of a hierarchy slicer must come from one table." };
      const q = buildHierarchyQuery(fields, filters);
      const [res] = await this.run(project, view.epoch, q.dax);
      return { kind: "hierarchy", query: q, rows: res.rows.map((r) => r.map(decodeCell)), ms: performance.now() - started };
    }
    if (type.family === "slicer") {
      const field = visual.roles.Values?.[0]?.field;
      if (!field) return { kind: "empty" };
      const q = buildSlicerQuery(field, model, filters);
      const [res] = await this.run(project, view.epoch, q.dax);
      const values = res.rows.map((r) => decodeCell(r[0]));
      let range: { min: Value; max: Value } | null = null;
      const colType = model.columnType(field.table, field.name);
      if (colType === "int64" || colType === "double" || colType === "decimal" || colType === "dateTime") {
        const [r] = await this.run(project, view.epoch, buildRangeQuery(field, filters));
        range = r.rows[0] ? { min: decodeCell(r.rows[0][0]), max: decodeCell(r.rows[0][1]) } : null;
      }
      return { kind: "slicer", query: q, values, range, ms: performance.now() - started };
    }

    // what the current selection does to this visual
    let sel = view.selection;
    let mode: "filter" | "highlight" | "none" = "none";
    if (sel && sel.page === page.name) {
      const src = page.visuals.find((v) => v.name === sel!.visual);
      mode = src ? resolveInteraction(page, src, visual) : "none";
    } else sel = null;
    // a matrix without a drill position shows all its levels, a chart starts at its first one
    const matrix = visualType(visual.visualType)?.family === "matrix";
    const base: QueryOptions = { filters, drill: matrix ? view.drill[visual.name] : (view.drill[visual.name] ?? NO_DRILL), columnsDrill: view.drill[drillKey(visual.name, "Columns")] };
    if (mode === "filter") base.tuples = selectionTuples(sel, mode);

    if (type.family === "matrix") {
      const q = buildMatrixQuery(visual, model, base);
      if (!q) return { kind: "empty" };
      const results = await this.run(project, view.epoch, q.dax);
      return { kind: "matrix", query: q, parts: results.map((r) => r.rows.map((row) => row.map(decodeCell))), truncated: results.some((r) => r.truncated), ms: performance.now() - started };
    }

    const q = buildVisualQuery(visual, model, base);
    if (!q) return { kind: "empty" };
    const [res] = await this.run(project, view.epoch, q.dax);
    let highlightRows: Value[][] | null = null;
    if (mode === "highlight") {
      const hq = buildVisualQuery(visual, model, { ...base, tuples: selectionTuples(sel, "highlight") });
      if (hq) highlightRows = (await this.run(project, view.epoch, hq.dax))[0].rows.map((r) => r.map(decodeCell));
    }
    let totals: Value[] | null = null;
    if (type.family === "table" && q.columns.some((c) => c.kind === "group")) {
      const tq = buildTotalsQuery(visual, model, base);
      if (tq) totals = (await this.run(project, view.epoch, tq.dax))[0].rows[0]?.map(decodeCell) ?? null;
    }
    return { kind: "grouped", query: q, rows: res.rows.map((r) => r.map(decodeCell)), highlightRows, totals, truncated: res.truncated, ms: performance.now() - started };
  }
}
