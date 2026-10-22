// Models for the DOM-rendered visuals (table, matrix, card, KPI): arranged cells and display text. Pure.
import { isNumeric, valueKey, type Value } from "./cells";
import { BLANK_LABEL, columnsOf, labelOf, num } from "./chartData";
import { seriesColor } from "./theme";
import { colorFn, condFormatFromPbir, textOn } from "./condFormat";
import type { Loaded } from "./dataLoader";
import { fieldKey, type FieldRef } from "./fields";
import { FormatReader } from "./formatReader";
import { formatCompact, formatNumber } from "./numberFormat";
import { unitsOf, valueText } from "./chartFormat";
import { cssFont, readFont, withDefaults } from "../format/styles";
import { tableStyle, type TableStyle } from "./tableStyle";
import type { CSSProperties } from "react";
import { queryRefOf, readLitProp, type J } from "./pbir";
import type { BuiltMatrixQuery, PlannedColumn } from "./queryBuilder";
import type { Theme } from "./theme";
import type { VisualModel } from "./visualDoc";

export function displayValue(v: Value, col: { format: string | null; field: FieldRef }, f?: FormatReader): string {
  if (v.kind === "blank") return "";
  if (isNumeric(v) && v.num !== null) {
    if (!f) return formatNumber(v.num, col.format);
    const sel = queryRefOf(col.field);
    // tables show full numbers unless the column asks for display units
    const u = f.num("columnFormatting", "labelDisplayUnits", 1, sel) === 1 ? "none" : unitsOf(f, "columnFormatting", "labelDisplayUnits", sel);
    return u === "none" || u === "auto" ? formatNumber(v.num, col.format) : formatCompact(v.num, u, f.num("columnFormatting", "labelPrecision", 1, sel), col.format);
  }
  return v.text;
}

export interface CellStyle {
  background?: string;
  color?: string;
  /** 0..1 width of a data bar behind a numeric cell, and its color. */
  bar?: { ratio: number; color: string; negative: boolean };
}

/** The color of a fill node ({ solid: { color: <literal> } }), or undefined. */
function fillOf(node: unknown): string | undefined {
  const l = readLitProp(node as J);
  return l && l.t === "string" ? l.v : undefined;
}

/** Formatting of one column from its `values` and `columnFormatting` entries (selector = the column's query reference). */
function columnStyler(f: FormatReader, col: PlannedColumn, numbers: (number | null)[]): (v: Value) => CellStyle {
  const sel = queryRefOf(col.field);
  const bg = f.raw("values", "backColor", sel);
  const fg = f.raw("values", "fontColor", sel);
  const bgSpec = bg ? condFormatFromPbir(bg) : null;
  const fgSpec = fg ? condFormatFromPbir(fg) : null;
  const bgFn = bgSpec ? colorFn(bgSpec, numbers) : null;
  const fgFn = fgSpec ? colorFn(fgSpec, numbers) : null;
  const plainBg = f.color("values", "backColor", sel) ?? f.color("columnFormatting", "backColor", sel);
  const plainFg = f.color("values", "fontColor", sel) ?? f.color("columnFormatting", "fontColor", sel);
  const barsNode = f.raw("columnFormatting", "dataBars", sel);
  const bars = barsNode !== undefined;
  const nums = numbers.filter((x): x is number => x !== null);
  const maxAbs = nums.length ? Math.max(...nums.map(Math.abs)) : 0;
  const barColor = (barsNode && fillOf(barsNode.positiveColor)) || "#6aa9e9";
  return (v) => {
    const s: CellStyle = {};
    const key: number | string | null = isNumeric(v) ? v.num : v.kind === "blank" ? null : v.text;
    const b = bgFn?.(key) ?? (bgSpec ? null : plainBg);
    if (b) {
      s.background = b;
      s.color = textOn(b);
    }
    const c = fgFn?.(key) ?? (fgSpec ? null : plainFg);
    if (c) s.color = c;
    if (bars && isNumeric(v) && v.num !== null && maxAbs > 0) s.bar = { ratio: Math.abs(v.num) / maxAbs, color: barColor, negative: v.num < 0 };
    return s;
  };
}

// ---- table ---------------------------------------------------------------------------------------------

export interface TableColumn {
  label: string;
  field: FieldRef;
  align: "left" | "right" | "center";
  isValue: boolean;
  /** Sort state of this column (from the visual's sort definition). */
  sort: "asc" | "desc" | null;
}

export interface TableModel {
  style: TableStyle;
  columns: TableColumn[];
  rows: { text: string; style: CellStyle; raw: Value }[][];
  totals: string[] | null;
  truncated: boolean;
}

