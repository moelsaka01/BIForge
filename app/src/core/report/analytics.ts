// Analytics pane: reference lines (constant, min, max, average, median, percentile) and the trend line of a
// cartesian chart, and the layout of a ribbon chart. Pure functions; the chart builder draws the result.

export type ReferenceKind = "constant" | "min" | "max" | "average" | "median" | "percentile";

/**
 * The reference lines of the Analytics pane. A constant line is an instance of the value axis's line object
 * (y1AxisReferenceLine); the statistic lines are instances of referenceLine, told apart by their `type` property.
 */
export const REFERENCE_KINDS: { kind: ReferenceKind; label: string; name: string; object: "y1AxisReferenceLine" | "referenceLine" }[] = [
  { kind: "constant", label: "Constant line", name: "Constant", object: "y1AxisReferenceLine" },
  { kind: "min", label: "Min line", name: "Min", object: "referenceLine" },
  { kind: "max", label: "Max line", name: "Max", object: "referenceLine" },
  { kind: "average", label: "Average line", name: "Average", object: "referenceLine" },
  { kind: "median", label: "Median line", name: "Median", object: "referenceLine" },
  { kind: "percentile", label: "Percentile line", name: "Percentile", object: "referenceLine" },
];

/** The value of a reference line over the plotted values; null when there is nothing to compute from. */
export function referenceValue(kind: ReferenceKind, values: (number | null)[], opt: { constant?: number; percentile?: number } = {}): number | null {
  if (kind === "constant") return opt.constant !== undefined && Number.isFinite(opt.constant) ? opt.constant : null;
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  switch (kind) {
    case "min":
      return xs[0];
    case "max":
      return xs[xs.length - 1];
    case "average":
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    case "median":
      return percentile(xs, 50);
    case "percentile":
      return percentile(xs, opt.percentile ?? 50);
    default:
      return null;
  }
}

/** Percentile with linear interpolation between ranks (the inclusive definition, like PERCENTILE.INC). `sorted` ascending. */
export function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 1) return sorted[0];
  const p = Math.min(100, Math.max(0, pct)) / 100;
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Least-squares line through (index, value) of the non-blank points; null with fewer than two points or no slope information. */
export function linearTrend(values: (number | null)[]): { slope: number; intercept: number; at(i: number): number } | null {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null && Number.isFinite(p[1]));
  if (pts.length < 2) return null;
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p[0], 0);
  const sy = pts.reduce((a, p) => a + p[1], 0);
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
  const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  const d = n * sxx - sx * sx;
  if (d === 0) return null;
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept, at: (i) => intercept + slope * i };
}

export interface RibbonSlot {
  /** Index of the series. */
  series: number;
  start: number;
  end: number;
  /** 1 is the highest value of the category. */
  rank: number;
}

/**
 * Ribbon chart layout: in every category the series are stacked by rank (largest at the top), so a series can change
 * its position from one category to the next, and the ribbons between neighbouring columns follow the ranks.
 * `cells[series][category]`; negative and blank values count as 0. Returns `slots[category][series]`.
 */
export function ribbonLayout(cells: (number | null)[][]): RibbonSlot[][] {
  const cats = cells[0]?.length ?? 0;
  const out: RibbonSlot[][] = [];
  for (let c = 0; c < cats; c++) {
    const vals = cells.map((row, s) => ({ s, v: Math.max(0, row[c] ?? 0) }));
    // the largest value on top: it is stacked last, so that it ends highest
    const order = [...vals].sort((a, b) => a.v - b.v || b.s - a.s);
    let acc = 0;
    const slots: RibbonSlot[] = new Array(cells.length);
    for (const o of order) {
      slots[o.s] = { series: o.s, start: acc, end: acc + o.v, rank: 0 };
      acc += o.v;
    }
    [...vals].sort((a, b) => b.v - a.v || a.s - b.s).forEach((o, i) => (slots[o.s].rank = i + 1));
    out.push(slots);
  }
  return out;
}
