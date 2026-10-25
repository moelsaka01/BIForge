// Catalog of the visual types BIForge can author. Type ids are the PBIR visualType names.

export type RoleKind = "column" | "value" | "any";

export interface RoleDef {
  name: string;
  label: string;
  /** column: grouping fields only; value: measures and aggregated columns; any: both (tables). */
  accepts: RoleKind;
  /** Maximum number of fields; more than one grouping field in the first role makes a drill hierarchy. */
  max: number;
}

export type VisualFamily = "decomposition" | "keyDrivers" | "cartesian" | "pie" | "scatter" | "table" | "matrix" | "card" | "kpi" | "gauge" | "treemap" | "funnel" | "waterfall" | "slicer" | "map" | "textbox" | "shape" | "image" | "button" | "pageNavigator" | "bookmarkNavigator";

export interface VisualTypeDef {
  id: string;
  label: string;
  family: VisualFamily;
  roles: RoleDef[];
  size: { width: number; height: number };
  /** Short text shown on the gallery button. */
  glyph: string;
  /** An object that shows no data (text box, shape, image, button, page navigator): inserted from the Insert tab, not the gallery. */
  static?: boolean;
}

const cat = (max = 8): RoleDef => ({ name: "Category", label: "X-axis", accepts: "column", max });
const series: RoleDef = { name: "Series", label: "Legend", accepts: "column", max: 1 };
const y = (label = "Y-axis", max = 12): RoleDef => ({ name: "Y", label, accepts: "value", max });

/** Small multiples split a chart into one small chart per value of a field (the report format calls the well Rows). */
const SMALL_MULTIPLES: RoleDef = { name: "Rows", label: "Small multiples", accepts: "column", max: 1 };
const NO_SMALL_MULTIPLES = new Set(["ribbonChart", "lineClusteredColumnComboChart", "lineStackedColumnComboChart"]);

const cartesian = (id: string, label: string, glyph: string, extra: RoleDef[] = []): VisualTypeDef => ({
  id,
  label,
  family: "cartesian",
  roles: [cat(), series, y(), ...extra, ...(NO_SMALL_MULTIPLES.has(id) ? [] : [SMALL_MULTIPLES])],
  size: { width: 400, height: 300 },
  glyph,
});

