// Report filters: the internal model, their DAX translation and their PBIR (filterConfiguration) form.
import { columnDax, fieldKey, litDax, valueDax, type FieldRef, type Lit } from "./fields";
import { decodeLit, encodeLit, fieldFromPbir, fieldToPbir, type J } from "./pbir";

export type CmpOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le";
export type TextOp = "contains" | "notContains" | "startsWith" | "notStartsWith";
export type RelUnit = "days" | "weeks" | "months" | "years";

export type SimpleCond =
  | { kind: "in"; values: Lit[] }
  | { kind: "notIn"; values: Lit[] }
  | { kind: "cmp"; op: CmpOp; value: Lit }
  | { kind: "between"; lo: Lit; hi: Lit }
  | { kind: "text"; op: TextOp; value: string }
  | { kind: "blank" }
  | { kind: "notBlank" };

/**
 * The selection of a hierarchy slicer: a list of prefixes of the levels' values. A row of length k means "everything whose
 * first k fields have these values" (a whole branch of the tree); the fields are the levels in order.
 */
export interface TuplesCond {
  kind: "tuples";
  fields: FieldRef[];
  rows: Lit[][];
}

export type Cond =
  | SimpleCond
  | TuplesCond
  | { kind: "compound"; op: "and" | "or"; a: SimpleCond; b: SimpleCond }
  | { kind: "topN"; n: number; dir: "top" | "bottom"; by: FieldRef }
  /** BIForge extension (stored as an annotation, not in the PBIR filter list). Dates only. */
  | { kind: "relativeDate"; op: "last" | "this" | "next"; n: number; unit: RelUnit; includeToday: boolean };

export interface FilterDef {
  name: string;
  field: FieldRef;
  cond: Cond;
  hidden?: boolean;
  locked?: boolean;
}

const CMP_DAX: Record<CmpOp, string> = { eq: "=", ne: "<>", gt: ">", ge: ">=", lt: "<", le: "<=" };
const CMP_KIND: Record<string, number> = { eq: 0, gt: 1, ge: 2, lt: 3, le: 4 };

// ---- DAX ------------------------------------------------------------------------------------

/** Start (first day) of the calendar unit that contains today. */
function unitStart(unit: RelUnit): string {
  switch (unit) {
    case "days":
      return "TODAY()";
    case "weeks":
      return "(TODAY() - (WEEKDAY(TODAY(), 1) - 1))";
    case "months":
      return "DATE(YEAR(TODAY()), MONTH(TODAY()), 1)";
    case "years":
      return "DATE(YEAR(TODAY()), 1, 1)";
  }
}

/** The start of the unit `k` units away from the current one (k may be negative). */
function unitShift(unit: RelUnit, k: number): string {
  const s = unitStart(unit);
  if (k === 0) return s;
  switch (unit) {
    case "days":
      return `(${s} + ${k})`;
    case "weeks":
      return `(${s} + ${7 * k})`;
    case "months":
      return `EDATE(${s}, ${k})`;
    case "years":
      return `EDATE(${s}, ${12 * k})`;
  }
}

function relativeBounds(c: Extract<Cond, { kind: "relativeDate" }>): [string, string] {
  const n = Math.max(0, Math.floor(c.n));
  // "this": the current unit; "last": n complete units before the current one (plus today when included);
  // "next": n complete units after it.
  if (c.op === "this") return [unitShift(c.unit, 0), `(${unitShift(c.unit, 1)} - 1)`];
  if (c.op === "last") return [unitShift(c.unit, -n), c.includeToday ? "TODAY()" : `(${unitShift(c.unit, 0)} - 1)`];
  return [c.includeToday ? "TODAY()" : unitShift(c.unit, 1), `(${unitShift(c.unit, n + 1)} - 1)`];
}

