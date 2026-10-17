// What the Format pane offers for each visual type. Every setting listed here is read by a renderer (a test checks
// that the object and property names appear in the renderer sources), so the pane never shows a dead control.
import type { VisualFamily } from "./visualTypes";
import { visualType } from "./visualTypes";

export type PropType = "bool" | "text" | "number" | "color" | "enum" | "units";

export interface PropDef {
  key: string;
  label: string;
  type: PropType;
  default?: boolean | number | string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** Placeholder shown when the value is automatic. */
  auto?: string;
}

export interface CardDef {
  id: string;
  label: string;
  /** PBIR formatting object name. */
  object: string;
  props: PropDef[];
  /** Applies to visuals of these families only (default: all that use this card list). */
}

const opt = (...xs: string[]) => xs.map((x) => ({ value: x, label: x }));

const UNITS: PropDef = { key: "displayUnits", label: "Display units", type: "enum", default: "auto", options: [{ value: "auto", label: "Auto" }, { value: "none", label: "None" }, { value: "thousands", label: "Thousands" }, { value: "millions", label: "Millions" }, { value: "billions", label: "Billions" }, { value: "trillions", label: "Trillions" }] };
const DECIMALS: PropDef = { key: "decimalPlaces", label: "Decimal places", type: "number", min: 0, max: 10, auto: "Auto" };

const legend: CardDef = {
  id: "legend",
  label: "Legend",
  object: "legend",
  props: [
    { key: "show", label: "Show", type: "bool", default: true },
    { key: "position", label: "Position", type: "enum", default: "Top", options: opt("Top", "Bottom", "Left", "Right") },
    { key: "fontSize", label: "Text size", type: "number", min: 6, max: 40, auto: "Theme" },
    { key: "labelColor", label: "Text color", type: "color" },
  ],
};
const axisProps = (extra: PropDef[] = []): PropDef[] => [
  { key: "show", label: "Show", type: "bool", default: true },
  { key: "fontSize", label: "Text size", type: "number", min: 6, max: 40, auto: "Theme" },
  { key: "labelColor", label: "Text color", type: "color" },
  ...extra,
  { key: "showAxisTitle", label: "Show title", type: "bool", default: false },
  { key: "axisTitle", label: "Title text", type: "text" },
];
const valueAxis: CardDef = {
  id: "valueAxis",
  label: "Y-axis",
  object: "valueAxis",
  props: axisProps([
    { key: "start", label: "Minimum", type: "number", auto: "Auto" },
    { key: "end", label: "Maximum", type: "number", auto: "Auto" },
    { key: "gridlineShow", label: "Gridlines", type: "bool", default: true },
    UNITS,
    DECIMALS,
  ]),
};
const categoryAxis: CardDef = { id: "categoryAxis", label: "X-axis", object: "categoryAxis", props: axisProps() };
const labels = (extra: PropDef[] = []): CardDef => ({
  id: "labels",
  label: "Data labels",
  object: "labels",
  props: [{ key: "show", label: "Show", type: "bool", default: false }, { key: "fontSize", label: "Text size", type: "number", min: 6, max: 40, auto: "Theme" }, { key: "color", label: "Color", type: "color" }, UNITS, DECIMALS, ...extra],
});
const colors: CardDef = { id: "dataPoint", label: "Data colors", object: "dataPoint", props: [{ key: "defaultColor", label: "Default color", type: "color" }] };
const scatterAxis = (id: string, label: string, object: string): CardDef => ({
  id,
  label,
  object,
  props: [{ key: "showAxisTitle", label: "Show title", type: "bool", default: true }, { key: "axisTitle", label: "Title text", type: "text" }, { key: "gridlineShow", label: "Gridlines", type: "bool", default: true }, UNITS, DECIMALS],
});

