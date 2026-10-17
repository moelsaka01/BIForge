// The formatting objects that most charts share, turned into ECharts options: legend, axes, data labels, lines and
// markers, reference lines. One reading per object, so a property supported here works on every chart that has the
// object, and the Format pane's controls for it do something everywhere.
import { echartsText, readFont, opacityOf, type Font } from "../format/styles";
import type { FormatReader } from "./formatReader";
import { formatCompact, formatNumber, type DisplayUnits } from "./numberFormat";
import type { Theme } from "./theme";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type O = Record<string, any>;

// ---- display units and number text --------------------------------------------------------------------

const UNIT_BY_NUMBER: Record<number, DisplayUnits> = { 0: "auto", 1: "none", 1000: "thousands", 1000000: "millions", 1000000000: "billions", 1000000000000: "trillions" };
const UNIT_NAME: Record<string, string> = { thousands: "Thousands", millions: "Millions", billions: "Billions", trillions: "Trillions" };

/** Display units of a card (labelDisplayUnits and its prefixed forms): 0 auto, 1 none, 1000 thousands, ... */
export function unitsOf(f: FormatReader, object: string, prop = "labelDisplayUnits", selector?: string): DisplayUnits {
  return UNIT_BY_NUMBER[f.num(object, prop, 0, selector)] ?? "auto";
}

export const unitLabel = (u: DisplayUnits): string => UNIT_NAME[u] ?? "";

/** A value as text with the card's display units and decimal places. */
export function valueText(x: number | null, fmt: string | null, f: FormatReader, object = "labels", prefix = "", selector?: string): string {
  if (x === null) return "";
  const u = unitsOf(f, object, prefix ? `${prefix}LabelDisplayUnits` : "labelDisplayUnits", selector);
  const precKey = prefix ? `${prefix}LabelPrecision` : "labelPrecision";
  const dec = f.has(object, precKey, selector) ? f.num(object, precKey, 1, selector) : u === "none" ? 2 : 1;
  return fmt && u === "none" ? formatNumber(x, fmt) : formatCompact(x, u, dec, fmt);
}

export interface Defaults {
  family: string;
  size: number;
  color: string;
}
export const labelDefaults = (theme: Theme): Defaults => ({ family: theme.textClasses.label.fontFace, size: theme.textClasses.label.fontSize, color: theme.textClasses.label.color });

// ---- legend ---------------------------------------------------------------------------------------------

const LEGEND_POS: Record<string, O> = {
  Top: { top: 0, left: 0, orient: "horizontal" },
  TopCenter: { top: 0, left: "center", orient: "horizontal" },
  TopRight: { top: 0, right: 0, orient: "horizontal" },
  Left: { top: 0, left: 0, orient: "vertical" },
  Right: { top: 0, right: 0, orient: "vertical" },
  LeftCenter: { top: "middle", left: 0, orient: "vertical" },
  RightCenter: { top: "middle", right: 0, orient: "vertical" },
  Bottom: { bottom: 0, left: 0, orient: "horizontal" },
  BottomCenter: { bottom: 0, left: "center", orient: "horizontal" },
  BottomRight: { bottom: 0, right: 0, orient: "horizontal" },
};

export function legendBlock(f: FormatReader, theme: Theme, show: boolean): O {
  const pos = f.str("legend", "position", "Top");
  const font = readFont(f, "legend", { color: "labelColor" });
  return {
    show: f.bool("legend", "show", show),
    type: "scroll",
    ...(LEGEND_POS[pos] ?? LEGEND_POS.Top),
    textStyle: echartsText(font, labelDefaults(theme)),
    icon: f.str("legend", "legendMarkerRendering", "markerCircleDefault") === "lineOnly" ? "path://M0,4 L10,4 L10,6 L0,6 Z" : "roundRect",
    itemWidth: 10,
    itemHeight: 10,
  };
}

/** The plot area's margins make room for the legend on its side. */
export function gridFor(f: FormatReader, legendShown: boolean): O {
  const pos = f.str("legend", "position", "Top");
  const g: O = { left: 8, right: 12, top: 8, bottom: 8, containLabel: true };
  if (legendShown) {
    if (pos.startsWith("Bottom")) g.bottom = 30;
    else if (pos.startsWith("Left")) g.left = 90;
    else if (pos.startsWith("Right")) g.right = 100;
    else g.top = 30;
  }
  return g;
}

// ---- axes -----------------------------------------------------------------------------------------------

const DASH: Record<string, number[] | string> = { solid: "solid", dashed: [6, 4], dotted: [2, 3], custom: [6, 4] };

export interface AxisInput {
  f: FormatReader;
  theme: Theme;
  /** The formatting object: valueAxis or categoryAxis. */
  object: "valueAxis" | "categoryAxis";
  /** "sec" reads the secondary axis properties of a combo chart's valueAxis (secShow, secStart, ...). */
  prefix?: "sec";
  kind: "category" | "value";
  /** Number format of the plotted measure, for value axes. */
  fmt?: string | null;
  /** Text used as the axis title when the title text is not set. */
  titleDefault: string;
  /** The axis shows 0..100 %. */
  hundred?: boolean;
  /** Reverse the direction by default (horizontal bar charts list categories from the top). */
  inverseDefault?: boolean;
  /** Whether the axis shows by default. */
  showDefault?: boolean;
  gridDefault?: boolean;
  horizontal?: boolean;
}

