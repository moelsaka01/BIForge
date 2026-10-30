// Builds Apache ECharts options for the chart visuals from query results, format settings and the theme.
// Pure: no DOM, no echarts import. Event handlers map chart events back to data points via `pointAt`.
import { valueKey, type Value } from "./cells";
import { BLANK_LABEL, columnsOf, labelOf, num as valueNum, pivot, pointOfCategory, valueToLit, type Pivot } from "./chartData";
import { condFormatFromPbir, colorFn } from "./condFormat";
import { REFERENCE_KINDS, linearTrend, referenceValue, ribbonLayout } from "./analytics";
import type { FieldRef } from "./fields";
import { FormatReader } from "./formatReader";
import type { Loaded } from "./dataLoader";
import type { SelectedPoint } from "./interactions";
import { formatCompact, formatNumber } from "./numberFormat";
import { donutCentre, type CentreBackground, type CentreImage } from "./donutCentre";
import { attachMarks, axisBlock, plotImage, type PlotImage, CAP, dashOf, gridFor, labelBlock, labelDefaults, legendBlock, lineSeriesStyle, referenceLineMark, referenceLineShade, sliceItemStyle, valueText, zoomBlock, type LineSpec } from "./chartFormat";
import { echartsText, opacityOf, readFont } from "../format/styles";
import { seriesColor, type Theme } from "./theme";
import type { VisualModel } from "./visualDoc";
import { visualType } from "./visualTypes";
import { gazetteer } from "./geo";
import { linkModel } from "./linkModel";
import { applyTooltipContent, tooltipContentChanges, tooltipLook } from "./tooltipLook";
import { bubbleMap, filledMap } from "./mapOptions";
import { bandStyle, stackBands, type Stacked } from "./ribbonBands";

import type { O } from "./chartFormat";
import { withOpacity } from "./chartFormat";

export interface ChartInput {
  visual: VisualModel;
  loaded: Extract<Loaded, { kind: "grouped" }>;
  theme: Theme;
  /** Points selected in this visual (the others are dimmed). */
  selected: SelectedPoint[];
  /** Small multiples: the color index of a series by its label, so that every panel colors a series alike. */
  colorBy?: (seriesLabel: string) => number | undefined;
}

export interface ChartBuild {
  option: O;
  /** Pictures in the hole of a donut chart, drawn over the chart by ChartView. */
  centreImages?: CentreImage[];
  centreBackground?: CentreBackground;
  /** The data point behind a chart element, for selection, drilling and tooltips. */
  pointAt(seriesIndex: number, dataIndex: number): SelectedPoint | null;
  /** Number of data points drawn (0: nothing to show). */
  count: number;
  /** Something the person should know about the drawing, shown under the chart (for example locations a map could not place). */
  notice?: string;
  /** Buttons drawn on a map (zoom, lasso) and where its points are, so that a lasso can pick the points inside a rectangle. */
  /** The picture of the plot area and the margins around the plot area it fills, in pixels. */
  plotImage?: PlotImage & { margins: { left: number; right: number; top: number; bottom: number } };
  mapTools?: { zoom: boolean; lasso: boolean; points: { series: number; index: number; lon: number; lat: number }[] };
}

const DIM = 0.35;
const SYMBOLS: Record<string, string> = { circle: "circle", square: "rect", diamond: "diamond", triangle: "triangle" };

/** Colors of the data points of a series: conditional formatting of the fill, or null for the series color. */
function pointColors(f: FormatReader, p: Pivot, valueCols: { field: FieldRef }[], vi: number, si: number): (string | null)[] | null {
  const raw = f.raw("dataPoint", "fill");
  const spec = raw ? condFormatFromPbir(raw) : null;
  if (!spec) return null;
  const idx = valueCols.findIndex((c) => c.field.kind !== "column" && fieldMatch(c.field, spec.input));
  const src = idx >= 0 ? idx : vi;
  const values = p.cells[src]?.[si] ?? [];
  const fn = colorFn(spec, values);
  return values.map((v) => fn(v));
}
const fieldMatch = (a: FieldRef, b: FieldRef) => a.kind === b.kind && a.table === b.table && a.name === b.name && (a.kind !== "agg" || (b.kind === "agg" && a.fn === b.fn));

function alignHighlight(base: Pivot, hl: Pivot): (number | null)[][][] {
  const ci = new Map(hl.categories.map((c, i) => [c.key, i]));
  const si = new Map(hl.series.map((s, i) => [s.key, i]));
  return base.cells.map((_, vi) =>
    base.series.map((s, a) => {
      const hs = si.get(s.key);
      return base.categories.map((c) => {
        const hc = ci.get(c.key);
        return hs === undefined || hc === undefined ? null : (hl.cells[vi]?.[hs]?.[hc] ?? null);
      });
    }),
  );
}

// ---- cartesian ----------------------------------------------------------------------------------------