const shapeCard: CardDef = {
  id: "shape",
  label: "Shape",
  object: "shape",
  props: [{ key: "tileShape", label: "Shape", type: "enum", default: "rectangle", options: [{ value: "rectangle", label: "Rectangle" }, { value: "roundedRectangle", label: "Rounded rectangle" }, { value: "oval", label: "Oval" }, { value: "triangle", label: "Triangle" }, { value: "line", label: "Line" }] }],
};
const fillCard: CardDef = {
  id: "fill",
  label: "Fill",
  object: "fill",
  props: [{ key: "show", label: "Show", type: "bool", default: true }, { key: "fillColor", label: "Color", type: "color" }, { key: "transparency", label: "Transparency (%)", type: "number", min: 0, max: 100, default: 0 }],
};
const outlineCard: CardDef = {
  id: "outline",
  label: "Outline",
  object: "outline",
  props: [{ key: "show", label: "Show", type: "bool", default: true }, { key: "lineColor", label: "Color", type: "color" }, { key: "weight", label: "Weight", type: "number", min: 0, max: 20, default: 1 }],
};
const rotationCard: CardDef = { id: "rotation", label: "Rotation", object: "rotation", props: [{ key: "angle", label: "Angle (degrees)", type: "number", min: -360, max: 360, default: 0 }] };
const textCard = (withText: boolean): CardDef => ({
  id: "text",
  label: "Text",
  object: "text",
  props: [
    { key: "show", label: "Show", type: "bool", default: true },
    ...(withText ? ([{ key: "text", label: "Text", type: "text", auto: "Button" }] as PropDef[]) : []),
    { key: "fontColor", label: "Font color", type: "color" },
    { key: "fontSize", label: "Text size", type: "number", min: 6, max: 60, default: 12 },
    { key: "horizontalAlignment", label: "Alignment", type: "enum", default: "center", options: opt("left", "center", "right") },
  ],
});

const BY_FAMILY: Partial<Record<VisualFamily, CardDef[]>> = {
  textbox: [rotationCard],
  shape: [shapeCard, fillCard, outlineCard, rotationCard],
  image: [{ id: "image", label: "Image", object: "image", props: [{ key: "scaling", label: "Scaling", type: "enum", default: "Normal", options: opt("Normal", "Fit", "Fill") }] }, rotationCard],
  button: [shapeCard, fillCard, outlineCard, textCard(true)],
  pageNavigator: [{ ...textCard(false), props: textCard(false).props.filter((p) => p.key !== "horizontalAlignment") }, { ...fillCard, label: "Selected page fill", props: fillCard.props.filter((p) => p.key === "fillColor") }, outlineCard],
  cartesian: [
    legend,
    categoryAxis,
    valueAxis,
    colors,
    labels(),
    {
      id: "lineStyles",
      label: "Lines",
      object: "lineStyles",
      props: [
        { key: "strokeWidth", label: "Line width", type: "number", min: 1, max: 10, default: 2 },
        { key: "lineStyle", label: "Line style", type: "enum", default: "solid", options: opt("solid", "dashed", "dotted") },
        { key: "showMarker", label: "Markers", type: "bool", default: false },
        { key: "smooth", label: "Smooth", type: "bool", default: false },
      ],
    },
  ],
  pie: [
    legend,
    { id: "slices", label: "Slices", object: "slices", props: [{ key: "innerRadiusRatio", label: "Inner radius (donut, %)", type: "number", min: 10, max: 90, default: 50 }] },
    {
      id: "labels",
      label: "Detail labels",
      object: "labels",
      props: [
        { key: "show", label: "Show", type: "bool", default: true },
        { key: "labelStyle", label: "Label contents", type: "enum", default: "Category", options: opt("Category", "Data value", "Percent of total", "Category, data value", "Category, percent of total", "Data value, percent of total", "All detail labels") },
        { key: "fontSize", label: "Text size", type: "number", min: 6, max: 40, auto: "Theme" },
        { key: "color", label: "Color", type: "color" },
        UNITS,
        DECIMALS,
      ],
    },
  ],
  scatter: [legend, scatterAxis("categoryAxis", "X-axis", "categoryAxis"), scatterAxis("valueAxis", "Y-axis", "valueAxis")],
  treemap: [],
  funnel: [legend],
  waterfall: [
    { id: "valueAxis", label: "Y-axis", object: "valueAxis", props: [UNITS, DECIMALS] },
    { id: "sentimentColors", label: "Sentiment colors", object: "sentimentColors", props: [{ key: "increaseFill", label: "Increase", type: "color" }, { key: "decreaseFill", label: "Decrease", type: "color" }, { key: "totalFill", label: "Total", type: "color" }] },
    { id: "labels", label: "Data labels", object: "labels", props: [{ key: "show", label: "Show", type: "bool", default: false }] },
  ],
  gauge: [
    { id: "axis", label: "Gauge axis", object: "axis", props: [{ key: "min", label: "Minimum", type: "number", auto: "0" }, { key: "max", label: "Maximum", type: "number", auto: "Auto" }] },
    { id: "target", label: "Target", object: "target", props: [{ key: "target", label: "Target value", type: "number", auto: "None" }] },
  ],
  table: [
    {
      id: "values",
      label: "Cell elements",
      object: "values",
      props: [{ key: "displayUnits", label: "Display units", type: "enum", default: "none", options: UNITS.options }, { key: "decimalPlaces", label: "Decimal places", type: "number", min: 0, max: 10, auto: "Auto" }],
    },
    { id: "total", label: "Totals", object: "total", props: [{ key: "totals", label: "Show totals row", type: "bool", default: true }] },
  ],
  matrix: [
    { id: "rowTotals", label: "Row grand total", object: "rowTotals", props: [{ key: "show", label: "Show", type: "bool", default: true }] },
    { id: "columnTotals", label: "Column totals", object: "columnTotals", props: [{ key: "show", label: "Show", type: "bool", default: true }] },
    { id: "values", label: "Values", object: "values", props: [{ key: "displayUnits", label: "Display units", type: "enum", default: "none", options: UNITS.options }, { key: "decimalPlaces", label: "Decimal places", type: "number", min: 0, max: 10, auto: "Auto" }] },
  ],
  card: [
    { id: "labels", label: "Callout value", object: "labels", props: [{ key: "fontSize", label: "Text size", type: "number", min: 8, max: 120, auto: "Theme" }, { key: "color", label: "Color", type: "color" }, UNITS, DECIMALS] },
    { id: "categoryLabels", label: "Category label", object: "categoryLabels", props: [{ key: "show", label: "Show", type: "bool", default: true }] },
  ],
  kpi: [{ id: "indicator", label: "Indicator", object: "indicator", props: [{ key: "direction", label: "Good when", type: "enum", default: "High is good", options: [{ value: "High is good", label: "Value is high" }, { value: "Low is good", label: "Value is low" }] }] }],
  slicer: [
    {
      id: "data",
      label: "Slicer settings",
      object: "data",
      props: [{ key: "mode", label: "Style", type: "enum", options: opt("Basic", "Dropdown", "Tile", "Between", "Before", "After", "Relative"), auto: "By data type" }],
    },
    {
      id: "selection",
      label: "Selection",
      object: "selection",
      props: [
        { key: "singleSelect", label: "Single select", type: "bool", default: false },
        { key: "selectAllCheckbox", label: "Show \"Select all\"", type: "bool", default: false },
      ],
    },
    { id: "header", label: "Header", object: "header", props: [{ key: "search", label: "Search box", type: "bool", default: false }] },
  ],
};

