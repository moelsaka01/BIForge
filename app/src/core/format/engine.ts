// The schema-driven Format pane: builds the cards and controls of a visual from the formatting objects the schema lists
// for its type (capabilities.ts), with labels and defaults from labels.ts. A visual type needs no pane code of its own;
// it needs a renderer that reads the properties (the rendered-coverage test says which ones it does).
import { CONTAINER_OBJECTS, GENERAL_ORDER, visualObjects, type CardProps, type Kind } from "./capabilities";
import { cardLabel, optionLabel, propGroup, propLabel } from "./labels";
import rendered from "./rendered.json";
import cloudOnly from "./cloudOnly.json";

export type PropType = "bool" | "text" | "number" | "color" | "enum";

export interface PropDef {
  key: string;
  label: string;
  type: PropType;
  default?: boolean | number | string;
  options?: { value: string; label: string }[];
  /** The allowed values are numbers (display units): the stored literal is a number. */
  numeric?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  /** Placeholder shown when the value is automatic. */
  auto?: string;
  /** A heading the pane shows before this property and the ones after it with the same group. */
  group?: string;
  /** Typed suggestions for a text property (font names). */
  suggest?: string[];
  /** Whether a renderer of this visual type reads the property (tests/rendered coverage); false: stored in the report, not drawn yet. */
  drawn?: boolean;
}

export interface CardDef {
  /** Unique within a visual: the object name, plus "#<instance>" for an instance of a repeatable object. */
  id: string;
  label: string;
  /** PBIR formatting object name. */
  object: string;
  props: PropDef[];
  /** Instance of a repeatable object (a reference line): stored with selector.id. */
  instance?: string;
  /** Properties written together with any change of this card (which statistic a reference line is). */
  fixed?: Record<string, string | number | boolean>;
}

export interface CardContext {
  pages: { name: string; displayName: string }[];
  /** Pages of type Tooltip (a visual's tooltip can show one). */
  tooltipPages?: { name: string; displayName: string }[];
  bookmarks: { id: string; name: string }[];
  /** The Style preset list of the visual: Base or the built-in table presets, and the presets the report theme defines. */
  stylePresets?: { options: { value: string; label: string }[]; default: string };
}

const NONE = [{ value: "", label: "(none)" }];

/** Settings of Power BI service features (pin to dashboard, comments, alerts, follow, Copilot summaries): BIForge has none of them, so the pane does not list them. */
const CLOUD_ONLY: ReadonlySet<string> = new Set(cloudOnly);

/** Defaults shown for an unset property (the renderers use the same values when the setting is absent). */
const DEFAULTS: Record<string, boolean | number | string> = {
  "legend.show": true,
  "categoryAxis.show": true,
  "valueAxis.show": true,
  "valueAxis.gridlineShow": true,
  "categoryAxis.gridlineShow": false,
  "labels.show": false,
  "title.show": true,
  "subTitle.show": false,
  "background.show": true,
  "background.transparency": 0,
  "border.show": false,
  "border.width": 1,
  "border.radius": 0,
  "dropShadow.show": false,
  "divider.show": false,
  "visualHeader.show": true,
  "lineStyles.strokeWidth": 2,
  "lineStyles.lineStyle": "solid",
  "lineStyles.showMarker": false,
  "lineStyles.lineChartType": "linear",
  "title.alignment": "left",
  "title.heading": "Normal",
  "slices.innerRadiusRatio": 50,
  "fill.show": true,
  "outline.show": true,
  "outline.weight": 1,
  "text.show": true,
  "rotation.angle": 0,
  "imageScaling.imageScalingType": "Normal",
  "visualLink.show": true,
  "visualLink.type": "None",
  "visualTooltip.type": "Default",
  "goals.direction": "High is good",
  "total.totals": true,
  "rowTotals.show": true,
  "columnTotals.show": true,
  "categoryLabels.show": true,
  "pageNavigator.show": true,
  "legend.position": "Top",
};

const FONTS = ["Segoe UI", "Segoe UI Light", "Segoe UI Semibold", "Arial", "Calibri", "Cambria", "Consolas", "Courier New", "Georgia", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "DIN"];

/** Properties another control of the pane edits (or that make no sense as a single control); never listed as plain controls. */
const HIDDEN: Record<string, ReadonlySet<string>> = {
  dataPoint: new Set(["fill", "fillRule"]), // per-series colors have their own list
  general: new Set(["formatString", "imageUrl"]), // read from the file; no control
};

