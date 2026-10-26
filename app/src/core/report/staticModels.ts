// The look of the objects that show no data (image, button, page navigator) from their formatting objects. Pure; the
// views apply the result, and the rendered-coverage test compares models to see which properties change the picture.
import type { CSSProperties } from "react";
import { cssFont, opacityOf, readFont } from "../format/styles";
import type { FormatReader } from "./formatReader";
import { POLYGONS, readShape, type ShapeModel } from "./staticVisuals";
import type { Theme } from "./theme";

// ---- image ----------------------------------------------------------------------------------------------

export interface ImageModel {
  src: string;
  alt: string;
  style: CSSProperties;
}

export function imageModel(f: FormatReader, width: number, height: number): ImageModel {
  const fit = f.str("image", "fit", "Normal");
  const stroke = f.bool("image", "strokeShow", false);
  const bgOn = f.bool("image", "backgroundEnabled", false);
  const corner = f.bool("image", "cornerRadiusAdvanced", false)
    ? `${f.num("image", "cornerRadiusLeftTop", 0)}px ${f.num("image", "cornerRadiusRightTop", 0)}px ${f.num("image", "cornerRadiusRightBottom", 0)}px ${f.num("image", "cornerRadiusLeftBottom", 0)}px`
    : f.num("image", "cornerRadius", 0);
  return {
    src: f.str("image", "sourceUrl", ""),
    alt: f.str("image", "altText", "") || f.str("general", "altText", ""),
    style: {
      width,
      height,
      objectFit: fit === "Stretch" ? "fill" : fit === "Fit" ? "contain" : fit === "Fill" ? "cover" : "none",
      display: "block",
      boxSizing: "border-box",
      borderRadius: corner,
      opacity: opacityOf(f.num("image", "transparency", 0)),
      background: bgOn ? `color-mix(in srgb, ${f.color("image", "backgroundColor") ?? "#ffffff"} ${Math.round(opacityOf(f.num("image", "backgroundTransparency", 0)) * 100)}%, transparent)` : undefined,
      border: stroke ? `${f.num("image", "strokeWidth", 1)}px ${f.str("image", "strokePattern", "solid")} ${f.color("image", "strokeColor") ?? "#888888"}` : undefined,
      filter: f.bool("image", "effects", false) ? `blur(${f.num("image", "blur", 0)}px) contrast(${100 + f.num("image", "contrast", 0)}%) saturate(${100 + f.num("image", "saturation", 0)}%) brightness(${100 + f.num("image", "exposure", 0)}%)` : undefined,
    },
  };
}

// ---- shadow, glow and rotation of the objects that show no data -----------------------------------------------------

/** Where the shadow falls for each preset of the Shadow card: the angle (degrees, counter-clockwise from the right) and the distance. */
const SHADOW_PRESETS: Record<string, { angle: number; distance: number }> = {
  bottomRight: { angle: 315, distance: 3 },
  bottom: { angle: 270, distance: 3 },
  bottomLeft: { angle: 225, distance: 3 },
  centerRight: { angle: 0, distance: 3 },
  center: { angle: 0, distance: 0 },
  centerLeft: { angle: 180, distance: 3 },
  topRight: { angle: 45, distance: 3 },
  top: { angle: 90, distance: 3 },
  topLeft: { angle: 135, distance: 3 },
};

/** The Shadow and Glow cards as a list of CSS shadows: [x, y, blur, color] each. */
function effectList(f: FormatReader): { x: number; y: number; blur: number; color: string }[] {
  const out: { x: number; y: number; blur: number; color: string }[] = [];
  if (f.bool("shadow", "show", false)) {
    const preset = SHADOW_PRESETS[f.str("shadow", "shadowPositionPreset", "")];
    const angle = (((preset ? preset.angle : f.num("shadow", "angle", 45)) * Math.PI) / 180);
    const dist = preset ? preset.distance : f.num("shadow", "shadowDistance", 3);
    out.push({ x: +(Math.cos(angle) * dist).toFixed(1), y: +(-Math.sin(angle) * dist).toFixed(1), blur: f.num("shadow", "shadowBlur", 4), color: `color-mix(in srgb, ${f.color("shadow", "color") ?? "#000000"} ${Math.round(opacityOf(f.num("shadow", "transparency", 60)) * 100)}%, transparent)` });
  }
  if (f.bool("glow", "show", false)) out.push({ x: 0, y: 0, blur: f.num("glow", "shadowBlur", 8), color: `color-mix(in srgb, ${f.color("glow", "color") ?? "#ffff00"} ${Math.round(opacityOf(f.num("glow", "transparency", 50)) * 100)}%, transparent)` });
  return out;
}

/** box-shadow for a box (button, navigator entry). */
export function boxEffects(f: FormatReader): string | undefined {
  const l = effectList(f);
  return l.length ? l.map((e) => `${e.x}px ${e.y}px ${e.blur}px ${e.color}`).join(", ") : undefined;
}