const lineProps = (extra: PropDef[] = []): PropDef[] => [
  { key: "show", label: "Show", type: "bool", default: false },
  ...extra,
  { key: "displayName", label: "Name", type: "text", auto: "Automatic" },
  { key: "lineColor", label: "Color", type: "color" },
  { key: "strokeWidth", label: "Width", type: "number", min: 1, max: 10, default: 1 },
  { key: "style", label: "Style", type: "enum", default: "dashed", options: opt("solid", "dashed", "dotted") },
  { key: "transparency", label: "Transparency (%)", type: "number", min: 0, max: 100, default: 0 },
  { key: "dataLabelShow", label: "Data label", type: "bool", default: false },
];

/** Cards of the Analytics pane: reference lines and the trend line, for the charts that draw them. */
export function analyticsCards(typeId: string): CardDef[] {
  const t = visualType(typeId);
  if (!t || t.family !== "cartesian" || typeId.startsWith("hundredPercent") || typeId === "ribbonChart") return [];
  const stacked = typeId.startsWith("stacked");
  return [
    { id: "constantLine", label: "Constant line", object: "constantLine", props: lineProps([{ key: "value", label: "Value", type: "number", auto: "Enter a value" }]) },
    { id: "minLine", label: "Min line", object: "minLine", props: lineProps() },
    { id: "maxLine", label: "Max line", object: "maxLine", props: lineProps() },
    { id: "averageLine", label: "Average line", object: "averageLine", props: lineProps() },
    { id: "medianLine", label: "Median line", object: "medianLine", props: lineProps() },
    { id: "percentileLine", label: "Percentile line", object: "percentileLine", props: lineProps([{ key: "percentile", label: "Percentile (%)", type: "number", min: 0, max: 100, default: 50 }]) },
    ...(stacked ? [] : [{ id: "trendLine", label: "Trend line", object: "trendLine", props: [{ key: "show", label: "Show", type: "bool", default: false } as PropDef, { key: "lineColor", label: "Color", type: "color" } as PropDef, { key: "strokeWidth", label: "Width", type: "number", min: 1, max: 10, default: 2 } as PropDef, { key: "style", label: "Style", type: "enum", default: "dashed", options: opt("solid", "dashed", "dotted") } as PropDef] }]),
  ];
}