function cartesianPanel(inp: ChartInput): ChartBuild {
  const { visual, loaded, theme } = inp;
  const q = loaded.query;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const t = visual.visualType;
  const horizontal = t === "barChart" || /BarChart$/.test(t);
  const hundred = t.startsWith("hundredPercent");
  const stacked = hundred || t === "barChart" || t === "columnChart" || t === "stackedAreaChart" || t === "lineStackedColumnComboChart";
  const lineOnly = t === "lineChart";
  const areaOnly = t === "areaChart" || t === "stackedAreaChart" || t === "hundredPercentStackedAreaChart";
  const ribbon = t === "ribbonChart";
  const combo = t === "lineClusteredColumnComboChart" || t === "lineStackedColumnComboChart";

  const valueCols = ["Y", "Y2"].flatMap((r) => columnsOf(q, r, "value"));
  const p = pivot(loaded.rows, q, "Category", "Series", ["Y", "Y2"]);
  const hl = loaded.highlightRows ? alignHighlight(p, pivot(loaded.highlightRows, q, "Category", "Series", ["Y", "Y2"])) : null;
  const multiMeasure = valueCols.length > 1;
  const hasSeries = p.series.length > 1 || (p.series.length === 1 && p.series[0].label !== "");
  const legendShown = hasSeries || multiMeasure;

  // percentages for 100% charts
  const totals = valueCols.map((_, vi) => p.categories.map((_c, ci) => p.series.reduce((a, _s, si) => a + Math.abs(p.cells[vi][si][ci] ?? 0), 0)));
  const shown = (vi: number, si: number, ci: number, cells = p.cells): number | null => {
    const v = cells[vi][si][ci];
    if (v === null || !hundred) return v;
    return totals[vi][ci] === 0 ? 0 : (v / totals[vi][ci]) * 100;
  };

  const selKeys = new Set(inp.selected.map((s) => JSON.stringify(s.values)));
  const selecting = selKeys.size > 0;
  const isSelected = (ci: number, si: number) => {
    const pt = pointOfCategory(p, ci, hasSeries ? si : null);
    return selKeys.has(JSON.stringify(pt.values)) || [...selKeys].some((k) => k === JSON.stringify(pt.values.slice(0, p.catFields.length)));
  };

  const seriesOut: O[] = [];
  const meta: { vi: number; si: number }[] = [];
  const labelOn = f.bool("labels", "show", false);
  const showSeriesName = f.bool("labels", "showSeries", false);
  const fillAlpha = opacityOf(f.num("dataPoint", "fillTransparency", 0));
  const borderOn = f.bool("dataPoint", "borderShow", false);
  // layout > gap between the segments of a stack: a border in the color of the background
  const stackGap = stacked ? Math.max(0, f.num("layout", "stackedGapSize", 0)) : 0;
  const gapEdge: O = stackGap > 0 ? { borderColor: theme.background, borderWidth: stackGap } : {};
  const addSeries = (vi: number, si: number, isHighlight: boolean) => {
    const role = valueCols[vi].role;
    const asLine = lineOnly || areaOnly || (combo && role === "Y2");
    const name = hasSeries ? (multiMeasure ? `${p.series[si].label || BLANK_LABEL} · ${valueCols[vi].label}` : p.series[si].label || BLANK_LABEL) : valueCols[vi].label;
    const colorIndex = hasSeries && !multiMeasure ? si : multiMeasure && !hasSeries ? vi : si * valueCols.length + vi;
    const color = f.color("dataPoint", "fill", name) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, (hasSeries && !multiMeasure ? inp.colorBy?.(p.series[si].label || BLANK_LABEL) : undefined) ?? colorIndex);
    const cond = !hasSeries || p.series.length === 1 ? pointColors(f, p, valueCols, vi, si) : null;
    const cells = isHighlight ? hl! : p.cells;
    const data = p.categories.map((_, ci) => {
      const v = shown(vi, si, ci, cells);
      const dimmed = (selecting && !isSelected(ci, si)) || (hl !== null && !isHighlight);
      const c = cond?.[ci] ?? color;
      const item: O = { value: v, raw: cells[vi][si][ci] };
      // Show blank as: a bar without a value is a bar of no extent that carries the text of the label
      if (v === null && !asLine && !isHighlight && labelOn && f.has("labels", "showBlankAs")) {
        item.value = 0;
        item.blank = true;
        item.label = { show: true };
      }
      // a border with transparency, or "outline only" (empty bar, border in the bar's color), is decided per bar
      const edge = asLine ? {} : borderOn ? sliceItemStyle(f, theme, c) : gapEdge;
      if (!asLine || cond) item.itemStyle = { color: c, opacity: (dimmed ? DIM : 1) * (asLine ? 1 : fillAlpha), ...edge };
      if (asLine && dimmed) item.itemStyle = { ...(item.itemStyle ?? {}), opacity: DIM };
      return item;
    });
    const barBorder = borderOn ? sliceItemStyle(f, theme, color) : gapEdge;
    const s: O = {
      name: isHighlight ? `${name} (highlighted)` : name,
      type: asLine ? "line" : "bar",
      data,
      itemStyle: { color, ...(asLine ? (f.has("dataPoint", "transparency") ? { opacity: opacityOf(f.num("dataPoint", "transparency", 0)) } : {}) : { opacity: fillAlpha, ...barBorder }) },
      // the gap widens when the pointer is on a segment ("explodes")
      emphasis: { focus: "none", ...(stackGap > 0 && !asLine && f.bool("layout", "stackedGapExplodes", false) ? { itemStyle: { borderWidth: stackGap * 2 + 2, borderColor: theme.background } } : {}) },
      label: labelBlock({
        f,
        theme,
        show: labelOn && !isHighlight,
        horizontal,
        stacked,
        asLine,
        text: (pa: O) => {
          const text = hundred ? `${Math.round(pa.value ?? 0)}%` : valueText(pa.data?.raw ?? null, valueCols[vi].format, f);
          return showSeriesName ? `${name}: ${text}` : text;
        },
      }),
    };
    // Desktop tries the label positions that are allowed and draws none when the label does not fit in the bar (Overflow text keeps it).
    // ECharts cannot hide a label by its size, so the series is marked and ChartView hides the labels that are wider than their bar.
    const insideLabel = !asLine && String(s.label.position).startsWith("inside") && !f.bool("labels", "labelOverflow", false);
    if (insideLabel) s.fitLabel = horizontal ? "x" : "y";
    if (f.bool("labels", "optimizeLabelDisplay", false)) s.labelLayout = { hideOverlap: true };
    // in the stacked combo only the columns stack; its lines are separate
    if (stacked && (!asLine || areaOnly)) s.stack = isHighlight ? "highlight" : "total";
    if (asLine) {
      Object.assign(s, lineSeriesStyle(f, color, hl !== null && !isHighlight));
      if (areaOnly || f.bool("lineStyles", "areaShow", false)) s.areaStyle = { opacity: isHighlight ? 0.85 : hl ? 0.2 : 0.4, color: f.bool("lineStyles", "areaMatchStrokeColor", true) ? undefined : f.color("lineStyles", "areaColor") };
      if (combo && role === "Y2") s.yAxisIndex = 1;
    } else {
      if (hl) s.barGap = "-100%";
      else if (f.has("categoryAxis", "innerPadding")) {
        s.barGap = `${f.num("categoryAxis", "innerPadding", 0)}%`;
        // a bar that has no neighbour in its category (stacked, or the only column): the padding between the bands is the gap between categories
        if (stacked || (!hasSeries && valueCols.filter((c) => c.role === "Y").length <= 1)) s.barCategoryGap = s.barGap;
      }
      if (f.has("categoryAxis", "outerPadding")) s.barCategoryGap = `${f.num("categoryAxis", "outerPadding", 20)}%`;
      // the layout card's gap between the groups of bars, as a percentage of a bar
      if (f.has("layout", "clusteredGapSize")) s.barCategoryGap = `${Math.min(500, Math.max(0, f.num("layout", "clusteredGapSize", 20)))}%`;
      // the bars of a cluster overlap; reversed, the first series is drawn on top
      if (!stacked && f.bool("layout", "clusteredGapOverlaps", false)) {
        s.barGap = "-40%";
        s.z = 2 + (f.bool("layout", "clusteredGapOverlapReverse", false) ? p.series.length - si : si);
      }
    }
    if (isHighlight) {
      s.z = 5;
      s.silent = true;
      s.label = { show: false };
    }
    seriesOut.push(s);
    meta.push({ vi, si });
  };
  // layout > sort series: the series with the largest total comes first
  const order = p.series.map((_s, si) => si);
  if (f.bool("layout", "seriesOrderSorted", false)) {
    const total = (si: number) => p.categories.reduce((a, _c, ci) => a + Math.abs(p.cells[0][si][ci] ?? 0), 0);
    order.sort((a, b) => total(b) - total(a));
  }
  valueCols.forEach((_, vi) => order.forEach((si) => addSeries(vi, si, false)));
  if (hl) valueCols.forEach((_, vi) => order.forEach((si) => addSeries(vi, si, true)));
  // layout > series order reversed: the stack (and the legend) lists the series from the last to the first
  const reverseOrder = () => {
    seriesOut.reverse();
    meta.reverse();
  };
  if (f.bool("layout", "seriesOrderReversed", false) && !ribbon && (stacked || !(lineOnly || areaOnly))) reverseOrder();

  if (ribbon) {
    // one custom series per legend entry: a column slot per category and a ribbon to the next category
    seriesOut.length = 0;
    meta.length = 0;
    const layout = ribbonLayout(p.series.map((_s, si) => p.cells[0][si]));
    const gap = Math.max(0, f.num("layout", "ribbonGapSize", 0));
    const bands = f.bool("ribbonBands", "show", true);
    const colGap = Math.max(0, f.num("layout", "stackedGapSize", 0));
    const explodes = colGap > 0 && f.bool("layout", "stackedGapExplodes", false);
    order.forEach((si) => {
      const s = p.series[si];
      const name = hasSeries ? s.label || BLANK_LABEL : valueCols[0].label;
      const color = f.color("dataPoint", "fill", name) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, si);
      const dimmed = p.categories.map((_c, ci) => selecting && !isSelected(ci, si));
      seriesOut.push({
        name,
        type: "custom",
        encode: { x: 0, y: [1, 2] },
        itemStyle: { color },
        // what the bands to the next column look like, kept on the series (the renderer below reads it)
        bandLook: bandStyle(f, theme, color, 1),
        bandGap: gap,
        bandsShown: bands,
        // fill transparency and border of the columns (dataPoint card)
        columnLook: { fillAlpha, ...(borderOn ? sliceItemStyle(f, theme, color) : {}) },
        columnGap: colGap,
        columnGapExplodes: explodes,
        data: p.categories.map((_c, ci) => {
          const slot = layout[ci][si];
          const next = layout[ci + 1]?.[si];
          return { value: [ci, slot.start, slot.end, next ? next.start : null, next ? next.end : null], raw: p.cells[0][si][ci], rank: slot.rank };
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderItem: (params: O, api: any) => {
          const ci = params.dataIndex as number;
          const lo = api.coord([ci, api.value(1)]);
          const hi = api.coord([ci, api.value(2)]);
          const half = api.size([1, 0])[0] * 0.28;
          const op = dimmed[ci] ? DIM : 1;
          const children: O[] = [{ type: "rect", shape: { x: lo[0] - half, y: Math.min(lo[1], hi[1]), width: half * 2, height: Math.abs(lo[1] - hi[1]) }, style: { fill: (borderOn ? sliceItemStyle(f, theme, color).color : undefined) ?? color, opacity: op * fillAlpha, ...(borderOn ? { stroke: sliceItemStyle(f, theme, color).borderColor, lineWidth: sliceItemStyle(f, theme, color).borderWidth } : colGap > 0 ? { stroke: theme.background, lineWidth: colGap } : {}) }, ...(explodes ? { emphasis: { style: { stroke: theme.background, lineWidth: colGap * 2 + 2 } } } : {}) }];
          if (bands && api.value(3) !== null && api.value(3) !== undefined && !Number.isNaN(api.value(3))) {
            const nlo = api.coord([ci + 1, api.value(3)]);
            const nhi = api.coord([ci + 1, api.value(4)]);
            children.push({ type: "polygon", shape: { points: [[lo[0] + half + gap, lo[1]], [nlo[0] - half - gap, nlo[1]], [nhi[0] - half - gap, nhi[1]], [hi[0] + half + gap, hi[1]]] }, style: { ...bandStyle(f, theme, color, 1), opacity: (bandStyle(f, theme, color, 1).opacity as number) * op } });
          }
          return { type: "group", children };
        },
      });
      meta.push({ vi: 0, si });
    });
    if (f.bool("layout", "seriesOrderReversed", false)) reverseOrder();
  }

  // bands that join the segments of a stacked chart (off unless the ribbon bands card turns them on)
  if (stacked && !lineOnly && !areaOnly && f.bool("ribbonBands", "show", false)) {
    const top = p.categories.map(() => 0);
    const stacks: Stacked[] = [];
    for (const s of seriesOut) {
      if (s.type !== "bar" || s.stack !== "total") continue;
      const spans = (s.data as O[]).map((d, ci): [number, number] => {
        const lo = top[ci];
        top[ci] += Math.max(0, Number(d.value ?? 0));
        return [lo, top[ci]];
      });
      stacks.push({ name: s.name, color: s.itemStyle.color, spans });
    }
    seriesOut.push(...stackBands(f, theme, stacks, horizontal, f.has("categoryAxis", "outerPadding") ? f.num("categoryAxis", "outerPadding", 20) : 20));
  }

  // Total labels of a stacked chart: an invisible line through the top of each stack carries the sum (and, when asked, the negative sum)
  if ((stacked || ribbon) && f.bool("totals", "show", false)) {
    const font = readFont(f, "totals", { color: "color" });
    const ys = valueCols.map((c, vi) => ({ c, vi })).filter((x) => x.c.role === "Y");
    const sums = p.categories.map((_c, ci) => {
      let pos = 0;
      let neg = 0;
      for (const { vi } of ys) for (let si = 0; si < p.series.length; si++) {
        const v = p.cells[vi][si][ci] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      return { pos, neg };
    });
    const label = (value: (s: { pos: number; neg: number }) => number, side: string): O => ({
      show: true,
      position: side,
      ...echartsText(font, labelDefaults(theme)),
      formatter: (pa: O) => {
        return valueText(Number(pa.data?.raw ?? 0), valueCols[0]?.format ?? null, f, "totals");
      },
      ...(f.bool("totals", "enableBackground", false) ? { backgroundColor: withOpacity(f.color("totals", "backgroundColor") ?? theme.background, opacityOf(f.num("totals", "backgroundTransparency", 0))), padding: [2, 4], borderRadius: 2 } : {}),
    });
    const carrier = (value: (s: { pos: number; neg: number }) => number, side: string): O => ({
      name: "",
      type: "line",
      silent: true,
      // a label hangs on a symbol: with symbol "none" ECharts draws no label, so the symbol is there at size 0
      symbol: "circle",
      symbolSize: 0,
      lineStyle: { opacity: 0 },
      tooltip: { show: false },
      z: 7,
      data: sums.map((s) => ({ value: hundred ? (value(s) === 0 ? null : value(s) > 0 ? 100 : -100) : value(s), raw: value(s) })),
      label: label(value, side),
    });
    seriesOut.push(carrier((s) => s.pos, horizontal ? "right" : "top"));
    if (f.bool("totals", "showPositiveAndNegative", false) && sums.some((s) => s.neg < 0)) seriesOut.push(carrier((s) => s.neg, horizontal ? "left" : "bottom"));
  }

  const autoPoints: number[] = [];
  // Analytics: reference lines over the plotted values, and a trend line
  if (seriesOut.length > 0) {
    const pooled: (number | null)[] = [];
    valueCols.forEach((c, vi) => c.role === "Y" && p.series.forEach((_s, si) => p.categories.forEach((_c, ci) => pooled.push(shown(vi, si, ci)))));
    const fmtRef = valueCols[0]?.format ?? null;
    const marks: O[] = [];
    const shades: O[][] = [];
    for (const k of REFERENCE_KINDS) {
      const sel = `id:${k.kind}`;
      const spec: LineSpec = { object: k.object, id: k.kind };
      // a statistic line is told apart by its type; a stored line of another type is not this one
      if (k.object === "referenceLine" && f.str("referenceLine", "type", "", sel) !== k.name) continue;
      // on a 100% chart only the constant line makes sense (the statistics of percentages say nothing)
      if (hundred && k.kind !== "constant") continue;
      const v = referenceValue(k.kind, pooled, { constant: f.has(k.object, "value", sel) ? f.num(k.object, "value", 0, sel) : undefined, percentile: f.num(k.object, "percentile", 50, sel) });
      const name = k.kind === "percentile" ? `${f.num(k.object, "percentile", 50, sel)}th percentile` : k.name;
      const mark = referenceLineMark(f, theme, spec, v, name, horizontal ? "xAxis" : "yAxis", fmtRef);
      if (mark) marks.push(mark);
      // "Include in auto scale": the value axis grows to show the line
      if (mark && v !== null && f.bool(k.object, "autoScale", false, sel)) autoPoints.push(v);
      const shade = referenceLineShade(f, theme, spec, v, horizontal ? "xAxis" : "yAxis");
      if (shade) shades.push(shade);
    }
    // the X-axis constant line stands on the category axis: the value is the name of a category, or its position (1 is the first)
    const xSel = "id:constant";
    if (p.categories.length > 0 && f.has("xAxisReferenceLine", "value", xSel)) {
      const raw = f.num("xAxisReferenceLine", "value", 0, xSel);
      const byName = p.categories.find((c) => c.label === String(raw));
      const at = byName ?? p.categories[Math.min(p.categories.length, Math.max(1, Math.round(raw))) - 1];
      const catAxis = horizontal ? "yAxis" : "xAxis";
      const xSpec: LineSpec = { object: "xAxisReferenceLine", id: "constant" };
      const xm = referenceLineMark(f, theme, xSpec, at.label, "X constant", catAxis, null);
      if (xm) marks.push(xm);
      const xs = referenceLineShade(f, theme, xSpec, at.label, catAxis, p.categories.map((c) => c.label));
      if (xs) shades.push(xs);
    }
    // a ribbon chart is drawn by a custom series, which cannot carry marks: an invisible line series on the same axes does
    let host = seriesOut[0];
    if (ribbon && (marks.length || shades.length)) {
      host = { name: "", type: "line", data: p.categories.map(() => null), silent: true, symbol: "none", tooltip: { show: false } };
      seriesOut.push(host);
    }
    attachMarks(seriesOut, host, marks, shades);
    if (f.bool("trend", "show", false) && valueCols.length > 0 && p.series.length > 0) {
      const style = f.str("trend", "style", "dashed");
      const trendDash = dashOf(f.str("trend", "dashArray", ""));
      // "Use highlight values" fits the highlighted part of a cross-highlighted chart
      const trendCells = f.bool("trend", "useHighlightValues", false) && hl ? hl : p.cells;
      // one line through the sum of the series ("Combine series"), or one line for each series
      const sources: { label: string; values: (number | null)[] }[] = f.bool("trend", "combineSeries", false)
        ? [{ label: "", values: p.categories.map((_c, ci) => { const xs = p.series.map((_s, si) => shown(0, si, ci, trendCells)).filter((x): x is number => x !== null); return xs.length ? xs.reduce((u, w) => u + w, 0) : null; }) }]
        : p.series.map((s, si) => ({ label: s.label || BLANK_LABEL, values: p.categories.map((_c, ci) => shown(0, si, ci, trendCells)) }));
      const several = sources.length > 1;
      for (const src of sources) {
        const tr = linearTrend(src.values);
        if (!tr) continue;
        const base = f.str("trend", "displayName", "") || "Trend line";
        const pts = p.categories.map((_c, ci) => tr.at(ci));
        // "Include in auto scale": the value axis grows to show the trend
        if (f.bool("trend", "autoScale", false)) autoPoints.push(...pts);
        seriesOut.push({
          name: several && src.label ? `${base} · ${src.label}` : base,
          type: "line",
          data: pts.map((v) => ({ value: v, raw: v })),
          symbol: "none",
          silent: true,
          z: 6,
          lineStyle: {
            color: f.color("trend", "lineColor") ?? theme.muted,
            width: f.num("trend", "width", 2),
            type: trendDash && (style === "custom" || !f.has("trend", "style")) ? trendDash : style === "custom" ? "dashed" : style,
            opacity: opacityOf(f.num("trend", "transparency", 0)),
            ...(f.has("trend", "dashCap") ? { cap: CAP[f.str("trend", "dashCap", "none")] ?? "butt" } : {}),
          },
          tooltip: { show: false },
        });
      }
    }
  }

  const catLabels = p.categories.map((c) => c.label);
  const catAxis: O = {
    ...axisBlock({ f, theme, object: "categoryAxis", kind: "category", titleDefault: columnsOf(q, "Category", "group").map((c) => c.label).join(", "), inverseDefault: horizontal, horizontal }),
    data: catLabels,
    boundaryGap: !(lineOnly || areaOnly),
  };
  const fmt0 = valueCols[0]?.format ?? null;
  const valAxis = axisBlock({ f, theme, object: "valueAxis", kind: "value", fmt: fmt0, titleDefault: valueCols.map((c) => c.label).join(", "), hundred, horizontal });
  if (autoPoints.length) {
    const lo = Math.min(...autoPoints);
    const hi = Math.max(...autoPoints);
    // the fixed 0 to 100 range of a 100% chart grows to show a line outside it
    if (hundred) {
      valAxis.min = Math.min(valAxis.min ?? 0, lo);
      valAxis.max = Math.max(valAxis.max ?? 100, hi);
    } else {
      if (valAxis.min === undefined) valAxis.min = (e: { min: number }) => Math.min(e.min, lo);
      if (valAxis.max === undefined) valAxis.max = (e: { max: number }) => Math.max(e.max, hi);
    }
  }
  const y2Cols = columnsOf(q, "Y2", "value");
  const valAxes = combo && y2Cols.length ? [valAxis, { ...axisBlock({ f, theme, object: "valueAxis", prefix: "sec", kind: "value", fmt: y2Cols[0].format, titleDefault: y2Cols.map((c) => c.label).join(", "), horizontal }), splitLine: { show: false } }] : [valAxis];

  const option: O = {
    animation: false,
    textStyle: { fontFamily: theme.textClasses.label.fontFace },
    grid: roomForTitles(gridFor(f, f.bool("legend", "show", legendShown)), horizontal ? valAxes[0] : catAxis, horizontal ? catAxis : valAxes[0], horizontal ? undefined : valAxes[1]),
    legend: legendBlock(f, theme, legendShown),
    tooltip: {
      trigger: "axis",
      axisPointer: { type: horizontal ? "shadow" : "line" },
      confine: true,
      formatter: (params: O[]) => {
        const rows = (Array.isArray(params) ? params : [params]).filter((x) => !String(x.seriesName).endsWith("(highlighted)") && meta[x.seriesIndex]);
        const head = rows[0]?.name ?? "";
        const lines = rows.map((x) => {
          const m = meta[x.seriesIndex];
          const raw: number | null = x.data?.raw ?? null;
          const txt = formatNumber(raw ?? NaN, valueCols[m.vi].format);
          return `${x.marker}${x.seriesName}: <b>${raw === null ? "" : hundred ? `${Math.round(x.value)}% (${txt})` : txt}</b>`;
        });
        return `${head}<br/>${lines.join("<br/>")}`;
      },
    },
    xAxis: horizontal ? valAxes[0] : catAxis,
    yAxis: horizontal ? catAxis : valAxes,
    series: seriesOut,
  };
  // Legend > match line color: a line's legend marker takes the color of the line instead of the series color
  if (f.bool("legend", "matchLineColor", false)) {
    const entries = seriesOut.filter((s) => s.name && s.type === "line" && !String(s.name).endsWith("(highlighted)"));
    option.legend = { ...option.legend, data: entries.map((s) => ({ name: s.name, itemStyle: { color: s.lineStyle?.color ?? s.itemStyle?.color } })) };
  }
  const zoom = zoomBlock(f, horizontal, combo && y2Cols.length > 0);
  if (zoom) {
    option.dataZoom = zoom.dataZoom;
    // the sliders sit below columns (or beside bars): the plot area leaves room for them
    if (horizontal) option.grid = { ...option.grid, right: (option.grid.right ?? 12) + zoom.room };
    else option.grid = { ...option.grid, bottom: (option.grid.bottom ?? 8) + zoom.room };
  }
  if (horizontal) option.yAxis = catAxis;

  return {
    option,
    count: p.categories.length,
    pointAt: (si, di) => {
      const m = meta[si];
      if (!m || !p.categories[di]) return null;
      return pointOfCategory(p, di, hasSeries ? m.si : null);
    },
  };
}

// ---- small multiples ---------------------------------------------------------------------------------------

const FIXED_LAYOUT_LIMIT = 36;

/** #rrggbb with an opacity as an rgba() color (ECharts backgrounds take no separate opacity). */
function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Columns and rows of a grid of n panels: the chosen counts, else the grid closest to the shape of the visual. */
export function panelGrid(n: number, layout: { type: string; columns: number | null; rows: number | null }, aspect: number): { columns: number; rows: number } {
  const count = Math.min(n, FIXED_LAYOUT_LIMIT);
  if (layout.type === "custom") {
    // without a count the custom layout starts with three columns
    const columns = layout.columns ? Math.max(1, Math.min(count, Math.round(layout.columns))) : layout.rows ? Math.max(1, Math.ceil(count / Math.max(1, Math.round(layout.rows)))) : Math.max(1, Math.min(count, 3));
    return { columns, rows: Math.ceil(count / columns) };
  }
  const columns = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * aspect))));
  return { columns, rows: Math.ceil(count / columns) };
}