function defaultFor(object: string, prop: string, kind: Kind): boolean | number | string | undefined {
  const d = DEFAULTS[`${object}.${prop}`];
  if (d !== undefined) return d;
  if (kind[0] === "b" && /^(bold|italic|underline)$/.test(prop)) return false;
  if (kind[0] === "n" && /transparency$/i.test(prop)) return 0;
  return undefined;
}

export function propDef(object: string, key: string, kind: Kind, ctx: CardContext | undefined, drawn: boolean): PropDef | null {
  const label = propLabel(key);
  const group = propGroup(object, key) ?? undefined;
  const base = { key, label, drawn, ...(group ? { group } : {}) };
  const dflt = defaultFor(object, key, kind);
  switch (kind[0]) {
    case "b":
      return { ...base, type: "bool", default: (dflt as boolean | undefined) ?? false };
    case "n": {
      const pct = /transparency$/i.test(key) ? { min: 0, max: 100 } : {};
      return { ...base, type: "number", ...pct, ...(kind[1] != null ? { min: kind[1] } : {}), ...(kind[2] != null ? { max: kind[2] } : {}), ...(kind[3] ? { integer: true } : {}), ...(dflt !== undefined ? { default: dflt } : {}), auto: "Auto" };
    }
    case "f":
      return { ...base, type: "number", min: kind[1], max: kind[2], auto: "Theme" };
    case "s": {
      if (object === "stylePreset" && key === "name") return { ...base, type: "enum", options: ctx?.stylePresets?.options ?? [{ value: "", label: "Base" }], default: ctx?.stylePresets?.default ?? "" };
      if (object === "visualLink" && key === "navigationSection") return { ...base, type: "enum", options: ctx?.pages.length ? ctx.pages.map((p) => ({ value: p.name, label: p.displayName })) : NONE, auto: "Choose a page" };
      if (object === "visualLink" && key === "bookmark") return { ...base, type: "enum", options: ctx?.bookmarks.length ? ctx.bookmarks.map((b) => ({ value: b.id, label: b.name })) : NONE, auto: "Choose a bookmark" };
      if (object === "visualTooltip" && key === "section") return { ...base, type: "enum", options: ctx?.tooltipPages?.length ? ctx.tooltipPages.map((p) => ({ value: p.name, label: p.displayName })) : NONE, auto: "Choose a tooltip page" };
      return { ...base, type: "text", ...(/fontFamily$/i.test(key) ? { suggest: FONTS, auto: "Theme" } : { auto: "Automatic" }) };
    }
    case "c":
      return { ...base, type: "color" };
    case "e": {
      const numeric = kind[1].every((v) => typeof v === "number");
      return {
        ...base,
        type: "enum",
        numeric,
        options: kind[1].map((v) => ({ value: String(v), label: object === "toolbar" && key === "position" ? (v === 1 ? "Bottom" : "Top") : optionLabel(key, v) })),
        ...(dflt !== undefined ? { default: String(dflt) } : {}),
        auto: "Automatic",
      };
    }
    default:
      return null;
  }
}

function drawnSet(visualType: string, object: string): ReadonlySet<string> {
  const r = rendered as Record<string, Record<string, string[]>>;
  return new Set([...(r["*"]?.[object] ?? []), ...(r[visualType]?.[object] ?? [])]);
}

function cardFrom(visualType: string, object: string, props: CardProps, ctx: CardContext | undefined, opt: { id?: string; label?: string; instance?: string; fixed?: CardDef["fixed"]; only?: ReadonlySet<string>; skip?: ReadonlySet<string> } = {}): CardDef | null {
  const drawn = drawnSet(visualType, object);
  const hidden = HIDDEN[object];
  const defs: PropDef[] = [];
  for (const [key, kind] of Object.entries(props)) {
    if (hidden?.has(key) || opt.skip?.has(key) || CLOUD_ONLY.has(`${object}.${key}`)) continue;
    if (opt.only && !opt.only.has(key)) continue;
    const d = propDef(object, key, kind, ctx, drawn.has(key));
    if (d) defs.push(d);
  }
  if (defs.length === 0) return null;
  // `show` first, then properties in the schema's alphabetical order grouped by their heading
  defs.sort((a, b) => (a.key === "show" ? -1 : b.key === "show" ? 1 : 0));
  const order: string[] = [];
  for (const d of defs) if (!order.includes(d.group ?? "")) order.push(d.group ?? "");
  defs.sort((a, b) => order.indexOf(a.group ?? "") - order.indexOf(b.group ?? "") || (a.key === "show" ? -1 : b.key === "show" ? 1 : 0));
  return { id: opt.id ?? object, label: opt.label ?? cardLabel(object), object, props: defs, ...(opt.instance ? { instance: opt.instance } : {}), ...(opt.fixed ? { fixed: opt.fixed } : {}) };
}

