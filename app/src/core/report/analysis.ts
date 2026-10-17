// The analysis visuals: decomposition tree (a measure split level by level by chosen fields, or by the field whose
// largest or smallest group stands out) and key influencers (which values of the explaining fields go with an outcome).
// Pure: queries are described as small table visuals that the normal query builder turns into DAX, and the statistics
// work on the rows that come back. The views run the queries (ReportData.rows).
import type { Value } from "./cells";
import { labelOf, num, valueToLit } from "./chartData";
import { fieldLabel, type FieldRef, type Lit } from "./fields";
import type { FilterDef } from "./filters";
import { projectionJson, parseVisual, VISUAL_SCHEMA, type VisualModel } from "./visualDoc";

/** A table visual of the given fields: the query a node of an analysis needs (groups first, then values). */
export function tableVisual(fields: FieldRef[], name = "analysis"): VisualModel {
  const json = {
    $schema: VISUAL_SCHEMA,
    name,
    position: { x: 0, y: 0, z: 0, width: 100, height: 100 },
    visual: { visualType: "tableEx", query: { queryState: { Values: { projections: fields.map((field) => projectionJson({ field })) } } } },
  };
  return parseVisual("analysis", json)!;
}

// ---- decomposition tree ---------------------------------------------------------------------------------

/** One chosen node on the way down the tree. */
export interface PathStep {
  field: FieldRef;
  value: Lit;
}

/** The filters the nodes above a level impose on it. */
export const stepFilters = (path: PathStep[]): FilterDef[] => path.map((s, i) => ({ name: `tree${i}`, field: s.field, cond: { kind: "in", values: [s.value] } }));

export interface Group {
  key: string;
  label: string;
  lit: Lit;
  /** The measure for this group; null when blank. */
  amount: number | null;
}

/** Rows of (group, measure) as groups, largest first (blank amounts last), at most `limit`. */
export function readGroups(rows: Value[][], format: string | null, limit = 10): Group[] {
  const groups = rows.map((r): Group => ({ key: r[0].text + "|" + r[0].kind, label: labelOf(r[0], format), lit: valueToLit(r[0]), amount: num(r[1]) }));
  groups.sort((a, b) => (b.amount ?? -Infinity) - (a.amount ?? -Infinity));
  return groups.slice(0, limit);
}

export type AutoSplit = "high" | "low";

export interface Candidate {
  field: FieldRef;
  groups: Group[];
}

/**
 * The field to split by when the user asks for the high or low value: the one whose largest (or smallest) group stands
 * out most from the average of that field's groups. Fields with a single group say nothing and are skipped.
 */
export function pickAutoSplit(cands: Candidate[], mode: AutoSplit): { field: FieldRef; group: Group } | null {
  let best: { field: FieldRef; group: Group; score: number } | null = null;
  for (const c of cands) {
    const amounts = c.groups.filter((g) => g.amount !== null);
    if (amounts.length < 2) continue;
    const mean = amounts.reduce((a, g) => a + (g.amount as number), 0) / amounts.length;
    if (mean === 0) continue;
    const group = amounts.reduce((a, g) => (mode === "high" ? ((g.amount as number) > (a.amount as number) ? g : a) : (g.amount as number) < (a.amount as number) ? g : a));
    const score = (group.amount as number) / mean;
    if (best === null || (mode === "high" ? score > best.score : score < best.score)) best = { field: c.field, group, score };
  }
  return best ? { field: best.field, group: best.group } : null;
}

// ---- key influencers --------------------------------------------------------------------------------------

export interface InfluenceGroup {
  lit: Lit;
  label: string;
  /** Rows (or cases) in the group. */
  n: number;
  /** Cases with the outcome (a categorical target) or the average of the target (a numeric one). */
  pos: number;
}

export interface InfluenceCandidate {
  field: FieldRef;
  groups: InfluenceGroup[];
}

export interface Influence {
  field: FieldRef;
  fieldLabel: string;
  value: Lit;
  label: string;
  /** Cases in the group. */
  count: number;
  /** The outcome rate inside the group (categorical) or the average of the target (numeric). */
  inside: number;
  /** The same for everyone else. */
  outside: number;
  /** inside / outside: how many times more likely (categorical), or how many times higher the average (numeric). */
  lift: number;
}

export interface InfluenceOptions {
  /** A group needs at least this share of all cases to be reported. */
  minShare: number;
  limit: number;
  sort: "impact" | "count";
}

const LIFT_CAP = 99;

/**
 * Categorical target: for each value of each explaining field, how much more likely the outcome is inside the group
 * than outside it (a likelihood ratio, not the regression of Desktop). Only groups where it is more likely, with enough cases.
 */
export function categoricalInfluences(cands: InfluenceCandidate[], totalN: number, totalPos: number, opt: InfluenceOptions): Influence[] {
  const out: Influence[] = [];
  for (const c of cands) {
    for (const g of c.groups) {
      const restN = totalN - g.n;
      if (g.n <= 0 || restN <= 0 || g.n / totalN < opt.minShare) continue;
      const inside = g.pos / g.n;
      const outside = (totalPos - g.pos) / restN;
      const lift = outside === 0 ? (inside > 0 ? LIFT_CAP : 1) : Math.min(LIFT_CAP, inside / outside);
      if (lift > 1) out.push({ field: c.field, fieldLabel: fieldLabel(c.field), value: g.lit, label: g.label, count: g.n, inside, outside, lift });
    }
  }
  return rank(out, opt);
}

/** Numeric target: groups whose average of the target is higher than the average of everyone else. */
export function numericInfluences(cands: InfluenceCandidate[], totalN: number, totalSum: number, opt: InfluenceOptions): Influence[] {
  const out: Influence[] = [];
  for (const c of cands) {
    for (const g of c.groups) {
      const restN = totalN - g.n;
      if (g.n <= 0 || restN <= 0 || g.n / totalN < opt.minShare) continue;
      const inside = g.pos; // the group's average
      const outside = (totalSum - g.pos * g.n) / restN;
      if (outside === 0 || !Number.isFinite(outside)) continue;
      const lift = inside / outside;
      if (lift > 1) out.push({ field: c.field, fieldLabel: fieldLabel(c.field), value: g.lit, label: g.label, count: g.n, inside, outside, lift });
    }
  }
  return rank(out, opt);
}

function rank(list: Influence[], opt: InfluenceOptions): Influence[] {
  return list.sort((a, b) => (opt.sort === "count" ? b.count - a.count || b.lift - a.lift : b.lift - a.lift || b.count - a.count)).slice(0, opt.limit);
}

/** The sentence of one influence, for the list. */
export function influenceText(i: Influence, target: string, outcome: string | null): string {
  const times = i.lift >= LIFT_CAP ? "far" : `${i.lift.toFixed(2)}×`;
  return outcome === null ? `When ${i.fieldLabel} is ${i.label}, the average of ${target} is ${times} higher` : `When ${i.fieldLabel} is ${i.label}, ${target} is ${times} more likely to be ${outcome}`;
}