/** Cards of the Visual tab for a visual type. Combo charts also offer the secondary axis; maps have none. */
export interface CardContext {
  pages: { name: string; displayName: string }[];
  bookmarks: { id: string; name: string }[];
}

const NONE = [{ value: "", label: "(none)" }];

/** The Action card of a button: what a click does. The page and bookmark lists come from the report. */
export function actionCard(ctx?: CardContext): CardDef {
  return {
    id: "visualLink",
    label: "Action",
    object: "visualLink",
    props: [
      { key: "type", label: "Type", type: "enum", default: "None", options: opt("None", "Back", "Bookmark", "PageNavigation", "WebUrl") },
      { key: "navigationSection", label: "Page", type: "enum", options: ctx?.pages.length ? ctx.pages.map((p) => ({ value: p.name, label: p.displayName })) : NONE, auto: "Choose a page" },
      { key: "bookmark", label: "Bookmark", type: "enum", options: ctx?.bookmarks.length ? ctx.bookmarks.map((b) => ({ value: b.id, label: b.name })) : NONE, auto: "Choose a bookmark" },
      { key: "webUrl", label: "Web address", type: "text", auto: "https://" },
    ],
  };
}

export function visualCards(typeId: string, ctx?: CardContext): CardDef[] {
  const fam = visualType(typeId)?.family;
  const cards = [...(fam === "button" ? [actionCard(ctx)] : []), ...((fam && BY_FAMILY[fam]) || [])];
  if (typeId === "lineClusteredColumnComboChart") return [...cards, { ...valueAxis, id: "secondaryValueAxis", label: "Secondary Y-axis", object: "secondaryValueAxis" }];
  if (typeId === "lineChart" || typeId === "areaChart" || typeId === "stackedAreaChart" || typeId === "hundredPercentStackedAreaChart" || typeId === "lineClusteredColumnComboChart") return cards;
  return cards.filter((c) => c.id !== "lineStyles");
}

/** Cards of the General tab (the visual container), the same for every visual. */
export function generalCards(pages: { name: string; displayName: string }[]): CardDef[] {
  return [
    {
      id: "title",
      label: "Title",
      object: "title",
      props: [
        { key: "show", label: "Show", type: "bool" },
        { key: "text", label: "Text", type: "text", auto: "Automatic" },
        { key: "fontSize", label: "Text size", type: "number", min: 6, max: 60, auto: "Theme" },
        { key: "fontColor", label: "Text color", type: "color" },
        { key: "bold", label: "Bold", type: "bool", default: false },
        { key: "alignment", label: "Alignment", type: "enum", default: "left", options: [{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }] },
        { key: "background", label: "Background", type: "color" },
      ],
    },
    {
      id: "background",
      label: "Background",
      object: "background",
      props: [{ key: "show", label: "Show", type: "bool", default: true }, { key: "color", label: "Color", type: "color" }, { key: "transparency", label: "Transparency (%)", type: "number", min: 0, max: 100, default: 0 }],
    },
    {
      id: "border",
      label: "Border",
      object: "border",
      props: [{ key: "show", label: "Show", type: "bool", default: false }, { key: "color", label: "Color", type: "color" }, { key: "radius", label: "Radius", type: "number", min: 0, max: 60, default: 0 }, { key: "width", label: "Width", type: "number", min: 1, max: 10, default: 1 }],
    },
    { id: "altText", label: "Alt text", object: "altText", props: [{ key: "text", label: "Alt text", type: "text", auto: "None" }] },
    { id: "dropShadow", label: "Shadow", object: "dropShadow", props: [{ key: "show", label: "Show", type: "bool", default: false }] },
    {
      id: "visualTooltip",
      label: "Tooltips",
      object: "visualTooltip",
      props: [
        { key: "type", label: "Type", type: "enum", default: "Default", options: [{ value: "Default", label: "Default" }, { value: "ReportPage", label: "Report page" }] },
        { key: "section", label: "Page", type: "enum", options: pages.map((p) => ({ value: p.name, label: p.displayName })), auto: "Choose a tooltip page" },
      ],
    },
  ];
}
