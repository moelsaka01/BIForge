// Objects that show no data: text box, shape, image, button, page navigator. Reading and writing their PBIR
// settings, and the action a button or navigator runs. Text lives in PBIR paragraphs (objects.general.paragraphs).
import type { J } from "./pbir";
import { getFormat, getRawProp, setFormat, setRawProp, type PageModel, type VisualModel } from "./visualDoc";
import { FormatReader } from "./formatReader";

export interface TextboxStyle {
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
  align: "left" | "center" | "right";
}
export interface TextboxModel extends TextboxStyle {
  text: string;
}

const DEFAULT_TEXT_STYLE: TextboxStyle = { fontSize: 14, bold: false, italic: false, underline: false, align: "left" };

export function readTextbox(json: J): TextboxModel {
  const paragraphs: J[] = getRawProp(json, "general", "paragraphs") as unknown as J[] ?? [];
  const first = paragraphs[0]?.textRuns?.[0]?.textStyle ?? {};
  const size = /^([\d.]+)pt$/.exec(first.fontSize ?? "");
  const align = paragraphs[0]?.horizontalTextAlignment;
  return {
    text: paragraphs.map((p) => (p.textRuns ?? []).map((r: J) => r.value ?? "").join("")).join("\n"),
    fontSize: size ? Number(size[1]) : DEFAULT_TEXT_STYLE.fontSize,
    bold: first.fontWeight === "bold",
    italic: first.fontStyle === "italic",
    underline: first.textDecoration === "underline",
    ...(typeof first.color === "string" ? { color: first.color } : {}),
    align: align === "center" || align === "right" ? align : "left",
  };
}

/** Writes the text and its style (one style for the whole text box) as PBIR paragraphs. */
export function writeTextbox(json: J, patch: Partial<TextboxModel>): void {
  const m = { ...readTextbox(json), ...patch };
  const textStyle: J = {
    fontSize: `${m.fontSize}pt`,
    ...(m.bold ? { fontWeight: "bold" } : {}),
    ...(m.italic ? { fontStyle: "italic" } : {}),
    ...(m.underline ? { textDecoration: "underline" } : {}),
    ...(m.color ? { color: m.color } : {}),
  };
  const paragraphs = m.text.split("\n").map((line) => ({ textRuns: [{ value: line, textStyle }], horizontalTextAlignment: m.align }));
  setRawProp(json, "general", "paragraphs", paragraphs as unknown as J);
}

/** The tile shapes of the report format. */
export type TileShape =
  | "rectangle"
  | "rectangleRounded"
  | "rectangleRoundedByPixel"
  | "oval"
  | "pill"
  | "line"
  | "triangleIsoc"
  | "triangleRight"
  | "pentagon"
  | "hexagon"
  | "octagon"
  | "parallelogram"
  | "trapezoid"
  | "arrow"
  | "arrowChevron"
  | "arrowPentagon"
  | "heart"
  | "tabCutCorner"
  | "tabCutTopCorners"
  | "tabCutTopCornersByPixel"
  | "tabRoundCorner"
  | "tabRoundTopCorners"
  | "speechbubbleRectangle";

export const TILE_SHAPES: { value: TileShape; label: string }[] = [
  { value: "rectangle", label: "Rectangle" },
  { value: "rectangleRounded", label: "Rounded rectangle" },
  { value: "oval", label: "Oval" },
  { value: "pill", label: "Pill" },
  { value: "triangleIsoc", label: "Triangle" },
  { value: "triangleRight", label: "Right triangle" },
  { value: "pentagon", label: "Pentagon" },
  { value: "hexagon", label: "Hexagon" },
  { value: "octagon", label: "Octagon" },
  { value: "parallelogram", label: "Parallelogram" },
  { value: "trapezoid", label: "Trapezoid" },
  { value: "arrow", label: "Arrow" },
  { value: "arrowChevron", label: "Chevron" },
  { value: "arrowPentagon", label: "Pentagon arrow" },
  { value: "heart", label: "Heart" },
  { value: "tabCutCorner", label: "Tab with cut corner" },
  { value: "tabCutTopCorners", label: "Tab with cut corners" },
  { value: "speechbubbleRectangle", label: "Speech bubble" },
  { value: "line", label: "Line" },
];

