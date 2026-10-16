import { describe, expect, it } from "vitest";
import { column, agg, lit, type FieldRef, type Lit } from "./fields";
import type { FilterDef } from "./filters";
import { buildMatrixQuery, buildRangeQuery, buildSlicerQuery, buildVisualQuery, drillPlan, NO_DRILL, type TupleFilter } from "./queryBuilder";
import { fixtureModel, loadCsv, sumOf, visualOf, type Row } from "./testFixture";

// ---- oracle: the expected answers computed from the CSV files, not by the DAX engine -------------
const sales = loadCsv("Sales");
const products = new Map(loadCsv("Product").map((r) => [r.ProductKey, r]));
const customers = new Map(loadCsv("Customer").map((r) => [r.CustomerKey, r]));
const dates = new Map(loadCsv("Date").map((r) => [r.Date, r]));

interface J {
  s: Row;
  p: Row | null;
  c: Row | null;
  d: Row | null;
}
const joined: J[] = sales.map((s) => ({ s, p: products.get(s.ProductKey) ?? null, c: customers.get(s.CustomerKey) ?? null, d: dates.get(s.OrderDate) ?? null }));
const qty = (j: J) => (j.s.Quantity === "" ? null : Number(j.s.Quantity));
const blankToNull = (x: string | undefined | null): string | null => (x === undefined || x === null ? null : x);

type Cell = string | number | null;

function groupSum(rows: J[], keys: ((j: J) => Cell)[], value: (rows: J[]) => number | null, order?: "valueDesc"): Cell[][] {
  const groups = new Map<string, { key: Cell[]; rows: J[] }>();
  for (const r of rows) {
    const key = keys.map((k) => k(r));
    const id = JSON.stringify(key);
    if (!groups.has(id)) groups.set(id, { key, rows: [] });
    groups.get(id)!.rows.push(r);
  }
  const out = [...groups.values()].map((g) => ({ key: g.key, v: value(g.rows) })).filter((g) => g.v !== null);
  const cmp = (a: Cell, b: Cell) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
  out.sort((a, b) => {
    if (order === "valueDesc" && a.v !== b.v) return (b.v as number) - (a.v as number);
    for (let i = 0; i < a.key.length; i++) {
      const c = cmp(a.key[i], b.key[i]);
      if (c) return c;
    }
    return 0;
  });
  return out.map((g) => [...g.key, g.v]);
}
const sumQty = (rows: J[]) => {
  const v = rows.map(qty).filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};
const cat = (j: J) => (j.p ? blankToNull(j.p.Category) : null);
const country = (j: J) => (j.c ? j.c.Country : null);

// ---- cases ------------------------------------------------------------------------------------------
const model = fixtureModel();
const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Qty = sumOf("Sales", "Quantity");

const inF = (name: string, field: FieldRef, ...vals: string[]): FilterDef => ({ name, field, cond: { kind: "in", values: vals.map(lit.str) } });

interface GoldenCase {
  id: string;
  dax: string;
  /** One row set per EVALUATE. */
  expected: Cell[][][];
  ordered: boolean;
}
const cases: GoldenCase[] = [];

function visualCase(id: string, v: ReturnType<typeof visualOf>, expected: Cell[][], opt: { filters?: FilterDef[]; tuples?: TupleFilter[]; drill?: typeof NO_DRILL; ordered?: boolean; dropColumns?: number } = {}) {
  const q = buildVisualQuery(v, model, { filters: opt.filters ?? [], tuples: opt.tuples, drill: opt.drill });
  expect(q, id).not.toBeNull();
  cases.push({ id, dax: q!.dax, expected: [expected], ordered: opt.ordered ?? true });
}