/** Boolean DAX predicate over `x` (a column or value expression). topN is not a predicate. */
export function condDax(x: string, c: Cond): string {
  switch (c.kind) {
    case "in":
    case "notIn": {
      const nonBlank = c.values.filter((v) => v.t !== "null");
      const hasBlank = nonBlank.length !== c.values.length;
      const parts: string[] = [];
      if (nonBlank.length) parts.push(`${x} IN {${nonBlank.map(litDax).join(", ")}}`);
      if (hasBlank) parts.push(`ISBLANK(${x})`);
      const p = parts.length === 0 ? "FALSE()" : parts.length === 1 ? parts[0] : `(${parts.join(" || ")})`;
      return c.kind === "in" ? p : `NOT (${p})`;
    }
    case "cmp":
      if (c.value.t === "null") return c.op === "ne" ? `NOT ISBLANK(${x})` : `ISBLANK(${x})`;
      return `${x} ${CMP_DAX[c.op]} ${litDax(c.value)}`;
    case "between":
      return `(${x} >= ${litDax(c.lo)} && ${x} <= ${litDax(c.hi)})`;
    case "text": {
      const v = litDax({ t: "string", v: c.value });
      const base = c.op === "contains" || c.op === "notContains" ? `CONTAINSSTRING(${x}, ${v})` : `(LEFT(${x}, ${[...c.value].length}) = ${v})`;
      return c.op === "notContains" || c.op === "notStartsWith" ? `NOT ${base}` : base;
    }
    case "blank":
      return `ISBLANK(${x})`;
    case "notBlank":
      return `NOT ISBLANK(${x})`;
    case "compound":
      return `(${condDax(x, c.a)} ${c.op === "and" ? "&&" : "||"} ${condDax(x, c.b)})`;
    case "relativeDate": {
      const [lo, hi] = relativeBounds(c);
      return `(${x} >= ${lo} && ${x} <= ${hi})`;
    }
    case "tuples":
      throw new Error("A hierarchy selection filters several columns at once.");
    case "topN":
      throw new Error("A Top N filter is not a predicate.");
  }
}

/** FILTER over the levels' columns: an OR of ANDs, one AND per selected branch (shorter rows leave the deeper levels free). */
export function tuplesDax(c: TuplesCond): string {
  const cols = c.fields.map(columnDax);
  const preds = c.rows.map((r) => `(${r.slice(0, cols.length).map((v, i) => (v.t === "null" ? `ISBLANK(${cols[i]})` : `${cols[i]} = ${litDax(v)}`)).join(" && ")})`);
  return `FILTER(ALL(${cols.join(", ")}), ${preds.length ? preds.join(" || ") : "FALSE()"})`;
}

/** True when the filter has no effect (an empty selection). */
export function isNeutral(c: Cond): boolean {
  return ((c.kind === "in" || c.kind === "notIn") && c.values.length === 0) || (c.kind === "tuples" && c.rows.length === 0);
}

export interface PostFilter {
  /** Value expression whose result is tested (a measure or aggregate). */
  expr: string;
  cond: Exclude<Cond, { kind: "topN" } | { kind: "relativeDate" } | { kind: "tuples" }>;
}

export interface FilterArgs {
  /** Table-valued filter arguments for SUMMARIZECOLUMNS / CALCULATETABLE. */
  args: string[];
  /** Conditions on measures; applied to the result rows. */
  post: PostFilter[];
}

/** Translates filters to DAX. Several filters on one column are merged into one argument. */
export function filtersToDax(defs: FilterDef[]): FilterArgs {
  const byColumn = new Map<string, { field: FieldRef; preds: string[] }>();
  const topNs: { field: FieldRef; cond: Extract<Cond, { kind: "topN" }> }[] = [];
  const post: PostFilter[] = [];
  const tupleArgs: string[] = [];
  for (const d of defs) {
    if (isNeutral(d.cond)) continue;
    if (d.cond.kind === "topN") {
      topNs.push({ field: d.field, cond: d.cond });
      continue;
    }
    if (d.cond.kind === "tuples") {
      tupleArgs.push(tuplesDax(d.cond));
      continue;
    }
    if (d.field.kind !== "column") {
      if (d.cond.kind === "relativeDate") continue;
      post.push({ expr: valueDax(d.field), cond: d.cond });
      continue;
    }
    const k = fieldKey(d.field).toLowerCase();
    const g = byColumn.get(k) ?? { field: d.field, preds: [] };
    g.preds.push(condDax(columnDax(d.field), d.cond));
    byColumn.set(k, g);
  }
  const args = [...byColumn.values()].map((g) => `FILTER(ALL(${columnDax(g.field)}), ${g.preds.join(" && ")})`);
  args.push(...tupleArgs);
  for (const t of topNs) {
    const col = columnDax(t.field);
    const others = args.length ? `, ${args.join(", ")}` : "";
    const dir = t.cond.dir === "top" ? "DESC" : "ASC";
    // candidates are the items that have a value (the ones the visual would show)
    const by = `CALCULATE(${valueDax(t.cond.by)}${others})`;
    args.push(`TOPN(${Math.max(1, Math.floor(t.cond.n))}, FILTER(CALCULATETABLE(VALUES(${col})${others}), NOT ISBLANK(${by})), ${by}, ${dir})`);
  }
  return { args, post };
}