/** The values of the small multiples field in a stable order: numbers by value, text alphabetically, blank last. */
function panelValues(rows: Value[][], col: { index: number }): Value[] {
  const seen = new Map<string, Value>();
  for (const r of rows) if (!seen.has(valueKey(r[col.index]))) seen.set(valueKey(r[col.index]), r[col.index]);
  return [...seen.values()].sort((a, b) => {
    if (a.kind === "blank" || b.kind === "blank") return a.kind === "blank" ? (b.kind === "blank" ? 0 : 1) : -1;
    const x = valueNum(a);
    const y = valueNum(b);
    if (x !== null && y !== null) return x - y;
    return a.text.localeCompare(b.text);
  });
}

function smallMultiples(inp: ChartInput, sm: { index: number; format: string | null; field: FieldRef }): ChartBuild {
  const { visual, loaded, theme } = inp;
  const q = loaded.query;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const horizontal = visual.visualType === "barChart" || /BarChart$/.test(visual.visualType);
  const values = panelValues(loaded.rows, sm).slice(0, FIXED_LAYOUT_LIMIT);
  // series keep their color in every panel
  const all = pivot(loaded.rows, q, "Category", "Series", ["Y", "Y2"]);
  const order = new Map(all.series.map((s, i) => [s.label || BLANK_LABEL, i]));
  const colorBy = (label: string) => order.get(label);
  const subs = values.map((v) => cartesianPanel({ ...inp, loaded: { ...loaded, rows: loaded.rows.filter((r) => valueKey(r[sm.index]) === valueKey(v)), highlightRows: loaded.highlightRows?.filter((r) => valueKey(r[sm.index]) === valueKey(v)) ?? null }, colorBy }));
  const n = subs.length;
  const layoutType = f.str("smallMultiplesLayout", "layoutType", "auto");
  const { columns, rows } = panelGrid(n, { type: layoutType, columns: f.has("smallMultiplesLayout", "columnCount") ? f.num("smallMultiplesLayout", "columnCount", 0) : null, rows: f.has("smallMultiplesLayout", "rowCount") ? f.num("smallMultiplesLayout", "rowCount", 0) : null }, 1.4);
  const pad = Math.max(0, f.num("smallMultiplesLayout", "gridPadding", 4));
  // advanced padding: the gap between neighbouring panels (inner) and the margin at the edge of the visual (outer), per direction
  const advanced = f.bool("smallMultiplesLayout", "advancedPaddingOptions", false);
  const px = (prop: string, dflt: number) => Math.max(0, f.num("smallMultiplesLayout", prop, dflt));
  const gapX = advanced ? px("columnPaddingInner", 12) : 2 * (pad + 4);
  const edgeX = advanced ? px("columnPaddingOuter", 8) : pad + 4;
  const gapY = advanced ? px("rowPaddingInner", 12) : 2 * pad;
  const edgeY = advanced ? px("rowPaddingOuter", 8) : pad;
  const headerShow = f.bool("subheader", "show", true);
  const headerAtBottom = f.str("subheader", "position", "top") === "bottom";
  const headerH = headerShow ? 22 : 0;
  const font = readFont(f, "subheader", {});
  const align = f.str("subheader", "alignment", "center");
  const legendShown = subs[0]?.option.legend?.show !== false && (all.series.length > 1 || subs[0]?.option.series.length > 1);
  const topMargin = legendShown ? 30 : 6;
  const bg = f.color("smallMultiplesLayout", "backgroundColor");
  const panelAlpha = opacityOf(f.num("smallMultiplesLayout", "backgroundTransparency", 0));
  const grids: O[] = [];
  const xAxes: O[] = [];
  const yAxes: O[] = [];
  const series: O[] = [];
  const titles: O[] = [];
  const seriesMap: { panel: number; local: number }[] = [];
  const valueAxisKey = horizontal ? "xAxis" : "yAxis";
  // one value scale for all panels, unless the axis has its own bounds
  let lo = 0;
  let hi = -Infinity;
  subs.forEach((s) => {
    const sums = new Map<number, number>();
    for (const se of s.option.series as O[]) {
      for (const [di, d] of (se.data as O[]).entries()) {
        const x = typeof d === "object" && d ? d.value : d;
        if (typeof x !== "number" || !Number.isFinite(x)) continue;
        if (se.stack) sums.set(di, (sums.get(di) ?? 0) + x);
        else {
          hi = Math.max(hi, x);
          lo = Math.min(lo, x);
        }
      }
    }
    for (const t of sums.values()) hi = Math.max(hi, t);
  });
  const userMin = f.has("valueAxis", "start");
  const userMax = f.has("valueAxis", "end");
  subs.forEach((sub, i) => {
    const c = i % columns;
    const r = Math.floor(i / columns);
    const area = (k: number, count: number) => `${(k * 100) / count}%`;
    const cellW = `${100 / columns}%`;
    const cellH = `${100 / rows}%`;
    const top = `calc(${area(r, rows)} + ${topMargin + headerH * (headerAtBottom ? 0 : 1)}px)`;
    const left = c === 0 ? edgeX : gapX / 2;
    const right = c === columns - 1 ? edgeX : gapX / 2;
    const above = r === 0 ? edgeY : gapY / 2;
    const below = r === rows - 1 ? edgeY : gapY / 2;
    grids.push({ ...(bg ? { show: true, backgroundColor: rgba(bg, panelAlpha) } : {}), left: `calc(${area(c, columns)} + ${left}px)`, top: `calc(${top} + ${above - pad}px)`, width: `calc(${cellW} - ${left + right}px)`, height: `calc(${cellH} - ${topMargin / rows + headerH + above + below}px)`, containLabel: true });
    const first = (x: unknown): O => (Array.isArray(x) ? x[0] : x) as O;
    const xa: O = { ...first(sub.option.xAxis), gridIndex: i };
    const ya: O = { ...first(sub.option.yAxis), gridIndex: i };
    const valueAxis = horizontal ? xa : ya;
    if (valueAxis.type === "value" && Number.isFinite(hi) && valueAxis.min === undefined && valueAxis.max === undefined && !userMin && !userMax) {
      valueAxis.min = Math.min(0, lo);
      valueAxis.max = hi;
    }
    // labels: values at the left (bars: bottom) edge only, categories at the bottom (bars: left) edge only
    const lastRow = r === rows - 1 || i + columns >= n;
    const firstCol = c === 0;
    const catAxis = horizontal ? ya : xa;
    if (catAxis.axisLabel) catAxis.axisLabel = { ...catAxis.axisLabel, show: horizontal ? firstCol : lastRow };
    if (valueAxis.axisLabel) valueAxis.axisLabel = { ...valueAxis.axisLabel, show: horizontal ? lastRow : firstCol };
    if (valueAxis.name) valueAxis.name = undefined;
    if (catAxis.name) catAxis.name = undefined;
    xAxes.push(xa);
    yAxes.push(ya);
    (sub.option.series as O[]).forEach((s, k) => {
      series.push({ ...s, xAxisIndex: i, yAxisIndex: i });
      seriesMap.push({ panel: i, local: k });
    });
    if (headerShow) {
      titles.push({
        text: labelOf(values[i], sm.format),
        left: `calc(${area(c, columns)} + ${pad + 4}px)`,
        top: headerAtBottom ? `calc(${area(r + 1, rows)} - ${headerH + pad}px)` : `calc(${area(r, rows)} + ${topMargin}px)`,
        textAlign: align,
        // Title wrap: a long header breaks into lines (within the width of a panel's header) instead of being cut
        textStyle: { ...echartsText(font, { family: theme.textClasses.label.fontFace, size: theme.textClasses.label.fontSize, color: theme.textClasses.label.color }), width: 140, overflow: f.bool("subheader", "titleWrap", false) ? "breakAll" : "truncate" },
      });
    }
  });
  // grid lines between the panels: value axes of a helper grid over the whole visual whose split lines fall on the cell edges
  if (f.bool("smallMultiplesLayout", "gridLineShow", false) && n > 0) {
    const kind = f.str("smallMultiplesLayout", "gridLineType", "inner");
    const edge = kind === "all" ? 0 : 1e-6;
    const line = (show: boolean): O => ({
      show,
      lineStyle: {
        color: f.color("smallMultiplesLayout", "gridLineColor") ?? theme.muted,
        width: Math.max(0, f.num("smallMultiplesLayout", "gridLineWidth", 1)),
        type: f.str("smallMultiplesLayout", "gridLineStyle", "solid"),
        opacity: opacityOf(f.num("smallMultiplesLayout", "gridLineTransparency", 0)),
      },
    });
    const helper = (cells: number, lines: boolean, inverse: boolean): O => ({
      type: "value",
      gridIndex: grids.length,
      min: edge,
      max: cells - edge,
      interval: 1,
      inverse,
      silent: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      axisPointer: { show: false },
      splitLine: line(lines),
    });
    xAxes.push(helper(columns, kind !== "innerHorizontal", false));
    yAxes.push(helper(rows, kind !== "innerVertical", true));
    grids.push({ left: 0, right: 0, top: 0, bottom: 0, show: false });
  }
  // the legend of the first panel, for the series of all panels
  const legend = { ...(subs[0]?.option.legend ?? {}), show: legendShown, data: all.series.map((s) => s.label || BLANK_LABEL) };
  const option: O = {
    ...subs[0]?.option,
    title: titles,
    legend,
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    series,
    tooltip: {
      ...(subs[0]?.option.tooltip ?? {}),
      formatter: (params: O | O[]) => {
        const list = Array.isArray(params) ? params : [params];
        const first = seriesMap[list[0]?.seriesIndex];
        if (!first) return "";
        const sub = subs[first.panel];
        const mapped = list.filter((x) => seriesMap[x.seriesIndex]?.panel === first.panel).map((x) => ({ ...x, seriesIndex: seriesMap[x.seriesIndex].local }));
        return `${labelOf(values[first.panel], sm.format)}<br/>${sub.option.tooltip.formatter(mapped)}`;
      },
    },
  };
  return {
    option,
    count: subs.reduce((a, s) => a + s.count, 0),
    pointAt: (si, di) => {
      const m = seriesMap[si];
      if (!m) return null;
      const pt = subs[m.panel].pointAt(m.local, di);
      if (!pt) return null;
      return { fields: [...pt.fields, sm.field], values: [...pt.values, valueToLit(values[m.panel])] };
    },
  };
}

