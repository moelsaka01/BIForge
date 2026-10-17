// Builds Apache ECharts options for the chart visuals from query results, format settings and the theme.
// Pure: no DOM, no echarts import. Event handlers map chart events back to data points via `pointAt`.
import type { Value } from "./cells";
import { BLANK_LABEL, columnsOf, labelOf, num as valueNum, pivot, pointOfCategory, valueToLit, type Pivot } from "./chartData";
import { condFormatFromPbir, colorFn } from "./condFormat";
import { REFERENCE_KINDS, linearTrend, referenceValue, ribbonLayout } from "./analytics";
import type { FieldRef } from "./fields";
import { FormatReader } from "./formatReader";
import type { Loaded } from "./dataLoader";
import type { SelectedPoint } from "./interactions";
import { formatCompact, formatNumber, type DisplayUnits } from "./numberFormat";
import { seriesColor, type Theme } from "./theme";
import type { VisualModel } from "./visualDoc";
import { visualType } from "./visualTypes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type O = Record<string, any>;

export interface ChartInput {
  visual: VisualModel;
  loaded: Extract<Loaded, { kind: "grouped" }>;
  theme: Theme;
  /** Points selected in this visual (the others are dimmed). */
  selected: SelectedPoint[];
}

export interface ChartBuild {
  option: O;
  /** The data point behind a chart element, for selection, drilling and tooltips. */
  pointAt(seriesIndex: number, dataIndex: number): SelectedPoint | null;
  /** Number of data points drawn (0: nothing to show). */
  count: number;
}

const DIM = 0.35;

function units(f: FormatReader, object: string): DisplayUnits {
  const u = f.str(object, "displayUnits", "auto");
  return (["auto", "none", "thousands", "millions", "billions", "trillions"].includes(u) ? u : "auto") as DisplayUnits;
}

function valueText(x: number | null, fmt: string | null, f: FormatReader, object = "labels"): string {
  if (x === null) return "";
  const u = units(f, object);
  const dec = f.num(object, "decimalPlaces", u === "none" ? 2 : 1);
  return fmt && u === "none" ? formatNumber(x, fmt) : formatCompact(x, u, dec, fmt);
}

function legendBlock(f: FormatReader, theme: Theme, show: boolean): O {
  const pos = f.str("legend", "position", "Top");
  const horizontal = pos.startsWith("Top") || pos.startsWith("Bottom");
  return {
    show: f.bool("legend", "show", show),
    type: "scroll",
    [pos.startsWith("Bottom") ? "bottom" : pos.startsWith("Left") ? "left" : pos.startsWith("Right") ? "right" : "top"]: 0,
    orient: horizontal ? "horizontal" : "vertical",
    textStyle: { color: f.color("legend", "labelColor") ?? theme.textClasses.label.color, fontSize: f.num("legend", "fontSize", theme.textClasses.label.fontSize), fontFamily: theme.textClasses.label.fontFace },
    icon: "roundRect",
    itemWidth: 10,
    itemHeight: 10,
  };
}

function gridFor(f: FormatReader, legendShown: boolean): O {
  const pos = f.str("legend", "position", "Top");
  const g: O = { left: 8, right: 12, top: 8, bottom: 8, containLabel: true };
  if (legendShown) {
    if (pos.startsWith("Bottom")) g.bottom = 30;
    else if (pos.startsWith("Left")) g.left = 90;
    else if (pos.startsWith("Right")) g.right = 100;
    else g.top = 30;
  }
  return g;
}

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

