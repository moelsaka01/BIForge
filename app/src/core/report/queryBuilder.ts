// Turns a visual definition plus the active filters into DAX queries. Pure functions.
import { columnDax, fieldLabel, litDax, sameField, valueDax, type FieldRef, type Lit } from "./fields";
import { condDax, filtersToDax, type FilterDef } from "./filters";
import { quoteTable } from "../dax/measureQuery";
import { fieldFormat, type ModelInfo } from "./modelInfo";
import type { SortSpec, VisualModel } from "./visualDoc";
import { visualType, type VisualFamily } from "./visualTypes";

/** State of drilling in a visual whose first (category) role holds several fields. */
export interface DrillState {
  /** Index of the field shown. */
  level: number;
  /** Chosen value per upper level (null: not restricted, e.g. after "go to next level"). */
  path: (Lit | null)[];
  /** Show all levels down to `level` at once ("expand all down one level"). */
  expand: boolean;
}

export const NO_DRILL: DrillState = { level: 0, path: [], expand: false };

/** A restriction to rows that were selected on a data point: one row per selected point. */
export interface TupleFilter {
  fields: FieldRef[];
  rows: Lit[][];
}

export interface PlannedColumn {
  /** Position of the column in each result row. */
  index: number;
  role: string;
  field: FieldRef;
  label: string;
  kind: "group" | "value" | "helper";
  format: string | null;
  /** Position of the field inside its role (display order). */
  order: number;
}

export interface BuiltQuery {
  dax: string;
  columns: PlannedColumn[];
  /** Set when the rows are ordered by a value (index among the value columns); charts order categories by total. */
  valueSort?: { valueIndex: number; dir: "asc" | "desc" };
}

export interface QueryOptions {
  /** Filters from the report, page, visual, slicers, drill and cross-filtering, all merged by the caller. */
  filters: FilterDef[];
  tuples?: TupleFilter[];
  drill?: DrillState;
}

interface Slot {
  role: string;
  field: FieldRef;
  order: number;
}

const rolesOf = (v: VisualModel, role: string): FieldRef[] => (v.roles[role] ?? []).map((p) => p.field);

function dedupe(slots: Slot[]): Slot[] {
  const out: Slot[] = [];
  for (const s of slots) if (!out.some((o) => sameField(o.field, s.field))) out.push(s);
  return out;
}

/** Categories visible for the current drill state, plus the filters that the upper levels impose. */
export function drillPlan(cats: FieldRef[], drill: DrillState = NO_DRILL): { fields: FieldRef[]; filters: FilterDef[] } {
  if (cats.length <= 1) return { fields: cats, filters: [] };
  const level = Math.min(Math.max(0, drill.level), cats.length - 1);
  if (drill.expand) return { fields: cats.slice(0, level + 1), filters: [] };
  const filters: FilterDef[] = [];
  for (let i = 0; i < level; i++) {
    const v = drill.path[i];
    if (v) filters.push({ name: `drill${i}`, field: cats[i], cond: { kind: "in", values: [v] } });
  }
  return { fields: [cats[level]], filters };
}

function slotsFor(v: VisualModel, family: VisualFamily, drill?: DrillState): { groups: Slot[]; values: Slot[]; extra: FilterDef[] } {
  const slot = (role: string, fs: FieldRef[]): Slot[] => fs.map((field, order) => ({ role, field, order }));
  const roleSlots = (role: string) => slot(role, rolesOf(v, role));
  switch (family) {
    case "cartesian": {
      const dp = drillPlan(rolesOf(v, "Category"), drill);
      return { groups: dedupe([...slot("Category", dp.fields), ...roleSlots("Series"), ...roleSlots("Rows")]), values: [...roleSlots("Y"), ...roleSlots("Y2")], extra: dp.filters };
    }
    case "pie":
    case "funnel":
      return { groups: roleSlots("Category"), values: roleSlots("Y"), extra: [] };
    case "treemap":
      return { groups: roleSlots("Group"), values: roleSlots("Values"), extra: [] };
    case "map":
    case "scatter":
      return { groups: dedupe([...roleSlots("Category"), ...roleSlots("Series")]), values: [...roleSlots("X"), ...roleSlots("Y"), ...roleSlots("Size")], extra: [] };
    case "waterfall":
      return { groups: dedupe([...roleSlots("Category"), ...roleSlots("Breakdown")]), values: roleSlots("Y"), extra: [] };
    case "table":
    case "card": {
      const all = roleSlots("Values");
      return { groups: dedupe(all.filter((s) => s.field.kind === "column")), values: all.filter((s) => s.field.kind !== "column"), extra: [] };
    }
    case "kpi":
      return { groups: roleSlots("TrendLine"), values: [...roleSlots("Indicator"), ...roleSlots("Goal")], extra: [] };
    case "gauge":
      return { groups: [], values: [...roleSlots("Y"), ...roleSlots("MinValue"), ...roleSlots("MaxValue"), ...roleSlots("TargetValue")], extra: [] };
    default:
      return { groups: [], values: [], extra: [] };
  }
}

