// Names shown in the Format pane. The schema only has identifiers, so the labels are written here: a table for the
// common ones and a camelCase splitter for the rest.

const PROP_LABELS: Record<string, string> = {
  show: "Show",
  fontSize: "Text size",
  textSize: "Text size",
  fontFamily: "Font family",
  fontColor: "Text color",
  labelColor: "Text color",
  color: "Color",
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  backColor: "Background color",
  backgroundColor: "Background color",
  background: "Background color",
  transparency: "Transparency (%)",
  alignment: "Alignment",
  horizontalAlignment: "Horizontal alignment",
  verticalAlignment: "Vertical alignment",
  text: "Text",
  titleText: "Title text",
  showAxisTitle: "Show title",
  titleColor: "Title color",
  titleFontSize: "Title text size",
  titleFontFamily: "Title font family",
  titleBold: "Title bold",
  titleItalic: "Title italic",
  titleUnderline: "Title underline",
  start: "Minimum",
  end: "Maximum",
  min: "Minimum",
  max: "Maximum",
  invertAxis: "Reverse order",
  logAxisScale: "Logarithmic scale",
  labelDisplayUnits: "Display units",
  labelPrecision: "Decimal places",
  gridlineShow: "Show gridlines",
  gridlineColor: "Gridline color",
  gridlineThickness: "Gridline width",
  gridlineStyle: "Gridline style",
  gridlineTransparency: "Gridline transparency (%)",
  gridlineDashArray: "Gridline dash pattern",
  gridlineDashCap: "Gridline dash cap",
  gridlineAutoScale: "Gridline width follows zoom",
  strokeWidth: "Line width",
  strokeColor: "Line color",
  lineColor: "Line color",
  lineStyle: "Line style",
  lineChartType: "Line type",
  showMarker: "Show markers",
  markerSize: "Marker size",
  markerShape: "Marker shape",
  markerColor: "Marker color",
  radius: "Corner radius",
  width: "Width",
  weight: "Weight",
  labelPosition: "Position",
  position: "Position",
  labelOrientation: "Orientation",
  enableBackground: "Show background",
  fill: "Color",
  defaultColor: "Default color",
  fillColor: "Fill color",
  innerRadiusRatio: "Inner radius (%)",
  tileShape: "Shape",
  angle: "Angle (degrees)",
  displayName: "Name",
  value: "Value",
  percentile: "Percentile (%)",
  dataLabelShow: "Show data label",
  navigationSection: "Page",
  webUrl: "Web address",
  altText: "Alt text",
  type: "Type",
  mode: "Style",
  singleSelect: "Single select",
  selectAllCheckboxEnabled: "Show \"Select all\"",
  selfFilterEnabled: "Search box",
  direction: "Good when",
  responsive: "Resize to fit",
  formatString: "Format string",
  heading: "Heading level",
  titleWrap: "Wrap text",
  wordWrap: "Wrap text",
  imageUrl: "Image address",
};

