import { describe, expect, it } from "vitest";
import { agg, column, lit, measure } from "./fields";
import { condDax, filterFromPbir, filterToPbir, filtersToDax, readFilters, writeFilters, type Cond, type FilterDef } from "./filters";
import { decodeLit, encodeLit, fieldFromPbir, fieldToPbir } from "./pbir";

const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);

describe("literals and fields in PBIR form", () => {
  it("round-trips every literal type", () => {
    for (const l of [lit.str("it's"), lit.num(3), lit.num(2.5), lit.num(-4), lit.bool(true), lit.bool(false), lit.date("2024-03-01T00:00:00"), lit.null()]) {
      expect(decodeLit(encodeLit(l))).toEqual(l);
    }
    expect(encodeLit(lit.str("it's"))).toBe("'it''s'");
    expect(encodeLit(lit.date("2024-03-01"))).toBe("datetime'2024-03-01T00:00:00'");
    expect(decodeLit("2.4M")).toEqual(lit.num(2.4));
    expect(decodeLit("nonsense")).toBeNull();
  });

  it("round-trips fields, with entity names or filter aliases", () => {
    for (const f of [Cat, measure("Sales", "Total"), Qty, agg("Sales", "Quantity", 6)]) expect(fieldFromPbir(fieldToPbir(f))).toEqual(f);
    const aliased = fieldToPbir(Cat, { alias: { Product: "p" } });
    expect(aliased.Column.Expression.SourceRef).toEqual({ Source: "p" });
    expect(fieldFromPbir(aliased, { p: "Product" })).toEqual(Cat);
    expect(fieldFromPbir({ Aggregation: { Expression: { Column: fieldToPbir(Cat).Column }, Function: 99 } })).toBeNull();
    expect(fieldToPbir(Qty)).toEqual({ Aggregation: { Expression: { Column: { Expression: { SourceRef: { Entity: "Sales" } }, Property: "Quantity" } }, Function: 0 } });
  });
});

const conds: Cond[] = [
  { kind: "in", values: [lit.str("a"), lit.str("b")] },
  { kind: "notIn", values: [lit.str("a")] },
  { kind: "cmp", op: "eq", value: lit.num(1) },
  { kind: "cmp", op: "ne", value: lit.num(1) },
  { kind: "cmp", op: "gt", value: lit.num(1) },
  { kind: "cmp", op: "ge", value: lit.num(1) },
  { kind: "cmp", op: "lt", value: lit.num(1) },
  { kind: "cmp", op: "le", value: lit.num(1) },
  { kind: "between", lo: lit.num(1), hi: lit.num(5) },
  { kind: "text", op: "contains", value: "x" },
  { kind: "text", op: "notContains", value: "x" },
  { kind: "text", op: "startsWith", value: "x" },
  { kind: "text", op: "notStartsWith", value: "x" },
  { kind: "blank" },
  { kind: "notBlank" },
  { kind: "compound", op: "and", a: { kind: "cmp", op: "gt", value: lit.num(1) }, b: { kind: "cmp", op: "lt", value: lit.num(9) } },
  { kind: "compound", op: "or", a: { kind: "blank" }, b: { kind: "cmp", op: "eq", value: lit.num(0) } },
];

describe("filters in PBIR form", () => {
  it("round-trip every condition type", () => {
    for (const cond of conds) {
      const d: FilterDef = { name: "f1", field: Cat, cond };
      expect(filterFromPbir(filterToPbir(d)), JSON.stringify(cond)).toEqual(d);
    }
  });

  it("round-trips Top N, with the subquery form of the schema", () => {
    const d: FilterDef = { name: "t", field: Cat, cond: { kind: "topN", n: 5, dir: "top", by: Qty } };
    const c = filterToPbir(d);
    expect(c.type).toBe("TopN");
    expect(c.filter.From[0].Expression.Subquery.Query.Top).toBe(5);
    expect(filterFromPbir(c)).toEqual(d);
    const b = filterToPbir({ ...d, cond: { kind: "topN", n: 2, dir: "bottom", by: Qty } });
    expect(filterFromPbir(b)?.cond).toMatchObject({ dir: "bottom", n: 2 });
  });

  it("uses the container types of the schema", () => {
    expect(filterToPbir({ name: "a", field: Cat, cond: { kind: "in", values: [lit.str("x")] } }).type).toBe("Categorical");
    expect(filterToPbir({ name: "a", field: Cat, cond: { kind: "between", lo: lit.num(1), hi: lit.num(2) } }).type).toBe("Range");
    expect(filterToPbir({ name: "a", field: Cat, cond: { kind: "blank" } }).type).toBe("Advanced");
    expect(filterToPbir({ name: "a", field: Cat, cond: { kind: "in", values: [lit.str("x")] }, hidden: true, locked: true })).toMatchObject({ isHiddenInViewMode: true, isLockedInViewMode: true });
  });

  it("keeps filters it cannot interpret and never applies them", () => {
    const odd = { name: "odd", field: fieldToPbir(Cat), type: "Advanced", filter: { Version: 2, From: [{ Name: "p", Entity: "Product", Type: 0 }], Where: [{ Condition: { Exists: {} } }] } };
    const holder: { filterConfig?: { filters: unknown[] } } = { filterConfig: { filters: [odd, filterToPbir({ name: "a", field: Cat, cond: { kind: "in", values: [lit.str("x")] } })] } };
    const r = readFilters(holder as never);
    expect(r.defs.map((d) => d.name)).toEqual(["a"]);
    expect(r.opaque).toEqual([odd]);
    writeFilters(holder as never, [], r.opaque);
    expect(holder.filterConfig!.filters).toEqual([odd]);
    writeFilters(holder as never, [], []);
    expect(holder.filterConfig).toBeUndefined();
  });

  it("stores relative-date filters as annotations, which Power BI ignores", () => {
    const holder: Record<string, unknown> = {};
    const d: FilterDef = { name: "rd", field: column("Date", "Date"), cond: { kind: "relativeDate", op: "last", n: 7, unit: "days", includeToday: true } };
    writeFilters(holder as never, [d], []);
    expect(holder.filterConfig).toBeUndefined();
    expect((holder.annotations as { name: string }[])[0].name).toBe("biforge.relativeDate.rd");
    expect(readFilters(holder as never).defs).toEqual([d]);
  });
});

