// Conditional formatting: color by gradient, by rules, or by a field's value. Stored in the property shapes of the
// PBIR schema (semanticQuery: FillRule and Conditional expressions); evaluated here.
import { fieldFromPbir, fieldToPbir, encodeLit, decodeLit, type J } from "./pbir";
import type { FieldRef } from "./fields";
import { normalizeColor } from "./theme";

export type RuleOp = "gt" | "ge" | "lt" | "le" | "eq";
export interface Stop {
  color: string;
  /** Fixed value; missing means the lowest/highest/middle value of the data. */
  value?: number;
}

export type CondFormat =
  | { kind: "gradient"; input: FieldRef; min: Stop; mid?: Stop; max: Stop; nullAsZero?: boolean }
  | { kind: "rules"; input: FieldRef; cases: { conds: { op: RuleOp; value: number }[]; color: string }[]; fallback?: string }
  | { kind: "fieldValue"; input: FieldRef };

const KIND: Record<RuleOp, number> = { eq: 0, gt: 1, ge: 2, lt: 3, le: 4 };
const OPS: RuleOp[] = ["eq", "gt", "ge", "lt", "le"];

const colorLit = (c: string): J => ({ Literal: { Value: encodeLit({ t: "string", v: c }) } });
const numLit = (n: number): J => ({ Literal: { Value: encodeLit({ t: "number", v: n }) } });

const stopToPbir = (s: Stop): J => ({ color: colorLit(s.color), ...(s.value !== undefined ? { value: numLit(s.value) } : {}) });

/** The property node (`{solid: {color: {expr: ...}}}`) that holds the formatting. */
export function condFormatToPbir(c: CondFormat): J {
  const input = fieldToPbir(c.input);
  if (c.kind === "fieldValue") return { solid: { color: { expr: input } } };
  if (c.kind === "gradient") {
    const rule = c.mid
      ? { linearGradient3: { min: stopToPbir(c.min), mid: stopToPbir(c.mid), max: stopToPbir(c.max), nullColoringStrategy: { strategy: colorLit(c.nullAsZero ? "asZero" : "noColor") } } }
      : { linearGradient2: { min: stopToPbir(c.min), max: stopToPbir(c.max), nullColoringStrategy: { strategy: colorLit(c.nullAsZero ? "asZero" : "noColor") } } };
    return { solid: { color: { expr: { FillRule: { Input: input, FillRule: rule } } } } };
  }
  const cmp = (op: RuleOp, v: number) => ({ Comparison: { ComparisonKind: KIND[op], Left: input, Right: numLit(v) } });
  const cases = c.cases.map((k) => ({
    Condition: k.conds.length === 1 ? cmp(k.conds[0].op, k.conds[0].value) : { And: { Left: cmp(k.conds[0].op, k.conds[0].value), Right: cmp(k.conds[1].op, k.conds[1].value) } },
    Value: colorLit(k.color),
  }));
  return { solid: { color: { expr: { Conditional: { Cases: cases, ...(c.fallback ? { DefaultValue: colorLit(c.fallback) } : {}) } } } } };
}

function strOf(l: J): string | null {
  const v = l?.Literal?.Value;
  const d = typeof v === "string" ? decodeLit(v) : null;
  return d && d.t === "string" ? d.v : null;
}
function numOf(l: J): number | null {
  const v = l?.Literal?.Value;
  const d = typeof v === "string" ? decodeLit(v) : null;
  return d && d.t === "number" ? d.v : null;
}
function stopFromPbir(s: J): Stop | null {
  const color = strOf(s?.color);
  if (!color) return null;
  const value = s.value ? numOf(s.value) : null;
  return { color, ...(value !== null ? { value } : {}) };
}