const CARD_LABELS: Record<string, string> = {
  title: "Title",
  subTitle: "Subtitle",
  divider: "Divider",
  spacing: "Spacing",
  background: "Background",
  border: "Border",
  dropShadow: "Shadow",
  padding: "Padding",
  lockAspect: "Lock aspect",
  general: "Alt text",
  visualHeader: "Visual header",
  visualHeaderTooltip: "Header tooltip",
  visualTooltip: "Tooltips",
  visualLink: "Action",
  stylePreset: "Style preset",
  legend: "Legend",
  categoryAxis: "X-axis",
  valueAxis: "Y-axis",
  labels: "Data labels",
  dataLabels: "Data labels",
  dataPoint: "Data colors",
  lineStyles: "Lines",
  markers: "Markers",
  plotArea: "Plot area",
  zoom: "Zoom slider",
  slices: "Slices",
  seriesLabels: "Series labels",
  smallMultiplesLayout: "Small multiples",
  error: "Error bars",
  forecast: "Forecast",
  anomalyDetection: "Find anomalies",
  referenceLine: "Reference lines",
  y1AxisReferenceLine: "Y-axis constant line",
  xAxisReferenceLine: "X-axis constant line",
  trend: "Trend line",
  ratioLine: "Ratio line",
  plotAreaShading: "Symmetry shading",
  sentimentColors: "Sentiment colors",
  breakdown: "Breakdown",
  axis: "Gauge axis",
  target: "Target",
  calloutValue: "Callout value",
  categoryLabels: "Category label",
  indicator: "Indicator",
  goals: "Goals",
  trendline: "Trend axis",
  status: "Status colors",
  lastDate: "Last date",
  values: "Cell elements",
  columnHeaders: "Column headers",
  rowHeaders: "Row headers",
  total: "Totals",
  rowTotal: "Row grand total",
  columnTotal: "Column grand total",
  subTotals: "Subtotals",
  grid: "Grid",
  columnWidth: "Column width",
  columnFormatting: "Specific column",
  sparklines: "Sparklines",
  blankRows: "Blank rows",
  card: "Card",
  cardTitle: "Card title",
  data: "Slicer settings",
  selection: "Selection",
  header: "Slicer header",
  items: "Values",
  dropdown: "Dropdown",
  slider: "Slider",
  searchBox: "Search box",
  date: "Date input",
  dateRange: "Date range",
  numericInputStyle: "Numeric inputs",
  shape: "Shape",
  fill: "Fill",
  outline: "Outline",
  rotation: "Rotation",
  text: "Text",
  icon: "Icon",
  glow: "Glow",
  shadow: "Shadow",
  image: "Image",
  imageScaling: "Scaling",
  pages: "Pages",
  layout: "Layout",
  filters: "Filters",
  accentBar: "Accent bar",
  wordWrap: "Word wrap",
  bubbles: "Bubbles",
  colorBorder: "Color border",
  fillPoint: "Fill point",
  colorByCategory: "Color by category",
  percentBarLabel: "Percent bar labels",
  actionButtonSection: "Button section",
  annotationTemplate: "Annotation",
};

/** "labelDisplayUnits" -> "Label display units". */
export function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase().replace(/\b(url|id|ui)\b/g, (m) => m.toUpperCase());
}

export const propLabel = (prop: string): string => PROP_LABELS[prop] ?? humanize(prop);
export const cardLabel = (object: string): string => CARD_LABELS[object] ?? humanize(object);

const UNIT_LABELS: Record<string, string> = { "0": "Auto", "1": "None", "1000": "Thousands", "1000000": "Millions", "1000000000": "Billions", "1000000000000": "Trillions", "-1": "Same as values" };

/** Label of one allowed value of an enumerated property. */
export function optionLabel(prop: string, value: string | number): string {
  if (/DisplayUnits$/i.test(prop) && UNIT_LABELS[String(value)] !== undefined) return UNIT_LABELS[String(value)];
  if (typeof value === "number") return String(value);
  return humanize(value.replace(/^(.)/, (c) => c.toUpperCase()));
}

/** Properties of a card that belong together; the pane shows a small heading before each group. */
export function propGroup(object: string, prop: string): string | null {
  if (/^sec[A-Z]/.test(prop)) return "Secondary axis";
  if (/^title[A-Z]/.test(prop) && prop !== "titleWrap" && prop !== "titleText") return /Axis$/.test(object) ? "Axis title" : "Title style";
  if (prop === "showAxisTitle" || (prop === "titleText" && /Axis$/.test(object))) return "Axis title";
  if (/^gridline/.test(prop)) return "Gridlines";
  if (/^detail/.test(prop)) return "Detail labels";
  if (/^dataLabel/.test(prop)) return "Data label";
  if (/^marker/.test(prop)) return "Markers";
  if (/^shade/.test(prop)) return "Shading";
  if (/^band/.test(prop)) return "Confidence band";
  if (/^bar[A-Z]/.test(prop)) return "Bars";
  if (/^stroke/.test(prop)) return "Line";
  if (/^border/.test(prop)) return "Border";
  if (/^outline/.test(prop)) return "Outline";
  if (/^label[A-Z]/.test(prop) && /^(error|forecast)$/.test(object)) return "Labels";
  return null;
}
