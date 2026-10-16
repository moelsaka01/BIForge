// Field references used by visuals, filters and slicers, and their DAX text. Pure functions.
import { columnRef, quoteBracket, quoteTable } from "../dax/measureQuery";

/** Numeric codes follow the public PBIR schema (semanticQuery, QueryAggregateFunction). */
export type AggFn = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const AGG_LABELS: Record<AggFn, string> = {
  0: "Sum",
  1: "Average",
  2: "Count (Distinct)",
  3: "Minimum",
  4: "Maximum",
  5: "Count",
  6: "Median",
  7: "Standard deviation",
  8: "Variance",
};

const AGG_DAX: Record<AggFn, string> = {
  0: "SUM",
  1: "AVERAGE",
  2: "DISTINCTCOUNT",
  3: "MIN",
  4: "MAX",
  5: "COUNT",
  6: "MEDIAN",
  7: "STDEV.S",
  8: "VAR.S",
};

export type FieldRef =
  | { kind: "column"; table: string; name: string }
  | { kind: "measure"; table: string; name: string }
  | { kind: "agg"; table: string; name: string; fn: AggFn };

export const column = (table: string, name: string): FieldRef => ({ kind: "column", table, name });
export const measure = (table: string, name: string): FieldRef => ({ kind: "measure", table, name });
export const agg = (table: string, name: string, fn: AggFn): FieldRef => ({ kind: "agg", table, name, fn });

/** True for fields that produce a number per group (measures and aggregated columns). */
export const isValueField = (f: FieldRef): boolean => f.kind !== "column";

/** Identity of a field across the report (used for query references and matching). */
export function fieldKey(f: FieldRef): string {
  return f.kind === "agg" ? `${AGG_DAX[f.fn]}(${f.table}.${f.name})` : `${f.table}.${f.name}`;
}

export function sameField(a: FieldRef, b: FieldRef): boolean {
  return fieldKey(a).toLowerCase() === fieldKey(b).toLowerCase();
}

/** Default display name: "Sum of Qty", the measure name, or the column name. */
export function fieldLabel(f: FieldRef): string {
  if (f.kind === "agg") {
    const word: Record<AggFn, string> = { 0: "Sum", 1: "Average", 2: "Count of", 3: "Min", 4: "Max", 5: "Count", 6: "Median", 7: "Standard deviation", 8: "Variance" };
    return f.fn === 2 ? `Count of ${f.name} (distinct)` : `${word[f.fn]} of ${f.name}`;
  }
  return f.name;
}

/** `'Table'[Column]` for columns; measures are referenced by name only, qualified with their home table. */
export function columnDax(f: FieldRef): string {
  return columnRef(f.table, f.name);
}

/** DAX scalar that computes the field's value: a column reference, a measure reference or an aggregate. */
export function valueDax(f: FieldRef): string {
  switch (f.kind) {
    case "column":
      return columnRef(f.table, f.name);
    case "measure":
      return `${quoteTable(f.table)}${quoteBracket(f.name)}`;
    case "agg":
      return `${AGG_DAX[f.fn]}(${columnRef(f.table, f.name)})`;
  }
}

/** Fields of a TOPN/ORDER BY clause can use the same text. */
export function orderDax(f: FieldRef): string {
  return valueDax(f);
}

/** DAX literal for a filter or slicer value. */
export type Lit = { t: "string"; v: string } | { t: "number"; v: number } | { t: "bool"; v: boolean } | { t: "date"; v: string } | { t: "null" };

export const lit = {
  str: (v: string): Lit => ({ t: "string", v }),
  num: (v: number): Lit => ({ t: "number", v }),
  bool: (v: boolean): Lit => ({ t: "bool", v }),
  date: (v: string): Lit => ({ t: "date", v }),
  null: (): Lit => ({ t: "null" }),
};

export function litDax(l: Lit): string {
  switch (l.t) {
    case "string":
      return `"${l.v.replace(/"/g, '""')}"`;
    case "number":
      return Number.isFinite(l.v) ? String(l.v) : "BLANK()";
    case "bool":
      return l.v ? "TRUE()" : "FALSE()";
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(l.v);
      if (!m) throw new Error(`Bad date literal "${l.v}".`);
      const t = /T(\d{2}):(\d{2}):(\d{2})/.exec(l.v);
      return t && (t[1] !== "00" || t[2] !== "00" || t[3] !== "00")
        ? `(DATE(${+m[1]}, ${+m[2]}, ${+m[3]}) + TIME(${+t[1]}, ${+t[2]}, ${+t[3]}))`
        : `DATE(${+m[1]}, ${+m[2]}, ${+m[3]})`;
    }
    case "null":
      return "BLANK()";
  }
}

export function litEqual(a: Lit, b: Lit): boolean {
  return a.t === b.t && (a.t === "null" || (a as { v: unknown }).v === (b as { v: unknown }).v);
}

export function litText(l: Lit): string {
  return l.t === "null" ? "(Blank)" : l.t === "bool" ? (l.v ? "True" : "False") : String(l.v);
}
