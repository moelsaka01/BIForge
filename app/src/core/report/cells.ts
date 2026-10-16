// Decoding of DAX result cells (the engine sends every value as text with a type tag).
import type { Cell } from "../dax/types";

export type CellKind = Cell["t"];

export interface Value {
  kind: CellKind;
  /** Text as sent by the engine ("" for blank). */
  text: string;
  /** Number for int, real, currency; milliseconds since 1970-01-01 (UTC) for datetime; else null. */
  num: number | null;
}

const MONTH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2}):(\d{2}) (AM|PM))?$/;

/** The engine prints dates as "M/d/yyyy" or "M/d/yyyy h:mm:ss AM"; returns the matching UTC milliseconds. */
export function parseEngineDate(s: string): number | null {
  const m = MONTH_RE.exec(s);
  if (!m) return null;
  let h = m[4] ? Number(m[4]) % 12 : 0;
  if (m[7] === "PM") h += 12;
  const t = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0);
  return Number.isNaN(t) ? null : t;
}

export function decodeCell(c: Cell): Value {
  switch (c.t) {
    case "int":
    case "real":
    case "currency": {
      const n = c.v === "NaN" ? NaN : Number(c.v);
      return { kind: c.t, text: c.v, num: Number.isNaN(n) && c.v !== "NaN" ? null : n };
    }
    case "datetime":
      return { kind: c.t, text: c.v, num: parseEngineDate(c.v) };
    default:
      return { kind: c.t, text: c.v, num: null };
  }
}

export const isBlank = (v: Value) => v.kind === "blank";
export const isNumeric = (v: Value) => v.kind === "int" || v.kind === "real" || v.kind === "currency";

/** Key that identifies a group value across queries (type-insensitive for numbers). */
export function valueKey(v: Value): string {
  return v.kind === "blank" ? "\u0000blank" : isNumeric(v) ? `n:${v.num}` : `${v.kind === "datetime" ? "d" : "s"}:${v.text}`;
}

/** ISO date text for a datetime value, "YYYY-MM-DD" (time dropped when it is midnight, kept otherwise). */
export function isoOf(v: Value): string | null {
  if (v.kind !== "datetime" || v.num === null) return null;
  const iso = new Date(v.num).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19);
}
