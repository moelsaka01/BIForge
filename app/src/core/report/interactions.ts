// How visuals affect each other: slicers, data point selection (cross-filter and cross-highlight), drillthrough.
// Pure functions over the report definition and the runtime selection state.
import type { Project } from "../model/types";
import { sameField, type FieldRef, type Lit } from "./fields";
import { readFilters, type FilterDef } from "./filters";
import type { TupleFilter } from "./queryBuilder";
import { parsePage, type PageModel, type VisualModel } from "./visualDoc";
import { visualType } from "./visualTypes";

/** A data point chosen by the user: the grouping fields of its visual and the point's value for each. */
export interface SelectedPoint {
  fields: FieldRef[];
  values: Lit[];
}

export interface Selection {
  page: string;
  visual: string;
  points: SelectedPoint[];
}

export type InteractionMode = "filter" | "highlight" | "none";

/** Visual types that can draw a highlighted part of their data (the others are filtered instead). */
const HIGHLIGHT_TARGETS = new Set([
  "clusteredBarChart",
  "stackedBarChart",
  "hundredPercentStackedBarChart",
  "clusteredColumnChart",
  "stackedColumnChart",
  "hundredPercentStackedColumnChart",
  "lineChart",
  "areaChart",
  "stackedAreaChart",
  "hundredPercentStackedAreaChart",
  "ribbonChart",
  "lineClusteredColumnComboChart",
  "pieChart",
  "donutChart",
]);

export const supportsHighlight = (typeId: string): boolean => HIGHLIGHT_TARGETS.has(typeId);

/** Visuals whose data points can be selected. */
export function isSelectable(typeId: string): boolean {
  const f = visualType(typeId)?.family;
  return f === "cartesian" || f === "pie" || f === "scatter" || f === "treemap" || f === "funnel" || f === "waterfall" || f === "table" || f === "matrix";
}

export function isSlicer(v: VisualModel): boolean {
  return v.visualType === "slicer";
}

/**
 * What a selection in `source` does to `target`: the page's explicit setting, else the default (charts highlight
 * charts that can, everything else is filtered).
 */
export function resolveInteraction(page: PageModel, source: VisualModel, target: VisualModel): InteractionMode {
  if (source.name === target.name) return "none";
  const explicit = page.interactions.find((i) => i.source === source.name && i.target === target.name)?.type ?? "Default";
  if (explicit === "NoFilter") return "none";
  if (explicit === "DataFilter") return "filter";
  const canHighlight = supportsHighlight(target.visualType);
  if (explicit === "HighlightFilter") return canHighlight ? "highlight" : "filter";
  const srcFamily = visualType(source.visualType)?.family;
  const chartLike = srcFamily === "cartesian" || srcFamily === "pie" || srcFamily === "scatter" || srcFamily === "treemap" || srcFamily === "funnel" || srcFamily === "waterfall";
  return chartLike && canHighlight ? "highlight" : "filter";
}

/** The slicer's own selection, if it has one. */
export function slicerFilters(v: VisualModel): FilterDef[] {
  return v.filters.defs;
}

export interface RuntimeFilters {
  /** Extra page-level filters that exist only while a drillthrough is active. */
  drillthrough: FilterDef[];
}

/**
 * Filters that apply to `visual`: report, page, the visual's own, slicers of the page, drillthrough.
 * A slicer's own list ignores its own selection.
 */
export function filtersFor(project: Project, page: PageModel, visual: VisualModel, rt: RuntimeFilters): FilterDef[] {
  const report = readFilters(project.report.files["report.json"] as never).defs;
  const out: FilterDef[] = [...report, ...page.filters.defs, ...rt.drillthrough];
  if (!isSlicer(visual)) out.push(...visual.filters.defs);
  for (const other of page.visuals) {
    if (!isSlicer(other) || other.name === visual.name) continue;
    const mode = page.interactions.find((i) => i.source === other.name && i.target === visual.name)?.type ?? "Default";
    if (mode === "NoFilter") continue;
    out.push(...slicerFilters(other));
  }
  return out.filter((f) => !(f.cond.kind === "in" && f.cond.values.length === 0));
}

/** Tuples for the selection as seen by a target visual: the points of the source visual. */
export function selectionTuples(sel: Selection | null, mode: InteractionMode): TupleFilter[] {
  if (!sel || mode === "none" || sel.points.length === 0) return [];
  // all points of one visual share the same fields
  const fields = sel.points[0].fields;
  return [{ fields, rows: sel.points.map((p) => p.values) }];
}

export function samePoint(a: SelectedPoint, b: SelectedPoint): boolean {
  return a.fields.length === b.fields.length && a.fields.every((f, i) => sameField(f, b.fields[i])) && a.values.every((v, i) => JSON.stringify(v) === JSON.stringify(b.values[i]));
}

/** Click on a point: plain click replaces the selection, ctrl-click toggles the point, click on the selected one clears. */
export function toggleSelection(cur: Selection | null, page: string, visual: string, point: SelectedPoint, additive: boolean): Selection | null {
  const same = cur && cur.page === page && cur.visual === visual;
  const points = same ? cur.points : [];
  const has = points.some((p) => samePoint(p, point));
  if (additive) {
    const next = has ? points.filter((p) => !samePoint(p, point)) : [...points, point];
    return next.length ? { page, visual, points: next } : null;
  }
  if (has && points.length === 1) return null;
  return { page, visual, points: [point] };
}

// ---- drillthrough ----------------------------------------------------------------------------------

export interface DrillthroughTarget {
  page: string;
  displayName: string;
  /** Fields of the target that the clicked visual can supply. */
  fields: FieldRef[];
}

/** Drillthrough pages whose every field is among the fields of the clicked data point. */
export function drillthroughTargets(project: Project, pageNames: string[], point: SelectedPoint): DrillthroughTarget[] {
  const out: DrillthroughTarget[] = [];
  for (const n of pageNames) {
    const pg = parsePage(project, n);
    if (!pg || pg.type !== "Drillthrough") continue;
    const params: { boundFilter: string }[] = (pg.json.pageBinding?.parameters as never) ?? [];
    const fields = pg.filters.defs.filter((d) => params.some((p) => p.boundFilter === d.name)).map((d) => d.field);
    if (fields.length && fields.every((f) => point.fields.some((pf) => sameField(pf, f)))) out.push({ page: n, displayName: pg.displayName, fields });
  }
  return out;
}

/** Filters that a drillthrough applies on the target page: the point's value for each drillthrough field. */
export function drillthroughFilters(target: DrillthroughTarget, point: SelectedPoint): FilterDef[] {
  return target.fields.map((f, i) => {
    const idx = point.fields.findIndex((pf) => sameField(pf, f));
    return { name: `drillthrough${i}`, field: f, cond: { kind: "in", values: [point.values[idx]] } as const };
  });
}