describe("filters in DAX", () => {
  const x = "Product[Category]";
  it("renders conditions", () => {
    expect(condDax(x, { kind: "in", values: [lit.str("a"), lit.str('q"x')] })).toBe('Product[Category] IN {"a", "q""x"}');
    expect(condDax(x, { kind: "in", values: [lit.str("a"), lit.null()] })).toBe('(Product[Category] IN {"a"} || ISBLANK(Product[Category]))');
    expect(condDax(x, { kind: "notIn", values: [lit.str("a")] })).toBe('NOT (Product[Category] IN {"a"})');
    expect(condDax(x, { kind: "cmp", op: "ne", value: lit.num(3) })).toBe("Product[Category] <> 3");
    expect(condDax(x, { kind: "cmp", op: "eq", value: lit.null() })).toBe("ISBLANK(Product[Category])");
    expect(condDax(x, { kind: "between", lo: lit.date("2024-01-02"), hi: lit.date("2024-03-04T00:00:00") })).toBe("(Product[Category] >= DATE(2024, 1, 2) && Product[Category] <= DATE(2024, 3, 4))");
    expect(condDax(x, { kind: "text", op: "startsWith", value: "ab" })).toBe('(LEFT(Product[Category], 2) = "ab")');
    expect(condDax(x, { kind: "text", op: "notContains", value: "ab" })).toBe('NOT CONTAINSSTRING(Product[Category], "ab")');
    expect(condDax(x, { kind: "blank" })).toBe("ISBLANK(Product[Category])");
    expect(() => condDax(x, { kind: "topN", n: 1, dir: "top", by: Qty })).toThrow();
  });

  it("relative dates are bounded by calendar units around today", () => {
    const d = (op: "last" | "this" | "next", n: number, unit: "days" | "weeks" | "months" | "years", includeToday = false) => condDax("D", { kind: "relativeDate", op, n, unit, includeToday });
    expect(d("last", 7, "days")).toBe("(D >= (TODAY() + -7) && D <= (TODAY() - 1))");
    expect(d("last", 7, "days", true)).toBe("(D >= (TODAY() + -7) && D <= TODAY())");
    expect(d("this", 1, "months")).toBe("(D >= DATE(YEAR(TODAY()), MONTH(TODAY()), 1) && D <= (EDATE(DATE(YEAR(TODAY()), MONTH(TODAY()), 1), 1) - 1))");
    expect(d("next", 2, "years")).toContain("EDATE(DATE(YEAR(TODAY()), 1, 1), 36) - 1");
    expect(d("last", 2, "weeks")).toContain("(TODAY() - (WEEKDAY(TODAY(), 1) - 1))");
  });

  it("merges filters per column, separates measure filters, skips empty selections", () => {
    const fa = filtersToDax([
      { name: "1", field: Cat, cond: { kind: "in", values: [lit.str("a")] } },
      { name: "2", field: Cat, cond: { kind: "notIn", values: [lit.str("b")] } },
      { name: "3", field: column("Customer", "Country"), cond: { kind: "in", values: [] } },
      { name: "4", field: Qty, cond: { kind: "cmp", op: "gt", value: lit.num(5) } },
    ]);
    expect(fa.args).toEqual(['FILTER(ALL(Product[Category]), Product[Category] IN {"a"} && NOT (Product[Category] IN {"b"}))']);
    expect(fa.post).toEqual([{ expr: "SUM(Sales[Quantity])", cond: { kind: "cmp", op: "gt", value: lit.num(5) } }]);
  });
});
