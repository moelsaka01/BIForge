// Page-level formatting: size presets, display option, canvas background (the page) and wallpaper (the area around it).
// Pure functions over page.json; the stored shape follows the report format (objects.background / objects.outspace,
// each a list with one `properties` bag).
import { readLitProp, type J } from "./pbir";
import type { Lit } from "./fields";
import { themeStyleExact, type Theme } from "./theme";

export interface PageSizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const PAGE_SIZES: PageSizePreset[] = [
  { id: "16:9", label: "16:9", width: 1280, height: 720 },
  { id: "4:3", label: "4:3", width: 960, height: 720 },
  { id: "Letter", label: "Letter", width: 816, height: 1056 },
  { id: "Tooltip", label: "Tooltip", width: 320, height: 240 },
];

/** The preset a size matches, else "Custom". */
export function sizePresetOf(width: number, height: number): string {
  return PAGE_SIZES.find((s) => s.width === width && s.height === height)?.id ?? "Custom";
}

export const DISPLAY_OPTIONS = ["FitToPage", "FitToWidth", "ActualSize"] as const;
export type DisplayOption = (typeof DISPLAY_OPTIONS)[number];

export const displayOptionOf = (page: J): DisplayOption => (DISPLAY_OPTIONS as readonly string[]).includes(page.displayOption) ? page.displayOption : "FitToPage";

export interface PageImage {
  url: string;
  name: string;
  fit: "Normal" | "Fit" | "Fill";
}

export interface PageLayer {
  color: string | null;
  /** 0 to 100, percent transparent. */
  transparency: number;
  image: PageImage | null;
}

const props = (page: J, object: string): J => page.objects?.[object]?.[0]?.properties ?? {};

/** A page setting: the page's own, else the theme's default style of pages (visualStyles.page). */
function pick(page: J, theme: Theme | undefined, object: string, prop: string): Lit | null {
  const own = readLitProp(props(page, object)[prop]);
  if (own) return own;
  const v = theme ? themeStyleExact(theme, "page", object, prop) : null;
  return v === null ? null : typeof v === "string" ? { t: "string", v } : typeof v === "number" ? { t: "number", v } : { t: "bool", v };
}

function readLayer(page: J, object: string, theme?: Theme): PageLayer {
  const p = props(page, object);
  const color = pick(page, theme, object, "color");
  const tr = pick(page, theme, object, "transparency");
  const img = p.image?.image;
  const url = readLitProp(img?.url);
  const name = readLitProp(img?.name);
  const scaling = readLitProp(img?.scaling);
  return {
    color: color?.t === "string" ? color.v : null,
    transparency: tr?.t === "number" ? Math.min(100, Math.max(0, tr.v)) : 0,
    image: url?.t === "string" && url.v ? { url: url.v, name: name?.t === "string" ? name.v : "image", fit: scaling?.t === "string" && (scaling.v === "Fit" || scaling.v === "Fill") ? scaling.v : "Normal" } : null,
  };
}

/** The canvas background of the page (Format page > Canvas background). */
export const readCanvasBackground = (page: J, theme?: Theme): PageLayer => readLayer(page, "background", theme);
/** The wallpaper, the area around the page (Format page > Canvas settings / Wallpaper). */
export const readWallpaper = (page: J, theme?: Theme): PageLayer => readLayer(page, "outspace", theme);

function rgba(hex: string, transparency: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || transparency <= 0) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${+(1 - transparency / 100).toFixed(3)})`;
}

/** CSS for a layer: its color with the transparency, then the picture on top (drawn with the same transparency). */
export function layerStyle(layer: PageLayer, fallbackColor: string | null): { background?: string; backgroundColor?: string; backgroundImage?: string; backgroundSize?: string; backgroundRepeat?: string; backgroundPosition?: string } {
  const color = layer.color ?? fallbackColor;
  const out: ReturnType<typeof layerStyle> = {};
  if (color) out.backgroundColor = rgba(color, layer.transparency);
  if (layer.image) {
    out.backgroundImage = `url("${layer.image.url.replace(/"/g, "%22")}")`;
    out.backgroundRepeat = "no-repeat";
    out.backgroundPosition = "center";
    out.backgroundSize = layer.image.fit === "Fit" ? "contain" : layer.image.fit === "Fill" ? "100% 100%" : "auto";
  }
  return out;
}

export type VerticalAlignment = "Top" | "Middle";

/** Where the page sits in the area when it is smaller than the area (Format page > Page alignment). */
export function readVerticalAlignment(page: J, theme?: Theme): VerticalAlignment {
  const l = pick(page, theme, "displayArea", "verticalAlignment");
  return l?.t === "string" && l.v === "Middle" ? "Middle" : "Top";
}

/** Everything the page formatting changes on screen; the Format page measurement (coverage.test.ts) compares these. */
export function pageLook(page: J, theme?: Theme): { background: PageLayer; wallpaper: PageLayer; verticalAlignment: VerticalAlignment } {
  return { background: readCanvasBackground(page, theme), wallpaper: readWallpaper(page, theme), verticalAlignment: readVerticalAlignment(page, theme) };
}
