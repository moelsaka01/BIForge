import { describe, expect, it } from "vitest";
import { quickExpression, quickName, splitColumn, type QuickSpec } from "./quickMeasures";

const base = "Sales[Quantity]";
const cat = "Product[Category]";
const date = "'Date'[Date]";

/** Every calculation on the fixture's fields; the Rust test tests/quick_measures.rs runs these over the DAX fixture. */
export const CASES: { id: string; spec: QuickSpec; group: string }[] = [
  { id: "sum", spec: { kind: "sum", base, category: cat }, group: cat },
  { id: "average", spec: { kind: "average", base, category: cat }, group: cat },
  { id: "max", spec: { kind: "max", base, category: cat }, group: cat },
  { id: "min", spec: { kind: "min", base, category: cat }, group: cat },
  { id: "count", spec: { kind: "count", base, category: cat }, group: cat },
  { id: "distinctCount", spec: { kind: "distinctCount", base: "Sales[CustomerKey]", category: cat }, group: cat },
  { id: "runningTotal", spec: { kind: "runningTotal", base, category: cat }, group: cat },
  { id: "percentOfTotal", spec: { kind: "percentOfTotal", base }, group: cat },
  { id: "ytd", spec: { kind: "ytd", base, date }, group: "'Date'[Month]" },
  { id: "qtd", spec: { kind: "qtd", base, date }, group: "'Date'[Month]" },
  { id: "mtd", spec: { kind: "mtd", base, date }, group: "'Date'[Month]" },
  { id: "sameLastYear", spec: { kind: "sameLastYear", base, date }, group: "'Date'[Year]" },
  { id: "yoy", spec: { kind: "yoy", base, date }, group: "'Date'[Year]" },
  { id: "yoyPercent", spec: { kind: "yoyPercent", base, date }, group: "'Date'[Year]" },
  { id: "rollingAverage", spec: { kind: "rollingAverage", base, date, periods: 3, periodUnit: "MONTH" }, group: "'Date'[YearMonth]" },
];

describe("quick measures", () => {
  it("write the DAX of each calculation", () => {
    expect(quickExpression({ kind: "average", base, category: cat })).toBe("AVERAGEX(VALUES(Product[Category]), CALCULATE(SUM(Sales[Quantity])))");
    expect(quickExpression({ kind: "ytd", base, date })).toBe("TOTALYTD(SUM(Sales[Quantity]), 'Date'[Date])");
    expect(quickExpression({ kind: "percentOfTotal", base: "[Total]" })).toBe("DIVIDE([Total], CALCULATE([Total], ALLSELECTED()))");
    expect(quickExpression({ kind: "yoy", base: "[Total]", date })).toContain("VAR __prev = CALCULATE([Total], SAMEPERIODLASTYEAR('Date'[Date]))");
    expect(quickExpression({ kind: "rollingAverage", base, date, periods: 6, periodUnit: "DAY" })).toBe("AVERAGEX(DATESINPERIOD('Date'[Date], MAX('Date'[Date]), -6, DAY), CALCULATE(SUM(Sales[Quantity])))");
    expect(quickName({ kind: "ytd", base })).toBe("Quantity YTD");
    expect(quickName({ kind: "runningTotal", base, category: cat })).toBe("Quantity running total in Category");
  });

  it("refuse missing or wrong fields", () => {
    expect(() => quickExpression({ kind: "sum", base: "" })).toThrow("base value");
    expect(() => quickExpression({ kind: "sum", base })).toThrow("category");
    expect(() => quickExpression({ kind: "ytd", base })).toThrow("date");
    expect(() => quickExpression({ kind: "sum", base: "[Total]", category: cat })).toThrow("needs a column");
    expect(() => quickExpression({ kind: "sum", base: "nonsense", category: cat })).toThrow("not a column");
    expect(() => quickExpression({ kind: "rollingAverage", base, date, periods: 0 })).toThrow("at least 1");
    expect(splitColumn("'My T'[A b]")).toEqual({ table: "My T", column: "A b" });
  });

  it("every case builds", () => {
    for (const c of CASES) expect(() => quickExpression(c.spec), c.id).not.toThrow();
  });
});