describe("visual queries (checked against values computed from the fixture CSV files)", () => {
  it("column chart: sum by category, largest first, blank group included", () => {
    visualCase("column.sum-by-category", visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] }), groupSum(joined, [cat], sumQty, "valueDesc"));
  });

  it("category + series", () => {
    visualCase("column.category-series", visualOf("stackedColumnChart", { Category: [Cat], Series: [Country], Y: [Qty] }), groupSum(joined, [cat, country], sumQty, "valueDesc"));
  });

  it("report/page filters narrow the data through relationships", () => {
    const filters = [inF("f1", Country, "France", "Germany"), { name: "f2", field: column("Date", "Year"), cond: { kind: "in", values: [lit.num(2024)] } } as FilterDef];
    const rows = joined.filter((j) => j.c && ["France", "Germany"].includes(j.c.Country) && j.d && j.d.Year === "2024");
    visualCase("column.filtered", visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] }), groupSum(rows, [cat], sumQty, "valueDesc"), { filters });
  });

  it("two filters on one column are combined (AND)", () => {
    const filters: FilterDef[] = [
      { name: "a", field: column("Sales", "Quantity"), cond: { kind: "cmp", op: "ge", value: lit.num(2) } },
      { name: "b", field: column("Sales", "Quantity"), cond: { kind: "cmp", op: "le", value: lit.num(4) } },
    ];
    const rows = joined.filter((j) => qty(j) !== null && qty(j)! >= 2 && qty(j)! <= 4);
    visualCase("column.range-and", visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] }), groupSum(rows, [cat], sumQty, "valueDesc"), { filters });
  });

  it("not-in, text and blank conditions", () => {
    const f1: FilterDef[] = [{ name: "n", field: Cat, cond: { kind: "notIn", values: [lit.str("Bikes")] } }];
    visualCase("filter.notin", visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] }), groupSum(joined.filter((j) => cat(j) !== "Bikes"), [cat], sumQty, "valueDesc"), { filters: f1 });
    const f2: FilterDef[] = [{ name: "t", field: column("Product", "Product"), cond: { kind: "text", op: "contains", value: "bike" } }];
    visualCase("filter.text-contains", visualOf("clusteredColumnChart", { Category: [column("Product", "Product")], Y: [Qty] }), groupSum(joined.filter((j) => j.p && j.p.Product.toLowerCase().includes("bike")), [(j) => j.p!.Product], sumQty, "valueDesc"), { filters: f2 });
    const f3: FilterDef[] = [{ name: "s", field: column("Product", "Product"), cond: { kind: "text", op: "startsWith", value: "ki" } }];
    visualCase("filter.text-startswith", visualOf("clusteredColumnChart", { Category: [column("Product", "Product")], Y: [Qty] }), groupSum(joined.filter((j) => j.p && j.p.Product.toLowerCase().startsWith("ki")), [(j) => j.p!.Product], sumQty, "valueDesc"), { filters: f3 });
  });

  it("between filter on a date and compound advanced filter", () => {
    const f: FilterDef[] = [{ name: "d", field: column("Sales", "OrderDate"), cond: { kind: "between", lo: lit.date("2024-03-01"), hi: lit.date("2024-05-31") } }];
    const rows = joined.filter((j) => j.s.OrderDate >= "2024-03-01" && j.s.OrderDate <= "2024-05-31");
    visualCase("filter.between-date", visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] }), groupSum(rows, [cat], sumQty, "valueDesc"), { filters: f });
    const g: FilterDef[] = [{ name: "c", field: column("Sales", "Quantity"), cond: { kind: "compound", op: "or", a: { kind: "cmp", op: "lt", value: lit.num(0) }, b: { kind: "cmp", op: "gt", value: lit.num(4) } } }];
    const rows2 = joined.filter((j) => qty(j) !== null && (qty(j)! < 0 || qty(j)! > 4));
    visualCase("filter.compound-or", visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] }), groupSum(rows2, [cat], sumQty, "valueDesc"), { filters: g });
  });

  it("top N filter keeps the best categories", () => {
    const Prod = column("Product", "Product");
    const f: FilterDef[] = [{ name: "top", field: Prod, cond: { kind: "topN", n: 3, dir: "top", by: Qty } }];
    const all = groupSum(joined, [(j) => (j.p ? j.p.Product : null)], sumQty, "valueDesc");
    const named = all.filter((r) => r[0] !== null).slice(0, 3);
    visualCase("filter.topn", visualOf("clusteredBarChart", { Category: [Prod], Y: [Qty] }), named, { filters: f });
    const fb: FilterDef[] = [{ name: "bottom", field: Prod, cond: { kind: "topN", n: 2, dir: "bottom", by: Qty } }];
    const bottom = all.slice().sort((a, b) => (a[1] as number) - (b[1] as number)).slice(0, 2).sort((a, b) => (b[1] as number) - (a[1] as number));
    visualCase("filter.bottomn", visualOf("clusteredBarChart", { Category: [Prod], Y: [Qty] }), bottom, { filters: fb });
  });

  it("a filter on a measure keeps groups whose value passes (applied to the result)", () => {
    const f: FilterDef[] = [{ name: "m", field: Qty, cond: { kind: "cmp", op: "gt", value: lit.num(100) } }];
    const rows = groupSum(joined, [cat], sumQty, "valueDesc").filter((r) => (r[1] as number) > 100);
    visualCase("filter.measure-gt", visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] }), rows, { filters: f });
  });

  it("line chart is ordered by the date column; sort by column hides the helper", () => {
    const YM = column("Date", "YearMonth");
    const rows = groupSum(joined, [(j) => (j.d ? Number(j.d.YearMonth) : null)], sumQty);
    visualCase("line.by-yearmonth", visualOf("lineChart", { Category: [YM], Y: [Qty] }), rows);
  });

  it("explicit sort by value ascending and by category descending", () => {
    const asc = groupSum(joined, [cat], sumQty, "valueDesc").slice().reverse();
    visualCase("sort.value-asc", visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] }, { sort: { field: { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Entity: "Sales" } }, Property: "Quantity" } }, Function: 0 } }, direction: "Ascending" } }), asc);
    const desc = groupSum(joined, [cat], sumQty).slice().reverse();
    visualCase("sort.category-desc", visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] }, { sort: { field: { Column: { Expression: { SourceRef: { Entity: "Product" } }, Property: "Category" } }, direction: "Descending" } }), desc);
  });

  it("pie, treemap and funnel group by one field", () => {
    const Color = column("Product", "Color");
    const colorOf = (j: J) => (j.p ? blankToNull(j.p.Color) : null);
    visualCase("pie.by-color", visualOf("pieChart", { Category: [Color], Y: [Qty] }), groupSum(joined, [colorOf], sumQty, "valueDesc"));
    visualCase("treemap.by-category", visualOf("treemap", { Group: [Cat], Values: [Qty] }), groupSum(joined, [cat], sumQty, "valueDesc"));
  });

  it("table: group columns and values, ordered by the first column", () => {
    const rows = groupSum(joined, [cat, country], sumQty);
    visualCase("table.cat-country-qty", visualOf("tableEx", { Values: [Cat, Country, Qty] }), rows);
  });

  it("card: one value, filtered", () => {
    const f = [inF("c", Cat, "Bikes")];
    visualCase("card.bikes", visualOf("card", { Values: [Qty] }), [[sumQty(joined.filter((j) => cat(j) === "Bikes"))]], { filters: f });
  });

  it("scatter has two value axes per point", () => {
    const Prod = column("Product", "Product");
    const n = agg("Sales", "SalesKey", 5);
    const rows = groupSum(joined, [(j) => (j.p ? j.p.Product : null)], sumQty).map((r) => r);
    expect(rows.length).toBeGreaterThan(3);
    const q = buildVisualQuery(visualOf("scatterChart", { Category: [Prod], X: [n], Y: [Qty] }), model, { filters: [] });
    expect(q!.dax).toContain("SUMMARIZECOLUMNS(");
    expect(q!.columns.map((c) => c.role)).toEqual(["Category", "X", "Y"]);
  });

  it("drilling: level 1 under a chosen level-0 value; expand shows both levels", () => {
    const Prod = column("Product", "Product");
    const v = visualOf("clusteredColumnChart", { Category: [Cat, Prod], Y: [Qty] });
    const down = { level: 1, path: [lit.str("Bikes")], expand: false };
    const rows = groupSum(joined.filter((j) => cat(j) === "Bikes"), [(j) => (j.p ? j.p.Product : null)], sumQty, "valueDesc");
    visualCase("drill.down-bikes", v, rows, { drill: down });
    const expand = groupSum(joined, [cat, (j) => (j.p ? j.p.Product : null)], sumQty, "valueDesc");
    visualCase("drill.expand", v, expand, { drill: { level: 1, path: [], expand: true } });
    expect(drillPlan([Cat, Prod], NO_DRILL).fields).toEqual([Cat]);
    expect(drillPlan([Cat, Prod], { level: 5, path: [], expand: false }).fields).toEqual([Prod]);
  });

  it("data point selection (tuples) restricts the other visuals", () => {
    const t: TupleFilter[] = [{ fields: [Cat, Country], rows: [[lit.str("Bikes"), lit.str("France")], [lit.str("Clothing"), lit.str("Canada")]] }];
    const rows = joined.filter((j) => (cat(j) === "Bikes" && country(j) === "France") || (cat(j) === "Clothing" && country(j) === "Canada"));
    visualCase("tuples.two-points", visualOf("clusteredColumnChart", { Category: [column("Product", "Product")], Y: [Qty] }), groupSum(rows, [(j) => (j.p ? j.p.Product : null)], sumQty, "valueDesc"), { tuples: t });
    const single: TupleFilter[] = [{ fields: [Cat], rows: [[lit.str("Bikes")]] }];
    visualCase("tuples.one-point", visualOf("clusteredColumnChart", { Category: [Country], Y: [Qty] }), groupSum(joined.filter((j) => cat(j) === "Bikes"), [country], sumQty, "valueDesc"), { tuples: single });
  });

  it("matrix: one statement per row/column depth with subtotals and the grand total", () => {
    const Ch = column("Sales", "Channel");
    const v = visualOf("pivotTable", { Rows: [Cat, Country], Columns: [Ch], Values: [Qty] });
    const q = buildMatrixQuery(v, model, { filters: [] })!;
    expect(q.parts.map((p) => [p.rowDepth, p.colDepth])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]]);
    const chan = (j: J) => j.s.Channel;
    const exp: Cell[][][] = [
      [[sumQty(joined)]],
      groupSum(joined, [chan], sumQty),
      groupSum(joined, [cat], sumQty),
      groupSum(joined, [cat, chan], sumQty),
      groupSum(joined, [cat, country], sumQty),
      groupSum(joined, [cat, country, chan], sumQty),
    ];
    cases.push({ id: "matrix.depths", dax: q.dax, expected: exp, ordered: true });
  });

  it("a point selected in a chart restricts a matrix whose rows contain the selected category (tuples keep their columns together)", () => {
    const Ch = column("Sales", "Channel");
    const v = visualOf("pivotTable", { Rows: [Cat], Columns: [Ch], Values: [Qty] });
    const tuples: TupleFilter[] = [{ fields: [Cat, Ch], rows: [[lit.str("Bikes"), lit.str("Online")]] }];
    const q = buildMatrixQuery(v, model, { filters: [], tuples })!;
    const rows = joined.filter((j) => cat(j) === "Bikes" && j.s.Channel === "Online");
    const chan = (j: J) => j.s.Channel;
    cases.push({ id: "matrix.tuple-on-row-column", dax: q.dax, expected: [[[sumQty(rows)]], groupSum(rows, [chan], sumQty), groupSum(rows, [cat], sumQty), groupSum(rows, [cat, chan], sumQty)], ordered: true });
  });

  it("slicer values and range", () => {
    const f = [inF("seg", column("Customer", "Segment"), "Consumer")];
    const s = buildSlicerQuery(Country, model, f);
    const countries = [...new Set([...customers.values()].filter((c) => c.Segment === "Consumer").map((c) => c.Country))].sort().map((c) => [c] as Cell[]);
    // blank row: sales with an unknown customer reach the slicer's values only when the blank group is visible
    cases.push({ id: "slicer.country-given-segment", dax: s.dax, expected: [countries], ordered: true });
    const r = buildRangeQuery(column("Sales", "Quantity"), [inF("ch", column("Sales", "Channel"), "Store")]);
    const q = sales.filter((x) => x.Channel === "Store" && x.Quantity !== "").map((x) => Number(x.Quantity));
    cases.push({ id: "slicer.range-store", dax: r, expected: [[[Math.min(...q), Math.max(...q)]]], ordered: false });
  });

  it("nothing bound gives no query", () => {
    expect(buildVisualQuery(visualOf("clusteredColumnChart", {}), model, { filters: [] })).toBeNull();
  });

  it("writes the golden file used by the Rust engine test (crates/engine/tests/report_queries.rs)", async () => {
    const NL = "\n";
    const body = cases
      .map((c) => {
        const sets = c.expected.map((set) => "    [" + set.map((r) => JSON.stringify(r)).join("," + NL + "     ") + "]").join("," + NL);
        return `  {"id": ${JSON.stringify(c.id)}, "ordered": ${c.ordered}, "dax": ${JSON.stringify(c.dax)},${NL}   "expected": [${NL}${sets}${NL}   ]}`;
      })
      .join("," + NL);
    const note = "Generated by app/src/core/report/queryBuilder.test.ts (vitest -u updates it). Expected rows come from the fixture CSV files.";
    const text = `{"note": ${JSON.stringify(note)},${NL} "cases": [${NL}${body}${NL} ]}${NL}`;
    await expect(text).toMatchFileSnapshot("../../../../tests/reports/query-cases.json");
  });
});

void (null as unknown as Lit);
