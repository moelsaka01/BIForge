// Brings report files written by earlier BIForge versions to the names Power BI Desktop uses (the published PBIR
// schemas and the report theme schema). Runs when a project is loaded; files that are already current are not touched.
import type { Project } from "../model/types";
import { fromStored } from "./storage";
import { lit } from "./fields";
import { litExpr, readLitProp, type J } from "./pbir";

/** visualType ids BIForge used before they were aligned with Desktop's. */
export const LEGACY_VISUAL_TYPES: Record<string, string> = {
  stackedBarChart: "barChart",
  stackedColumnChart: "columnChart",
};

/** Role names BIForge guessed before they were read from the capability definitions of Desktop: visualType -> old role -> role. */
export const LEGACY_ROLES: Record<string, Record<string, string>> = {
  kpi: { TrendAxis: "TrendLine" },
  filledMap: { Y: "Size" },
};

const isVisualFile = (key: string) => /(^|\/)pages\/[^/]+\/visuals\/[^/]+\/visual\.json$/.test(key);

type Entry = { selector?: J; properties: Record<string, J> };
type Objects = Record<string, Entry[]>;

const UNITS_BY_NAME: Record<string, number> = { auto: 0, none: 1, thousands: 1000, millions: 1000000, billions: 1000000000, trillions: 1000000000000 };

/** Moves a property between objects (keeping the entry's selector); `convert` rewrites the value node. Returns whether anything moved. */
function move(objects: Objects, fromObject: string, fromProp: string, toObject: string, toProp: string, convert?: (node: J) => J | null): boolean {
  const list = objects[fromObject];
  if (!list) return false;
  let moved = false;
  for (const e of [...list]) {
    if (!(fromProp in e.properties)) continue;
    const node = e.properties[fromProp];
    delete e.properties[fromProp];
    moved = true;
    const out = convert ? convert(node) : node;
    if (out !== null) {
      const target = (objects[toObject] ??= []);
      let t = target.find((x) => JSON.stringify(x.selector ?? null) === JSON.stringify(e.selector ?? null));
      if (!t) target.push((t = { ...(e.selector ? { selector: e.selector } : {}), properties: {} }));
      t.properties[toProp] = out;
    }
    if (Object.keys(e.properties).length === 0) list.splice(list.indexOf(e), 1);
  }
  if (list.length === 0) delete objects[fromObject];
  return moved;
}

const litOf = (node: J) => readLitProp(node);
const unitsNode = (node: J): J | null => {
  const l = litOf(node);
  if (!l || l.t !== "string") return node;
  const n = UNITS_BY_NAME[l.v];
  return n === undefined ? null : litExpr(lit.num(n));
};

const LABEL_STYLES: Record<string, string> = { "Data value": "Data", "Category, data value": "Both", "All detail labels": "Category, data value, percent of total" };
const SHAPES: Record<string, string> = { roundedRectangle: "rectangleRounded", triangle: "triangleIsoc" };
const SECONDARY: [string, string][] = [
  ["show", "secShow"],
  ["start", "secStart"],
  ["end", "secEnd"],
  ["labelColor", "secLabelColor"],
  ["fontSize", "secFontSize"],
  ["showAxisTitle", "secShowAxisTitle"],
  ["axisTitle", "secTitleText"],
];

const STATS: Record<string, { kind: string; type?: string }> = {
  constantLine: { kind: "constant" },
  minLine: { kind: "min", type: "Min" },
  maxLine: { kind: "max", type: "Max" },
  averageLine: { kind: "average", type: "Average" },
  medianLine: { kind: "median", type: "Median" },
  percentileLine: { kind: "percentile", type: "Percentile" },
};

