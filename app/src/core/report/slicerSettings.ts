// What a slicer is set to, read from its formatting objects (data, selection, general). Pure.
import { readFont, type Font } from "../format/styles";
import type { FormatReader } from "./formatReader";
import { tileLook, type TileLook } from "./tileLook";

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
  /** Fill, outline, shadow, glow, shape and rotation of the slicer (Slicer (new) and List slicer). */
  tile: TileLook;
  mode: SlicerMode;
  singleSelect: boolean;
  selectAll: boolean;
  search: boolean;
  /** general > Format string: how the numbers in the list are written (empty: as the field formats them). */
  formatString: string;
  /** Header: shown when switched on, its text (empty: the field name) and font. */
  header: { show: boolean; text: string; font: Font; background?: string };
  /** The values: font and the row background. */
  items: { font: Font; background?: string; padding: number };
}

/** The style a slicer type starts with: the new slicer draws buttons, the list slicer a drop-down list, the others a vertical list. */
export function defaultSlicerStyle(visualType: string, isDateOrNumeric: boolean): string {
  if (isDateOrNumeric) return "Between";
  return visualType === "advancedSlicerVisual" ? "HorizontalList" : visualType === "listSlicer" ? "Dropdown" : "Basic";
}

export function readSlicer(f: FormatReader, isDateOrNumeric: boolean, searchDefault = false, visualType = "slicer"): SlicerSettings {
  return {
    tile: tileLook(f, true),
    mode: slicerMode(f.str("data", "mode", defaultSlicerStyle(visualType, isDateOrNumeric)), f.num("general", "orientation", 0) === 1),
    singleSelect: f.bool("selection", "singleSelect", false) || f.str("data", "mode", "") === "Single",
    selectAll: f.bool("selection", "selectAllCheckboxEnabled", false),
    search: f.bool("general", "selfFilterEnabled", searchDefault),
    // the text slicer lists no values
    formatString: visualType === "textSlicer" ? "" : f.str("general", "formatString", ""),
    header: { show: f.has("header", "show") && f.bool("header", "show", false), text: f.str("header", "text", ""), font: readFont(f, "header", { color: "fontColor", size: "textSize" }), background: f.color("header", "background") },
    items: { font: readFont(f, "items", { color: "fontColor", size: "textSize" }), background: f.color("items", "background"), padding: f.num("items", "padding", 0) },
  };
}