function cartesian(inp: ChartInput): ChartBuild {
  const sm = columnsOf(inp.loaded.query, "Rows", "group")[0];
  return sm && inp.loaded.rows.length > 0 ? smallMultiples(inp, sm) : cartesianPanel(inp);
}

// ---- pie, donut, funnel, treemap ---------------------------------------------------------------------

function sliceData(inp: ChartInput) {
  const q = inp.loaded.query;
  const role = inp.visual.visualType === "treemap" ? "Group" : "Category";
  const valueRole = inp.visual.visualType === "treemap" ? "Values" : "Y";
  const p = pivot(inp.loaded.rows, q, role, null, [valueRole]);
  const vcol = columnsOf(q, valueRole, "value")[0];
  return { p, vcol, values: p.cells[0]?.[0] ?? [] };
}

const SLICE_STYLES: Record<string, { cat: boolean; val: boolean; pct: boolean }> = {
  Category: { cat: true, val: false, pct: false },
  Data: { cat: false, val: true, pct: false },
  "Percent of total": { cat: false, val: false, pct: true },
  Both: { cat: true, val: true, pct: false },
  "Category, percent of total": { cat: true, val: false, pct: true },
  "Data value, percent of total": { cat: false, val: true, pct: true },
  "Category, data value, percent of total": { cat: true, val: true, pct: true },
};
const PIE_POS: Record<string, string> = { outside: "outside", inside: "inside", preferOutside: "outside", preferInside: "inside" };

