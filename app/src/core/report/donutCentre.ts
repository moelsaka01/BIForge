// The centre of a donut chart: a background disc (centerBackground), a picture (image), a label and the value (the total of the
// slices) in the hole, stacked above each other. Drawn only when Center value > Show is on.
import { echartsText, opacityOf, readFont } from "../format/styles";
import type { FormatReader } from "./formatReader";
import { labelDefaults, valueText } from "./chartFormat";
import type { Theme } from "./theme";

type O = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface DonutCentre {
  graphic: O[];
  /** Series drawn under the slices' hole: the background disc. */
  discs: O[];
  /** The picture: a layer over the chart (an ECharts image element is not drawn by its SVG renderer here), `dy` pixels from the centre. */
  images: CentreImage[];
}

export interface CentreImage {
  src: string;
  size: number;
  dy: number;
  opacity: number;
  alt: string;
}

const srcOf = (f: FormatReader, object: string): string => {
  const type = f.str(object, "imageType", "imageUrl");
  return (type === "imageData" ? f.str(object, "imageData", "") : f.str(object, "imageUrl", "")).trim();
};

export function donutCentre(f: FormatReader, theme: Theme, total: number | null, format: string | null, holePercent: number): DonutCentre | null {
  if (!f.bool("centerValue", "show", false)) return null;
  const d = labelDefaults(theme);
  const graphic: O[] = [];
  const discs: O[] = [];
  const images: CentreImage[] = [];
  if (f.bool("centerBackground", "show", false)) {
    const src = srcOf(f, "centerBackground");
    const alpha = opacityOf(f.num("centerBackground", "transparency", 0));
    const r = Math.max(0, holePercent - f.num("centerBackground", "padding", 0) / 4); // about 4 px to the percent of a usual chart
    discs.push({
      type: "pie",
      silent: true,
      z: 0,
      radius: [0, `${r}%`],
      center: ["50%", "50%"],
      label: { show: false },
      data: [{ value: 1, itemStyle: { color: src ? { image: src, repeat: "no-repeat" } : (f.color("centerBackground", "fillColor") ?? theme.background), opacity: src ? opacityOf(f.num("centerBackground", "imageTransparency", 0)) : alpha } }],
    });
  }
  // the blocks from top to bottom: picture above, label above, value, label below, picture below
  const showImage = f.bool("image", "show", false) && srcOf(f, "image") !== "";
  const showLabel = f.bool("label", "show", true);
  const showValue = f.bool("value", "show", true);
  const imageSize = Math.max(0, f.num("image", "size", 24));
  const imageGap = f.num("image", "gap", 4);
  const labelGap = f.num("label", "gap", 2);
  const labelFont = echartsText(readFont(f, "label"), d);
  const valueFont = echartsText(readFont(f, "value"), { ...d, size: d.size * 1.6 });
  const labelSize = Number(labelFont.fontSize);
  const valueSize = Number(valueFont.fontSize);
  const blocks: { kind: "image" | "label" | "value"; h: number; gapAfter: number }[] = [];
  const imageTop = f.str("image", "position", "Top") === "Top";
  const labelTop = f.str("label", "position", "Top") === "Top";
  if (showImage && imageTop) blocks.push({ kind: "image", h: imageSize, gapAfter: imageGap });
  if (showLabel && labelTop) blocks.push({ kind: "label", h: labelSize, gapAfter: labelGap });
  if (showValue) blocks.push({ kind: "value", h: valueSize, gapAfter: showLabel && !labelTop ? labelGap : imageGap });
  if (showLabel && !labelTop) blocks.push({ kind: "label", h: labelSize, gapAfter: imageGap });
  if (showImage && !imageTop) blocks.push({ kind: "image", h: imageSize, gapAfter: 0 });
  const height = blocks.reduce((a, b, i) => a + b.h + (i < blocks.length - 1 ? b.gapAfter : 0), 0);
  let y = -height / 2;
  const wrap = f.bool("label", "textWrap", false);
  const wrapValue = f.bool("value", "textWrap", false);
  for (const b of blocks) {
    const mid = y + b.h / 2;
    if (b.kind === "image") images.push({ src: srcOf(f, "image"), size: imageSize, dy: mid, opacity: opacityOf(f.num("image", "transparency", 0)), alt: f.str("image", "altText", "") });
    else if (b.kind === "label") graphic.push({ type: "text", x: 0, y: mid, z: 5, silent: true, style: { text: f.str("label", "text", "Total"), fill: labelFont.color, fontFamily: labelFont.fontFamily, fontSize: labelFont.fontSize, fontWeight: labelFont.fontWeight, fontStyle: labelFont.fontStyle, textAlign: "center", textVerticalAlign: "middle", ...(wrap ? { width: 90, overflow: "breakAll" } : {}) } });
    else graphic.push({ type: "text", x: 0, y: mid, z: 5, silent: true, style: { text: valueText(total, format, f, "value"), fill: valueFont.color, fontFamily: valueFont.fontFamily, fontSize: valueFont.fontSize, fontWeight: valueFont.fontWeight, fontStyle: valueFont.fontStyle, textAlign: "center", textVerticalAlign: "middle", ...(wrapValue ? { width: 90, overflow: "breakAll" } : {}) } });
    y += b.h + b.gapAfter;
  }
  // one group, centred as a whole by its bounding box (an element with left/top ignores its own x and y)
  return { graphic: graphic.length ? [{ type: "group", left: "center", top: "middle", children: graphic }] : [], discs, images };
}