function cartesian(inp: ChartInput): ChartBuild {
  const { visual, loaded, theme } = inp;
  const q = loaded.query;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const t = visual.visualType;
  const horizontal = /BarChart$/.test(t);
  const hundred = t.startsWith("hundredPercent");
  const stacked = hundred || t === "stackedBarChart" || t === "stackedColumnChart" || t === "stackedAreaChart";
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
  const labelStyle = { color: f.color("labels", "color") ?? theme.textClasses.label.color, fontSize: f.num("labels", "fontSize", theme.textClasses.label.fontSize) };
  const addSeries = (vi: number, si: number, isHighlight: boolean) => {
    const role = valueCols[vi].role;
    const asLine = lineOnly || areaOnly || (combo && role === "Y2");
    const name = hasSeries ? (multiMeasure ? `${p.series[si].label || BLANK_LABEL} · ${valueCols[vi].label}` : p.series[si].label || BLANK_LABEL) : valueCols[vi].label;
    const colorIndex = hasSeries && !multiMeasure ? si : multiMeasure && !hasSeries ? vi : si * valueCols.length + vi;
    const color = f.color("dataPoint", "fill", name) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, colorIndex);
    const cond = !hasSeries || p.series.length === 1 ? pointColors(f, p, valueCols, vi, si) : null;
    const cells = isHighlight ? hl! : p.cells;
    const data = p.categories.map((_, ci) => {
      const v = shown(vi, si, ci, cells);
      const dimmed = (selecting && !isSelected(ci, si)) || (hl !== null && !isHighlight);
      const c = cond?.[ci] ?? color;
      const item: O = { value: v, raw: cells[vi][si][ci] };
      if (!asLine || cond) item.itemStyle = { color: c, opacity: dimmed ? DIM : 1 };
      if (asLine && dimmed) item.itemStyle = { ...(item.itemStyle ?? {}), opacity: DIM };
      return item;
    });
    const s: O = {
      name: isHighlight ? `${name} (highlighted)` : name,
      type: asLine ? "line" : "bar",
      data,
      itemStyle: { color },
      emphasis: { focus: "none" },
      label: { show: labelOn && !isHighlight, position: horizontal ? "right" : "top", ...labelStyle, formatter: (pa: O) => (hundred ? `${Math.round(pa.value ?? 0)}%` : valueText(pa.data?.raw ?? null, valueCols[vi].format, f)) },
    };
    if (stacked) {
      s.stack = isHighlight ? "highlight" : "total";
      if (!asLine) s.label.position = "inside";
    }
    if (asLine) {
      s.symbolSize = f.bool("lineStyles", "showMarker", false) ? 8 : 5;
      s.smooth = f.bool("lineStyles", "smooth", false);
      s.lineStyle = { width: f.num("lineStyles", "strokeWidth", 2), type: f.str("lineStyles", "lineStyle", "solid"), opacity: hl !== null && !isHighlight ? DIM : 1 };
      if (areaOnly) s.areaStyle = { opacity: isHighlight ? 0.85 : hl ? 0.2 : 0.4 };
      if (combo && role === "Y2") s.yAxisIndex = 1;
    } else if (hl) {
      s.barGap = "-100%";
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
      if (!f.bool(k.kind, "show", false)) continue;
      const v = referenceValue(k.kind, pooled, { constant: f.has(k.kind, "value") ? f.num(k.kind, "value", 0) : undefined, percentile: f.num(k.kind, "percentile", 50) });
      if (v === null) continue;
      const color = f.color(k.kind, "lineColor") ?? theme.muted;
      const title = f.str(k.kind, "displayName", "") || (k.kind === "percentileLine" ? `${f.num(k.kind, "percentile", 50)}th percentile` : k.name);
      marks.push({
        name: title,
        [horizontal ? "xAxis" : "yAxis"]: v,
        lineStyle: { color, width: f.num(k.kind, "strokeWidth", 1), type: f.str(k.kind, "style", "dashed"), opacity: 1 - Math.min(100, Math.max(0, f.num(k.kind, "transparency", 0))) / 100 },
        label: { show: f.bool(k.kind, "dataLabelShow", false), formatter: () => `${title}: ${valueText(v, fmtRef, f, "valueAxis")}`, color, position: "insideEndTop" },
      });
    }
    if (marks.length) seriesOut[0].markLine = { silent: true, symbol: "none", animation: false, data: marks };
    if (f.bool("trendLine", "show", false) && !stacked && valueCols.length > 0 && p.series.length > 0) {
      const tr = linearTrend(p.categories.map((_c, ci) => shown(0, 0, ci)));
      if (tr) {
        seriesOut.push({
          name: "Trend line",
          type: "line",
          data: p.categories.map((_c, ci) => ({ value: tr.at(ci), raw: tr.at(ci) })),
          symbol: "none",
          silent: true,
          z: 6,
          lineStyle: { color: f.color("trendLine", "lineColor") ?? theme.muted, width: f.num("trendLine", "strokeWidth", 2), type: f.str("trendLine", "style", "dashed") },
          tooltip: { show: false },
        });
      }
    }
  }

  const catLabels = p.categories.map((c) => c.label);
  const fg = f.color("categoryAxis", "labelColor") ?? theme.textClasses.label.color;
  const axisFont = { color: fg, fontSize: f.num("categoryAxis", "fontSize", theme.textClasses.label.fontSize), fontFamily: theme.textClasses.label.fontFace };
  const catAxis: O = {
    type: "category",
    data: catLabels,
    show: f.bool("categoryAxis", "show", true),
    inverse: horizontal,
    axisLabel: { ...axisFont, hideOverlap: true, width: horizontal ? 110 : 90, overflow: "truncate" },
    axisLine: { lineStyle: { color: theme.muted } },
    axisTick: { show: false },
    boundaryGap: !(lineOnly || areaOnly),
    name: f.bool("categoryAxis", "showAxisTitle", false) ? f.str("categoryAxis", "axisTitle", columnsOf(q, "Category", "group").map((c) => c.label).join(", ")) : undefined,
    nameLocation: "middle",
    nameGap: 28,
  };
  const fmt0 = valueCols[0]?.format ?? null;
  const gridColor = theme.dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)";
  const mkValueAxis = (object: string, fmt: string | null, show: boolean): O => ({
    type: "value",
    show: f.bool(object, "show", show),
    min: f.has(object, "start") ? f.num(object, "start", 0) : hundred ? 0 : undefined,
    max: f.has(object, "end") ? f.num(object, "end", 0) : hundred ? 100 : undefined,
    splitLine: { show: f.bool(object, "gridlineShow", true), lineStyle: { color: gridColor } },
    axisLabel: {
      color: f.color(object, "labelColor") ?? theme.textClasses.label.color,
      fontSize: f.num(object, "fontSize", theme.textClasses.label.fontSize),
      formatter: (v: number) => (hundred ? `${v}%` : valueText(v, fmt, f, object)),
    },
    name: f.bool(object, "showAxisTitle", false) ? f.str(object, "axisTitle", valueCols.map((c) => c.label).join(", ")) : undefined,
    nameLocation: "middle",
    nameGap: 44,
  });
  const valAxis = mkValueAxis("valueAxis", fmt0, true);
  const y2Cols = columnsOf(q, "Y2", "value");
  const valAxes = combo && y2Cols.length ? [valAxis, { ...mkValueAxis("secondaryValueAxis", y2Cols[0].format, true), splitLine: { show: false } }] : [valAxis];

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

