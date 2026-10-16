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

const BY_FAMILY: Partial<Record<VisualFamily, CardDef[]>> = {
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

/** Cards of the Visual tab for a visual type. Combo charts also offer the secondary axis; maps have none. */
export function visualCards(typeId: string): CardDef[] {
  const fam = visualType(typeId)?.family;
  const cards = (fam && BY_FAMILY[fam]) || [];
  if (typeId === "lineClusteredColumnComboChart") return [...cards, { ...valueAxis, id: "secondaryValueAxis", label: "Secondary Y-axis", object: "secondaryValueAxis" }];
  if (typeId === "lineChart" || typeId === "areaChart" || typeId === "stackedAreaChart" || typeId === "lineClusteredColumnComboChart") return cards;
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