export function axisBlock(a: AxisInput): O {
  const { f, theme, object, kind } = a;
  const k = (name: string) => (a.prefix ? a.prefix + name.charAt(0).toUpperCase() + name.slice(1) : name);
  const d = labelDefaults(theme);
  const font: Font = readFont(f, object, a.prefix ? { prefix: a.prefix, color: "secLabelColor" } : { color: "labelColor" });
  const titleFont = readFont(f, object, { prefix: a.prefix ? "secTitle" : "title" });
  const unit = unitsOf(f, object, k("labelDisplayUnits"));
  const style = f.str(object, k("axisStyle"), "showTitleOnly");
  const titleText = f.str(object, k("titleText"), a.titleDefault);
  const unitText = unitLabel(unit);
  const title = style === "showUnitOnly" ? unitText : style === "showBoth" && unitText ? `${titleText} (${unitText})` : titleText;
  const showTitle = f.bool(object, k("showAxisTitle"), false) && title !== "";
  const gridOn = f.bool(object, "gridlineShow", a.gridDefault ?? a.kind === "value");
  const gridAlpha = opacityOf(f.num(object, "gridlineTransparency", 0));
  const gridBase = f.color(object, "gridlineColor") ?? (theme.dark ? "#ffffff" : "#000000");
  const baseAlpha = f.has(object, "gridlineColor") ? 1 : theme.dark ? 0.12 : 0.1;
  const log = f.bool(object, k("logAxisScale"), false);
  const invert = f.bool(object, "invertAxis", false);
  const opposite = f.bool(object, "switchAxisPosition", false);
  const lo = f.has(object, k("start")) ? f.num(object, k("start"), 0) : undefined;
  const hi = f.has(object, k("end")) ? f.num(object, k("end"), 0) : undefined;
  const base: O = {
    show: f.bool(object, k("show"), a.showDefault ?? true),
    axisLabel: {
      ...echartsText(font, d),
    },
    name: showTitle ? title : undefined,
    nameLocation: "middle",
    nameGap: kind === "value" ? 44 : 28,
    nameTextStyle: echartsText(titleFont, { family: d.family, size: d.size, color: d.color }),
    splitLine: { show: gridOn, lineStyle: { color: gridBase, opacity: baseAlpha * gridAlpha, width: f.num(object, "gridlineThickness", 1), type: DASH[f.str(object, "gridlineStyle", "solid")] ?? "solid" } },
  };
  if (kind === "category") {
    base.axisLabel = { ...base.axisLabel, hideOverlap: true, width: f.has(object, "preferredCategoryWidth") ? f.num(object, "preferredCategoryWidth", 90) : a.horizontal ? 110 : 90, overflow: "truncate" };
    base.axisLine = { lineStyle: { color: theme.muted } };
    base.axisTick = { show: false };
    base.inverse = a.inverseDefault ? !invert : invert;
    base.type = "category";
    if (opposite) base.position = a.horizontal ? "right" : "top";
  } else {
    base.type = log ? "log" : "value";
    base.inverse = invert;
    base.min = lo ?? (a.hundred ? 0 : undefined);
    base.max = hi ?? (a.hundred ? 100 : undefined);
    if (opposite) base.position = a.horizontal ? "top" : "right";
    base.axisLabel.formatter = (v: number) => (a.hundred ? `${v}%` : valueText(v, a.fmt ?? null, f, object, a.prefix ?? ""));
  }
  return base;
}

// ---- data labels ----------------------------------------------------------------------------------------

const BAR_POS: Record<string, [string, string]> = {
  // [vertical columns, horizontal bars]
  InsideEnd: ["insideTop", "insideRight"],
  OutsideEnd: ["top", "right"],
  InsideCenter: ["inside", "inside"],
  InsideBase: ["insideBottom", "insideLeft"],
};

export interface LabelInput {
  f: FormatReader;
  theme: Theme;
  show: boolean;
  horizontal: boolean;
  stacked: boolean;
  asLine: boolean;
  text(pa: O): string;
}

/** The label of a series from the labels object. */
export function labelBlock(a: LabelInput): O {
  const { f, theme } = a;
  const font = readFont(f, "labels", { color: "color" });
  const pos = f.str("labels", "labelPosition", "Auto");
  let position: string = a.asLine ? "top" : a.stacked ? "inside" : a.horizontal ? "right" : "top";
  if (a.asLine) position = pos === "Under" ? "bottom" : "top";
  else if (BAR_POS[pos]) position = BAR_POS[pos][a.horizontal ? 1 : 0];
  const out: O = {
    show: a.show,
    position,
    ...echartsText(font, labelDefaults(theme)),
    formatter: a.text,
    opacity: opacityOf(f.num("labels", "transparency", 0)),
  };
  if (f.bool("labels", "enableBackground", false)) {
    out.backgroundColor = f.color("labels", "backgroundColor") ?? theme.background;
    out.padding = [2, 4];
    out.borderRadius = 2;
  }
  if (f.num("labels", "labelOrientation", 0) === 1) out.rotate = 90;
  return out;
}