// ---- pie, donut, funnel, treemap ---------------------------------------------------------------------

function sliceData(inp: ChartInput) {
  const q = inp.loaded.query;
  const role = inp.visual.visualType === "treemap" ? "Group" : "Category";
  const valueRole = inp.visual.visualType === "treemap" ? "Values" : "Y";
  const p = pivot(inp.loaded.rows, q, role, null, [valueRole]);
  const vcol = columnsOf(q, valueRole, "value")[0];
  return { p, vcol, values: p.cells[0]?.[0] ?? [] };
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
  const style = f.str("labels", "labelStyle", "Category");
  const data = p.categories.map((c, i) => ({
    name: c.label,
    value: values[i] ?? 0,
    itemStyle: {
      color: f.color("dataPoint", "fill", c.label) ?? seriesColor(theme, i),
      opacity: (selKeys.size > 0 && !selKeys.has(JSON.stringify(c.values.map(valueToLit)))) || (hlByKey !== null && (hlByKey.get(c.key) ?? 0) === 0) ? DIM : 1,
    },
  }));
  const text = (pa: O) => {
    const val = valueText(pa.value, vcol?.format ?? null, f);
    const pct = total ? `${((pa.value / total) * 100).toFixed(1)}%` : "";
    switch (style) {
      case "Data value":
        return val;
      case "Percent of total":
        return pct;
      case "Category, data value":
        return `${pa.name}: ${val}`;
      case "Category, percent of total":
        return `${pa.name}: ${pct}`;
      case "Data value, percent of total":
        return `${val} (${pct})`;
      case "All detail labels":
        return `${pa.name}: ${val} (${pct})`;
      default:
        return pa.name;
    }
  };
  const option: O = {
    animation: false,
    legend: legendBlock(f, theme, true),
    tooltip: { trigger: "item", confine: true, formatter: (pa: O) => `${pa.marker}${pa.name}: <b>${formatNumber(pa.value, vcol?.format ?? null)}</b> (${total ? ((pa.value / total) * 100).toFixed(1) : 0}%)` },
    series: [
      {
        type: "pie",
        radius: donut ? [`${f.num("slices", "innerRadiusRatio", 50)}%`, "72%"] : ["0%", "72%"],
        center: ["50%", "55%"],
        data,
        label: { show: f.bool("labels", "show", true), formatter: text, color: f.color("labels", "color") ?? theme.textClasses.label.color, fontSize: f.num("labels", "fontSize", theme.textClasses.label.fontSize) },
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
  const data = p.categories.map((c, i) => ({ name: c.label, value: values[i] ?? 0, itemStyle: { color: f.color("dataPoint", "fill", c.label) ?? seriesColor(theme, i) } }));
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
        label: { show: true, position: "inside", color: "#fff", formatter: (pa: O) => `${pa.name}  ${valueText(pa.value, vcol?.format ?? null, f)}` },
        itemStyle: { borderColor: theme.background, borderWidth: 1 },
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
  const option: O = {
    animation: false,
    tooltip: { confine: true, formatter: (pa: O) => `${pa.name}: <b>${formatNumber(pa.value, vcol?.format ?? null)}</b>` },
    series: [
      {
        type: "treemap",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        data: colored,
        label: { show: true, formatter: "{b}", color: "#fff" },
        upperLabel: { show: groups.length > 1, height: 18, color: "#fff" },
        itemStyle: { borderColor: theme.background, borderWidth: 1, gapWidth: 1 },
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
  const series = list.map((s, si) => ({
    name: s.name,
    type: "scatter",
    itemStyle: { color: f.color("dataPoint", "fill", s.name) ?? seriesColor(theme, si), opacity: 0.85 },
    symbolSize: (d: number[]) => (sc ? 8 + (smax === smin ? 0.5 : (d[2] - smin) / (smax - smin)) * 28 : 10),
    data: s.pts.map((pt) => [valueNum(pt.row[xc?.index ?? 0]), valueNum(pt.row[yc?.index ?? 0]), sc ? (valueNum(pt.row[sc.index]) ?? 0) : 0, cat ? labelOf(pt.row[cat.index], cat.format) : ""]),
  }));
  const axis = (object: string, c: typeof xc): O => ({
    type: "value",
    scale: true,
    name: f.bool(object, "showAxisTitle", true) ? f.str(object, "axisTitle", c?.label ?? "") : undefined,
    nameLocation: "middle",
    nameGap: object === "valueAxis" ? 44 : 28,
    axisLabel: { color: theme.textClasses.label.color, formatter: (v: number) => valueText(v, c?.format ?? null, f, object) },
    splitLine: { show: f.bool(object, "gridlineShow", true), lineStyle: { color: theme.dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)" } },
  });
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
  const names = [...p.categories.map((c) => c.label), "Total"];
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
  base.push(0);
  up.push("-");
  down.push("-");
  total.push(run);
  const common = { type: "bar", stack: "wf", barMaxWidth: 48 };
  const colors = { up: f.color("sentimentColors", "increaseFill") ?? theme.good, down: f.color("sentimentColors", "decreaseFill") ?? theme.bad, total: f.color("sentimentColors", "totalFill") ?? theme.neutral };
  const option: O = {
    animation: false,
    legend: { show: false },
    grid: gridFor(f, false),
    tooltip: { trigger: "axis", confine: true, formatter: (ps: O[]) => `${ps[0].name}<br/>${ps.filter((x) => x.seriesName !== "base" && x.value !== "-").map((x) => `${x.marker}${x.seriesName}: <b>${formatNumber(x.seriesName === "Decrease" ? -x.value : x.value, vcol?.format ?? null)}</b>`).join("<br/>")}` },
    xAxis: { type: "category", data: names, axisLabel: { color: theme.textClasses.label.color, hideOverlap: true, width: 90, overflow: "truncate" } },
    yAxis: { type: "value", axisLabel: { color: theme.textClasses.label.color, formatter: (v: number) => valueText(v, vcol?.format ?? null, f, "valueAxis") }, splitLine: { lineStyle: { color: theme.dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)" } } },
    series: [
      { ...common, name: "base", data: base, itemStyle: { color: "transparent" }, silent: true, tooltip: { show: false } },
      { ...common, name: "Increase", data: up, itemStyle: { color: colors.up }, label: { show: f.bool("labels", "show", false), position: "inside" } },
      { ...common, name: "Decrease", data: down, itemStyle: { color: colors.down } },
      { ...common, name: "Total", data: total, itemStyle: { color: colors.total } },
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
  const target = read("TargetValue") ?? (f.has("target", "target") ? f.num("target", "target", 0) : null);
  const min = read("MinValue") ?? f.num("axis", "min", 0);
  const max = read("MaxValue") ?? f.num("axis", "max", target !== null ? Math.max(target * 2, value ?? 0) : Math.max(100, (value ?? 0) * 1.25));
  const fmt = columnsOf(q, "Y", "value")[0]?.format ?? null;
  const span = max - min || 1;
  const data: O[] = value === null ? [] : [{ value, name: columnsOf(q, "Y", "value")[0]?.label ?? "", itemStyle: { color: seriesColor(theme, 0) } }];
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
        progress: { show: true, width: 16, itemStyle: { color: seriesColor(theme, 0) } },
        axisLine: { lineStyle: { width: 16, color: [[1, theme.dark ? "#444" : "#e5e5e5"]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        splitNumber: 2,
        axisLabel: { distance: 16, fontSize: 10, color: theme.textClasses.label.color, formatter: (v: number) => formatCompact(v, "auto", 1, fmt) },
        detail: { valueAnimation: false, fontSize: theme.textClasses.callout.fontSize * 0.8, color: theme.textClasses.callout.color, offsetCenter: [0, "20%"], formatter: (v: number) => valueText(v, fmt, f) },
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
              detail: { show: false },
              title: { show: false },
              pointer: { show: true, length: "16%", width: 4, offsetCenter: [0, "-74%"], itemStyle: { color: theme.foreground } },
              silent: true,
              data: [{ value: Math.min(max, Math.max(min, target)), name: "Target" }],
            },
          ]
        : []),
    ],
  };
  void span;
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
    default:
      return null;
  }
}