export function buildTable(visual: VisualModel, loaded: Extract<Loaded, { kind: "grouped" }>, theme: Theme, totals: Value[] | null): TableModel {
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const q = loaded.query;
  // display order = the order of the fields in the well
  const fields = visual.roles.Values ?? [];
  const cols: { pf: (typeof fields)[number]; pc: PlannedColumn }[] = [];
  for (const [i, pf] of fields.entries()) {
    const pc = q.columns.find((c) => c.role === "Values" && c.order === i && c.kind !== "helper");
    if (pc) cols.push({ pf, pc });
  }
  const sortKey = visual.sort ? fieldKey(visual.sort.field) : null;
  const columns: TableColumn[] = cols.map(({ pf, pc }) => ({
    label: pf.displayName ?? pc.label,
    field: pc.field,
    align: alignOf(f, pc),
    isValue: pc.kind === "value",
    sort: sortKey && sortKey === fieldKey(pc.field) ? visual.sort!.dir : null,
  }));
  const stylers = cols.map(({ pc }) => columnStyler(f, pc, loaded.rows.map((r) => num(r[pc.index]))));
  // alternate rows: the second, fourth, ... row use the secondary colors of the values card (unless a rule colored the cell)
  const altBg = f.color("values", "backColorSecondary");
  const altFg = f.color("values", "fontColorSecondary");
  const rows = loaded.rows.map((row, r) =>
    cols.map(({ pc }, i) => {
      const v = row[pc.index];
      const style = stylers[i](v);
      if (r % 2 === 1) {
        if (altBg && !style.background) {
          style.background = altBg;
          if (!style.color) style.color = textOn(altBg);
        }
        if (altFg && !style.bar) style.color = style.background && f.color("values", "fontColor", queryRefOf(pc.field)) ? style.color : altFg;
      }
      return { text: displayValue(v, pc, f), style, raw: v };
    }),
  );
  const style = tableStyle(f, theme);
  const tot = totals && f.bool("total", "totals", true) ? cols.map(({ pc }) => (pc.kind === "value" ? displayValue(totals[valueIndex(q.columns, pc)], pc, f) : "")) : null;
  if (tot && tot.length) tot[0] = tot[0] || style.totalLabel;
  return { style, columns, rows, totals: tot, truncated: loaded.truncated };
}

/** Column alignment: the column's own setting (columnFormatting.alignment), else numbers right and text left. */
function alignOf(f: FormatReader, pc: PlannedColumn): "left" | "right" | "center" {
  const a = f.str("columnFormatting", "alignment", "Auto", queryRefOf(pc.field));
  return a === "Left" ? "left" : a === "Right" ? "right" : a === "Center" ? "center" : pc.kind === "value" ? "right" : "left";
}

/** Position of a value column among the value columns (the totals query returns only values). */
function valueIndex(all: PlannedColumn[], pc: PlannedColumn): number {
  return all.filter((c) => c.kind === "value").findIndex((c) => c.index === pc.index);
}

// ---- matrix --------------------------------------------------------------------------------------------

export interface MatrixHeaderCell {
  text: string;
  span: number;
}

export interface MatrixRow {
  key: string;
  depth: number;
  label: string;
  /** True when the row has children and can be expanded or collapsed. */
  expandable: boolean;
  expanded: boolean;
  cells: { text: string; style: CellStyle }[];
  total: { text: string; style: CellStyle }[];
  /** Row-field values leading to this row (for selection). */
  path: Value[];
  isGrand?: boolean;
}

export interface MatrixModel {
  style: TableStyle;
  rowHeader: string;
  /** Header rows above the data: one per column field, then one for the value names when there are several. */
  headers: MatrixHeaderCell[][];
  rows: MatrixRow[];
  valueCount: number;
  showRowTotals: boolean;
  /** Labels of the row total columns, one per value. */
  totalLabels: string[];
}

interface PartIndex {
  /** key of (row values + column values) -> values */
  map: Map<string, Value[]>;
}