/** Outlines of the shapes that are polygons, as percentages of the box. */
export const POLYGONS: Partial<Record<string, [number, number][]>> = {
  triangleIsoc: [[50, 0], [100, 100], [0, 100]],
  triangleRight: [[0, 0], [100, 100], [0, 100]],
  pentagon: [[50, 0], [100, 38], [82, 100], [18, 100], [0, 38]],
  hexagon: [[25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]],
  octagon: [[30, 0], [70, 0], [100, 30], [100, 70], [70, 100], [30, 100], [0, 70], [0, 30]],
  parallelogram: [[25, 0], [100, 0], [75, 100], [0, 100]],
  trapezoid: [[20, 0], [80, 0], [100, 100], [0, 100]],
  arrow: [[0, 30], [60, 30], [60, 0], [100, 50], [60, 100], [60, 70], [0, 70]],
  arrowChevron: [[0, 0], [70, 0], [100, 50], [70, 100], [0, 100], [30, 50]],
  arrowPentagon: [[0, 0], [75, 0], [100, 50], [75, 100], [0, 100]],
  tabCutCorner: [[0, 0], [85, 0], [100, 15], [100, 100], [0, 100]],
  tabCutTopCorners: [[15, 0], [85, 0], [100, 15], [100, 100], [0, 100], [0, 15]],
  tabCutTopCornersByPixel: [[15, 0], [85, 0], [100, 15], [100, 100], [0, 100], [0, 15]],
  speechbubbleRectangle: [[0, 0], [100, 0], [100, 75], [40, 75], [20, 100], [20, 75], [0, 75]],
  heart: [[50, 100], [8, 55], [0, 30], [12, 8], [32, 0], [50, 18], [68, 0], [88, 8], [100, 30], [92, 55]],
};

export interface ShapeModel {
  shape: TileShape;
  fill: { show: boolean; color: string; transparency: number };
  outline: { show: boolean; color: string; weight: number; transparency: number };
}

export function readShape(f: FormatReader, defaults: { shape: TileShape; fill: string; outline: string } = { shape: "rectangle", fill: "#c8d6e5", outline: "#555555" }): ShapeModel {
  const shape = f.str("shape", "tileShape", defaults.shape) as TileShape;
  return {
    shape: TILE_SHAPES.some((s) => s.value === shape) || shape === "rectangleRoundedByPixel" || shape === "tabRoundCorner" || shape === "tabRoundTopCorners" ? shape : "rectangle",
    fill: { show: f.bool("fill", "show", true), color: f.color("fill", "fillColor") ?? defaults.fill, transparency: f.num("fill", "transparency", 0) },
    outline: { show: f.bool("outline", "show", true), color: f.color("outline", "lineColor") ?? defaults.outline, weight: f.num("outline", "weight", 1), transparency: f.num("outline", "transparency", 0) },
  };
}