/** An axis title stands outside the labels, which the grid does not count: the side the title is on gets room for it. */
function roomForTitles(grid: O, xAxis: O, yAxis: O, secondary?: O): O {
  const room = 22;
  if (xAxis?.name) grid.bottom = (grid.bottom as number) + room;
  if (yAxis?.name) grid.left = (grid.left as number) + room;
  // the title of the second value axis (combo charts) stands at the right edge
  if (secondary?.name) grid.right = (grid.right as number) + room;
  return grid;
}

function pie(inp: ChartInput): ChartBuild {
  const { visual, theme } = inp;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const { p, vcol, values } = sliceData(inp);
  const donut = visual.visualType === "donutChart";
  const total = values.reduce<number>((a, v) => a + Math.max(0, v ?? 0), 0);
  const hl = inp.loaded.highlightRows ? sliceData({ ...inp, loaded: { ...inp.loaded, rows: inp.loaded.highlightRows } }) : null;
  const hlByKey = hl ? new Map(hl.p.categories.map((c, i) => [c.key, hl.values[i]])) : null;
  const selKeys = new Set(inp.selected.map((s) => JSON.stringify(s.values)));
  const style = SLICE_STYLES[f.str("labels", "labelStyle", "Category")] ?? SLICE_STYLES.Category;
  const sliceAlpha = opacityOf(f.num("dataPoint", "fillTransparency", 0));
  const data = p.categories.map((c, i) => {
    const fill = f.color("dataPoint", "fill", c.label) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, i);
    return {
      name: c.label,
      value: values[i] ?? 0,
      itemStyle: {
        color: fill,
        opacity: ((selKeys.size > 0 && !selKeys.has(JSON.stringify(c.values.map(valueToLit)))) || (hlByKey !== null && (hlByKey.get(c.key) ?? 0) === 0) ? DIM : 1) * sliceAlpha,
        ...(f.bool("dataPoint", "borderShow", false) ? sliceItemStyle(f, theme, fill) : {}),
      },
    };
  });
  const pctDigits = f.num("labels", "percentageLabelPrecision", 1);
  const text = (pa: O) => {
    const parts: string[] = [];
    if (style.cat) parts.push(pa.name);
    const val = valueText(pa.value, vcol?.format ?? null, f);
    const pct = total ? `${((pa.value / total) * 100).toFixed(pctDigits)}%` : "";
    if (style.val && style.pct) return `${style.cat ? `${pa.name}: ` : ""}${val} (${pct})`;
    if (style.val) parts.push(val);
    if (style.pct) parts.push(pct);
    return parts.join(": ");
  };
  const font = readFont(f, "labels", { color: "color" });
  const bg = f.str("labels", "background", "auto");
  const hole = (donut ? f.num("slices", "innerRadiusRatio", 50) : 0) * 0.72;
  const centre = donut ? donutCentre(f, theme, values.some((v) => v !== null && v !== undefined) ? total : null, vcol?.format ?? null, hole) : null;
  const option: O = {
    animation: false,
    ...(centre ? { graphic: centre.graphic } : {}),
    legend: legendBlock(f, theme, true),
    tooltip: { trigger: "item", confine: true, formatter: (pa: O) => `${pa.marker}${pa.name}: <b>${formatNumber(pa.value, vcol?.format ?? null)}</b><span data-extra> (${total ? ((pa.value / total) * 100).toFixed(1) : 0}%)</span>` },
    series: [
      ...(centre?.discs ?? []),
      {
        type: "pie",
        radius: donut ? [`${f.num("slices", "innerRadiusRatio", 50)}%`, "72%"] : ["0%", "72%"],
        center: ["50%", centre ? "50%" : "55%"],
        startAngle: 90 - f.num("slices", "startAngle", 0),
        data,
        label: {
          show: f.bool("labels", "show", true),
          position: PIE_POS[f.str("labels", "position", "outside")] ?? "outside",
          formatter: text,
          ...echartsText(font, labelDefaults(theme)),
          ...(bg === "on" ? { backgroundColor: theme.background, padding: [2, 4] } : {}),
          overflow: f.bool("labels", "overflow", false) ? "none" : "truncate",
        },
        itemStyle: { borderColor: theme.background, borderWidth: 1 },
      },
    ],
  };
  return { option, count: data.length, ...(centre?.images.length ? { centreImages: centre.images } : {}), ...(centre?.background ? { centreBackground: centre.background } : {}), pointAt: (_s, di) => (p.categories[di] ? pointOfCategory(p, di, null) : null) };
}

