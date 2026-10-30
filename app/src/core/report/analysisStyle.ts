// The look of the decomposition tree and the key influencers visual from their formatting objects. Pure.
import type { CSSProperties } from "react";
import { cssFont, readFont } from "../format/styles";
import { unitsOf } from "./chartFormat";
import type { DisplayUnits } from "./numberFormat";
import type { FormatReader } from "./formatReader";
import { seriesColor, type Theme } from "./theme";

export interface TreeStyle {
  /** Nodes shown per level before "more". */
  barsPerLevel: number;
  /** How wide a bar is: against the top node, the parent node or the largest of its level. */
  scaling: "topNode" | "parentNode" | "levelMaximum";
  barColor: string;
  barBackground: string | undefined;
  negativeColor: string;
  barWidthPercent: number;
  /** Space between nodes of a level. */
  gap: number;
  accent: string;
  connector: string;
  connectorType: "curve" | "round";
  clickAction: "select" | "toggle";
  levelTitle: CSSProperties;
  levelSubtitle: CSSProperties;
  levelHeaderBackground: string | undefined;
  showSubtitles: boolean;
  label: CSSProperties;
  valueLabel: CSSProperties;
  /** Display units and decimals of the values. */
  /** general > Format string: replaces the units and decimals of the values. */
  formatString: string;
  units: DisplayUnits;
  precision: number;
  aiMode: "absolute" | "relative";
}

const DENSITY: Record<string, number> = { dense: 2, default: 6, sparse: 12 };

export function treeStyle(f: FormatReader, theme: Theme): TreeStyle {
  const lb = theme.textClasses.label;
  const base = { family: lb.fontFace, size: lb.fontSize + 1, color: theme.foreground };
  const barColor = f.color("dataBars", "dataBarColor") ?? f.color("dataBars", "positiveBarColor") ?? seriesColor(theme, 0);
  return {
    barsPerLevel: Math.max(1, Math.round(f.num("tree", "barsPerLevel", 10))),
    scaling: (["topNode", "parentNode", "levelMaximum"].includes(f.str("dataBars", "dataBarScalingType", "levelMaximum")) ? f.str("dataBars", "dataBarScalingType", "levelMaximum") : "levelMaximum") as TreeStyle["scaling"],
    barColor,
    barBackground: f.color("dataBars", "dataBarBackgroundColor"),
    negativeColor: f.color("dataBars", "negativeBarColor") ?? theme.bad,
    barWidthPercent: Math.min(100, Math.max(10, f.num("dataBars", "dataBarWidthPercent", 70))),
    gap: DENSITY[f.str("tree", "density", "default")] ?? 6,
    accent: f.color("tree", "accentColor") ?? seriesColor(theme, 0),
    connector: f.color("tree", "connectorDefaultColor") ?? theme.muted,
    connectorType: f.str("tree", "connectorType", "curve") === "round" ? "round" : "curve",
    clickAction: f.str("tree", "defaultClickAction", "select") === "toggle" ? "toggle" : "select",
    levelTitle: cssFont(readFont(f, "levelHeader", { prefix: "levelTitle", color: "levelTitleFontColor" }), { family: lb.fontFace, size: lb.fontSize + 2, color: theme.foreground }),
    levelSubtitle: cssFont(readFont(f, "levelHeader", { prefix: "levelSubtitle", color: "levelSubtitleFontColor" }), { family: lb.fontFace, size: lb.fontSize, color: theme.muted }),
    levelHeaderBackground: f.color("levelHeader", "levelHeaderBackgroundColor"),
    showSubtitles: f.bool("levelHeader", "showSubtitles", true),
    label: cssFont(readFont(f, "categoryLabels", { prefix: "categoryLabel", color: "categoryLabelFontColor" }), base),
    valueLabel: cssFont(readFont(f, "dataLabels", { prefix: "dataLabel", color: "dataLabelFontColor" }), base),
    formatString: f.str("general", "formatString", ""),
    units: unitsOf(f, "dataLabels", "dataLabelDisplayUnits"),
    precision: f.has("dataLabels", "dataLabelPrecision") ? f.num("dataLabels", "dataLabelPrecision", 1) : 1,
    aiMode: f.str("analysis", "aiMode", "absolute") === "relative" ? "relative" : "absolute",
  };
}

export interface InfluencersStyle {
  /** "impact" ranks by likelihood ratio, "count" by the number of cases. */
  sort: "impact" | "count";
  /** The outcome chosen for the analysis (keyDrivers.targetValue), or empty for the first value. */
  targetValue: string;
  analysis: "keyInfluencers" | "topProfiles";
}

export function influencersStyle(f: FormatReader): InfluencersStyle {
  return {
    sort: f.str("keyDrivers", "selectedSort", "impact") === "count" ? "count" : "impact",
    targetValue: f.str("keyDrivers", "targetValue", ""),
    analysis: f.str("keyDrivers", "selectedAnalysis", "keyInfluencers") === "topProfiles" ? "topProfiles" : "keyInfluencers",
  };
}
