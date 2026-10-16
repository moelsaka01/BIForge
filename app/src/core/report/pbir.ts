// Encoding of fields, literals and formatting values in the PBIR JSON shape (public JSON schemas:
// semanticQuery 1.4, visualContainer 2.x). Pure functions.
import type { AggFn, FieldRef, Lit } from "./fields";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type J = any;

// ---- literals -----------------------------------------------------------------------------

export function encodeLit(l: Lit): string {
  switch (l.t) {
    case "string":
      return `'${l.v.replace(/'/g, "''")}'`;
    case "number":
      return Number.isInteger(l.v) ? `${l.v}L` : `${l.v}D`;
    case "bool":
      return l.v ? "true" : "false";
    case "date":
      return `datetime'${l.v.includes("T") ? l.v : `${l.v}T00:00:00`}'`;
    case "null":
      return "null";
  }
}

export function decodeLit(s: string): Lit | null {
  if (s === "null") return { t: "null" };
  if (s === "true" || s === "false") return { t: "bool", v: s === "true" };
  let m = /^datetime'(.*)'$/.exec(s);
  if (m) return { t: "date", v: m[1] };
  m = /^'(.*)'$/s.exec(s);
  if (m) return { t: "string", v: m[1].replace(/''/g, "'") };
  m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[LDM]?$/.exec(s);
  if (m) return { t: "number", v: Number(m[1]) };
  return null;
}

/** `{expr: {Literal: {Value: ...}}}` as used by formatting properties. */
export const litExpr = (l: Lit): J => ({ expr: { Literal: { Value: encodeLit(l) } } });

/** Reads a formatting property written by {@link litExpr}; plain solid-color objects are unwrapped too. */
export function readLitProp(p: J): Lit | null {
  const v = p?.expr?.Literal?.Value;
  if (typeof v === "string") return decodeLit(v);
  const c = p?.solid?.color?.expr?.Literal?.Value;
  if (typeof c === "string") return decodeLit(c);
  return null;
}

// ---- fields -------------------------------------------------------------------------------

/** How a source (table) is referenced: by entity name in visuals, by alias in filter definitions. */
export type SourceStyle = { entity: true } | { alias: Record<string, string> };

function sourceRef(table: string, style: SourceStyle): J {
  return "entity" in style ? { SourceRef: { Entity: table } } : { SourceRef: { Source: style.alias[table] ?? table } };
}

export function fieldToPbir(f: FieldRef, style: SourceStyle = { entity: true }): J {
  const base = { Expression: sourceRef(f.table, style), Property: f.name };
  switch (f.kind) {
    case "column":
      return { Column: base };
    case "measure":
      return { Measure: base };
    case "agg":
      return { Aggregation: { Expression: { Column: base }, Function: f.fn } };
  }
}

function sourceOf(ref: J, aliases?: Record<string, string>): string | null {
  const sr = ref?.SourceRef;
  if (!sr) return null;
  if (typeof sr.Entity === "string") return sr.Entity;
  if (typeof sr.Source === "string") return aliases?.[sr.Source] ?? sr.Source;
  return null;
}

export function fieldFromPbir(j: J, aliases?: Record<string, string>): FieldRef | null {
  if (!j || typeof j !== "object") return null;
  if (j.Column || j.Measure) {
    const k = j.Column ? "Column" : "Measure";
    const table = sourceOf(j[k].Expression, aliases);
    if (table === null || typeof j[k].Property !== "string") return null;
    return { kind: k === "Column" ? "column" : "measure", table, name: j[k].Property };
  }
  if (j.Aggregation) {
    const inner = fieldFromPbir(j.Aggregation.Expression, aliases);
    const fn = j.Aggregation.Function;
    if (!inner || inner.kind !== "column" || !Number.isInteger(fn) || fn < 0 || fn > 8) return null;
    return { kind: "agg", table: inner.table, name: inner.name, fn: fn as AggFn };
  }
  return null;
}

/** `Table.Name` reference text that PBIR uses in `queryRef` (for aggregates: `Sum(Table.Name)`). */
export function queryRefOf(f: FieldRef): string {
  if (f.kind !== "agg") return `${f.table}.${f.name}`;
  const label = ["Sum", "Average", "DistinctCount", "Min", "Max", "Count", "Median", "StandardDeviation", "Variance"][f.fn];
  return `${label}(${f.table}.${f.name})`;
}