/** filter for an SVG shape: drop-shadow follows the outline of the shape. */
export function shapeEffects(f: FormatReader): string | undefined {
  const l = effectList(f);
  return l.length ? l.map((e) => `drop-shadow(${e.x}px ${e.y}px ${e.blur}px ${e.color})`).join(" ") : undefined;
}

/** The Rotation card: the whole object turns by angle (the visual frame does it), the shape alone by shapeAngle, the text alone by textAngle. */
export function rotationParts(f: FormatReader): { frame: number; shape: number; text: number } {
  return { frame: f.num("rotation", "angle", 0), shape: f.num("rotation", "shapeAngle", 0), text: f.num("rotation", "textAngle", 0) };
}
const turn = (deg: number): string | undefined => (deg ? `rotate(${deg}deg)` : undefined);

// ---- shapes drawn with CSS: buttons and navigator entries ------------------------------------------------

const clipOf = (shape: string): string | undefined => {
  const p = POLYGONS[shape];
  return p ? `polygon(${p.map(([x, y]) => `${x}% ${y}%`).join(", ")})` : undefined;
};

/** Corner radius of a tile shape for a box of the given size. */
function radiusOf(shape: ShapeModel["shape"] | string, w: number, h: number, f: FormatReader): string | number {
  const m = Math.min(w, h);
  switch (shape) {
    case "oval":
      return "50%";
    case "pill":
      return m / 2;
    case "rectangleRounded":
    case "rectangleRoundedByPixel":
      return f.has("shape", "rectangleRoundedCurve") ? (m * f.num("shape", "rectangleRoundedCurve", 25)) / 100 : m / 4;
    case "tabRoundCorner":
    case "tabRoundTopCorners":
      return `${m / 4}px ${m / 4}px 0 0`;
    default:
      return 0;
  }
}

export interface ButtonModel {
  label: string;
  /** The Rotation card: angle of the whole object (turned by the visual frame), and the style of the text span (turned against the shape). */
  frameAngle: number;
  textStyle: CSSProperties;
  style: CSSProperties;
  /** The icon glyph and where it sits relative to the text, or null. */
  icon: { glyph: string; placement: string; size: number; color: string } | null;
  shape: string;
}

const ICONS: Record<string, string> = {
  leftArrow: "←",
  rightArrow: "→",
  back: "⮌",
  reset: "↺",
  help: "?",
  information: "i",
  qna: "?",
  bookmarks: "🔖",
  applyAllSlicers: "✓",
  clearAllSlicers: "✕",
  spinner: "◌",
};

export function buttonModel(f: FormatReader, theme: Theme, width: number, height: number, actionIsBack: boolean, hasAction: boolean): ButtonModel {
  const defaults = { shape: "rectangle", fill: "#e6e6e6", outline: "#8a8a8a" };
  const shape = readShape(f, { shape: "rectangle" as const, fill: defaults.fill, outline: defaults.outline });
  const tile = f.str("shape", "tileShape", "rectangle");
  const font = readFont(f, "text", { color: "fontColor" });
  const text = f.bool("text", "show", true) ? f.str("text", "text", "Button") : "";
  const label = text || (actionIsBack ? "Back" : "Button");
  const v = f.str("text", "verticalAlignment", "middle");
  const iconShape = f.str("icon", "shapeType", "blank");
  const iconOn = f.bool("icon", "show", false) && iconShape !== "blank";
  const outlineAlpha = opacityOf(f.num("outline", "transparency", 0));
  const lbl = theme.textClasses.label;
  const rot = rotationParts(f);
  return {
    label,
    frameAngle: rot.frame,
    textStyle: { display: "inline-block", transform: turn(rot.text - rot.shape) },
    shape: tile,
    icon: iconOn ? { glyph: ICONS[iconShape] ?? "●", placement: f.str("icon", "placement", "left"), size: f.num("icon", "iconSize", 16), color: f.color("icon", "lineColor") ?? theme.foreground } : null,
    style: {
      width,
      height,
      boxSizing: "border-box",
      cursor: hasAction ? "pointer" : "default",
      background: shape.fill.show ? `color-mix(in srgb, ${shape.fill.color} ${100 - shape.fill.transparency}%, transparent)` : "transparent",
      border: shape.outline.show ? `${shape.outline.weight}px solid color-mix(in srgb, ${shape.outline.color} ${Math.round(outlineAlpha * 100)}%, transparent)` : "none",
      borderRadius: radiusOf(tile, width, height, f),
      clipPath: clipOf(tile),
      ...cssFont(font, { family: lbl.fontFace, size: 12, color: theme.foreground }),
      textAlign: f.str("text", "horizontalAlignment", "center") as CSSProperties["textAlign"],
      display: "flex",
      flexDirection: ["above", "below"].includes(f.str("icon", "placement", "left")) ? "column" : "row",
      justifyContent: f.str("text", "horizontalAlignment", "center") === "left" ? "flex-start" : f.str("text", "horizontalAlignment", "center") === "right" ? "flex-end" : "center",
      alignItems: v === "top" ? "flex-start" : v === "bottom" ? "flex-end" : "center",
      padding: `${f.num("text", "topMargin", 0)}px ${f.num("text", "rightMargin", 0)}px ${f.num("text", "bottomMargin", 0)}px ${f.num("text", "leftMargin", 0)}px`,
      boxShadow: boxEffects(f),
      transform: turn(rot.shape),
      overflow: "hidden",
      gap: 4,
    },
  };
}