/** SVG for a shape in a w by h box (the outline is drawn inside the box). */
export function shapeSvg(m: ShapeModel, w: number, h: number): { tag: "rect" | "ellipse" | "polygon" | "line"; attrs: Record<string, string | number> } {
  const sw = m.outline.show ? m.outline.weight : 0;
  const half = sw / 2;
  const common = {
    fill: m.shape === "line" || !m.fill.show ? "none" : m.fill.color,
    "fill-opacity": 1 - Math.min(100, Math.max(0, m.fill.transparency)) / 100,
    stroke: sw > 0 ? m.outline.color : "none",
    "stroke-opacity": 1 - Math.min(100, Math.max(0, m.outline.transparency)) / 100,
    "stroke-width": sw,
  };
  switch (m.shape) {
    case "oval":
      return { tag: "ellipse", attrs: { cx: w / 2, cy: h / 2, rx: Math.max(0, w / 2 - half), ry: Math.max(0, h / 2 - half), ...common } };
    case "pill":
      return { tag: "rect", attrs: { x: half, y: half, width: Math.max(0, w - sw), height: Math.max(0, h - sw), rx: Math.min(w, h) / 2, ...common } };
    case "line":
      return { tag: "line", attrs: { x1: 0, y1: h / 2, x2: w, y2: h / 2, ...common, fill: "none", stroke: m.outline.color, "stroke-width": Math.max(1, m.outline.weight) } };
    case "rectangleRounded":
    case "rectangleRoundedByPixel":
      return { tag: "rect", attrs: { x: half, y: half, width: Math.max(0, w - sw), height: Math.max(0, h - sw), rx: Math.min(w, h) / 6, ...common } };
    default: {
      const poly = POLYGONS[m.shape];
      if (poly) return { tag: "polygon", attrs: { points: poly.map(([px, py]) => `${half + (px / 100) * (w - sw)},${half + (py / 100) * (h - sw)}`).join(" "), ...common } };
      return { tag: "rect", attrs: { x: half, y: half, width: Math.max(0, w - sw), height: Math.max(0, h - sw), ...common } };
    }
  }
}

// ---- buttons and the page navigator ------------------------------------------------------

export type ActionType = "None" | "Back" | "Bookmark" | "PageNavigation" | "WebUrl" | "Drillthrough";
export interface ButtonAction {
  type: ActionType;
  page?: string;
  bookmark?: string;
  url?: string;
}

export function readAction(json: J): ButtonAction {
  const type = getFormat(json, "visualLink", "type");
  const show = getFormat(json, "visualLink", "show");
  if (show?.t === "bool" && !show.v) return { type: "None" };
  const t = type?.t === "string" ? (type.v as ActionType) : "None";
  const str = (k: string) => {
    const l = getFormat(json, "visualLink", k);
    return l?.t === "string" && l.v !== "" ? l.v : undefined;
  };
  const type2 = ["Back", "Bookmark", "PageNavigation", "WebUrl", "Drillthrough"].includes(t) ? t : "None";
  return { type: type2, page: type2 === "Drillthrough" ? str("drillthroughSection") : str("navigationSection"), bookmark: str("bookmark"), url: str("webUrl") };
}

/** Why an action cannot run now (an empty target, an unsafe address), or null when it can. */
export function actionProblem(a: ButtonAction, pageNames: string[], bookmarkIds: string[]): string | null {
  switch (a.type) {
    case "PageNavigation":
      return !a.page ? "No page is chosen for this button." : pageNames.includes(a.page) ? null : "The page this button goes to no longer exists.";
    case "Drillthrough":
      return !a.page ? "No drillthrough page is chosen." : pageNames.includes(a.page) ? null : "The drillthrough page no longer exists.";
    case "Bookmark":
      return !a.bookmark ? "No bookmark is chosen for this button." : bookmarkIds.includes(a.bookmark) ? null : "The bookmark this button applies no longer exists.";
    case "WebUrl":
      return a.url && /^https?:\/\/[^\s]+$/i.test(a.url) ? null : "A web link must start with http:// or https://.";
    default:
      return null;
  }
}

/** Pages a navigator lists: visible, normal pages in report order. */
export const navigatorPages = (pages: PageModel[], showHidden = false): PageModel[] => pages.filter((p) => (showHidden || !p.hidden) && !p.type);

export const rotationOf = (v: VisualModel): number => {
  const l = getFormat(v.json, "rotation", "angle");
  return l?.t === "number" ? l.v : 0;
};

export const ALT_TEXT = (v: VisualModel): string => {
  const l = getFormat(v.json, "general", "altText");
  return l?.t === "string" ? l.v : "";
};

export { setFormat };
