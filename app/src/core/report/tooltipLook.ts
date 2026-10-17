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
  };
}