export function buildMatrix(visual: VisualModel, parts: Value[][][], q: BuiltMatrixQuery, theme: Theme, collapsed: Set<string>): MatrixModel {
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const R = q.rows.length;
  const C = q.cols.length;
  const V = q.values.length;
  const idx = new Map<string, PartIndex>();
  const partOf = (rd: number, cd: number) => q.parts.findIndex((p) => p.rowDepth === rd && p.colDepth === cd);
  q.parts.forEach((p, i) => {
    const gcols = p.columns.filter((c) => c.kind === "group");
    const vcols = p.columns.filter((c) => c.kind === "value");
    const map = new Map<string, Value[]>();
    for (const row of parts[i] ?? []) map.set(gcols.map((c) => valueKey(row[c.index])).join("\u0001"), vcols.map((c) => row[c.index]));
    idx.set(`${p.rowDepth},${p.colDepth}`, { map });
  });
  const cell = (rd: number, cd: number, rowVals: Value[], colVals: Value[]): Value[] | undefined => idx.get(`${rd},${cd}`)?.map.get([...rowVals.slice(0, rd), ...colVals.slice(0, cd)].map(valueKey).join("\u0001"));

  // distinct row paths (from the leaf-by-nothing part) and column paths
  const rowLeaf = partOf(R, 0) >= 0 ? partOf(R, 0) : partOf(R, C);
  const colLeaf = partOf(0, C) >= 0 ? partOf(0, C) : -1;
  const rowCols = q.parts[rowLeaf]?.columns.filter((c) => c.role === "Rows" && c.kind === "group") ?? [];
  const colCols = colLeaf >= 0 ? q.parts[colLeaf].columns.filter((c) => c.role === "Columns" && c.kind === "group") : [];
  const rowPaths: Value[][] = R ? (parts[rowLeaf] ?? []).map((r) => rowCols.map((c) => r[c.index])) : [[]];
  const colPaths: Value[][] = C && colLeaf >= 0 ? (parts[colLeaf] ?? []).map((r) => colCols.map((c) => r[c.index])) : [[]];

  const valueCols = q.parts[partOf(R, C) >= 0 ? partOf(R, C) : rowLeaf]?.columns.filter((c) => c.kind === "value") ?? [];
  const fmtOf = (vi: number) => valueCols[vi] ?? { format: null, field: q.values[vi] };
  const labelFor = (vi: number) => visual.roles.Values?.[vi]?.displayName ?? valueCols[vi]?.label ?? "";

  // styling by column of values (all numbers of that value across the leaf cells)
  const allNums: (number | null)[][] = Array.from({ length: V }, () => []);
  for (const rp of rowPaths) for (const cp of colPaths) cell(R, C, rp, cp)?.forEach((v, vi) => allNums[vi].push(num(v)));
  const stylers = valueCols.map((pc, vi) => columnStyler(f, pc, allNums[vi]));

  const mk = (vals: Value[] | undefined, vi: number) => {
    const v = vals?.[vi];
    return v ? { text: displayValue(v, fmtOf(vi), f), style: stylers[vi]?.(v) ?? {} } : { text: "", style: {} };
  };

  // headers
  const headers: MatrixHeaderCell[][] = [];
  for (let level = 0; level < C; level++) {
    const row: MatrixHeaderCell[] = [];
    let i = 0;
    while (i < colPaths.length) {
      let j = i + 1;
      while (j < colPaths.length && colPaths.slice(i, j + 1).every((p) => p.slice(0, level + 1).map(valueKey).join() === colPaths[i].slice(0, level + 1).map(valueKey).join())) j++;
      row.push({ text: labelOf(colPaths[i][level], colCols[level].format), span: (j - i) * Math.max(1, V) });
      i = j;
    }
    headers.push(row);
  }
  if (V > 1 || C === 0) headers.push(colPaths.flatMap(() => Array.from({ length: V }, (_, vi) => ({ text: labelFor(vi), span: 1 }))));

  // rows (stepped layout; collapsed parents hide their children)
  const rows: MatrixRow[] = [];
  const seen = new Set<string>();
  const addRow = (path: Value[], depth: number) => {
    const key = path.slice(0, depth + 1).map(valueKey).join("\u0001");
    if (seen.has(key)) return;
    seen.add(key);
    const expandable = depth < R - 1;
    const isCollapsed = collapsed.has(key);
    rows.push({
      key,
      depth,
      label: labelOf(path[depth], rowCols[depth]?.format),
      expandable,
      expanded: expandable && !isCollapsed,
      path: path.slice(0, depth + 1),
      cells: colPaths.flatMap((cp) => Array.from({ length: V }, (_, vi) => mk(cell(depth + 1, C, path, cp), vi))),
      total: Array.from({ length: V }, (_, vi) => mk(cell(depth + 1, 0, path, []), vi)),
    });
  };
  if (R === 0) {
    rows.push({
      key: "",
      depth: 0,
      label: "",
      expandable: false,
      expanded: false,
      path: [],
      cells: colPaths.flatMap((cp) => Array.from({ length: V }, (_, vi) => mk(cell(0, C, [], cp), vi))),
      total: Array.from({ length: V }, (_, vi) => mk(cell(0, 0, [], []), vi)),
    });
  } else {
    for (const path of rowPaths) {
      for (let d = 0; d < R; d++) {
        const parentKey = (k: number) => path.slice(0, k + 1).map(valueKey).join("\u0001");
        if (d > 0 && Array.from({ length: d }, (_, k) => k).some((k) => collapsed.has(parentKey(k)))) break;
        addRow(path, d);
      }
    }
  }
  // grand total row
  if (R > 0 && V > 0 && f.bool("rowTotals", "show", true)) {
    rows.push({
      key: "\u0000grand",
      depth: 0,
      label: "Total",
      expandable: false,
      expanded: false,
      path: [],
      isGrand: true,
      cells: colPaths.flatMap((cp) => Array.from({ length: V }, (_, vi) => mk(cell(0, C, [], cp), vi))),
      total: Array.from({ length: V }, (_, vi) => mk(cell(0, 0, [], []), vi)),
    });
  }
  return {
    style: tableStyle(f, theme),
    rowHeader: q.rows.map((r) => r.name).join(" / "),
    headers,
    rows,
    valueCount: V,
    showRowTotals: C > 0 && V > 0 && f.bool("columnTotals", "show", true),
    totalLabels: Array.from({ length: V }, (_, vi) => (V > 1 ? `Total ${labelFor(vi)}` : "Total")),
  };
}

