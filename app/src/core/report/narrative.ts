// Smart narrative: a plain-language summary written from the fields of the visual (a Category and one or more Values).
// It is a template, not an AI: the sentences are fixed and the numbers come from the query result. Pure.
import type { CSSProperties } from "react";
import { cssFont, readFont } from "../format/styles";
import { isNumeric } from "./cells";
import { columnsOf, labelOf } from "./chartData";
import type { Loaded } from "./dataLoader";
import { FormatReader } from "./formatReader";
import { formatNumber } from "./numberFormat";
import type { Theme } from "./theme";
import type { VisualModel } from "./visualDoc";

/** A piece of a sentence; `strong` marks a number or a name taken from the data. */
export interface Seg {
  text: string;
  strong?: boolean;
}

export interface NarrativeModel {
  sentences: Seg[][];
  style: CSSProperties;
  align: "left" | "center" | "right";
}

const s = (text: string): Seg => ({ text });
const b = (text: string): Seg => ({ text, strong: true });

/** Sentences for one measure over the categories (already in the order of the result). */
export function describeMeasure(label: string, catLabel: string, cats: string[], vals: (number | null)[], fmt: (x: number) => string, isDate: boolean): Seg[][] {
  const rows = cats.map((c, i) => ({ c, v: vals[i] })).filter((r): r is { c: string; v: number } => r.v !== null && Number.isFinite(r.v));
  if (rows.length === 0) return [[s(`There is no value of `), b(label), s(".")]];
  if (rows.length === 1) return [[b(label), s(" is "), b(fmt(rows[0].v)), ...(catLabel ? [s(" for "), b(rows[0].c)] : []), s(".")]];
  const out: Seg[][] = [];
  const hi = rows.reduce((a, r) => (r.v > a.v ? r : a));
  const lo = rows.reduce((a, r) => (r.v < a.v ? r : a));
  const total = rows.reduce((t, r) => t + r.v, 0);
  out.push([b(hi.c), s(" has the highest "), b(label), s(" ("), b(fmt(hi.v)), s(")"), ...(total > 0 && rows.every((r) => r.v >= 0) ? [s(", "), b(`${Math.round((hi.v / total) * 100)}%`), s(" of the total")] : []), s(".")]);
  if (hi.c !== lo.c) out.push([b(lo.c), s(" has the lowest ("), b(fmt(lo.v)), s(").")]);
  if (isDate) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const change = first.v !== 0 ? (last.v - first.v) / Math.abs(first.v) : null;
    out.push([b(label), s(" went from "), b(fmt(first.v)), s(" in "), b(first.c), s(" to "), b(fmt(last.v)), s(" in "), b(last.c), ...(change === null ? [] : [s(" ("), b(`${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`), s(")")]), s(".")]);
  } else {
    out.push([s("Across "), b(String(rows.length)), s(` ${catLabel ? catLabel.toLowerCase() : "items"}, the average ${label} is `), b(fmt(total / rows.length)), s(".")]);
  }
  return out;
}

export function buildNarrative(visual: VisualModel, loaded: Extract<Loaded, { kind: "grouped" }>, theme: Theme): NarrativeModel {
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const q = loaded.query;
  const cat = columnsOf(q, "Category", "group")[0];
  const values = columnsOf(q, "Values", "value");
  const sentences: Seg[][] = [];
  const catLabel = cat?.label ?? "";
  const cats = cat ? loaded.rows.map((r) => labelOf(r[cat.index], cat.format)) : loaded.rows.map(() => "");
  const isDate = !!cat && loaded.rows.length > 0 && loaded.rows[0][cat.index]?.kind === "datetime";
  for (const col of values) {
    const vals = loaded.rows.map((r) => {
      const v = r[col.index];
      return v && isNumeric(v) ? v.num : null;
    });
    sentences.push(...describeMeasure(col.label, catLabel, cats, vals, (x) => formatNumber(x, col.format), isDate));
  }
  if (sentences.length === 0) sentences.push([s("Add a field to the Values well to get a summary.")]);
  const tx = theme.textClasses.label;
  const a = f.str("text", "textAlignment", "Auto");
  const align = a === "Center" ? "center" : a === "Right" ? "right" : "left";
  return {
    sentences,
    style: { ...cssFont(readFont(f, "text", { color: "fontColor" }), { family: tx.fontFace, size: f.num("text", "fontSize", tx.fontSize + 3), color: theme.foreground }), textAlign: align },
    align,
  };
}
