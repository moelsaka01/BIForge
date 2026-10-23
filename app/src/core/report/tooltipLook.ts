// How the hover tooltip of a visual looks, read from the Tooltips card. One function for the container model (which the
// Format pane's "drawn" measurement compares) and the chart options (which apply it), so they cannot drift apart.
import { opacityOf } from "../format/styles";
import type { FormatReader } from "./formatReader";

export interface TooltipLook {
  show: boolean;
  background: string | null;
  /** 0 to 1: how much of the background shows. */
  opacity: number;
  titleColor: string | null;
  valueColor: string | null;
  valuesBold: boolean;
  fontFamily: string | null;
  fontSize: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** What the tooltip says: the chart's extra details (a pie's percentage, a bubble's size), the values only, a sentence, an action hint. */
  chartSpecific: boolean;
  fieldsOnly: boolean;
  sentence: { on: boolean; template: string };
  actions: { show: boolean; color: string | null };
}

/** The Header tooltip card: the information icon next to the title and what its tooltip says and looks like. */
export interface HeaderTooltip {
  /** "Default": `text` is the tooltip. "Canvas": the tooltip page named by `section`. */
  type: string;
  text: string;
  section: string;
  background: string | null;
  opacity: number;
  titleColor: string | null;
  fontFamily: string | null;
  fontSize: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export function headerTooltip(f: FormatReader): HeaderTooltip {
  const o = "visualHeaderTooltip";
  return {
    type: f.str(o, "type", "Default"),
    text: f.str(o, "text", ""),
    section: f.str(o, "section", ""),
    background: f.color(o, "background") ?? f.color(o, "themedBackground") ?? null,
    opacity: opacityOf(f.num(o, "transparency", 0)),
    titleColor: f.color(o, "titleFontColor") ?? f.color(o, "themedTitleFontColor") ?? null,
    fontFamily: f.has(o, "fontFamily") ? f.str(o, "fontFamily", "") || null : null,
    fontSize: f.has(o, "fontSize") ? f.num(o, "fontSize", 12) : null,
    bold: f.bool(o, "bold", false),
    italic: f.bool(o, "italic", false),
    underline: f.bool(o, "underline", false),
  };
}

export function tooltipLook(f: FormatReader): TooltipLook {
  return {
    show: f.bool("visualTooltip", "show", true),
    background: f.color("visualTooltip", "background") ?? f.color("visualTooltip", "themedBackground") ?? null,
    opacity: opacityOf(f.num("visualTooltip", "transparency", 0)),
    titleColor: f.color("visualTooltip", "titleFontColor") ?? f.color("visualTooltip", "themedTitleFontColor") ?? null,
    valueColor: f.color("visualTooltip", "valueFontColor") ?? f.color("visualTooltip", "themedValueFontColor") ?? null,
    valuesBold: f.bool("visualTooltip", "showValuesInBold", true),
    fontFamily: f.has("visualTooltip", "fontFamily") ? f.str("visualTooltip", "fontFamily", "") || null : null,
    fontSize: f.has("visualTooltip", "fontSize") ? f.num("visualTooltip", "fontSize", 12) : null,
    bold: f.bool("visualTooltip", "bold", false),
    italic: f.bool("visualTooltip", "italic", false),
    underline: f.bool("visualTooltip", "underline", false),
    chartSpecific: f.bool("visualTooltip", "showChartSpecificTooltips", true),
    fieldsOnly: f.bool("visualTooltip", "showTooltipFieldsOnly", false),
    sentence: { on: f.bool("visualTooltip", "showSentenceFormat", false), template: f.str("visualTooltip", "sentenceTemplate", "{category}: {value}") },
    actions: { show: f.bool("visualTooltip", "showActionsInTooltips", false), color: f.color("visualTooltip", "actionFontColor") ?? null },
  };
}

export const tooltipContentChanges = (k: TooltipLook): boolean => !k.chartSpecific || k.fieldsOnly || k.sentence.on || k.actions.show;

/**
 * Applies the content settings of the Tooltips card to the HTML a chart made for its tooltip. `first` is the point the tooltip
 * is about (an item or the first of an axis tooltip). The chart marks its extra details with <span data-extra>; the value rows are
 * the lines that hold a <b> value; a sentence template can use {category}, {series} and {value} (the first value as shown).
 */
export function applyTooltipContent(html: string, k: TooltipLook, first: unknown): string {
  let out = html;
  if (!k.chartSpecific) out = out.replace(/<span data-extra>[\s\S]*?<\/span>/g, "");
  else out = out.replace(/<span data-extra>([\s\S]*?)<\/span>/g, "$1");
  if (k.sentence.on) {
    const p = (Array.isArray(first) ? first[0] : first) as { name?: unknown; seriesName?: unknown } | undefined;
    const value = /<b>([\s\S]*?)<\/b>/.exec(out)?.[1] ?? "";
    const text = k.sentence.template.replace(/\{category\}/g, String(p?.name ?? "")).replace(/\{series\}/g, String(p?.seriesName ?? "")).replace(/\{value\}/g, `<b>${value}</b>`);
    out = text;
  } else if (k.fieldsOnly) {
    out = out.split("<br/>").filter((line) => line.includes("<b>")).join("<br/>");
  }
  if (k.actions.show) out += `<br/><span style="font-size:11px;${k.actions.color ? `color:${k.actions.color}` : "opacity:.75"}">Click to filter, Ctrl+click to add to the selection</span>`;
  return out;
}