/** Objects of the Analytics tab. */
const ANALYTICS_OBJECTS = new Set(["y1AxisReferenceLine", "xAxisReferenceLine", "referenceLine", "trend", "error", "forecast", "anomalyDetection", "plotAreaShading", "ratioLine"]);
/** Objects never shown as cards: other tabs, structure, or values with no editable property. */
const NEVER = new Set(["actionButtonSection", "annotationTemplate", "filters", "scalarKey", "layout", "stylePreset", "visualLink"]);

/** Cards of the Visual tab: every object of the visual type that is not container formatting or an analytics line. */
export function visualCards(visualType: string, ctx?: CardContext): CardDef[] {
  const objs = visualObjects(visualType);
  if (!objs) return [];
  const out: CardDef[] = [];
  for (const [object, props] of Object.entries(objs)) {
    if (CONTAINER_OBJECTS.has(object) || ANALYTICS_OBJECTS.has(object) || NEVER.has(object) || object === "general") continue;
    const c = cardFrom(visualType, object, props, ctx);
    if (c) out.push(c);
  }
  const link = objs.visualLink && /^(actionButton|image|shape|textbox|pageNavigator)$/.test(visualType) ? cardFrom(visualType, "visualLink", objs.visualLink, ctx, { label: "Action" }) : null;
  if (link) out.unshift(link);
  return out;
}

/** Cards of the General tab: the container formatting every visual has, plus alt text. */
export function generalCards(visualType: string, ctx?: CardContext): CardDef[] {
  const objs = visualObjects(visualType);
  if (!objs) return [];
  const out: CardDef[] = [];
  for (const object of GENERAL_ORDER) {
    const props = objs[object];
    if (!props) continue;
    if (object === "general") {
      // only the container-side properties: alt text (the others belong to the visual's own objects)
      const c = cardFrom(visualType, "general", props, ctx, { id: "altText", label: "Alt text", only: new Set(["altText"]) });
      if (c) out.push(c);
      continue;
    }
    const c = cardFrom(visualType, object, props, ctx, object === "visualLink" ? { label: "Action" } : {});
    if (c) out.push(c);
  }
  return out;
}

const STATS: { id: string; label: string; type: string }[] = [
  { id: "min", label: "Min line", type: "Min" },
  { id: "max", label: "Max line", type: "Max" },
  { id: "average", label: "Average line", type: "Average" },
  { id: "median", label: "Median line", type: "Median" },
  { id: "percentile", label: "Percentile line", type: "Percentile" },
];

/** Cards of the Analytics tab: constant line, the statistic lines (instances of the reference line object), trend line and the other analytics objects the type has. */
export function analyticsCards(visualType: string, ctx?: CardContext): CardDef[] {
  const objs = visualObjects(visualType);
  if (!objs) return [];
  const out: CardDef[] = [];
  const skipTypeLess = new Set(["type", "measure", "percentile", "value"]);
  if (objs.y1AxisReferenceLine) {
    const c = cardFrom(visualType, "y1AxisReferenceLine", objs.y1AxisReferenceLine, ctx, { id: "y1AxisReferenceLine#constant", label: "Constant line", instance: "constant" });
    if (c) out.push(c);
  }
  if (objs.xAxisReferenceLine) {
    const c = cardFrom(visualType, "xAxisReferenceLine", objs.xAxisReferenceLine, ctx, { id: "xAxisReferenceLine#constant", label: "X-axis constant line", instance: "constant" });
    if (c) out.push(c);
  }
  if (objs.referenceLine) {
    for (const s of STATS) {
      const c = cardFrom(visualType, "referenceLine", objs.referenceLine, ctx, {
        id: `referenceLine#${s.id}`,
        label: s.label,
        instance: s.id,
        fixed: { type: s.type },
        skip: s.id === "percentile" ? new Set(["type", "measure", "value"]) : skipTypeLess,
      });
      if (c) out.push(c);
    }
  }
  for (const object of ["trend", "error", "forecast", "anomalyDetection", "plotAreaShading", "ratioLine"]) {
    if (!objs[object]) continue;
    const c = cardFrom(visualType, object, objs[object], ctx);
    if (c) out.push(c);
  }
  return out;
}

/** Every object name a visual type has, container or not; used to tell a card from a stray name. */
export const objectNames = (visualType: string): string[] => Object.keys(visualObjects(visualType) ?? {});