/** One visual file to current names; returns whether it changed. */
export function migrateVisual(json: J): boolean {
  const v = json?.visual;
  if (!v) return false;
  let changed = false;
  const renamed = LEGACY_VISUAL_TYPES[v.visualType];
  if (renamed) {
    v.visualType = renamed;
    changed = true;
  }
  const queryState = v.query?.queryState;
  const roleMap = LEGACY_ROLES[v.visualType];
  if (queryState && roleMap) {
    for (const [from, to] of Object.entries(roleMap)) {
      if (from in queryState && !(to in queryState)) {
        queryState[to] = queryState[from];
        delete queryState[from];
        changed = true;
      }
    }
  }
  // the sync group is part of the visual, not of the container
  if (json.syncGroup) {
    v.syncGroup = json.syncGroup;
    delete json.syncGroup;
    changed = true;
  }
  const objects: Objects | undefined = v.objects;
  const container: Objects | undefined = v.visualContainerObjects;

  if (container) {
    // alt text belongs to the container's `general` object
    if (move(container, "altText", "text", "general", "altText")) changed = true;
    for (const e of container.visualTooltip ?? []) {
      const t = litOf(e.properties.type);
      if (t?.t === "string" && t.v === "ReportPage") {
        e.properties.type = litExpr(lit.str("Canvas"));
        changed = true;
      }
    }
  }
  if (!objects) return changed;
  const m = (...a: Parameters<typeof move>) => {
    if (move(...a)) changed = true;
  };
  const mo = (from: string, fp: string, to: string, tp: string, c?: (n: J) => J | null) => m(objects, from, fp, to, tp, c);

  for (const axis of ["categoryAxis", "valueAxis"]) {
    mo(axis, "axisTitle", axis, "titleText");
    mo(axis, "displayUnits", axis, "labelDisplayUnits", unitsNode);
    mo(axis, "decimalPlaces", axis, "labelPrecision");
  }
  mo("labels", "displayUnits", "labels", "labelDisplayUnits", unitsNode);
  mo("labels", "decimalPlaces", "labels", "labelPrecision");
  // the gauge's callout and the card's value use the same names
  for (const [from, fp] of SECONDARY) mo("secondaryValueAxis", fp === "axisTitle" ? "axisTitle" : from, "valueAxis", SECONDARY.find((s) => s[0] === from)![1]);
  mo("secondaryValueAxis", "displayUnits", "valueAxis", "secLabelDisplayUnits", unitsNode);
  mo("secondaryValueAxis", "decimalPlaces", "valueAxis", "secLabelPrecision");
  mo("lineStyles", "smooth", "lineStyles", "lineChartType", (n) => (litOf(n)?.t === "bool" && (litOf(n) as { v: boolean }).v ? litExpr(lit.str("smooth")) : null));
  // tables: display units and decimals are per column
  mo("values", "displayUnits", "columnFormatting", "labelDisplayUnits", unitsNode);
  mo("values", "decimalPlaces", "columnFormatting", "labelPrecision");
  mo("values", "dataBars", "columnFormatting", "dataBars", (n) => {
    const l = litOf(n);
    if (!l || l.t !== "bool" || !l.v) return null;
    return { positiveColor: { solid: { color: litExpr(lit.str("#6aa9e9")) } }, reverseDirection: litExpr(lit.bool(false)), hideText: litExpr(lit.bool(false)) };
  });
  mo("indicator", "direction", "goals", "direction");
  mo("target", "target", "axis", "target");
  mo("selection", "selectAllCheckbox", "selection", "selectAllCheckboxEnabled");
  mo("header", "search", "general", "selfFilterEnabled");
  mo("image", "imageUrl", "image", "sourceUrl", (n) => n);
  if (objects.image?.some((e) => "sourceUrl" in e.properties && !("sourceType" in e.properties))) {
    for (const e of objects.image) if ("sourceUrl" in e.properties && !("sourceType" in e.properties)) e.properties.sourceType = litExpr(lit.str("imageUrl"));
    changed = true;
  }
  mo("image", "scaling", "image", "fit");
  for (const e of objects.shape ?? []) {
    const l = litOf(e.properties.tileShape);
    if (l?.t === "string" && SHAPES[l.v]) {
      e.properties.tileShape = litExpr(lit.str(SHAPES[l.v]));
      changed = true;
    }
  }
  for (const e of objects.labels ?? []) {
    const l = litOf(e.properties.labelStyle);
    if (l?.t === "string" && LABEL_STYLES[l.v]) {
      e.properties.labelStyle = litExpr(lit.str(LABEL_STYLES[l.v]));
      changed = true;
    }
  }
  for (const e of objects.data ?? []) {
    const l = litOf(e.properties.mode);
    if (l?.t === "string" && l.v === "Tile") {
      e.properties.mode = litExpr(lit.str("Basic"));
      const general = (objects.general ??= []);
      const own = general.find((x) => !x.selector) ?? general[general.push({ properties: {} }) - 1];
      own.properties.orientation = litExpr(lit.num(1));
      changed = true;
    }
  }
  // Analytics lines: a constant line is an instance of the value axis's reference line; statistics are `referenceLine` instances
  for (const [old, s] of Object.entries(STATS)) {
    const list = objects[old];
    if (!list) continue;
    for (const e of list) {
      const props: Record<string, J> = {};
      for (const [k, node] of Object.entries(e.properties)) props[k === "strokeWidth" ? "width" : k] = node;
      if (s.type) props.type = litExpr(lit.str(s.type));
      const target = s.type ? "referenceLine" : "y1AxisReferenceLine";
      (objects[target] ??= []).push({ selector: { id: s.kind }, properties: props });
    }
    delete objects[old];
    changed = true;
  }
  if (objects.trendLine) {
    for (const e of objects.trendLine) {
      const props: Record<string, J> = {};
      for (const [k, node] of Object.entries(e.properties)) props[k === "strokeWidth" ? "width" : k] = node;
      (objects.trend ??= []).push({ ...(e.selector ? { selector: e.selector } : {}), properties: props });
    }
    delete objects.trendLine;
    changed = true;
  }
  return changed;
}

/** Returns the project with every report file migrated; the same object when nothing needed to change. */
export function migrateProject(p: Project): Project {
  return migrateVisuals(fromStored(p)); // group members: relative positions on disk become page positions in memory
}

function migrateVisuals(p: Project): Project {
  const files = p.report?.files as Record<string, J> | undefined;
  if (!files) return p;
  const keys = Object.keys(files).filter(isVisualFile);
  // find out first on a copy of each file whether it would change, so an up-to-date project is returned as it is
  const stale = keys.filter((k) => migrateVisual(structuredClone(files[k])));
  if (stale.length === 0) return p;
  const copy = structuredClone(p);
  const out = copy.report.files as Record<string, J>;
  for (const k of stale) migrateVisual(out[k]);
  return copy;
}
