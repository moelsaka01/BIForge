// What a slicer is set to, read from its formatting objects (data, selection, general). Pure.
import { readFont, type Font } from "../format/styles";
import type { FormatReader } from "./formatReader";

export type SlicerMode = "Basic" | "Dropdown" | "Tile" | "Between" | "Before" | "After" | "Relative";

/** The slicer styles of the report format mapped to the ones BIForge draws (a horizontal list is a tile slicer). */
export function slicerMode(mode: string, horizontal: boolean): SlicerMode {
  switch (mode) {
    case "VerticalList":
    case "Single":
      return "Basic";
    case "HorizontalList":
      return "Tile";
    case "Basic":
      return horizontal ? "Tile" : "Basic";
    case "RelativeTime":
    case "RelativeDatePicker":
      return "Relative";
    case "Dropdown":
    case "Between":
    case "Before":
    case "After":
    case "Relative":
      return mode;
    default:
      return "Basic";
  }
}

export interface SlicerSettings {
  mode: SlicerMode;
  singleSelect: boolean;
  selectAll: boolean;
  search: boolean;
  /** Header: shown when switched on, its text (empty: the field name) and font. */
  header: { show: boolean; text: string; font: Font; background?: string };
  /** The values: font and the row background. */
  items: { font: Font; background?: string; padding: number };
}

export function readSlicer(f: FormatReader, isDateOrNumeric: boolean, searchDefault = false): SlicerSettings {
  return {
    mode: slicerMode(f.str("data", "mode", isDateOrNumeric ? "Between" : "Basic"), f.num("general", "orientation", 0) === 1),
    singleSelect: f.bool("selection", "singleSelect", false) || f.str("data", "mode", "") === "Single",
    selectAll: f.bool("selection", "selectAllCheckboxEnabled", false),
    search: f.bool("general", "selfFilterEnabled", searchDefault),
    header: { show: f.has("header", "show") && f.bool("header", "show", false), text: f.str("header", "text", ""), font: readFont(f, "header", { color: "fontColor", size: "textSize" }), background: f.color("header", "background") },
    items: { font: readFont(f, "items", { color: "fontColor", size: "textSize" }), background: f.color("items", "background"), padding: f.num("items", "padding", 0) },
  };
}
