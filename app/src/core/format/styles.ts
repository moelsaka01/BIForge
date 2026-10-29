// Shared readers for the property groups many cards have (a font, a line, a fill), so every renderer reads them the
// same way and the Format pane's controls for them work on every visual.
import type { CSSProperties } from "react";
import type { FormatReader } from "../report/formatReader";

export interface Font {
  family?: string;
  size?: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
}

export interface FontKeys {
  /** Prefix of the property names: "title" gives titleFontSize, titleBold, ...; "sec" gives secFontSize, secBold, ... */
  prefix?: string;
  /** Name of the color property (default: fontColor when the card has one, else labelColor, else color). */
  color?: string;
  /** Name of the size property (default fontSize; some cards use textSize). */
  size?: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Reads font family, size, bold, italic, underline and color of a card; unset values are left out so the caller can use the theme's. */
export function readFont(f: FormatReader, object: string, keys: FontKeys = {}, selector?: string): Font {
  const k = (name: string) => (keys.prefix ? keys.prefix + cap(name) : name);
  const sizeKey = keys.size ?? k("fontSize");
  const colorKey = keys.color ?? (keys.prefix ? (keys.prefix === "title" ? "titleColor" : `${keys.prefix}Color`) : "fontColor");
  const size = f.has(object, sizeKey, selector) ? f.num(object, sizeKey, 0, selector) : undefined;
  const family = f.has(object, k("fontFamily"), selector) ? f.str(object, k("fontFamily"), "", selector) : undefined;
  return {
    ...(family ? { family } : {}),
    ...(size ? { size } : {}),
    bold: f.bool(object, k("bold"), false, selector),
    italic: f.bool(object, k("italic"), false, selector),
    underline: f.bool(object, k("underline"), false, selector),
    color: f.color(object, colorKey, selector),
  };
}

/** Font `over` on top of `base`: what `over` sets wins, what it leaves unset comes from `base`. */
export function mergeFonts(base: Font, over: Font): Font {
  return {
    family: over.family ?? base.family,
    size: over.size ?? base.size,
    color: over.color ?? base.color,
    bold: over.bold || base.bold,
    italic: over.italic || base.italic,
    underline: over.underline || base.underline,
  };
}

/** The same with fallbacks for what is unset. */
export function withDefaults(font: Font, d: { family: string; size: number; color: string }): Required<Pick<Font, "bold" | "italic" | "underline">> & { family: string; size: number; color: string } {
  return { family: font.family ?? d.family, size: font.size ?? d.size, color: font.color ?? d.color, bold: font.bold, italic: font.italic, underline: font.underline };
}

export function cssFont(font: Font, d: { family: string; size: number; color: string }): CSSProperties {
  const x = withDefaults(font, d);
  return {
    fontFamily: x.family,
    fontSize: x.size,
    color: x.color,
    fontWeight: x.bold ? 700 : 400,
    fontStyle: x.italic ? "italic" : "normal",
    textDecoration: x.underline ? "underline" : "none",
  };
}

/** Font-family entry that marks underlined chart text; ChartView styles every SVG text carrying it (ECharts has no text decoration). */
export const UNDERLINE_FAMILY = "BIForgeUnderline";

/** ECharts text style; underlined text gets UNDERLINE_FAMILY after its family so the renderer's stylesheet draws a real underline without touching the text. */
export function echartsText(font: Font, d: { family: string; size: number; color: string }): Record<string, unknown> {
  const x = withDefaults(font, d);
  return { fontFamily: x.underline ? `${x.family}, ${UNDERLINE_FAMILY}` : x.family, fontSize: x.size, color: x.color, fontWeight: x.bold ? "bold" : "normal", fontStyle: x.italic ? "italic" : "normal" };
}

/** 0..1 opacity from a transparency percentage. */
export const opacityOf = (transparencyPercent: number): number => 1 - Math.min(100, Math.max(0, transparencyPercent)) / 100;