function funnel(inp: ChartInput): ChartBuild {
  const { visual, theme } = inp;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const { p, vcol, values } = sliceData(inp);
  const data = p.categories.map((c, i) => {
    const fill = f.color("dataPoint", "fill", c.label) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, i);
    return { name: c.label, value: values[i] ?? 0, itemStyle: { color: fill, ...(f.bool("dataPoint", "borderShow", false) ? sliceItemStyle(f, theme, fill) : {}) } };
  });
  const first = values[0] ?? 0;
  const fmtStyle = f.str("labels", "funnelLabelStyle", "Data");
  const pctDigits = f.num("labels", "percentageLabelPrecision", 0);
  const font = readFont(f, "labels", { color: "color" });
  const catFont = readFont(f, "categoryAxis", { color: "color" });
  const showCat = f.bool("categoryAxis", "show", true);
  // the percent bar label: the share of the previous stage, after the figures, in its own font
  const percentBar = f.bool("percentBarLabel", "show", false);
  const percentFont = readFont(f, "percentBarLabel", { color: "color" });
  const labelText = (pa: O) => {
    const v = pa.value as number;
    const prev = values[pa.dataIndex - 1] ?? v;
    const val = valueText(v, vcol?.format ?? null, f);
    const pctFirst = first ? `${((v / first) * 100).toFixed(pctDigits)}%` : "";
    const pctPrev = prev ? `${((v / prev) * 100).toFixed(pctDigits)}%` : "";
    const body = fmtStyle === "Percent of first" ? pctFirst : fmtStyle === "Percent of previous" ? pctPrev : fmtStyle === "Data, percent of first" ? `${val} (${pctFirst})` : fmtStyle === "Data, percent of previous" ? `${val} (${pctPrev})` : val;
    // the category and the figures are two spans, each in its own font (Category labels and Labels cards)
    const pct = percentBar ? `  {p|${pctPrev}}` : "";
    return (showCat ? `{c|${String(pa.name)}}  {v|${body}}` : `{v|${body}}`) + pct;
  };
  const option: O = {
    animation: false,
    legend: legendBlock(f, theme, false),
    tooltip: { trigger: "item", confine: true, formatter: (pa: O) => `${pa.marker}${pa.name}: <b>${formatNumber(pa.value, vcol?.format ?? null)}</b>` },
    series: [
      {
        type: "funnel",
        sort: "descending",
        left: "8%",
        right: "8%",
        top: 10,
        bottom: 10,
        data,
        label: {
          show: f.bool("labels", "show", true),
          position: f.str("labels", "labelPosition", "Auto") === "OutsideEnd" ? "outside" : "inside",
          ...echartsText({ ...font, color: font.color ?? (showCat ? catFont.color : undefined) ?? "#ffffff" }, labelDefaults(theme)),
          formatter: labelText,
          rich: { c: echartsText({ ...catFont, color: catFont.color ?? font.color ?? "#ffffff" }, labelDefaults(theme)), v: echartsText({ ...font, color: font.color ?? (showCat ? catFont.color : undefined) ?? "#ffffff" }, labelDefaults(theme)), p: echartsText({ ...percentFont, color: percentFont.color ?? font.color ?? "#ffffff" }, labelDefaults(theme)) },
          ...(f.bool("labels", "enableBackground", false) ? { backgroundColor: withOpacity(f.color("labels", "backgroundColor") ?? theme.background, opacityOf(f.num("labels", "backgroundTransparency", 0))), padding: [2, 4] } : {}),
        },
        itemStyle: { borderColor: theme.background, borderWidth: 1 },
        labelLine: { show: showCat },
      },
    ],
  };
  return { option, count: data.length, pointAt: (_s, di) => (p.categories[di] ? pointOfCategory(p, di, null) : null) };
}

function treemap(inp: ChartInput): ChartBuild {
  const { visual, theme, loaded } = inp;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const q = loaded.query;
  const groups = columnsOf(q, "Group", "group");
  const vcol = columnsOf(q, "Values", "value")[0];
  type Node = { name: string; value: number; children?: Node[]; leaf?: { values: Value[] } };
  const roots: Node[] = [];
  for (const row of loaded.rows) {
    const v = valueNum(row[vcol.index]) ?? 0;
    const top = labelOf(row[groups[0].index], groups[0].format);
    let node = roots.find((n) => n.name === top);
    if (!node) roots.push((node = { name: top, value: 0, children: groups.length > 1 ? [] : undefined, leaf: { values: [row[groups[0].index]] } }));
    node.value += v;
    if (groups.length > 1) {
      node.children!.push({ name: labelOf(row[groups[1].index], groups[1].format), value: v, leaf: { values: [row[groups[0].index], row[groups[1].index]] } });
    }
  }
  const colored = roots.map((n, i) => ({ ...n, itemStyle: { color: f.color("dataPoint", "fill", n.name) ?? seriesColor(theme, i) } }));
  const flat: Node[] = [];
  const walk = (ns: Node[]) => ns.forEach((n) => (flat.push(n), n.children && walk(n.children)));
  walk(colored);
  const catFont = readFont(f, "categoryLabels", { color: "color" });
  const valFont = readFont(f, "labels", { color: "color" });
  const showCat = f.bool("categoryLabels", "show", true);
  const showVal = f.bool("labels", "show", true);
  const white = { family: theme.textClasses.label.fontFace, size: theme.textClasses.label.fontSize, color: "#ffffff" };
  const option: O = {
    animation: false,
    legend: legendBlock(f, theme, false),
    tooltip: { confine: true, formatter: (pa: O) => `${pa.name}: <b>${formatNumber(pa.value, vcol?.format ?? null)}</b>` },
    series: [
      {
        type: "treemap",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        data: colored,
        label: {
          show: showCat || showVal,
          // the category and the value are two spans, each with its own font (Category labels and Labels cards)
          formatter: (pa: O) => {
            const val = showVal ? valueText(pa.value, vcol?.format ?? null, f) : "";
            return [showCat ? `{c|${pa.name}}` : "", showVal ? `{v|${val}}` : ""].filter(Boolean).join("\n");
          },
          rich: { c: echartsText({ ...catFont, color: catFont.color ?? valFont.color }, white), v: echartsText({ ...valFont, color: valFont.color ?? catFont.color }, white) },
        },
        upperLabel: { show: groups.length > 1 && showCat, height: 18, ...echartsText({ ...catFont, color: catFont.color }, white) },
        itemStyle: { borderColor: theme.background, borderWidth: 1, gapWidth: f.has("layout", "innerPadding") ? f.num("layout", "innerPadding", 1) : 1 },
        // layout > outer padding (space around the whole treemap) and tiling method (the aspect ratio the rectangles aim for)
        ...(f.has("layout", "outerPadding") ? (() => { const pad = Math.max(0, f.num("layout", "outerPadding", 0)); return { left: pad, right: pad, top: pad, bottom: pad }; })() : {}),
        squareRatio: { stableSquarified: 0.5 * (1 + Math.sqrt(5)), binary: 1, alternating: 3 }[f.str("layout", "tilingMethod", "stableSquarified")] ?? 0.5 * (1 + Math.sqrt(5)),
      },
    ],
  };
  return {
    option,
    count: roots.length,
    pointAt: (_s, di) => {
      const n = flat[di];
      return n?.leaf ? { fields: groups.slice(0, n.leaf.values.length).map((g) => g.field), values: n.leaf.values.map(valueToLit) } : null;
    },
  };
}

// ---- scatter, waterfall, gauge ---------------------------------------------------------------------------