export const VISUAL_TYPES: VisualTypeDef[] = [
  cartesian("clusteredBarChart", "Clustered bar chart", "≡▮"),
  cartesian("barChart", "Stacked bar chart", "≣▮"),
  cartesian("hundredPercentStackedBarChart", "100% stacked bar chart", "%≡"),
  cartesian("clusteredColumnChart", "Clustered column chart", "▮▮"),
  cartesian("columnChart", "Stacked column chart", "▮▯"),
  cartesian("hundredPercentStackedColumnChart", "100% stacked column chart", "%▮"),
  cartesian("lineChart", "Line chart", "╱╲"),
  cartesian("areaChart", "Area chart", "◿"),
  cartesian("stackedAreaChart", "Stacked area chart", "◢"),
  cartesian("hundredPercentStackedAreaChart", "100% stacked area chart", "%◢"),
  cartesian("ribbonChart", "Ribbon chart", "▮≈"),
  cartesian("lineClusteredColumnComboChart", "Line and clustered column chart", "▮╱", [{ name: "Y2", label: "Line y-axis", accepts: "value", max: 12 }]),
  cartesian("lineStackedColumnComboChart", "Line and stacked column chart", "▯╱", [{ name: "Y2", label: "Line y-axis", accepts: "value", max: 12 }]),
  {
    id: "pieChart",
    label: "Pie chart",
    family: "pie",
    roles: [{ name: "Category", label: "Legend", accepts: "column", max: 1 }, y("Values", 1)],
    size: { width: 360, height: 300 },
    glyph: "◔",
  },
  {
    id: "donutChart",
    label: "Donut chart",
    family: "pie",
    roles: [{ name: "Category", label: "Legend", accepts: "column", max: 1 }, y("Values", 1)],
    size: { width: 360, height: 300 },
    glyph: "◎",
  },
  {
    id: "scatterChart",
    label: "Scatter chart",
    family: "scatter",
    roles: [
      { name: "Category", label: "Details", accepts: "column", max: 1 },
      { name: "Series", label: "Legend", accepts: "column", max: 1 },
      { name: "X", label: "X-axis", accepts: "value", max: 1 },
      { name: "Y", label: "Y-axis", accepts: "value", max: 1 },
      { name: "Size", label: "Size", accepts: "value", max: 1 },
    ],
    size: { width: 420, height: 320 },
    glyph: "∴",
  },
  {
    id: "tableEx",
    label: "Table",
    family: "table",
    roles: [{ name: "Values", label: "Columns", accepts: "any", max: 30 }],
    size: { width: 460, height: 300 },
    glyph: "▦",
  },
  {
    id: "pivotTable",
    label: "Matrix",
    family: "matrix",
    roles: [
      { name: "Rows", label: "Rows", accepts: "column", max: 6 },
      { name: "Columns", label: "Columns", accepts: "column", max: 3 },
      { name: "Values", label: "Values", accepts: "value", max: 12 },
    ],
    size: { width: 480, height: 320 },
    glyph: "▤",
  },
  { id: "card", label: "Card", family: "card", roles: [{ name: "Values", label: "Fields", accepts: "value", max: 1 }], size: { width: 200, height: 120 }, glyph: "123" },
  { id: "cardVisual", label: "Card (new)", family: "card", roles: [{ name: "Data", label: "Data", accepts: "any", max: 8 }], size: { width: 320, height: 140 }, glyph: "▭" },
  {
    id: "multiRowCard",
    label: "Multi-row card",
    family: "card",
    roles: [{ name: "Values", label: "Fields", accepts: "any", max: 12 }],
    size: { width: 260, height: 220 },
    glyph: "☰",
  },
  {
    id: "kpi",
    label: "KPI",
    family: "kpi",
    roles: [
      { name: "Indicator", label: "Value", accepts: "value", max: 1 },
      { name: "TrendLine", label: "Trend axis", accepts: "column", max: 1 },
      { name: "Goal", label: "Target", accepts: "value", max: 1 },
    ],
    size: { width: 240, height: 160 },
    glyph: "▲",
  },
  {
    id: "gauge",
    label: "Gauge",
    family: "gauge",
    roles: [
      { name: "Y", label: "Value", accepts: "value", max: 1 },
      { name: "MinValue", label: "Minimum", accepts: "value", max: 1 },
      { name: "MaxValue", label: "Maximum", accepts: "value", max: 1 },
      { name: "TargetValue", label: "Target", accepts: "value", max: 1 },
    ],
    size: { width: 300, height: 220 },
    glyph: "◠",
  },
  {
    id: "treemap",
    label: "Treemap",
    family: "treemap",
    roles: [{ name: "Group", label: "Category", accepts: "column", max: 2 }, { name: "Values", label: "Values", accepts: "value", max: 1 }],
    size: { width: 400, height: 300 },
    glyph: "▩",
  },
  {
    id: "funnel",
    label: "Funnel",
    family: "funnel",
    roles: [{ name: "Category", label: "Category", accepts: "column", max: 1 }, y("Values", 1)],
    size: { width: 360, height: 300 },
    glyph: "⏷",
  },
  {
    id: "waterfallChart",
    label: "Waterfall chart",
    family: "waterfall",
    roles: [
      { name: "Category", label: "Category", accepts: "column", max: 1 },
      { name: "Breakdown", label: "Breakdown", accepts: "column", max: 1 },
      y("Y-axis", 1),
    ],
    size: { width: 420, height: 300 },
    glyph: "▂▅",
  },
  {
    id: "decompositionTreeVisual",
    label: "Decomposition tree",
    family: "decomposition",
    roles: [
      { name: "Analyze", label: "Analyze", accepts: "value", max: 1 },
      { name: "ExplainBy", label: "Explain by", accepts: "column", max: 10 },
    ],
    size: { width: 620, height: 360 },
    glyph: "⑂",
  },
  {
    id: "keyDriversVisual",
    label: "Key influencers",
    family: "keyDrivers",
    roles: [
      { name: "Target", label: "Analyze", accepts: "any", max: 1 },
      { name: "ExplainBy", label: "Explain by", accepts: "column", max: 10 },
    ],
    size: { width: 480, height: 360 },
    glyph: "⚑",
  },
  { id: "slicer", label: "Slicer", family: "slicer", roles: [{ name: "Values", label: "Field (several make a hierarchy slicer)", accepts: "column", max: 5 }], size: { width: 200, height: 240 }, glyph: "▽" },
  // the new slicers: same selection pipeline as the slicer (role Values, one filter on the visual); they differ in what they draw
  { id: "advancedSlicerVisual", label: "Slicer (new)", family: "slicer", roles: [{ name: "Values", label: "Field", accepts: "column", max: 1 }], size: { width: 240, height: 180 }, glyph: "▤" },
  { id: "listSlicer", label: "List slicer", family: "slicer", roles: [{ name: "Values", label: "Field", accepts: "column", max: 1 }], size: { width: 220, height: 40 }, glyph: "▾" },
  { id: "textSlicer", label: "Text slicer", family: "slicer", roles: [{ name: "Values", label: "Field", accepts: "column", max: 1 }], size: { width: 220, height: 56 }, glyph: "Ⓣ" },
  {
    id: "map",
    label: "Map",
    family: "map",
    roles: [
      { name: "Category", label: "Location", accepts: "column", max: 1 },
      series,
      { name: "Size", label: "Bubble size", accepts: "value", max: 1 },
      { name: "X", label: "Longitude", accepts: "value", max: 1 },
      { name: "Y", label: "Latitude", accepts: "value", max: 1 },
    ],
    size: { width: 420, height: 300 },
    glyph: "🌐",
  },
  {
    id: "filledMap",
    label: "Filled map",
    family: "map",
    roles: [{ name: "Category", label: "Location", accepts: "column", max: 1 }, { name: "Size", label: "Color saturation", accepts: "value", max: 1 }],
    size: { width: 420, height: 300 },
    glyph: "▦",
  },
];