// ---- cards and KPI -----------------------------------------------------------------------------------------

export interface CardModel {
  label: string;
  text: string;
  color?: string;
  fontSize: number;
  showLabel: boolean;
  /** Font of the value and of the category label under it. */
  valueStyle: CSSProperties;
  labelStyle: CSSProperties;
}

export function buildCard(visual: VisualModel, loaded: Extract<Loaded, { kind: "grouped" }>, theme: Theme): CardModel {
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const col = loaded.query.columns.find((c) => c.role === "Values" && c.kind === "value");
  const v = col ? loaded.rows[0]?.[col.index] : undefined;
  const text = v ? (v.kind === "blank" ? BLANK_LABEL : isNumeric(v) && v.num !== null ? formatCompact2(v.num, f, col!.format) : v.text) : "";
  const raw = f.raw("labels", "color");
  const spec = raw ? condFormatFromPbir(raw) : null;
  const color = spec && v ? (colorFn(spec, [v.num ?? null])(isNumeric(v) ? v.num : v.text) ?? undefined) : f.color("labels", "color");
  const co = theme.textClasses.callout;
  const font = readFont(f, "labels", { color: "color" });
  const lb = theme.textClasses.label;
  return {
    label: visual.roles.Values?.[0]?.displayName ?? col?.label ?? "",
    text: v?.kind === "blank" ? "" : text,
    color,
    fontSize: f.num("labels", "fontSize", co.fontSize),
    showLabel: f.bool("categoryLabels", "show", true),
    valueStyle: cssFont({ ...font, color }, { family: co.fontFace, size: co.fontSize, color: co.color }),
    labelStyle: cssFont(readFont(f, "categoryLabels", { color: "color" }), { family: lb.fontFace, size: lb.fontSize + 1, color: theme.muted }),
  };
}

function formatCompact2(x: number, f: FormatReader, fmt: string | null): string {
  return valueText(x, fmt, f, "labels");
}

export interface MultiRowCardModel {
  cards: { title: string; items: { label: string; text: string }[] }[];
  /** First item of a card (the title line), the other values, and their captions. */
  titleStyle: CSSProperties;
  valueStyle: CSSProperties;
  captionStyle: CSSProperties;
  showCaptions: boolean;
  /** One card: padding, background, outline and the accent bar. */
  cardStyle: CSSProperties;
  bar: { color: string; weight: number } | null;
}

export function buildMultiRowCard(visual: VisualModel, loaded: Extract<Loaded, { kind: "grouped" }>, theme: Theme): MultiRowCardModel {
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const q = loaded.query;
  const fields = visual.roles.Values ?? [];
  const cols = fields.map((pf, i) => ({ pf, pc: q.columns.find((c) => c.role === "Values" && c.order === i && c.kind !== "helper")! })).filter((x) => x.pc);
  const cards = loaded.rows.map((row) => ({
    title: "",
    items: cols.map(({ pf, pc }) => ({ label: pf.displayName ?? pc.label, text: displayValue(row[pc.index], pc, f) })),
  }));
  const lb = theme.textClasses.label;
  const outlineW = f.num("card", "outlineWeight", 0);
  const barOn = f.bool("card", "barShow", false);
  return {
    cards,
    titleStyle: cssFont(readFont(f, "cardTitle", { color: "color" }), { family: lb.fontFace, size: 14, color: theme.foreground }),
    valueStyle: cssFont(readFont(f, "dataLabels", { color: "color" }), { family: lb.fontFace, size: 12, color: theme.foreground }),
    captionStyle: cssFont(readFont(f, "categoryLabels", { color: "color" }), { family: lb.fontFace, size: 10, color: theme.muted }),
    showCaptions: f.bool("categoryLabels", "show", true),
    cardStyle: {
      padding: f.num("card", "cardPadding", 0),
      background: f.color("card", "cardBackground"),
      ...(outlineW ? { border: `${outlineW}px solid ${f.color("card", "outlineColor") ?? theme.muted}` } : {}),
    },
    bar: barOn ? { color: f.color("card", "barColor") ?? seriesColor(theme, 0), weight: f.num("card", "barWeight", 4) } : null,
  };
}