// ---- PBIR ----------------------------------------------------------------------------------

const REL_ANNOTATION = "biforge.relativeDate.";

function aliasesFor(tables: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const t of tables) {
    if (out[t]) continue;
    const base = (t.match(/[A-Za-z]/)?.[0] ?? "t").toLowerCase();
    let a = base;
    for (let i = 2; used.has(a); i++) a = `${base}${i}`;
    used.add(a);
    out[t] = a;
  }
  return out;
}

const litC = (l: Lit): J => ({ Literal: { Value: encodeLit(l) } });

function condToPbir(col: J, c: SimpleCond | { kind: "compound"; op: "and" | "or"; a: SimpleCond; b: SimpleCond }): J {
  switch (c.kind) {
    case "in":
      return { In: { Expressions: [col], Values: c.values.map((v) => [litC(v)]) } };
    case "notIn":
      return { Not: { Expression: condToPbir(col, { kind: "in", values: c.values }) } };
    case "cmp": {
      if (c.value.t === "null") return c.op === "ne" ? condToPbir(col, { kind: "notBlank" }) : condToPbir(col, { kind: "blank" });
      if (c.op === "ne") return { Not: { Expression: condToPbir(col, { kind: "cmp", op: "eq", value: c.value }) } };
      return { Comparison: { ComparisonKind: CMP_KIND[c.op], Left: col, Right: litC(c.value) } };
    }
    case "between":
      return { Between: { Expression: col, LowerBound: litC(c.lo), UpperBound: litC(c.hi) } };
    case "text": {
      const base = c.op === "contains" || c.op === "notContains" ? "Contains" : "StartsWith";
      const e = { [base]: { Left: col, Right: litC({ t: "string", v: c.value }) } };
      return c.op === "notContains" || c.op === "notStartsWith" ? { Not: { Expression: e } } : e;
    }
    case "blank":
      return { Comparison: { ComparisonKind: 0, Left: col, Right: litC({ t: "null" }) } };
    case "notBlank":
      return { Not: { Expression: condToPbir(col, { kind: "blank" }) } };
    case "compound":
      return { [c.op === "and" ? "And" : "Or"]: { Left: condToPbir(col, c.a), Right: condToPbir(col, c.b) } };
  }
}

function condFromPbir(j: J, field: FieldRef, aliases: Record<string, string>): Cond | null {
  const sameCol = (e: J) => {
    const f = fieldFromPbir(e, aliases);
    return f !== null && fieldKey(f).toLowerCase() === fieldKey(field).toLowerCase();
  };
  const lit = (e: J): Lit | null => (typeof e?.Literal?.Value === "string" ? decodeLit(e.Literal.Value) : null);
  if (j.In && !j.In.Table) {
    if (j.In.Expressions?.length !== 1 || !sameCol(j.In.Expressions[0])) return null;
    const values: Lit[] = [];
    for (const row of j.In.Values ?? []) {
      const l = row.length === 1 ? lit(row[0]) : null;
      if (!l) return null;
      values.push(l);
    }
    return { kind: "in", values };
  }
  if (j.Not) {
    const inner = condFromPbir(j.Not.Expression, field, aliases);
    if (!inner) return null;
    switch (inner.kind) {
      case "in":
        return { kind: "notIn", values: inner.values };
      case "cmp":
        return inner.op === "eq" ? (inner.value.t === "null" ? { kind: "notBlank" } : { kind: "cmp", op: "ne", value: inner.value }) : null;
      case "blank":
        return { kind: "notBlank" };
      case "text":
        return inner.op === "contains" ? { kind: "text", op: "notContains", value: inner.value } : inner.op === "startsWith" ? { kind: "text", op: "notStartsWith", value: inner.value } : null;
      default:
        return null;
    }
  }
  if (j.Comparison) {
    const k = j.Comparison.ComparisonKind;
    const op = (["eq", "gt", "ge", "lt", "le"] as const)[k];
    const v = lit(j.Comparison.Right);
    if (!op || !v || !sameCol(j.Comparison.Left)) return null;
    return v.t === "null" && op === "eq" ? { kind: "blank" } : { kind: "cmp", op, value: v };
  }
  if (j.Between) {
    const lo = lit(j.Between.LowerBound);
    const hi = lit(j.Between.UpperBound);
    if (!lo || !hi || !sameCol(j.Between.Expression)) return null;
    return { kind: "between", lo, hi };
  }
  for (const [key, op] of [["Contains", "contains"], ["StartsWith", "startsWith"]] as const) {
    if (j[key]) {
      const v = lit(j[key].Right);
      if (!v || v.t !== "string" || !sameCol(j[key].Left)) return null;
      return { kind: "text", op, value: v.v };
    }
  }
  for (const [key, op] of [["And", "and"], ["Or", "or"]] as const) {
    if (j[key]) {
      const a = condFromPbir(j[key].Left, field, aliases);
      const b = condFromPbir(j[key].Right, field, aliases);
      const simple = (c: Cond | null): c is SimpleCond => c !== null && c.kind !== "compound" && c.kind !== "topN" && c.kind !== "relativeDate";
      return simple(a) && simple(b) ? { kind: "compound", op, a, b } : null;
    }
  }
  return null;
}

