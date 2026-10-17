// What a visual can be formatted with: formatting objects ("cards") and their properties, as listed by the report
// theme schema of Power BI Desktop (capabilities.json, written by tools/re/format-capabilities.mjs) plus the container
// objects of the published PBIR schemas. This is the single source of names for the Format pane, the renderers' tests
// and the PBIR property-name check.
import raw from "./capabilities.json";

/** b boolean; n number [min, max, integer]; s text; c color; f font size [min, max]; e one of [values]; x structured value kept as written. */
export type Kind =
  | readonly ["b"]
  | readonly ["n", (number | null)?, (number | null)?, 1?]
  | readonly ["s"]
  | readonly ["c"]
  | readonly ["f", number, number]
  | readonly ["e", readonly (string | number)[]]
  | readonly ["x"];

export type CardProps = Readonly<Record<string, Kind>>;

interface Raw {
  cards: Record<string, CardProps>;
  visuals: Record<string, Record<string, string>>;
}
const data = raw as unknown as Raw;

/**
 * Objects of the visual container (PBIR visual.visualContainerObjects, schema visualConfiguration 2.8.0
 * VisualContainerFormattingObjects); every other object lives in visual.objects.
 */
export const CONTAINER_OBJECTS: ReadonlySet<string> = new Set([
  "title",
  "subTitle",
  "divider",
  "spacing",
  "background",
  "padding",
  "lockAspect",
  "border",
  "dropShadow",
  "visualLink",
  "visualTooltip",
  "stylePreset",
  "visualHeader",
  "visualHeaderTooltip",
]);

/**
 * `general` exists on both sides: these properties are stored in visual.visualContainerObjects.general (published
 * schema, VisualContainerGeneralFormattingObjects); the others (formatString, responsive, imageUrl, ...) in visual.objects.general.
 */
export const CONTAINER_GENERAL_PROPS: ReadonlySet<string> = new Set(["x", "y", "width", "height", "altText", "allowBinnedLineSample", "allowOverlappingPointsSample", "keepLayerOrder"]);

/** Whether a property is stored in visual.visualContainerObjects (true) or visual.objects (false). */
export const isContainerProp = (object: string, prop: string): boolean => CONTAINER_OBJECTS.has(object) || (object === "general" && CONTAINER_GENERAL_PROPS.has(prop));

/** Container objects the General tab shows, in order. (visualLink is an Action card of buttons, stylePreset is chosen with themes.) */
export const GENERAL_ORDER = ["title", "subTitle", "visualHeader", "background", "border", "dropShadow", "padding", "spacing", "divider", "lockAspect", "visualTooltip", "visualHeaderTooltip", "general"] as const;

/**
 * Properties the theme schema does not list because a theme cannot set them, but that the visuals store; their names
 * come from the published PBIR visual container schema and from the formatting code of Desktop.
 */
const EXTRAS: Record<string, Record<string, Kind>> = {
  // visualContainerObjects.general: the published schema lists x, y, width, height, altText (+ three chart switches)
  general: { altText: ["s"] },
  // instances of the Analytics pane's reference line: which statistic, and the percentile
  referenceLine: { type: ["e", ["Min", "Max", "Average", "Median", "Percentile"]], percentile: ["n", 0, 100], measure: ["x"] },
};

/** Properties BIForge stores that no published schema or Desktop code names. Listed so the check that finds invented names can say why each stays. */
export const BIFORGE_EXTENSIONS: Record<string, Record<string, string>> = {
  rowTotals: { show: "matrix row grand total switch: the theme schema lists only the totals' fonts and colors" },
  columnTotals: { show: "matrix column grand total switch: same" },
  dataPoint: { fillRule: "kept" },
};

/** Style names where BIForge's visual id differs from the key in the schema (none now that the ids follow Desktop's). */
const STYLE_KEY: Record<string, string> = {};

export const styleKey = (visualType: string): string => STYLE_KEY[visualType] ?? visualType;

/** All objects of a visual type and their properties, or null when the schema has no entry for the type. */
export function visualObjects(visualType: string): Record<string, CardProps> | null {
  const v = data.visuals[styleKey(visualType)];
  if (!v) return null;
  const out: Record<string, CardProps> = {};
  for (const [object, id] of Object.entries(v)) {
    if (object === "*") continue;
    out[object] = { ...data.cards[id], ...EXTRAS[object] };
  }
  return out;
}

/** The kind of a property, or null when the visual type has no such object or property. */
export function propKind(visualType: string, object: string, prop: string): Kind | null {
  const id = data.visuals[styleKey(visualType)]?.[object];
  if (id === undefined) return null;
  return data.cards[id]?.[prop] ?? EXTRAS[object]?.[prop] ?? null;
}

export function hasObject(visualType: string, object: string): boolean {
  return data.visuals[styleKey(visualType)]?.[object] !== undefined;
}

export const knownVisualTypes = (): string[] => Object.keys(data.visuals);
