// General > Responsive and Responsive (legacy): a chart in a small visual drops its legend, axes and titles instead of squeezing them.
// The thresholds are the ones Power BI Desktop's cartesian visuals use (research notes: written from what the minified code does, not copied).
// The rules are applied as format overrides on a copy of the visual, so that everything built from the format (grid margins, axis titles,
// the zoom slider) follows.
import { lit } from "./fields";
import { FormatReader } from "./formatReader";
import type { Theme } from "./theme";
import { setFormat, type VisualModel } from "./visualDoc";

export interface Viewport {
  width: number;
  height: number;
}

/** The chart types with the Responsive switches (the cartesian visuals). */
export const RESPONSIVE_TYPES = /^(clusteredBarChart|clusteredColumnChart|barChart|columnChart|hundredPercent\w+Chart|lineChart|areaChart|stackedAreaChart|ribbonChart|waterfallChart|scatterChart|line\w+ComboChart)$/;

const SIDE_LEGEND = /^(Left|Right)/;

/** The visual as it is drawn in a viewport this small: with Responsive on (the default) the new rules, else the legacy rules when they are on. */
export function responsiveVisual(visual: VisualModel, theme: Theme, size: Viewport | undefined): VisualModel {
  if (!size || !RESPONSIVE_TYPES.test(visual.visualType)) return visual;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const responsive = f.bool("general", "responsive", true);
  const legacy = f.bool("general", "responsiveLegacy", false);
  if (!responsive && !legacy) return visual;
  const { width: w, height: h } = size;
  const json = structuredClone(visual.json);
  const off = (object: string, ...props: string[]) => props.forEach((p) => setFormat(json, object, p, lit.bool(false)));
  const titles = (axes: ("x" | "y")[]) => {
    if (axes.includes("x")) off("categoryAxis", "showAxisTitle");
    if (axes.includes("y")) off("valueAxis", "showAxisTitle", "secShowAxisTitle");
  };
  const valueAxesOff = () => off("valueAxis", "show", "secShow");
  const sideLegend = SIDE_LEGEND.test(f.str("legend", "position", "Top"));
  if (responsive) {
    if ((w < 210 || h < 100) && sideLegend) setFormat(json, "legend", "position", lit.str("Top"));
    if (h < 70 || w < 80) off("legend", "show");
    if (h < 100) off("categoryAxis", "show");
    if (w < 210) titles(["y"]);
    if (w < 100) valueAxesOff();
    if (h < 145) titles(["x"]);
    // the zoom slider needs room
    if (h < 150 || w < 280) off("zoom", "show", "showOnValueAxis", "showOnValueSecAxis");
  } else {
    if (h <= 58) titles(["x", "y"]);
    if (w <= 128) titles(["y"]);
    if (h <= 58) off("categoryAxis", "show");
    if (w <= 76 || (w <= 128 && sideLegend)) valueAxesOff();
  }
  return { ...visual, json };
}