const FILTER_TYPE: Record<string, string> = { in: "Categorical", notIn: "Categorical", between: "Range", topN: "TopN", tuples: "Categorical" };

/** A hierarchy selection: one In over the levels' columns per row length, joined with Or. */
function tuplesToPbir(c: TuplesCond, style: { alias: Record<string, string> }): J {
  const cols = c.fields.map((f) => fieldToPbir(f.kind === "agg" ? { kind: "column", table: f.table, name: f.name } : f, style));
  const byLen = new Map<number, Lit[][]>();
  for (const r of c.rows) byLen.set(Math.min(r.length, cols.length), [...(byLen.get(Math.min(r.length, cols.length)) ?? []), r]);
  const parts: J[] = [...byLen.entries()].sort((a, b) => a[0] - b[0]).map(([k, rows]) => ({ In: { Expressions: cols.slice(0, k), Values: rows.map((r) => r.slice(0, k).map(litC)) } }));
  return parts.reduce((a, b) => ({ Or: { Left: a, Right: b } }));
}

/** The reverse: the In clauses of an Or tree become rows; the levels are the expressions of the longest In. */
function tuplesFromPbir(j: J, aliases: Record<string, string>): TuplesCond | null {
  const ins: J[] = [];
  const walk = (x: J): boolean => {
    if (x?.In && !x.In.Table && Array.isArray(x.In.Expressions) && x.In.Expressions.length >= 1) return ins.push(x.In), true;
    if (x?.Or) return walk(x.Or.Left) && walk(x.Or.Right);
    return false;
  };
  // a plain one-column list is an ordinary "in" filter; a hierarchy selection has at least one In over several levels
  if (!walk(j) || ins.length === 0 || !ins.some((i) => i.Expressions.length >= 2)) return null;
  const longest = ins.reduce((a, b) => (b.Expressions.length > a.Expressions.length ? b : a));
  const fields: FieldRef[] = [];
  for (const e of longest.Expressions) {
    const f = fieldFromPbir(e, aliases);
    if (!f || f.kind === "agg" || f.kind === "measure") return null;
    fields.push(f);
  }
  const rows: Lit[][] = [];
  for (const i of ins) {
    for (const row of i.Values ?? []) {
      const lits: Lit[] = [];
      for (const cell of row) {
        const l = typeof cell?.Literal?.Value === "string" ? decodeLit(cell.Literal.Value) : null;
        if (!l) return null;
        lits.push(l);
      }
      rows.push(lits);
    }
  }
  return { kind: "tuples", fields, rows };
}

export function filterToPbir(d: FilterDef): J {
  const aliases = aliasesFor([d.field.table, ...(d.cond.kind === "topN" ? [d.cond.by.table] : []), ...(d.cond.kind === "tuples" ? d.cond.fields.map((f) => f.table) : [])]);
  const style = { alias: aliases };
  const col = fieldToPbir(d.field.kind === "agg" ? { kind: "column", table: d.field.table, name: d.field.name } : d.field, style);
  const field = fieldToPbir(d.field);
  const container: J = { name: d.name, field, type: FILTER_TYPE[d.cond.kind] ?? "Advanced" };
  const from = Object.entries(aliases).map(([entity, name]) => ({ Name: name, Entity: entity, Type: 0 }));
  if (d.cond.kind === "topN") {
    const by = d.cond.by;
    const sub = {
      Version: 2,
      From: from,
      Select: [{ ...fieldToPbir(d.field, style), Name: "field" }, { ...fieldToPbir(by, style), Name: "by" }],
      OrderBy: [{ Direction: d.cond.dir === "top" ? 2 : 1, Expression: fieldToPbir(by, style) }],
      Top: d.cond.n,
    };
    container.filter = {
      Version: 2,
      From: [{ Name: "subquery", Expression: { Subquery: { Query: sub } }, Type: 2 }, ...from],
      Where: [{ Condition: { In: { Expressions: [col], Table: { SourceRef: { Source: "subquery" } } } } }],
    };
  } else if (d.cond.kind === "relativeDate") {
    return container;
  } else {
    container.filter = { Version: 2, From: from, Where: [{ Condition: d.cond.kind === "tuples" ? tuplesToPbir(d.cond, style) : condToPbir(col, d.cond) }] };
  }
  if (d.hidden) container.isHiddenInViewMode = true;
  if (d.locked) container.isLockedInViewMode = true;
  return container;
}