const staticType = (id: string, label: string, family: VisualFamily, glyph: string, size: { width: number; height: number }): VisualTypeDef => ({ id, label, family, roles: [], size, glyph, static: true });

VISUAL_TYPES.push(
  staticType("textbox", "Text box", "textbox", "T", { width: 300, height: 80 }),
  staticType("shape", "Shape", "shape", "◻", { width: 160, height: 120 }),
  staticType("image", "Image", "image", "🖼", { width: 200, height: 150 }),
  staticType("actionButton", "Button", "button", "▭", { width: 160, height: 40 }),
  staticType("pageNavigator", "Page navigator", "pageNavigator", "⇆", { width: 420, height: 48 }),
  staticType("bookmarkNavigator", "Bookmark navigator", "bookmarkNavigator", "🔖", { width: 420, height: 48 }),
);

export const isStatic = (typeId: string): boolean => visualType(typeId)?.static === true;

export function visualType(id: string): VisualTypeDef | undefined {
  return VISUAL_TYPES.find((t) => t.id === id);
}

export function roleDef(typeId: string, role: string): RoleDef | undefined {
  return visualType(typeId)?.roles.find((r) => r.name === role);
}

/** The role a field is added to by default when it is dropped on the visual without choosing a well. */
export function defaultRole(typeId: string, kind: "column" | "value", current: Record<string, unknown[]>): string | null {
  const t = visualType(typeId);
  if (!t) return null;
  const candidates = t.roles.filter((r) => r.accepts === "any" || r.accepts === kind);
  for (const r of candidates) {
    if ((current[r.name]?.length ?? 0) < r.max) return r.name;
  }
  // every well is full: a field dropped on the visual replaces the one in a single-field well
  return candidates.find((r) => r.max === 1)?.name ?? null;
}

export const isChartFamily = (f: VisualFamily) => ["cartesian", "pie", "scatter", "map", "treemap", "funnel", "waterfall", "gauge"].includes(f);
