// Text for the column quality / distribution / profile of the Power Query editor. Pure, so it is unit tested.
import type { ColumnProfile } from "./types";

/** A share as a whole percent ("98%"); "0%" when there are no rows. A non-zero share never rounds down to "0%". */
export function pct(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const p = (part / whole) * 100;
  return `${p < 1 ? "<1" : Math.round(p)}%`;
}

export interface QualityBar {
  valid: number;
  error: number;
  empty: number;
  /** Widths in percent of the bar (they add up to 100 when there are rows). */
  validWidth: number;
  errorWidth: number;
  emptyWidth: number;
}

export function qualityOf(p: ColumnProfile): QualityBar {
  const w = (n: number) => (p.rows > 0 ? (n / p.rows) * 100 : 0);
  return { valid: p.valid, error: p.error, empty: p.empty, validWidth: w(p.valid), errorWidth: w(p.error), emptyWidth: w(p.empty) };
}

export const qualityLabel = (p: ColumnProfile): string => `Valid ${pct(p.valid, p.rows)}, Error ${pct(p.error, p.rows)}, Empty ${pct(p.empty, p.rows)}`;

export const distributionLabel = (p: ColumnProfile): string => `${p.distinct.toLocaleString("en-US")} distinct, ${p.unique.toLocaleString("en-US")} unique`;

const fmtNum = (n: number): string => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 6 }));

/** The statistics table of a column profile: label and value pairs; numeric statistics only for numeric columns. */
export function statsOf(p: ColumnProfile): [string, string][] {
  const rows: [string, string][] = [
    ["Count", fmtNum(p.rows)],
    ["Error", fmtNum(p.error)],
    ["Empty", fmtNum(p.empty)],
    ["Distinct", fmtNum(p.distinct)],
    ["Unique", fmtNum(p.unique)],
  ];
  if (p.min !== null) rows.push(["Min", p.min]);
  if (p.max !== null) rows.push(["Max", p.max]);
  if (p.average !== null) rows.push(["Average", fmtNum(p.average)]);
  if (p.stdDev !== null) rows.push(["Standard deviation", fmtNum(p.stdDev)]);
  return rows;
}

/** The bar lengths (0..1) of a distribution: relative to the most frequent value. */
export function distributionBars(p: ColumnProfile): { label: string; count: number; width: number }[] {
  const max = Math.max(1, ...p.top.map(([, n]) => n));
  return p.top.map(([v, n]) => ({ label: v === null ? "null" : v === "" ? "(empty)" : v, count: n, width: n / max }));
}

/** What the profile is based on, as the status line says it. */
export const basisLabel = (p: ColumnProfile | undefined, all: boolean): string => (all ? "Column profiling based on entire data set" : `Column profiling based on top 1000 rows${p && !p.rowsLimited ? " (all rows are shown)" : ""}`);