function scatter(inp: ChartInput): ChartBuild {
  const { visual, theme, loaded } = inp;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const q = loaded.query;
  const cat = columnsOf(q, "Category", "group")[0];
  const ser = columnsOf(q, "Series", "group")[0];
  const xc = columnsOf(q, "X", "value")[0];
  const yc = columnsOf(q, "Y", "value")[0];
  const sc = columnsOf(q, "Size", "value")[0];
  const sizes = sc ? loaded.rows.map((r) => valueNum(r[sc.index]) ?? 0) : [];
  const [smin, smax] = sizes.length ? [Math.min(...sizes), Math.max(...sizes)] : [0, 0];
  const bySeries = new Map<string, { name: string; pts: { row: Value[]; i: number }[] }>();
  loaded.rows.forEach((row, i) => {
    const key = ser ? row[ser.index].text : "";
    const s = bySeries.get(key) ?? { name: ser ? labelOf(row[ser.index], ser.format) : (yc?.label ?? ""), pts: [] };
    s.pts.push({ row, i });
    bySeries.set(key, s);
  });
  const list = [...bySeries.values()];
  const bubble = f.num("bubbles", "bubbleSize", 10) / 10;
  const markerAlpha = opacityOf(f.num("markers", "transparency", 15));
  const showPointLabels = f.bool("categoryLabels", "show", false);
  const ptFont = readFont(f, "categoryLabels", { color: "color" });
  const markerBorder = f.bool("markers", "borderShow", false);
  const series = list.map((s, si) => {
    const color = f.color("dataPoint", "fill", s.name) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, si);
    return {
      name: s.name,
      type: "scatter",
      itemStyle: { color, opacity: markerAlpha, ...(markerBorder ? { borderColor: f.bool("markers", "borderColorMatchFill", false) ? color : (f.color("markers", "borderColor") ?? theme.foreground), borderWidth: f.num("markers", "borderWidth", 1) } : {}) },
      symbol: SYMBOLS[f.str("bubbles", "markerShape", "circle")] ?? "circle",
      symbolRotate: f.num("markers", "rotation", 0),
      symbolSize: (d: number[]) => bubble * (sc ? 8 + (smax === smin ? 0.5 : (d[2] - smin) / (smax - smin)) * 28 : 10),
      label: { show: showPointLabels, formatter: (pa: O) => String(pa.data[3] ?? ""), position: "right", ...echartsText(ptFont, labelDefaults(theme)) },
      data: s.pts.map((pt) => [valueNum(pt.row[xc?.index ?? 0]), valueNum(pt.row[yc?.index ?? 0]), sc ? (valueNum(pt.row[sc.index]) ?? 0) : 0, cat ? labelOf(pt.row[cat.index], cat.format) : ""]),
    };
  });
  // Analytics: the constant lines on both value axes, and a trend line through the points (one per series, or one through all)
  const marks: O[] = [];
  const shades: O[][] = [];
  const grow: { x: number[]; y: number[] } = { x: [], y: [] };
  for (const [object, axisKey, c, auto] of [["y1AxisReferenceLine", "yAxis", yc, grow.y], ["xAxisReferenceLine", "xAxis", xc, grow.x]] as const) {
    const sel = "id:constant";
    const at = f.has(object, "value", sel) ? f.num(object, "value", 0, sel) : null;
    const spec: LineSpec = { object, id: "constant" };
    const mark = referenceLineMark(f, theme, spec, at, "Constant", axisKey, c?.format ?? null);
    if (mark) marks.push(mark);
    const shade = referenceLineShade(f, theme, spec, at, axisKey);
    if (shade) shades.push(shade);
    if (mark && at !== null && f.bool(object, "autoScale", false, sel)) auto.push(at);
  }
  if (f.bool("trend", "show", false)) {
    const style = f.str("trend", "style", "dashed");
    const trendDash = dashOf(f.str("trend", "dashArray", ""));
    const groups = f.bool("trend", "combineSeries", false) ? [{ name: "", pts: list.flatMap((s) => s.pts) }] : list;
    for (const g of groups) {
      const xs = g.pts.map((pt) => valueNum(pt.row[xc?.index ?? 0]));
      const ys = g.pts.map((pt) => valueNum(pt.row[yc?.index ?? 0]));
      const tr = linearTrend(ys, xs);
      const known = xs.filter((x): x is number => x !== null);
      if (!tr || known.length < 2) continue;
      const lo = Math.min(...known);
      const hi = Math.max(...known);
      if (f.bool("trend", "autoScale", false)) grow.y.push(tr.at(lo), tr.at(hi));
      series.push({
        name: groups.length > 1 && g.name ? `${f.str("trend", "displayName", "") || "Trend line"} · ${g.name}` : f.str("trend", "displayName", "") || "Trend line",
        type: "line",
        data: [[lo, tr.at(lo)], [hi, tr.at(hi)]],
        symbol: "none",
        silent: true,
        z: 6,
        lineStyle: {
          color: f.color("trend", "lineColor") ?? theme.muted,
          width: f.num("trend", "width", 2),
          type: trendDash && (style === "custom" || !f.has("trend", "style")) ? trendDash : style === "custom" ? "dashed" : style,
          opacity: opacityOf(f.num("trend", "transparency", 0)),
          ...(f.has("trend", "dashCap") ? { cap: CAP[f.str("trend", "dashCap", "none")] ?? "butt" } : {}),
        },
        tooltip: { show: false },
      } as never);
    }
  }
  const axis = (object: "categoryAxis" | "valueAxis", c: typeof xc): O => ({ ...axisBlock({ f, theme, object, kind: "value", fmt: c?.format ?? null, titleDefault: c?.label ?? "", gridDefault: true }), scale: true });
  const option: O = {
    animation: false,
    legend: legendBlock(f, theme, !!ser),
    grid: gridFor(f, f.bool("legend", "show", !!ser)),
    tooltip: { trigger: "item", confine: true, formatter: (pa: O) => `${pa.marker}${pa.data[3] || pa.seriesName}<br/>${xc?.label}: <b>${formatNumber(pa.data[0], xc?.format ?? null)}</b><br/>${yc?.label}: <b>${formatNumber(pa.data[1], yc?.format ?? null)}</b>${sc ? `<span data-extra><br/>${sc.label}: <b>${formatNumber(pa.data[2], sc.format ?? null)}</b></i>` : ""}` },
    xAxis: axis("categoryAxis", xc),
    yAxis: axis("valueAxis", yc),
    series,
  };
  option.grid = roomForTitles(option.grid, option.xAxis, option.yAxis);
  const first = (option.series as O[])[0];
  if (first) attachMarks(option.series as O[], first, marks, shades);
  // "Include in auto scale": an axis grows to show a line
  for (const [axisOpt, pts] of [[option.yAxis, grow.y], [option.xAxis, grow.x]] as const) {
    if (!pts.length) continue;
    const lo = Math.min(...pts);
    const hi = Math.max(...pts);
    if (axisOpt.min === undefined) axisOpt.min = (e: { min: number }) => Math.min(e.min, lo);
    if (axisOpt.max === undefined) axisOpt.max = (e: { max: number }) => Math.max(e.max, hi);
  }
  return {
    option,
    count: loaded.rows.length,
    pointAt: (si, di) => {
      const pt = list[si]?.pts[di];
      if (!pt) return null;
      const fields: FieldRef[] = [];
      const values = [];
      for (const c of [cat, ser]) if (c) (fields.push(c.field), values.push(valueToLit(pt.row[c.index])));
      return fields.length ? { fields, values } : null;
    },
  };
}

function waterfall(inp: ChartInput): ChartBuild {
  const { visual, theme, loaded } = inp;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const q = loaded.query;
  const vcol = columnsOf(q, "Y", "value")[0];
  const p = pivot(loaded.rows, q, "Category", null, ["Y"]);
  const vals = (p.cells[0]?.[0] ?? []).map((v) => v ?? 0);
  const showTotal = f.bool("valueAxis", "totalsEnabled", true);
  const names = [...p.categories.map((c) => c.label), ...(showTotal ? ["Total"] : [])];
  const base: (number | string)[] = [];
  const up: (number | string)[] = [];
  const down: (number | string)[] = [];
  const total: (number | string)[] = [];
  let run = 0;
  vals.forEach((v) => {
    const start = run;
    run += v;
    base.push(Math.min(start, run));
    up.push(v >= 0 ? v : "-");
    down.push(v < 0 ? -v : "-");
    total.push("-");
  });
  if (showTotal) {
    base.push(0);
    up.push("-");
    down.push("-");
    total.push(run);
  }
  const common = { type: "bar", stack: "wf", barMaxWidth: 48 };
  const colors = { up: f.color("sentimentColors", "increaseFill") ?? theme.good, down: f.color("sentimentColors", "decreaseFill") ?? theme.bad, total: f.color("sentimentColors", "totalFill") ?? theme.neutral };
  const label = (sign: 1 | -1) =>
    labelBlock({ f, theme, show: f.bool("labels", "show", false), horizontal: false, stacked: true, asLine: false, text: (pa: O) => valueText(sign * (pa.value as number), vcol?.format ?? null, f) });
  const option: O = {
    animation: false,
    legend: { ...legendBlock(f, theme, false), data: ["Increase", "Decrease", "Total"] },
    grid: gridFor(f, f.bool("legend", "show", false)),
    tooltip: { trigger: "axis", confine: true, formatter: (ps: O[]) => `${ps[0].name}<br/>${ps.filter((x) => x.seriesName !== "base" && x.value !== "-").map((x) => `${x.marker}${x.seriesName}: <b>${formatNumber(x.seriesName === "Decrease" ? -x.value : x.value, vcol?.format ?? null)}</b>`).join("<br/>")}` },
    xAxis: { ...axisBlock({ f, theme, object: "categoryAxis", kind: "category", titleDefault: columnsOf(q, "Category", "group").map((c) => c.label).join(", ") }), data: names },
    yAxis: axisBlock({ f, theme, object: "valueAxis", kind: "value", fmt: vcol?.format ?? null, titleDefault: vcol?.label ?? "" }),
    series: [
      { ...common, name: "base", data: base, itemStyle: { color: "transparent" }, silent: true, tooltip: { show: false } },
      { ...common, name: "Increase", data: up, itemStyle: { color: colors.up }, label: label(1) },
      { ...common, name: "Decrease", data: down, itemStyle: { color: colors.down }, label: label(-1) },
      { ...common, name: "Total", data: total, itemStyle: { color: colors.total }, label: label(1) },
    ],
  };
  option.grid = roomForTitles(option.grid, option.xAxis, option.yAxis);
  // the constant line of the Analytics pane
  const sel = "id:constant";
  const at = f.has("y1AxisReferenceLine", "value", sel) ? f.num("y1AxisReferenceLine", "value", 0, sel) : null;
  const spec: LineSpec = { object: "y1AxisReferenceLine", id: "constant" };
  const mark = referenceLineMark(f, theme, spec, at, "Constant", "yAxis", vcol?.format ?? null);
  const shade = referenceLineShade(f, theme, spec, at, "yAxis");
  attachMarks(option.series, option.series[0], mark ? [mark] : [], shade ? [shade] : []);
  // "Include in auto scale": the value axis grows to show the line
  if (mark && at !== null && f.bool("y1AxisReferenceLine", "autoScale", false, sel)) {
    if (option.yAxis.min === undefined) option.yAxis.min = (e: { min: number }) => Math.min(e.min, at);
    if (option.yAxis.max === undefined) option.yAxis.max = (e: { max: number }) => Math.max(e.max, at);
  }
  return { option, count: p.categories.length, pointAt: (_s, di) => (p.categories[di] ? pointOfCategory(p, di, null) : null) };
}

