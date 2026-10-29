// The bands that join the columns of a ribbon chart or a stacked chart (formatting objects ribbonBands and layout > ribbonGapSize).
import type { FormatReader } from "./formatReader";
import { withOpacity, type O } from "./chartFormat";
import { opacityOf } from "../format/styles";
import type { Theme } from "./theme";

/** The look of a band in the color of its series: fill (matching the series or its own color) and the optional border. */
export function bandStyle(f: FormatReader, theme: Theme, series: string, dimmed: number): O {
  const fill = f.bool("ribbonBands", "fillMatchColor", true) ? series : (f.color("ribbonBands", "fillColor") ?? series);
  const out: O = { fill, opacity: dimmed * opacityOf(f.num("ribbonBands", "fillTransparency", 60)) };
  if (f.bool("ribbonBands", "borderShow", false)) {
    const edge = f.bool("ribbonBands", "borderColorMatchFill", true) ? fill : (f.color("ribbonBands", "borderColor") ?? theme.foreground);
    out.stroke = withOpacity(edge, opacityOf(f.num("ribbonBands", "borderTransparency", 0)));
    out.lineWidth = Math.max(0, f.num("ribbonBands", "borderSize", 1));
  }
  return out;
}

export interface Stacked {
  name: string;
  color: string;
  /** [bottom, top] of the series in each category. */
  spans: [number, number][];
}

/** Custom series that draw a band between the same series in neighbouring columns (or bars) of a stacked chart. */
export function stackBands(f: FormatReader, theme: Theme, stacks: Stacked[], horizontal: boolean, categoryGapPct: number): O[] {
  const gap = Math.max(0, f.num("layout", "ribbonGapSize", 0));
  const look = (color: string) => bandStyle(f, theme, color, 1);
  return stacks.map((s) => ({
    name: s.name,
    type: "custom",
    silent: true,
    z: 1,
    tooltip: { show: false },
    encode: horizontal ? { y: 0, x: [1, 2] } : { x: 0, y: [1, 2] },
    itemStyle: { color: s.color },
    // what the bands look like, kept on the series (the renderer below reads it)
    bandLook: look(s.color),
    bandGap: gap,
    data: s.spans.map(([lo, hi], ci) => [ci, lo, hi, s.spans[ci + 1]?.[0] ?? null, s.spans[ci + 1]?.[1] ?? null]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderItem: (params: O, api: any) => {
      const ci = params.dataIndex as number;
      if (api.value(3) === null || api.value(3) === undefined || Number.isNaN(api.value(3))) return null;
      const at = (c: number, v: number): number[] => (horizontal ? api.coord([v, c]) : api.coord([c, v]));
      const unit: number = horizontal ? api.size([0, 1])[1] : api.size([1, 0])[0];
      const half = unit / (1 + categoryGapPct / 100) / 2 + gap;
      const off = (p: number[], d: number): number[] => (horizontal ? [p[0], p[1] + d] : [p[0] + d, p[1]]);
      const points = [off(at(ci, api.value(1)), half), off(at(ci + 1, api.value(3)), -half), off(at(ci + 1, api.value(4)), -half), off(at(ci, api.value(2)), half)];
      return { type: "polygon", shape: { points }, style: look(s.color) };
    },
  }));
}