/** Reads a property node written by {@link condFormatToPbir}; null when it is a plain color or unknown. */
export function condFormatFromPbir(node: J): CondFormat | null {
  const e = node?.solid?.color?.expr;
  if (!e) return null;
  if (e.FillRule) {
    const input = fieldFromPbir(e.FillRule.Input);
    const g3 = e.FillRule.FillRule?.linearGradient3;
    const g = g3 ?? e.FillRule.FillRule?.linearGradient2;
    if (!input || !g) return null;
    const min = stopFromPbir(g.min);
    const max = stopFromPbir(g.max);
    const mid = g3 ? stopFromPbir(g.mid) : null;
    if (!min || !max || (g3 && !mid)) return null;
    const nullAsZero = strOf(g.nullColoringStrategy?.strategy) === "asZero";
    return { kind: "gradient", input, min, ...(mid ? { mid } : {}), max, ...(nullAsZero ? { nullAsZero } : {}) };
  }
  if (e.Conditional) {
    const cases: Extract<CondFormat, { kind: "rules" }>["cases"] = [];
    let input: FieldRef | null = null;
    const readCmp = (j: J): { op: RuleOp; value: number } | null => {
      const c = j?.Comparison;
      const f = c ? fieldFromPbir(c.Left) : null;
      const v = c ? numOf(c.Right) : null;
      if (!c || !f || v === null || !OPS[c.ComparisonKind]) return null;
      input ??= f;
      return { op: OPS[c.ComparisonKind], value: v };
    };
    for (const k of e.Conditional.Cases ?? []) {
      const color = strOf(k.Value);
      const conds = k.Condition?.And ? [readCmp(k.Condition.And.Left), readCmp(k.Condition.And.Right)] : [readCmp(k.Condition)];
      if (!color || conds.some((x) => x === null)) return null;
      cases.push({ conds: conds as { op: RuleOp; value: number }[], color });
    }
    if (!input || !cases.length) return null;
    const fallback = e.Conditional.DefaultValue ? strOf(e.Conditional.DefaultValue) : null;
    return { kind: "rules", input, cases, ...(fallback ? { fallback } : {}) };
  }
  const f = fieldFromPbir(e);
  return f ? { kind: "fieldValue", input: f } : null;
}

// ---- evaluation ------------------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const h = normalizeColor(hex).slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

const test = (op: RuleOp, v: number, ref: number) => (op === "gt" ? v > ref : op === "ge" ? v >= ref : op === "lt" ? v < ref : op === "le" ? v <= ref : v === ref);

/**
 * A function from a value to a color (or null for no color). `all` are the values of the formatted column across
 * the visual; the data minimum and maximum come from them when a gradient stop has no fixed value.
 */
export function colorFn(spec: CondFormat, all: (number | null)[]): (v: number | string | null) => string | null {
  if (spec.kind === "fieldValue") return (v) => (typeof v === "string" && /^#|^rgb|^[a-z]+$/i.test(v) ? v : null);
  if (spec.kind === "rules") {
    return (v) => {
      const n = typeof v === "number" ? v : v === null ? null : Number(v);
      if (n === null || Number.isNaN(n)) return spec.fallback ?? null;
      for (const c of spec.cases) if (c.conds.every((k) => test(k.op, n, k.value))) return c.color;
      return spec.fallback ?? null;
    };
  }
  const nums = all.filter((x): x is number => x !== null && Number.isFinite(x));
  const lo = spec.min.value ?? (nums.length ? Math.min(...nums) : 0);
  const hi = spec.max.value ?? (nums.length ? Math.max(...nums) : 0);
  const mid = spec.mid ? (spec.mid.value ?? (lo + hi) / 2) : null;
  return (v) => {
    let n = typeof v === "number" ? v : v === null ? null : Number(v);
    if (n === null || Number.isNaN(n)) {
      if (!spec.nullAsZero) return null;
      n = 0;
    }
    if (hi === lo) return spec.max.color;
    if (n <= lo) return spec.min.color;
    if (n >= hi) return spec.max.color;
    if (mid !== null && spec.mid) {
      return n <= mid ? mix(spec.min.color, spec.mid.color, mid === lo ? 1 : (n - lo) / (mid - lo)) : mix(spec.mid.color, spec.max.color, hi === mid ? 1 : (n - mid) / (hi - mid));
    }
    return mix(spec.min.color, spec.max.color, (n - lo) / (hi - lo));
  };
}

/** Readable text color (black or white) for a background. */
export function textOn(bg: string): string {
  const [r, g, b] = rgb(bg).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#1a1a1a" : "#ffffff";
}
