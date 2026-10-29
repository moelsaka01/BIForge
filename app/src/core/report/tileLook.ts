// The container look shared by the visuals that are tiles of their own (Card (new), Slicer (new), List slicer): the Fill, Outline,
// Shadow, Glow, Rotation, Shape and Overflow cards. One model, so that the three visuals draw them the same way.
import type { CSSProperties } from "react";
import type { FormatReader } from "./formatReader";
import { clipOf, SHADOW_PRESETS, turn } from "./staticModels";
import { opacityOf } from "../format/styles";

export const TILE_VISUALS = new Set(["cardVisual", "advancedSlicerVisual", "listSlicer"]);

export interface TileLook {
  /** Style of the frame around the visual: fill, outline, shadow and glow, corners, turn of the shape. */
  style: CSSProperties;
  /** The picture of the Fill card, as a layer behind the content (with its own effects), or null. */
  image: CSSProperties | null;
  /** The turn of the content alone (text angle against the shape angle). */
  contentTransform: string | undefined;
  /** The Rotation card's angle of the whole visual (the visual frame applies it). */
  frameAngle: number;
  /** Which way the content grows past the frame, and whether it scrolls. */
  overflow: { direction: "horizontal" | "vertical"; scroll: boolean };
}

const mix = (color: string, alpha: number) => `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;

/** One Shadow or Glow card as a CSS box-shadow entry, or null when it is off. */
function glow(f: FormatReader, object: "shadowCustom" | "glowCustom"): string | null {
  if (!f.bool(object, "show", false)) return null;
  const shadow = object === "shadowCustom";
  const presetKey = shadow ? "shadowPositionPreset" : "glowPositionPreset";
  const preset = SHADOW_PRESETS[f.str(object, presetKey, "custom")];
  const angle = ((preset ? preset.angle : f.num(object, "angle", shadow ? 45 : 0)) * Math.PI) / 180;
  const dist = preset ? preset.distance : f.num(object, shadow ? "shadowDistance" : "glowDistance", shadow ? 3 : 0);
  const x = +(Math.cos(angle) * dist).toFixed(1);
  const y = +(-Math.sin(angle) * dist).toFixed(1);
  const color = mix(f.color(object, "color") ?? (shadow ? "#000000" : "#ffd700"), opacityOf(f.num(object, "transparency", shadow ? 70 : 50)));
  const inset = f.str(object, "position", "Outer") === "Inner" ? "inset " : "";
  return `${inset}${x}px ${y}px ${f.num(object, "shadowBlur", shadow ? 4 : 8)}px ${f.num(object, shadow ? "shadowSpread" : "glowSpread", 0)}px ${color}`;
}

/** The corners of the Shape card: rounded (uniform or per corner) or snipped, as a border radius and a clip path. */
function corners(f: FormatReader): { radius: string | undefined; clip: string | undefined } {
  const shape = f.str("shapeCustomRectangle", "tileShape", "rectangle");
  if (shape === "rectangleRounded" || shape === "rectangleRoundedByPixel") {
    const unit = shape === "rectangleRounded" ? "%" : "px";
    const at = (prop: string) => `${Math.max(0, f.num("shapeCustomRectangle", prop, f.num("shapeCustomRectangle", "rectangleRoundedCurve", 25)))}${unit}`;
    return { radius: f.bool("shapeCustomRectangle", "rectangleRoundedCurveCustomStyle", false) ? `${at("rectangleRoundedCurveLeftTop")} ${at("rectangleRoundedCurveRightTop")} ${at("rectangleRoundedCurveRightBottom")} ${at("rectangleRoundedCurveLeftBottom")}` : at("rectangleRoundedCurve"), clip: undefined };
  }
  if (shape === "tabCutCorner" || shape === "tabCutTopCorners" || shape === "tabCutTopCornersByPixel") {
    const custom = f.bool("shapeCustomRectangle", "tabCutCornerSnipSizeCustomStyle", false);
    const size = (prop: string, uniform: string) => Math.max(0, f.num("shapeCustomRectangle", custom ? prop : uniform, 10));
    const tl = size("tabCutCornerSnipSizeLeftTop", "tabCutCornerSnipSizeTop");
    const tr = size("tabCutCornerSnipSizeRightTop", "tabCutCornerSnipSizeTop");
    const br = shape === "tabCutCorner" ? size("tabCutCornerSnipSizeRightBottom", "tabCutCornerSnipSizeBottom") : 0;
    const bl = shape === "tabCutCorner" ? size("tabCutCornerSnipSizeLeftBottom", "tabCutCornerSnipSizeBottom") : 0;
    const u = "px";
    const p = (x: string, y: string) => `${x} ${y}`;
    return { radius: undefined, clip: `polygon(${[p(`${tl}${u}`, "0"), p(`calc(100% - ${tr}${u})`, "0"), p("100%", `${tr}${u}`), p("100%", `calc(100% - ${br}${u})`), p(`calc(100% - ${br}${u})`, "100%"), p(`${bl}${u}`, "100%"), p("0", `calc(100% - ${bl}${u})`), p("0", `${tl}${u}`)].join(", ")})` };
  }
  if (shape === "oval") return { radius: "50%", clip: undefined };
  if (shape === "pill") return { radius: "9999px", clip: undefined };
  return { radius: undefined, clip: clipOf(shape) };
}

export function tileLook(f: FormatReader, slicer = false): TileLook {
  const fillAlpha = opacityOf(f.num("fillCustom", "transparency", 0));
  const fillOn = f.bool("fillCustom", "show", false);
  const shadows = [f.bool("outline", "show", false) ? `inset 0 0 0 ${Math.max(0, f.num("outline", "weight", 1))}px ${mix(f.color("outline", "lineColor") ?? "#808080", opacityOf(f.num("outline", "transparency", 0)))}` : null, glow(f, "shadowCustom"), glow(f, "glowCustom")].filter((x): x is string => x !== null);
  const shape = corners(f);
  const rot = { frame: f.num("rotation", "angle", 0), shape: f.num("rotation", "shapeAngle", 0), text: f.num("rotation", "textAngle", 0) };
  // the Card's Fill card names the picture settings imageUrl, imageFit, ...; the slicers' url, fit, ...
  const both = (a: string, b: string) => (slicer ? b : a);
  const pnum = (a: string, b: string, d: number) => f.num("fillCustom", both(a, b), d);
  let image: CSSProperties | null = null;
  if (fillOn && f.bool("fillCustom", "imageShow", false)) {
    const type = f.str("fillCustom", both("imageType", "sourceType"), "imageUrl");
    const url = type === "imageData" ? f.str("fillCustom", both("imageData", "field"), "") : f.str("fillCustom", both("imageUrl", "url"), "");
    if (url) {
      const fit = f.str("fillCustom", both("imageFit", "fit"), "Fit");
      const effects = f.bool("fillCustom", both("imageEffects", "effects"), false);
      const filter = effects ? [`blur(${pnum("imageBlur", "blur", 0)}px)`, `contrast(${1 + pnum("imageContrast", "contrast", 0) / 100})`, `brightness(${1 + pnum("imageExposure", "exposure", 0) / 100})`, `saturate(${1 + pnum("imageSaturation", "saturation", 0) / 100})`].join(" ") : undefined;
      image = {
        position: "absolute",
        inset: 0,
        height: f.has("fillCustom", both("imageHeight", "height")) ? pnum("imageHeight", "height", 100) : undefined,
        pointerEvents: "none",
        backgroundImage: `url("${url}")`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
        backgroundSize: fit === "Fit" ? "contain" : fit === "Fill" ? "cover" : fit === "Stretch" ? "100% 100%" : "auto",
        opacity: f.bool("fillCustom", "imageSplitTransparency", false) ? opacityOf(f.num("fillCustom", "imageTransparency", 0)) : fillAlpha,
        filter,
      };
    }
  }
  const direction = f.num("overFlow", "overFlowDirection", 1) === 0 ? "horizontal" : "vertical";
  return {
    style: {
      boxSizing: "border-box",
      position: "relative",
      overflow: "hidden",
      background: fillOn ? mix(f.color("fillCustom", "fillColor") ?? "#ffffff", fillAlpha) : undefined,
      borderRadius: shape.radius,
      clipPath: shape.clip,
      boxShadow: shadows.length ? shadows.join(", ") : undefined,
      transform: turn(rot.shape),
      // the accent bar of a slicer is one edge of the frame (a card draws one per tile)
      ...(slicer && f.bool("accentBar", "show", false)
        ? { [`border${f.str("accentBar", "position", "Left")}`]: `${Math.max(0, f.num("accentBar", "width", 4))}px solid ${mix(f.color("accentBar", "color") ?? "#118dff", opacityOf(f.num("accentBar", "transparency", 0)))}` }
        : {}),
    },
    image,
    contentTransform: turn(rot.text - rot.shape),
    frameAngle: rot.frame,
    overflow: { direction, scroll: f.num("overFlow", "overFlowStyle", 1) === 1 },
  };
}