export function filterFromPbir(c: J): FilterDef | null {
  if (!c || typeof c.name !== "string") return null;
  const field = fieldFromPbir(c.field);
  const flt = c.filter;
  if (!field || !flt || !Array.isArray(flt.From) || !Array.isArray(flt.Where) || flt.Where.length !== 1) return null;
  const aliases: Record<string, string> = {};
  for (const f of flt.From) if (typeof f.Name === "string" && typeof f.Entity === "string") aliases[f.Name] = f.Entity;
  const cond = flt.Where[0].Condition;
  let parsed: Cond | null = null;
  if (c.type === "TopN") {
    const sub = flt.From.find((f: J) => f.Expression?.Subquery)?.Expression?.Subquery?.Query;
    const subAliases: Record<string, string> = { ...aliases };
    for (const f of sub?.From ?? []) if (typeof f.Name === "string" && typeof f.Entity === "string") subAliases[f.Name] = f.Entity;
    const order = sub?.OrderBy?.[0];
    const by = order ? fieldFromPbir(order.Expression, subAliases) : null;
    if (sub && by && Number.isInteger(sub.Top) && (order.Direction === 1 || order.Direction === 2)) parsed = { kind: "topN", n: sub.Top, dir: order.Direction === 2 ? "top" : "bottom", by };
  } else if (cond) {
    parsed = tuplesFromPbir(cond, aliases);
    if (!parsed) parsed = condFromPbir(cond, field.kind === "agg" ? { kind: "column", table: field.table, name: field.name } : field, aliases);
  }
  if (!parsed) return null;
  return { name: c.name, field, cond: parsed, ...(c.isHiddenInViewMode ? { hidden: true } : {}), ...(c.isLockedInViewMode ? { locked: true } : {}) };
}

export interface FilterHolder {
  filterConfig?: { filters?: J[] } & Record<string, J>;
  annotations?: { name: string; value: string }[];
}

export interface ReadFilters {
  defs: FilterDef[];
  /** Containers BIForge cannot interpret; they are kept as they are on write and never applied. */
  opaque: J[];
}

/** Filters stored on a report, page or visual JSON document. */
export function readFilters(holder: FilterHolder | undefined): ReadFilters {
  const defs: FilterDef[] = [];
  const opaque: J[] = [];
  for (const c of holder?.filterConfig?.filters ?? []) {
    const d = filterFromPbir(c);
    if (d) defs.push(d);
    else opaque.push(c);
  }
  for (const a of holder?.annotations ?? []) {
    if (!a.name.startsWith(REL_ANNOTATION)) continue;
    try {
      const o = JSON.parse(a.value) as { field: FieldRef; cond: Cond };
      if (o.cond?.kind === "relativeDate") defs.push({ name: a.name.slice(REL_ANNOTATION.length), field: o.field, cond: o.cond });
    } catch {
      /* unreadable annotation: leave it alone */
    }
  }
  return { defs, opaque };
}

/** Replaces the interpretable filters of the holder with `defs` (opaque containers are preserved). */
export function writeFilters(holder: FilterHolder, defs: FilterDef[], opaque: J[]): void {
  const containers = [...defs.filter((d) => d.cond.kind !== "relativeDate").map(filterToPbir), ...opaque];
  if (containers.length) holder.filterConfig = { ...(holder.filterConfig ?? {}), filters: containers };
  else if (holder.filterConfig) {
    delete holder.filterConfig.filters;
    if (Object.keys(holder.filterConfig).filter((k) => k !== "$schema").length === 0) delete holder.filterConfig;
  }
  const anns = (holder.annotations ?? []).filter((a) => !a.name.startsWith(REL_ANNOTATION));
  for (const d of defs) if (d.cond.kind === "relativeDate") anns.push({ name: REL_ANNOTATION + d.name, value: JSON.stringify({ field: d.field, cond: d.cond }) });
  if (anns.length) holder.annotations = anns;
  else delete holder.annotations;
}