function tupleArg(t: TupleFilter): string | null {
  if (!t.rows.length || !t.fields.length) return null;
  const rows = t.rows.map((r) => (r.length === 1 ? litDax(r[0]) : `(${r.map(litDax).join(", ")})`));
  return `TREATAS({${rows.join(", ")}}, ${t.fields.map(columnDax).join(", ")})`;
}

function sortByCol(model: ModelInfo, f: FieldRef): FieldRef | null {
  if (f.kind !== "column") return null;
  const s = model.sortByColumn(f.table, f.name);
  return s ? { kind: "column", table: f.table, name: s } : null;
}

/** Whether the default order of the visual is by its first value (largest first) instead of by category. */
function sortsByValueByDefault(typeId: string, family: VisualFamily, model: ModelInfo, firstGroup: FieldRef | undefined): boolean {
  if (!firstGroup) return false;
  if (family === "pie" || family === "funnel" || family === "treemap") return true;
  if (family !== "cartesian") return false;
  if (["lineChart", "areaChart", "stackedAreaChart", "hundredPercentStackedAreaChart", "lineClusteredColumnComboChart"].includes(typeId)) return false;
  return model.columnType(firstGroup.table, firstGroup.name) !== "dateTime";
}

/** Primary build function for the grouped (non-matrix, non-slicer) visuals. Returns null when nothing is bound. */
export function buildVisualQuery(v: VisualModel, model: ModelInfo, opt: QueryOptions): BuiltQuery | null {
  const type = visualType(v.visualType);
  if (!type) return null;
  const { groups, values, extra } = slotsFor(v, type.family, opt.drill);
  if (groups.length === 0 && values.length === 0) return null;
  const byValue = values.length > 0 && sortsByValueByDefault(v.visualType, type.family, model, groups[0]?.field);
  return assemble(model, groups, values, [...opt.filters, ...extra], opt.tuples ?? [], v.sort, byValue);
}

/** Grand totals of the value fields of a table, under the same filters (one row). */
export function buildTotalsQuery(v: VisualModel, model: ModelInfo, opt: QueryOptions): BuiltQuery | null {
  const type = visualType(v.visualType);
  if (!type) return null;
  const { values } = slotsFor(v, type.family, opt.drill);
  return values.length ? assemble(model, [], values, opt.filters, opt.tuples ?? [], null, false) : null;
}

function assemble(model: ModelInfo, groups: Slot[], values: Slot[], filters: FilterDef[], tuples: TupleFilter[], sort: SortSpec | null, byValue: boolean): BuiltQuery {
  const fa = filtersToDax(filters);
  const args = [...fa.args, ...tuples.map(tupleArg).filter((x): x is string => x !== null)];
  const columns: PlannedColumn[] = [];
  const groupDax: string[] = [];
  const add = (s: Slot, kind: PlannedColumn["kind"]) => {
    columns.push({ index: columns.length, role: s.role, field: s.field, label: fieldLabel(s.field), kind, format: fieldFormat(model, s.field), order: s.order });
  };
  const sortHelper = new Map<string, FieldRef>(); // group column key -> the column to order by instead
  const keyOf = (f: FieldRef) => `${f.table}|${f.name}`.toLowerCase();
  for (const g of groups) {
    groupDax.push(columnDax(g.field));
    add(g, "group");
  }
  for (const g of groups) {
    const sb = sortByCol(model, g.field);
    if (sb && !columns.some((c) => sameField(c.field, sb))) {
      sortHelper.set(keyOf(g.field), sb);
      groupDax.push(columnDax(sb));
      add({ role: g.role, field: sb, order: g.order }, "helper");
    }
  }
  const measureDax: string[] = [];
  values.forEach((s, i) => {
    measureDax.push(`"m${i}", ${valueDax(s.field)}`);
    add(s, "value");
  });
  fa.post.forEach((p, j) => {
    measureDax.push(`"__f${j}", ${p.expr}`);
    columns.push({ index: columns.length, role: "__filter", field: { kind: "measure", table: "", name: `__f${j}` }, label: `__f${j}`, kind: "helper", format: null, order: j });
  });

  const body = `SUMMARIZECOLUMNS(${[...groupDax, ...args, ...measureDax].join(", ")})`;
  const filtered = fa.post.length ? `FILTER(${body}, ${fa.post.map((p, j) => condDax(`[__f${j}]`, p.cond)).join(" && ")})` : body;

  // ORDER BY: the explicit sort, else the family default, then the group columns so that ties are stable
  const order: string[] = [];
  const pushGroup = (f: FieldRef, dir: string) => {
    const text = `${columnDax(sortHelper.get(keyOf(f)) ?? f)} ${dir}`;
    if (!order.includes(text)) order.push(text);
  };
  const dirOf = (d: "asc" | "desc") => (d === "asc" ? "ASC" : "DESC");
  let explicit = false;
  let valueSort: BuiltQuery["valueSort"];
  if (sort) {
    const g = groups.find((x) => sameField(x.field, sort.field));
    const vi = values.findIndex((x) => sameField(x.field, sort.field));
    if (g) pushGroup(g.field, dirOf(sort.dir));
    else if (vi >= 0) {
      order.push(`[m${vi}] ${dirOf(sort.dir)}`);
      valueSort = { valueIndex: vi, dir: sort.dir };
    }
    explicit = !!g || vi >= 0;
  }
  if (!explicit && byValue) {
    order.push("[m0] DESC");
    valueSort = { valueIndex: 0, dir: "desc" };
  }
  for (const g of groups) pushGroup(g.field, "ASC");
  return { dax: `EVALUATE ${filtered}${order.length ? `\nORDER BY ${order.join(", ")}` : ""}`, columns, ...(valueSort ? { valueSort } : {}) };
}