export interface KpiModel {
  value: string;
  goal: string | null;
  /** (value - goal) / goal, or null without a goal. */
  variance: number | null;
  varianceText: string | null;
  status: "good" | "bad" | "neutral";
  trend: { x: string; y: number | null }[];
  label: string;
  valueStyle: CSSProperties;
  goalStyle: CSSProperties;
  goalText: string;
  showGoal: boolean;
  showDistance: boolean;
  /** Colors for the three states and whether the trend area shows (with its transparency, percent). */
  colors: { good: string; bad: string; neutral: string };
  showTrend: boolean;
  trendTransparency: number;
  showIcon: boolean;
  align: CSSProperties["textAlign"];
}

export function buildKpi(visual: VisualModel, loaded: Extract<Loaded, { kind: "grouped" }>, theme: Theme): KpiModel {
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const q = loaded.query;
  const ind = columnsOf(q, "Indicator", "value")[0];
  const goal = columnsOf(q, "Goal", "value")[0];
  const axis = columnsOf(q, "TrendLine", "group")[0];
  // the indicator is the value at the last point of the trend axis (or the only row)
  const rows = loaded.rows;
  const last = rows.length ? rows[rows.length - 1] : undefined;
  const v = last && ind ? num(last[ind.index]) : null;
  const g = last && goal ? num(last[goal.index]) : null;
  const variance = v !== null && g !== null && g !== 0 ? (v - g) / Math.abs(g) : null;
  // status direction: "High is good" / "Low is good" (goals.direction)
  const higherIsBetter = f.str("goals", "direction", "High is good") !== "Low is good";
  const status = variance === null ? "neutral" : (variance >= 0) === higherIsBetter ? "good" : "bad";
  const co = theme.textClasses.callout;
  const lb = theme.textClasses.label;
  const pct = f.has("goals", "labelPrecision") ? f.num("goals", "labelPrecision", 1) : 1;
  const goalFont = readFont(f, "goals", { color: "goalFontColor" });
  const indFont = readFont(f, "indicator", { color: "fontColor" });
  const units = unitsOf(f, "indicator", "indicatorDisplayUnits");
  const prec = f.has("indicator", "indicatorPrecision") ? f.num("indicator", "indicatorPrecision", 1) : 1;
  return {
    value: v === null ? "" : formatCompact(v, units, prec, ind?.format ?? null),
    goal: g === null ? null : formatCompact(g, "auto", 1, goal?.format ?? null),
    variance,
    varianceText: variance === null ? null : `${variance >= 0 ? "+" : ""}${(variance * 100).toFixed(pct)}%`,
    status,
    trend: axis && ind ? rows.map((r) => ({ x: labelOf(r[axis.index], axis.format), y: num(r[ind.index]) })) : [],
    label: visual.roles.Indicator?.[0]?.displayName ?? ind?.label ?? "",
    valueStyle: cssFont(indFont, { family: co.fontFace, size: co.fontSize, color: theme.foreground }),
    goalStyle: cssFont({ ...goalFont, color: undefined }, { family: lb.fontFace, size: 12, color: theme.foreground }),
    goalText: f.str("goals", "goalText", "Goal"),
    showGoal: f.bool("goals", "showGoal", true),
    showDistance: f.bool("goals", "showDistance", true),
    colors: { good: f.color("status", "goodColor") ?? theme.good, bad: f.color("status", "badColor") ?? theme.bad, neutral: f.color("status", "neutralColor") ?? theme.neutral },
    showTrend: f.bool("trendline", "show", true),
    trendTransparency: f.num("trendline", "transparency", 75),
    showIcon: f.bool("indicator", "showIcon", false),
    align: (f.str("indicator", "horizontalAlignment", "left") as CSSProperties["textAlign"]) ?? "left",
  };
}