export interface ShapeLook {
  /** drop-shadow of the Shadow and Glow cards, and the turn of the shape alone. */
  filter: string | undefined;
  shapeTransform: string | undefined;
  /** The turn of the text alone (also when there is no text yet). */
  textTransform: string | undefined;
  frameAngle: number;
  /** The text inside the shape (Text card), or null when it is off or empty. */
  text: { content: string; box: CSSProperties; style: CSSProperties } | null;
}

export function shapeLook(f: FormatReader, theme: Theme): ShapeLook {
  const rot = rotationParts(f);
  const content = f.bool("text", "show", false) ? f.str("text", "text", "") : "";
  const v = f.str("text", "verticalAlignment", "middle");
  const h = f.str("text", "horizontalAlignment", "center");
  const lbl = theme.textClasses.label;
  return {
    filter: shapeEffects(f),
    shapeTransform: turn(rot.shape),
    textTransform: turn(rot.text),
    frameAngle: rot.frame,
    text: content
      ? {
          content,
          box: {
            position: "absolute",
            inset: 0,
            display: "flex",
            justifyContent: h === "left" ? "flex-start" : h === "right" ? "flex-end" : "center",
            alignItems: v === "top" ? "flex-start" : v === "bottom" ? "flex-end" : "center",
            padding: `${f.num("text", "topMargin", 0)}px ${f.num("text", "rightMargin", 0)}px ${f.num("text", "bottomMargin", 0)}px ${f.num("text", "leftMargin", 0)}px`,
            pointerEvents: "none",
            overflow: "hidden",
          },
          style: { ...cssFont(readFont(f, "text", { color: "fontColor" }), { family: lbl.fontFace, size: 12, color: theme.foreground }), transform: turn(rot.text), textAlign: h as CSSProperties["textAlign"] },
        }
      : null,
  };
}

export interface NavigatorModel {
  container: CSSProperties;
  /** The Text card can switch the names off; the Rotation card turns the text of an entry and the whole object. */
  showText: boolean;
  textStyle: CSSProperties;
  frameAngle: number;
  /** Style of one page entry; the current page uses the fill color. */
  entry(current: boolean): CSSProperties;
  showHidden: boolean;
  showTooltipPages: boolean;
}

export function navigatorModel(f: FormatReader, theme: Theme, width: number, height: number): NavigatorModel {
  const font = readFont(f, "text", { color: "fontColor" });
  const lbl = theme.textClasses.label;
  const active = f.color("fill", "fillColor") ?? "#cfe3f8";
  const activeAlpha = opacityOf(f.num("fill", "transparency", 0));
  const rot = rotationParts(f);
  const v = f.str("text", "verticalAlignment", "middle");
  const h = f.str("text", "horizontalAlignment", "center");
  const outlineAlpha = Math.round(opacityOf(f.num("outline", "transparency", 0)) * 100);
  return {
    showText: f.bool("text", "show", true),
    textStyle: { display: "inline-block", transform: turn(rot.text - rot.shape) },
    frameAngle: rot.frame,
    container: { width, height, display: "flex", flexDirection: "row", gap: f.num("layout", "cellPadding", 4), alignItems: "stretch", overflow: "hidden" },
    entry: (current) => ({
      flex: "1 1 0",
      minWidth: 0,
      border: f.bool("outline", "show", true) ? `${f.num("outline", "weight", 1)}px solid color-mix(in srgb, ${f.color("outline", "lineColor") ?? "#8a8a8a"} ${outlineAlpha}%, transparent)` : "none",
      boxShadow: boxEffects(f),
      transform: turn(rot.shape),
      display: "flex",
      justifyContent: h === "left" ? "flex-start" : h === "right" ? "flex-end" : "center",
      alignItems: v === "top" ? "flex-start" : v === "bottom" ? "flex-end" : "center",
      padding: `${f.num("text", "topMargin", 0)}px ${f.num("text", "rightMargin", 0)}px ${f.num("text", "bottomMargin", 0)}px ${f.num("text", "leftMargin", 0)}px`,
      background: current && f.bool("fill", "show", true) ? `color-mix(in srgb, ${active} ${Math.round(activeAlpha * 100)}%, transparent)` : "transparent",
      ...cssFont(font, { family: lbl.fontFace, size: 12, color: theme.foreground }),
      textAlign: f.str("text", "horizontalAlignment", "center") as CSSProperties["textAlign"],
      cursor: "pointer",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    }),
    showHidden: f.bool("pages", "showHiddenPages", false),
    showTooltipPages: f.bool("pages", "showTooltipPages", false),
  };
}
