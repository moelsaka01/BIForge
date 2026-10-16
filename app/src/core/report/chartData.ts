// Shaping of result rows for the renderers: labels, point references, category/series pivoting.
import { isoOf, isNumeric, valueKey, type Value } from "./cells";
import { lit, type FieldRef, type Lit } from "./fields";
import type { SelectedPoint } from "./interactions";
import type { BuiltQuery, PlannedColumn } from "./queryBuilder";
import { formatNumber } from "./numberFormat";

export const BLANK_LABEL = "(Blank)";

/** Text for a group value. Numbers use the field's format; dates and text are shown as the engine sent them. */
export function labelOf(v: Value, format?: string | null): string {
  if (v.kind === "blank") return BLANK_LABEL;
  if (isNumeric(v) && v.num !== null) return formatNumber(v.num, format ?? null);
  return v.text;
}

export function valueToLit(v: Value): Lit {
  switch (v.kind) {
    case "blank":
      return lit.null();
    case "int":
    case "real":
    case "currency":
      return lit.num(v.num ?? NaN);
    case "bool":
      return lit.bool(v.text === "TRUE");
    case "datetime": {
      const iso = isoOf(v);
      return iso ? lit.date(iso) : lit.str(v.text);
    }
    default:
      return lit.str(v.text);
  }
}

export const num = (v: Value | undefined): number | null => (v && isNumeric(v) && v.num !== null && Number.isFinite(v.num) ? v.num : null);

export function columnsOf(q: BuiltQuery, role: string, kind: PlannedColumn["kind"]): PlannedColumn[] {
  return q.columns.filter((c) => c.role === role && c.kind === kind).sort((a, b) => a.order - b.order);
}

export interface Category {
  key: string;
  label: string;
  values: Value[];
  /** Index of the first row of the category (selection lookups). */
  firstRow: number;
}

export interface Pivot {
  categories: Category[];
  series: { key: string; label: string; value: Value | null }[];
  /** cells[valueIdx][seriesIdx][categoryIdx] */
  cells: (number | null)[][][];
  catFields: FieldRef[];
  serField: FieldRef | null;
}

/**
 * Arranges rows into categories x series x measures. Categories keep the order of the rows, or are ordered by the
 * total of the sort measure when the query sorts by value (rows of one category are then not adjacent).
 */
export function pivot(rows: Value[][], q: BuiltQuery, catRole: string, serRole: string | null, valueRoles: string[]): Pivot {
  const cats = columnsOf(q, catRole, "group");
  const ser = serRole ? columnsOf(q, serRole, "group")[0] : undefined;
  const vals = valueRoles.flatMap((r) => columnsOf(q, r, "value"));
  const catIdx = new Map<string, number>();
  const serIdx = new Map<string, number>();
  const categories: Category[] = [];
  const series: Pivot["series"] = [];
  const cells: (number | null)[][][] = vals.map(() => []);
  rows.forEach((row, r) => {
    const ck = cats.map((c) => valueKey(row[c.index])).join("\u0001");
    let ci = catIdx.get(ck);
    if (ci === undefined) {
      ci = categories.length;
      catIdx.set(ck, ci);
      categories.push({ key: ck, label: cats.map((c) => labelOf(row[c.index], c.format)).join(" / "), values: cats.map((c) => row[c.index]), firstRow: r });
    }
    const sk = ser ? valueKey(row[ser.index]) : "";
    let si = serIdx.get(sk);
    if (si === undefined) {
      si = series.length;
      serIdx.set(sk, si);
      series.push({ key: sk, label: ser ? labelOf(row[ser.index], ser.format) : "", value: ser ? row[ser.index] : null });
      cells.forEach((c) => c.push([]));
    }
    vals.forEach((v, vi) => {
      cells[vi][si][ci] = num(row[v.index]);
    });
  });
  if (!series.length) {
    series.push({ key: "", label: "", value: null });
    cells.forEach((c) => c.push([]));
  }
  const p: Pivot = { categories, series, cells, catFields: cats.map((c) => c.field), serField: ser?.field ?? null };
  if (q.valueSort && cells[q.valueSort.valueIndex] && categories.length) {
    const m = cells[q.valueSort.valueIndex];
    const total = (ci: number) => m.reduce((a, s) => a + (s[ci] ?? 0), 0);
    const order = categories.map((_, i) => i).sort((a, b) => (q.valueSort!.dir === "desc" ? total(b) - total(a) : total(a) - total(b)) || a - b);
    p.categories = order.map((i) => categories[i]);
    p.cells = cells.map((vm) => vm.map((s) => order.map((i) => s[i] ?? null)));
  } else {
    p.cells = cells.map((vm) => vm.map((s) => categories.map((_, i) => s[i] ?? null)));
  }
  return p;
}

export function pointOfCategory(p: Pivot, ci: number, si: number | null): SelectedPoint {
  const c = p.categories[ci];
  const fields = [...p.catFields];
  const values = c.values.map(valueToLit);
  if (si !== null && p.serField && p.series[si]?.value) {
    fields.push(p.serField);
    values.push(valueToLit(p.series[si].value!));
  }
  return { fields, values };
}