// ---- matrix -----------------------------------------------------------------------------------

export interface MatrixPart {
  rowDepth: number;
  colDepth: number;
  columns: PlannedColumn[];
}

export interface BuiltMatrixQuery {
  /** One EVALUATE per part. */
  dax: string;
  parts: MatrixPart[];
  rows: FieldRef[];
  cols: FieldRef[];
  values: FieldRef[];
}

/**
 * A matrix needs the leaf cells plus the subtotal and total at each row/column depth, so it sends one EVALUATE
 * per (row depth, column depth) pair in a single query.
 */
export function buildMatrixQuery(v: VisualModel, model: ModelInfo, opt: QueryOptions): BuiltMatrixQuery | null {
  const rows = rolesOf(v, "Rows");
  const cols = rolesOf(v, "Columns");
  const values = rolesOf(v, "Values");
  if (!rows.length && !cols.length && !values.length) return null;
  const parts: MatrixPart[] = [];
  const stmts: string[] = [];
  for (let rd = 0; rd <= rows.length; rd++) {
    for (let cd = 0; cd <= cols.length; cd++) {
      // without values only the leaf combination is useful
      if (!values.length && !(rd === rows.length && cd === cols.length)) continue;
      const groups: Slot[] = [...rows.slice(0, rd).map((field, order) => ({ role: "Rows", field, order })), ...cols.slice(0, cd).map((field, order) => ({ role: "Columns", field, order }))];
      const vals: Slot[] = values.map((field, order) => ({ role: "Values", field, order }));
      if (!groups.length && !vals.length) continue;
      const q = assemble(model, groups, vals, opt.filters, opt.tuples ?? [], null, false);
      parts.push({ rowDepth: rd, colDepth: cd, columns: q.columns });
      stmts.push(q.dax);
    }
  }
  return { dax: stmts.join("\n"), parts, rows, cols, values };
}

// ---- slicers -----------------------------------------------------------------------------------

export interface SlicerQuery {
  dax: string;
  field: FieldRef;
  /** The column sorts by another column; it is the second result column and not shown. */
  sortHelper: boolean;
}

/** The selectable values of a slicer: only filters that reach the column's table narrow the list. */
export function buildSlicerQuery(field: FieldRef, model: ModelInfo, filters: FilterDef[]): SlicerQuery {
  const fa = filtersToDax(filters.filter((f) => f.cond.kind !== "topN"));
  const col = columnDax(field);
  const sb = sortByCol(model, field);
  const inner = sb ? `SUMMARIZE(${quoteTable(field.table)}, ${col}, ${columnDax(sb)})` : `VALUES(${col})`;
  const body = fa.args.length ? `CALCULATETABLE(${inner}, ${fa.args.join(", ")})` : inner;
  return { dax: `EVALUATE ${body}\nORDER BY ${sb ? `${columnDax(sb)}, ` : ""}${col}`, field, sortHelper: !!sb };
}

export interface HierarchyQuery {
  dax: string;
  fields: FieldRef[];
}

/** The existing combinations of the levels of a hierarchy slicer, in level order, under the filters of the other slicers. */
export function buildHierarchyQuery(fields: FieldRef[], filters: FilterDef[]): HierarchyQuery {
  const fa = filtersToDax(filters.filter((f) => f.cond.kind !== "topN"));
  const cols = fields.map(columnDax);
  const body = `SUMMARIZECOLUMNS(${[...cols, ...fa.args].join(", ")})`;
  return { dax: `EVALUATE ${body}
ORDER BY ${cols.join(", ")}`, fields };
}

/** Smallest and largest value of a column under the filters (range slicers). */
export function buildRangeQuery(field: FieldRef, filters: FilterDef[]): string {
  const fa = filtersToDax(filters.filter((f) => f.cond.kind !== "topN"));
  const col = columnDax(field);
  const wrap = (e: string) => (fa.args.length ? `CALCULATE(${e}, ${fa.args.join(", ")})` : e);
  return `EVALUATE ROW("min", ${wrap(`MIN(${col})`)}, "max", ${wrap(`MAX(${col})`)})`;
}
