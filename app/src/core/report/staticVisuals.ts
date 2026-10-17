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

export type TileShape = "rectangle" | "roundedRectangle" | "oval" | "triangle" | "line";
export const TILE_SHAPES: { value: TileShape; label: string }[] = [
  { value: "rectangle", label: "Rectangle" },
  { value: "roundedRectangle", label: "Rounded rectangle" },
  { value: "oval", label: "Oval" },
  { value: "triangle", label: "Triangle" },
  { value: "line", label: "Line" },
];

export interface ShapeModel {
  shape: TileShape;
  fill: { show: boolean; color: string; transparency: number };
  outline: { show: boolean; color: string; weight: number };
}

export function readShape(f: FormatReader, defaults: { shape: TileShape; fill: string; outline: string } = { shape: "rectangle", fill: "#c8d6e5", outline: "#555555" }): ShapeModel {
  const shape = f.str("shape", "tileShape", defaults.shape) as TileShape;
  return {
    shape: TILE_SHAPES.some((s) => s.value === shape) ? shape : "rectangle",
    fill: { show: f.bool("fill", "show", true), color: f.color("fill", "fillColor") ?? defaults.fill, transparency: f.num("fill", "transparency", 0) },
    outline: { show: f.bool("outline", "show", true), color: f.color("outline", "lineColor") ?? defaults.outline, weight: f.num("outline", "weight", 1) },
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
    "stroke-width": sw,
  };
  switch (m.shape) {
    case "oval":
      return { tag: "ellipse", attrs: { cx: w / 2, cy: h / 2, rx: Math.max(0, w / 2 - half), ry: Math.max(0, h / 2 - half), ...common } };
    case "triangle":
      return { tag: "polygon", attrs: { points: `${w / 2},${half} ${w - half},${h - half} ${half},${h - half}`, ...common } };
    case "line":
      return { tag: "line", attrs: { x1: 0, y1: h / 2, x2: w, y2: h / 2, ...common, fill: "none", stroke: m.outline.color, "stroke-width": Math.max(1, m.outline.weight) } };
    case "roundedRectangle":
      return { tag: "rect", attrs: { x: half, y: half, width: Math.max(0, w - sw), height: Math.max(0, h - sw), rx: Math.min(w, h) / 6, ...common } };
    default:
      return { tag: "rect", attrs: { x: half, y: half, width: Math.max(0, w - sw), height: Math.max(0, h - sw), ...common } };
  }
}

// ---- buttons and the page navigator ------------------------------------------------------

export type ActionType = "None" | "Back" | "Bookmark" | "PageNavigation" | "WebUrl";
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
  return { type: ["Back", "Bookmark", "PageNavigation", "WebUrl"].includes(t) ? t : "None", page: str("navigationSection"), bookmark: str("bookmark"), url: str("webUrl") };
}

/** Why an action cannot run now (an empty target, an unsafe address), or null when it can. */
export function actionProblem(a: ButtonAction, pageNames: string[], bookmarkIds: string[]): string | null {
  switch (a.type) {
    case "PageNavigation":
      return !a.page ? "No page is chosen for this button." : pageNames.includes(a.page) ? null : "The page this button goes to no longer exists.";
    case "Bookmark":
      return !a.bookmark ? "No bookmark is chosen for this button." : bookmarkIds.includes(a.bookmark) ? null : "The bookmark this button applies no longer exists.";
    case "WebUrl":
      return a.url && /^https?:\/\/[^\s]+$/i.test(a.url) ? null : "A web link must start with http:// or https://.";
    default:
      return null;
  }
}

/** Pages a navigator lists: visible, normal pages in report order. */
export const navigatorPages = (pages: PageModel[]): PageModel[] => pages.filter((p) => !p.hidden && !p.type);

export const rotationOf = (v: VisualModel): number => {
  const l = getFormat(v.json, "rotation", "angle");
  return l?.t === "number" ? l.v : 0;
};

export const ALT_TEXT = (v: VisualModel): string => {
  const l = getFormat(v.json, "altText", "text");
  return l?.t === "string" ? l.v : "";
};

export { setFormat };