function gauge(inp: ChartInput): ChartBuild {
  const { visual, theme, loaded } = inp;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const q = loaded.query;
  const read = (role: string) => {
    const c = columnsOf(q, role, "value")[0];
    return c && loaded.rows[0] ? valueNum(loaded.rows[0][c.index]) : null;
  };
  const value = read("Y");
  const target = read("TargetValue") ?? (f.has("axis", "target") ? f.num("axis", "target", 0) : null);
  const min = read("MinValue") ?? f.num("axis", "min", 0);
  const max = read("MaxValue") ?? f.num("axis", "max", target !== null ? Math.max(target * 2, value ?? 0) : Math.max(100, (value ?? 0) * 1.25));
  const fmt = columnsOf(q, "Y", "value")[0]?.format ?? null;
  const fill = f.color("dataPoint", "fill") ?? seriesColor(theme, 0);
  const data: O[] = value === null ? [] : [{ value, name: columnsOf(q, "Y", "value")[0]?.label ?? "", itemStyle: { color: fill } }];
  const axisFont = readFont(f, "labels", { color: "color" });
  const calloutFont = readFont(f, "calloutValue", { color: "color" });
  const targetFont = readFont(f, "target", { color: "color" });
  const calloutDefaults = { family: theme.textClasses.callout.fontFace, size: theme.textClasses.callout.fontSize * 0.8, color: theme.textClasses.callout.color };
  const option: O = {
    animation: false,
    series: [
      {
        type: "gauge",
        min,
        max,
        startAngle: 200,
        endAngle: -20,
        radius: "92%",
        center: ["50%", "62%"],
        progress: { show: true, width: 16, itemStyle: { color: fill } },
        axisLine: { lineStyle: { width: 16, color: [[1, theme.dark ? "#444" : "#e5e5e5"]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        splitNumber: 2,
        axisLabel: {
          show: f.bool("labels", "show", true),
          distance: 16,
          ...echartsText(axisFont, { ...labelDefaults(theme), size: 10 }),
          formatter: (v: number) => (f.has("labels", "labelDisplayUnits") ? valueText(v, fmt, f, "labels") : formatCompact(v, "auto", 1, fmt)),
        },
        detail: { show: f.bool("calloutValue", "show", true), valueAnimation: false, offsetCenter: [0, "20%"], ...echartsText(calloutFont, calloutDefaults), formatter: (v: number) => valueText(v, fmt, f, "calloutValue") },
        title: { show: false },
        data,
      },
      ...(target !== null
        ? [
            {
              type: "gauge",
              min,
              max,
              startAngle: 200,
              endAngle: -20,
              radius: "92%",
              center: ["50%", "62%"],
              axisLine: { show: false },
              progress: { show: false },
              axisTick: { show: false },
              splitLine: { show: false },
              axisLabel: { show: false },
              detail: { show: f.bool("target", "show", false), offsetCenter: [0, "42%"], ...echartsText(targetFont, { ...calloutDefaults, size: 11 }), formatter: () => `Target: ${valueText(target, fmt, f, "target")}` },
              title: { show: false },
              pointer: { show: true, length: "16%", width: 4, offsetCenter: [0, "-74%"], itemStyle: { color: f.color("dataPoint", "target") ?? theme.foreground } },
              silent: true,
              data: [{ value: Math.min(max, Math.max(min, target)), name: "Target" }],
            },
          ]
        : []),
    ],
  };
  return { option, count: value === null ? 0 : 1, pointAt: () => null };
}

/** Builds the chart for the visual, or null when the visual is not an ECharts visual. */
export function buildChart(inp0: ChartInput): ChartBuild | null {
  // general > Format string: a number format for the values of the visual that replaces the fields' own
  const fs = new FormatReader(inp0.visual.json, inp0.theme, inp0.visual.visualType).str("general", "formatString", "");
  const inp: ChartInput = fs
    ? { ...inp0, loaded: { ...inp0.loaded, query: { ...inp0.loaded.query, columns: inp0.loaded.query.columns.map((c) => (c.kind === "value" ? { ...c, format: fs } : c)) } } }
    : inp0;
  const b = buildChartRaw(inp);
  if (b) {
    const f = new FormatReader(inp.visual.json, inp.theme, inp.visual.visualType);
    styleTooltip(b.option, f);
    styleLegendTitle(b.option, f, inp.theme);
    const img = plotImage(f);
    const g = Array.isArray(b.option.grid) ? b.option.grid[0] : b.option.grid;
    if (img && g) {
      const px = (v: unknown, d: number) => (typeof v === "number" ? v : d);
      b.plotImage = { ...img, margins: { left: px(g.left, 8), right: px(g.right, 12), top: px(g.top, 8), bottom: px(g.bottom, 8) } };
    }
  }
  return b;
}

/** The legend title (legend > Title): a text above or beside the entries; the legend and the plot area make room for it. */
function styleLegendTitle(option: O, f: FormatReader, theme: Theme): void {
  const legend = option.legend;
  if (!legend || legend.show === false || !f.bool("legend", "showTitle", false)) return;
  const pos = f.str("legend", "position", "Top");
  const text = f.str("legend", "titleText", "") || "Legend";
  const font = readFont(f, "legend", { color: "labelColor" });
  const t: O = { text, textStyle: { ...echartsText(font, labelDefaults(theme)), fontWeight: "bold" }, itemGap: 0, padding: 0 };
  const room = 18;
  if (pos.startsWith("Bottom")) {
    Object.assign(t, { bottom: 22, left: pos === "BottomCenter" ? "center" : pos === "BottomRight" ? undefined : 0, right: pos === "BottomRight" ? 0 : undefined });
    if (option.grid) option.grid = { ...option.grid, bottom: (option.grid.bottom ?? 8) + room };
  } else if (pos.startsWith("Left") || pos.startsWith("Right")) {
    Object.assign(t, pos.startsWith("Left") ? { top: 0, left: 0 } : { top: 0, right: 0 });
    legend.top = pos.endsWith("Center") ? "middle" : room;
  } else {
    Object.assign(t, { top: 0, left: pos === "TopCenter" ? "center" : pos === "TopRight" ? undefined : 0, right: pos === "TopRight" ? 0 : undefined });
    legend.top = room;
    if (option.grid) option.grid = { ...option.grid, top: (option.grid.top ?? 8) + room };
  }
  option.title = [...(Array.isArray(option.title) ? option.title : option.title ? [option.title] : []), t];
}

/** The look of the hover tooltip from the Tooltips card: colors, font, bold values, transparency, and the switch. */
function styleTooltip(option: O, f: FormatReader): void {
  const t = option.tooltip;
  if (!t) return;
  const k = tooltipLook(f);
  const link = linkModel(f);
  // a linked visual can hide its own hover tooltip (Action card: suppress the default tooltip)
  if (!k.show || (link.type !== "None" && link.suppressVisualTooltip)) {
    option.tooltip = { show: false };
    return;
  }
  const wrap = (fn: unknown) => {
    if (typeof fn !== "function") return fn;
    return (...args: unknown[]) => {
      let html = String((fn as (...a: unknown[]) => unknown)(...args));
      html = applyTooltipContent(html, k, args[0]);
      if (!k.valuesBold) html = html.replace(/<\/?b>/g, "");
      else if (k.valueColor) html = html.replace(/<b>/g, `<b style="color:${k.valueColor}">`);
      return html;
    };
  };
  const text = {
    ...(k.titleColor ? { color: k.titleColor } : {}),
    ...(k.fontFamily ? { fontFamily: k.fontFamily } : {}),
    ...(k.fontSize !== null ? { fontSize: k.fontSize } : {}),
    ...(k.bold ? { fontWeight: "bold" } : {}),
    ...(k.italic ? { fontStyle: "italic" } : {}),
  };
  option.tooltip = {
    ...t,
    ...(typeof t.formatter === "function" && (!k.valuesBold || k.valueColor || tooltipContentChanges(k)) ? { formatter: wrap(t.formatter) } : {}),
    ...(k.background || k.opacity < 1 ? { backgroundColor: `color-mix(in srgb, ${k.background ?? "#ffffff"} ${Math.round(k.opacity * 100)}%, transparent)` } : {}),
    ...(Object.keys(text).length ? { textStyle: text } : {}),
    ...(k.underline ? { extraCssText: "text-decoration: underline;" } : {}),
  };
}

function buildChartRaw(inp: ChartInput): ChartBuild | null {
  const fam = visualType(inp.visual.visualType)?.family;
  switch (fam) {
    case "cartesian":
      return cartesian(inp);
    case "pie":
      return pie(inp);
    case "funnel":
      return funnel(inp);
    case "treemap":
      return treemap(inp);
    case "scatter":
      return scatter(inp);
    case "waterfall":
      return waterfall(inp);
    case "gauge":
      return gauge(inp);
    case "map": {
      const gaz = gazetteer();
      if (!gaz) return null;
      return inp.visual.visualType === "filledMap" || inp.visual.visualType === "shapeMap" ? filledMap(inp, gaz) : bubbleMap(inp, gaz);
    }
    default:
      return null;
  }
}
