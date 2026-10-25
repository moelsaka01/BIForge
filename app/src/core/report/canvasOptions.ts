// View options of the report canvas (View > Page options, and Options > Report settings). They belong to the app, not to
// the report: they are kept in the app settings.
import type { OptionValue } from "../shell/settings";

export interface CanvasOptions {
  /** Edges and centers snap to other visuals and the page while moving and resizing, with guide lines. */
  smartGuides: boolean;
  gridlines: boolean;
  snapToGrid: boolean;
  /** Visuals cannot be moved or resized (selecting and formatting still work). */
  lockObjects: boolean;
  gridSize: number;
  /** Options > Report settings > Show the visual header on hover (a visual's own Visual header setting wins). */
  visualHeader: boolean;
  /** What a selection does to a visual the page has no Edit interactions setting for: highlight where possible, filter, or nothing. */
  crossDefault: "highlight" | "filter" | "none";
  /** Slicers that do not say otherwise show their search box. */
  slicerSearch: boolean;
  /** Viewing mode: filters can be switched between Basic, Advanced, Top N and Relative date. */
  changeFilterTypes: boolean;
  /** The Filters pane has its search box. */
  filterSearch: boolean;
  /** Viewing mode lists hidden pages too. */
  showHiddenPages: boolean;
}

export const CANVAS_OPTION_IDS = ["canvas.smartGuides", "canvas.gridlines", "canvas.snapToGrid", "canvas.lockObjects"] as const;
export type CanvasOptionId = (typeof CANVAS_OPTION_IDS)[number];

export const DEFAULT_CANVAS: CanvasOptions = { smartGuides: true, gridlines: false, snapToGrid: false, lockObjects: false, gridSize: 10, visualHeader: true, crossDefault: "highlight", slicerSearch: false, changeFilterTypes: true, filterSearch: true, showHiddenPages: false };

export function canvasOptionsOf(options: Record<string, OptionValue>): CanvasOptions {
  const bool = (id: string, d: boolean) => (typeof options[id] === "boolean" ? (options[id] as boolean) : d);
  const size = options["canvas.gridSize"];
  return {
    smartGuides: bool("canvas.smartGuides", DEFAULT_CANVAS.smartGuides),
    gridlines: bool("canvas.gridlines", DEFAULT_CANVAS.gridlines),
    snapToGrid: bool("canvas.snapToGrid", DEFAULT_CANVAS.snapToGrid),
    lockObjects: bool("canvas.lockObjects", DEFAULT_CANVAS.lockObjects),
    visualHeader: bool("report.visualHeader", DEFAULT_CANVAS.visualHeader),
    crossDefault: bool("file.qr.disableCross", false) ? "none" : options["report.crossFilter"] === "filter" ? "filter" : "highlight",
    slicerSearch: bool("report.slicerSearch", false) || bool("file.report.slicerSearch", false),
    changeFilterTypes: bool("report.changeFilterTypes", true) && bool("file.report.changeFilterTypes", true),
    filterSearch: bool("report.filterSearch", true),
    showHiddenPages: bool("file.report.hiddenPages", false),
    gridSize: typeof size === "number" && size >= 2 && size <= 200 ? Math.round(size) : DEFAULT_CANVAS.gridSize,
  };
}
