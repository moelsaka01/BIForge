// Test support: the DAX fixture data (tests/dax/fixtures) loaded in TypeScript, a ModelInfo for it, and helpers to
// build visuals. The expected values in report tests are computed here from the CSV files, independently of the
// DAX engine.
import salesCsv from "../../../../tests/dax/fixtures/Sales.csv?raw";
import productCsv from "../../../../tests/dax/fixtures/Product.csv?raw";
import customerCsv from "../../../../tests/dax/fixtures/Customer.csv?raw";
import dateCsv from "../../../../tests/dax/fixtures/Date.csv?raw";
import { measure, type AggFn, type FieldRef } from "./fields";
import type { ModelInfo } from "./modelInfo";
import { parseVisual, projectionJson, type Projection, type VisualModel } from "./visualDoc";
import { VISUAL_SCHEMA } from "./visualDoc";

const CSV: Record<string, string> = { Sales: salesCsv, Product: productCsv, Customer: customerCsv, Date: dateCsv };

export type Row = Record<string, string>;

export function loadCsv(name: string): Row[] {
  const lines = CSV[name].split(/\r?\n/).filter((l) => l.length);
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
  });
}

export const TABLE_COLUMNS: Record<string, Record<string, string>> = {
  Sales: { SalesKey: "int64", OrderDate: "dateTime", ShipDate: "dateTime", CustomerKey: "int64", ProductKey: "int64", PromotionKey: "int64", Quantity: "int64", UnitPrice: "double", Discount: "double", Channel: "string" },
  Product: { ProductKey: "int64", Product: "string", Category: "string", Subcategory: "string", Color: "string", ListPrice: "double", Cost: "double" },
  Customer: { CustomerKey: "int64", Customer: "string", City: "string", Country: "string", Segment: "string", BirthDate: "dateTime" },
  Date: { Date: "dateTime", Year: "int64", Quarter: "string", MonthNumber: "int64", Month: "string", YearMonth: "int64", DayOfWeek: "int64", IsWeekend: "boolean" },
};

export function fixtureModel(extra: { sortBy?: Record<string, string>; formats?: Record<string, string>; measures?: Record<string, string[]> } = {}): ModelInfo {
  return {
    tables: () => Object.keys(TABLE_COLUMNS),
    columns: (t) => Object.keys(TABLE_COLUMNS[t] ?? {}),
    measures: (t) => extra.measures?.[t] ?? [],
    columnType: (t, c) => TABLE_COLUMNS[t]?.[c] ?? null,
    sortByColumn: (t, c) => extra.sortBy?.[`${t}.${c}`] ?? null,
    formatString: (t, c) => extra.formats?.[`${t}.${c}`] ?? null,
  };
}

/** Builds a visual from role -> fields. */
export function visualOf(visualType: string, roles: Record<string, FieldRef[]>, opt: { name?: string; page?: string; sort?: unknown } = {}): VisualModel {
  const queryState: Record<string, unknown> = {};
  for (const [role, fs] of Object.entries(roles)) queryState[role] = { projections: fs.map((field) => projectionJson({ field } as Projection)) };
  const json = {
    $schema: VISUAL_SCHEMA,
    name: opt.name ?? "v1",
    position: { x: 0, y: 0, z: 0, width: 400, height: 300 },
    visual: { visualType, query: { queryState, ...(opt.sort ? { sortDefinition: { sort: [opt.sort] } } : {}) } },
  };
  return parseVisual(opt.page ?? "page1", json)!;
}

export const sumOf = (table: string, name: string) => ({ kind: "agg" as const, table, name, fn: 0 as AggFn });
export { measure };