// ---- lines and markers ------------------------------------------------------------------------------------

const SYMBOL: Record<string, string> = {
  circle: "circle",
  square: "rect",
  diamond: "diamond",
  triangle: "triangle",
  x: "path://M2,2 L8,8 M8,2 L2,8",
  shortDash: "path://M1,4 L9,4 L9,6 L1,6 Z",
  longDash: "path://M0,4 L10,4 L10,6 L0,6 Z",
  plus: "path://M4,0 L6,0 L6,4 L10,4 L10,6 L6,6 L6,10 L4,10 L4,6 L0,6 L0,4 L4,4 Z",
};
const STEP: Record<string, string> = { before: "start", center: "middle", after: "end" };

/** Line series options from the lineStyles object (line width and dash, markers, smoothing or steps, area). */
export function lineSeriesStyle(f: FormatReader, color: string, dimmed: boolean): O {
  const kindOf = f.str("lineStyles", "lineChartType", "linear");
  const showLine = f.bool("lineStyles", "strokeShow", true);
  const marker = f.bool("lineStyles", "showMarker", false);
  const out: O = {
    symbol: SYMBOL[f.str("lineStyles", "markerShape", "circle")] ?? "circle",
    symbolSize: marker ? f.num("lineStyles", "markerSize", 8) : 5,
    showSymbol: true,
    smooth: kindOf === "smooth",
    lineStyle: {
      color: f.color("lineStyles", "strokeColor") ?? color,
      width: showLine ? f.num("lineStyles", "strokeWidth", 2) : 0,
      type: f.str("lineStyles", "lineStyle", "solid") === "custom" ? "dashed" : f.str("lineStyles", "lineStyle", "solid"),
      opacity: (dimmed ? 0.35 : 1) * opacityOf(f.num("lineStyles", "strokeTransparency", 0)),
    },
  };
  if (kindOf === "step") out.step = STEP[f.str("lineStyles", "interpolationStep", "center")] ?? "middle";
  const markerColor = f.color("lineStyles", "markerColor");
  if (markerColor) out.itemStyle = { color: markerColor };
  return out;
}

// ---- reference lines --------------------------------------------------------------------------------------

export interface LineSpec {
  object: "y1AxisReferenceLine" | "xAxisReferenceLine" | "referenceLine";
  /** Instance id (selector.id): constant, min, max, average, median, percentile. */
  id: string;
}

const H_POS: Record<string, string> = { left: "insideStartTop", right: "insideEndTop" };

/** One reference line as an ECharts markLine entry; null when it is off or has no value. */
export function referenceLineMark(f: FormatReader, theme: Theme, spec: LineSpec, value: number | null, nameFallback: string, axisKey: "xAxis" | "yAxis", fmt: string | null): O | null {
  const sel = `id:${spec.id}`;
  if (value === null || !f.bool(spec.object, "show", false, sel)) return null;
  const color = f.color(spec.object, "lineColor", sel) ?? theme.muted;
  const title = f.str(spec.object, "displayName", "", sel) || nameFallback;
  const style = f.str(spec.object, "style", "dashed", sel);
  const what = f.str(spec.object, "dataLabelText", "ValueAndName", sel);
  const labelUnits = unitsOf(f, spec.object, "dataLabelDisplayUnits", sel);
  const dec = f.has(spec.object, "dataLabelDecimalPoints", sel) ? f.num(spec.object, "dataLabelDecimalPoints", 1, sel) : labelUnits === "none" ? 2 : 1;
  const text = labelUnits === "none" ? formatNumber(value, fmt) : formatCompact(value, labelUnits, dec, fmt);
  const label = what === "Name" ? title : what === "ValueAndName" ? `${title}: ${text}` : text;
  const above = f.str(spec.object, "dataLabelVerticalPosition", "above", sel) === "above";
  const side = f.str(spec.object, "dataLabelHorizontalPosition", "right", sel);
  return {
    name: title,
    [axisKey]: value,
    lineStyle: { color, width: f.num(spec.object, "width", 1, sel), type: style === "custom" ? "dashed" : style, opacity: opacityOf(f.num(spec.object, "transparency", 0, sel)) },
    label: { show: f.bool(spec.object, "dataLabelShow", false, sel), formatter: () => label, color: f.color(spec.object, "dataLabelColor", sel) ?? color, position: `${H_POS[side] ?? "insideEndTop"}`.replace("Top", above ? "Top" : "Bottom") },
    z: f.str(spec.object, "position", "front", sel) === "back" ? 1 : 10,
  };
}
