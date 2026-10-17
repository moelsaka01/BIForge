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
import { axisBlock, gridFor, labelBlock, labelDefaults, legendBlock, lineSeriesStyle, referenceLineMark, valueText, type LineSpec } from "./chartFormat";
import { echartsText, opacityOf, readFont } from "../format/styles";
import { seriesColor, type Theme } from "./theme";
import type { VisualModel } from "./visualDoc";
import { visualType } from "./visualTypes";
import { gazetteer } from "./geo";
import { bubbleMap, filledMap } from "./mapOptions";

import type { O } from "./chartFormat";

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
  /** The data point behind a chart element, for selection, drilling and tooltips. */
  pointAt(seriesIndex: number, dataIndex: number): SelectedPoint | null;
  /** Number of data points drawn (0: nothing to show). */
  count: number;
  /** Something the person should know about the drawing, shown under the chart (for example locations a map could not place). */
  notice?: string;
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
  const stacked = hundred || t === "barChart" || t === "columnChart" || t === "stackedAreaChart";
  const lineOnly = t === "lineChart";
  const areaOnly = t === "areaChart" || t === "stackedAreaChart" || t === "hundredPercentStackedAreaChart";
  const ribbon = t === "ribbonChart";
  const combo = t === "lineClusteredColumnComboChart";

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
      if (!asLine || cond) item.itemStyle = { color: c, opacity: (dimmed ? DIM : 1) * (asLine ? 1 : fillAlpha) };
      if (asLine && dimmed) item.itemStyle = { ...(item.itemStyle ?? {}), opacity: DIM };
      return item;
    });
    const barBorder = borderOn
      ? { borderWidth: f.num("dataPoint", "borderSize", 1), borderColor: f.bool("dataPoint", "borderColorMatchFill", false) ? color : (f.color("dataPoint", "borderColor") ?? theme.foreground) }
      : {};
    const s: O = {
      name: isHighlight ? `${name} (highlighted)` : name,
      type: asLine ? "line" : "bar",
      data,
      itemStyle: { color, ...(asLine ? {} : { opacity: fillAlpha, ...barBorder }) },
      emphasis: { focus: "none" },
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
    if (stacked) s.stack = isHighlight ? "highlight" : "total";
    if (asLine) {
      Object.assign(s, lineSeriesStyle(f, color, hl !== null && !isHighlight));
      if (areaOnly || f.bool("lineStyles", "areaShow", false)) s.areaStyle = { opacity: isHighlight ? 0.85 : hl ? 0.2 : 0.4, color: f.bool("lineStyles", "areaMatchStrokeColor", true) ? undefined : f.color("lineStyles", "areaColor") };
      if (combo && role === "Y2") s.yAxisIndex = 1;
    } else {
      if (hl) s.barGap = "-100%";
      else if (f.has("categoryAxis", "innerPadding")) s.barGap = `${f.num("categoryAxis", "innerPadding", 0)}%`;
      if (f.has("categoryAxis", "outerPadding")) s.barCategoryGap = `${f.num("categoryAxis", "outerPadding", 20)}%`;
    }
    if (isHighlight) {
      s.z = 5;
      s.silent = true;
      s.label = { show: false };
    }
    seriesOut.push(s);
    meta.push({ vi, si });
  };
  valueCols.forEach((_, vi) => p.series.forEach((_s, si) => addSeries(vi, si, false)));
  if (hl) valueCols.forEach((_, vi) => p.series.forEach((_s, si) => addSeries(vi, si, true)));

  if (ribbon) {
    // one custom series per legend entry: a column slot per category and a ribbon to the next category
    seriesOut.length = 0;
    meta.length = 0;
    const layout = ribbonLayout(p.series.map((_s, si) => p.cells[0][si]));
    p.series.forEach((s, si) => {
      const name = hasSeries ? s.label || BLANK_LABEL : valueCols[0].label;
      const color = f.color("dataPoint", "fill", name) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, si);
      const dimmed = p.categories.map((_c, ci) => selecting && !isSelected(ci, si));
      seriesOut.push({
        name,
        type: "custom",
        encode: { x: 0, y: [1, 2] },
        itemStyle: { color },
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
          const children: O[] = [{ type: "rect", shape: { x: lo[0] - half, y: Math.min(lo[1], hi[1]), width: half * 2, height: Math.abs(lo[1] - hi[1]) }, style: { fill: color, opacity: op } }];
          if (api.value(3) !== null && api.value(3) !== undefined && !Number.isNaN(api.value(3))) {
            const nlo = api.coord([ci + 1, api.value(3)]);
            const nhi = api.coord([ci + 1, api.value(4)]);
            children.push({ type: "polygon", shape: { points: [[lo[0] + half, lo[1]], [nlo[0] - half, nlo[1]], [nhi[0] - half, nhi[1]], [hi[0] + half, hi[1]]] }, style: { fill: color, opacity: op * 0.4 } });
          }
          return { type: "group", children };
        },
      });
      meta.push({ vi: 0, si });
    });
  }

  // Analytics: reference lines over the plotted values, and a trend line
  if (!hundred && !ribbon && seriesOut.length > 0) {
    const pooled: (number | null)[] = [];
    valueCols.forEach((c, vi) => c.role === "Y" && p.series.forEach((_s, si) => p.categories.forEach((_c, ci) => pooled.push(shown(vi, si, ci)))));
    const fmtRef = valueCols[0]?.format ?? null;
    const marks: O[] = [];
    for (const k of REFERENCE_KINDS) {
      const sel = `id:${k.kind}`;
      const spec: LineSpec = { object: k.object, id: k.kind };
      // a statistic line is told apart by its type; a stored line of another type is not this one
      if (k.object === "referenceLine" && f.str("referenceLine", "type", "", sel) !== k.name) continue;
      const v = referenceValue(k.kind, pooled, { constant: f.has(k.object, "value", sel) ? f.num(k.object, "value", 0, sel) : undefined, percentile: f.num(k.object, "percentile", 50, sel) });
      const name = k.kind === "percentile" ? `${f.num(k.object, "percentile", 50, sel)}th percentile` : k.name;
      const mark = referenceLineMark(f, theme, spec, v, name, horizontal ? "xAxis" : "yAxis", fmtRef);
      if (mark) marks.push(mark);
    }
    if (marks.length) seriesOut[0].markLine = { silent: true, symbol: "none", animation: false, data: marks };
    if (f.bool("trend", "show", false) && !stacked && valueCols.length > 0 && p.series.length > 0) {
      const tr = linearTrend(p.categories.map((_c, ci) => shown(0, 0, ci)));
      if (tr) {
        const style = f.str("trend", "style", "dashed");
        seriesOut.push({
          name: f.str("trend", "displayName", "") || "Trend line",
          type: "line",
          data: p.categories.map((_c, ci) => ({ value: tr.at(ci), raw: tr.at(ci) })),
          symbol: "none",
          silent: true,
          z: 6,
          lineStyle: { color: f.color("trend", "lineColor") ?? theme.muted, width: f.num("trend", "width", 2), type: style === "custom" ? "dashed" : style, opacity: opacityOf(f.num("trend", "transparency", 0)) },
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
  const y2Cols = columnsOf(q, "Y2", "value");
  const valAxes = combo && y2Cols.length ? [valAxis, { ...axisBlock({ f, theme, object: "valueAxis", prefix: "sec", kind: "value", fmt: y2Cols[0].format, titleDefault: y2Cols.map((c) => c.label).join(", "), horizontal }), splitLine: { show: false } }] : [valAxis];

  const option: O = {
    animation: false,
    textStyle: { fontFamily: theme.textClasses.label.fontFace },
    grid: gridFor(f, f.bool("legend", "show", legendShown)),
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
  if (layout.type === "custom" && (layout.columns || layout.rows)) {
    const columns = layout.columns ? Math.max(1, Math.min(count, Math.round(layout.columns))) : Math.max(1, Math.ceil(count / Math.max(1, Math.round(layout.rows!))));
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
    grids.push({ ...(bg ? { show: true, backgroundColor: rgba(bg, panelAlpha) } : {}), left: `calc(${area(c, columns)} + ${pad + 4}px)`, top, width: `calc(${cellW} - ${pad * 2 + 8}px)`, height: `calc(${cellH} - ${topMargin / rows + headerH + pad * 2}px)`, containLabel: true });
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
        textStyle: echartsText(font, { family: theme.textClasses.label.fontFace, size: theme.textClasses.label.fontSize, color: theme.textClasses.label.color }),
      });
    }
  });
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
  const data = p.categories.map((c, i) => ({
    name: c.label,
    value: values[i] ?? 0,
    itemStyle: {
      color: f.color("dataPoint", "fill", c.label) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, i),
      opacity: ((selKeys.size > 0 && !selKeys.has(JSON.stringify(c.values.map(valueToLit)))) || (hlByKey !== null && (hlByKey.get(c.key) ?? 0) === 0) ? DIM : 1) * sliceAlpha,
    },
  }));
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
  const option: O = {
    animation: false,
    legend: legendBlock(f, theme, true),
    tooltip: { trigger: "item", confine: true, formatter: (pa: O) => `${pa.marker}${pa.name}: <b>${formatNumber(pa.value, vcol?.format ?? null)}</b> (${total ? ((pa.value / total) * 100).toFixed(1) : 0}%)` },
    series: [
      {
        type: "pie",
        radius: donut ? [`${f.num("slices", "innerRadiusRatio", 50)}%`, "72%"] : ["0%", "72%"],
        center: ["50%", "55%"],
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
  return { option, count: data.length, pointAt: (_s, di) => (p.categories[di] ? pointOfCategory(p, di, null) : null) };
}

function funnel(inp: ChartInput): ChartBuild {
  const { visual, theme } = inp;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const { p, vcol, values } = sliceData(inp);
  const data = p.categories.map((c, i) => ({ name: c.label, value: values[i] ?? 0, itemStyle: { color: f.color("dataPoint", "fill", c.label) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, i) } }));
  const first = values[0] ?? 0;
  const fmtStyle = f.str("labels", "funnelLabelStyle", "Data");
  const pctDigits = f.num("labels", "percentageLabelPrecision", 0);
  const font = readFont(f, "labels", { color: "color" });
  const catFont = readFont(f, "categoryAxis", { color: "color" });
  const showCat = f.bool("categoryAxis", "show", true);
  const labelText = (pa: O) => {
    const v = pa.value as number;
    const prev = values[pa.dataIndex - 1] ?? v;
    const val = valueText(v, vcol?.format ?? null, f);
    const pctFirst = first ? `${((v / first) * 100).toFixed(pctDigits)}%` : "";
    const pctPrev = prev ? `${((v / prev) * 100).toFixed(pctDigits)}%` : "";
    const body = fmtStyle === "Percent of first" ? pctFirst : fmtStyle === "Percent of previous" ? pctPrev : fmtStyle === "Data, percent of first" ? `${val} (${pctFirst})` : fmtStyle === "Data, percent of previous" ? `${val} (${pctPrev})` : val;
    return showCat ? `${pa.name}  ${body}` : body;
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
          ...(f.bool("labels", "enableBackground", false) ? { backgroundColor: f.color("labels", "backgroundColor") ?? theme.background, padding: [2, 4] } : {}),
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
          formatter: (pa: O) => [showCat ? pa.name : "", showVal ? valueText(pa.value, vcol?.format ?? null, f) : ""].filter(Boolean).join("\n"),
          ...echartsText({ ...catFont, color: catFont.color ?? valFont.color }, white),
        },
        upperLabel: { show: groups.length > 1 && showCat, height: 18, ...echartsText({ ...catFont, color: catFont.color }, white) },
        itemStyle: { borderColor: theme.background, borderWidth: 1, gapWidth: f.has("layout", "innerPadding") ? f.num("layout", "innerPadding", 1) : 1 },
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
  const axis = (object: "categoryAxis" | "valueAxis", c: typeof xc): O => ({ ...axisBlock({ f, theme, object, kind: "value", fmt: c?.format ?? null, titleDefault: c?.label ?? "", gridDefault: true }), scale: true });
  const option: O = {
    animation: false,
    legend: legendBlock(f, theme, !!ser),
    grid: gridFor(f, f.bool("legend", "show", !!ser)),
    tooltip: { trigger: "item", confine: true, formatter: (pa: O) => `${pa.marker}${pa.data[3] || pa.seriesName}<br/>${xc?.label}: <b>${formatNumber(pa.data[0], xc?.format ?? null)}</b><br/>${yc?.label}: <b>${formatNumber(pa.data[1], yc?.format ?? null)}</b>${sc ? `<br/>${sc.label}: <b>${formatNumber(pa.data[2], sc.format ?? null)}</b>` : ""}` },
    xAxis: axis("categoryAxis", xc),
    yAxis: axis("valueAxis", yc),
    series,
  };
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
export function buildChart(inp: ChartInput): ChartBuild | null {
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
      return inp.visual.visualType === "filledMap" ? filledMap(inp, gaz) : bubbleMap(inp, gaz);
    }
    default:
      return null;
  }
}
