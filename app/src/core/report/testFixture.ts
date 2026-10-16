// Test support: the DAX fixture data (tests/dax/fixtures) loaded in TypeScript, a ModelInfo for it, and helpers to
// build visuals. The expected values in report tests are computed here from the CSV files, independently of the
// DAX engine.
import salesCsv from "../../../../tests/dax/fixtures/Sales.csv?raw";
import productCsv from "../../../../tests/dax/fixtures/Product.csv?raw";
import customerCsv from "../../../../tests/dax/fixtures/Customer.csv?raw";
import dateCsv from "../../../../tests/dax/fixtures/Date.csv?raw";
import { measure, type AggFn, type FieldRef } from "./fields";
import type { ModelInfo } from "./modelInfo";
const REPORT_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.3.0/schema.json";
import { PAGE_SCHEMA, PAGES_SCHEMA, parseVisual, projectionJson, VISUAL_SCHEMA, type Projection, type VisualModel } from "./visualDoc";
import type { Project, TmdlNode } from "../model/types";
import { sampleProject } from "../testing/fakes";

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

// ---- a Project with the fixture model and an empty one-page report ---------------------------------

const tnode = (kind: string, name: string, extra: Partial<TmdlNode> = {}): TmdlNode => ({ description: [], kind, name, default: null, props: [], children: [], ...extra });

export function fixtureProject(measures: Record<string, { name: string; expr: string; format?: string }[]> = {}): Project {
  const p = sampleProject("Fixture");
  p.model.tmdl = {
    "model.tmdl": { nodes: [tnode("model", "Model")] },
    ...Object.fromEntries(
      Object.entries(TABLE_COLUMNS).map(([t, cols]) => [
        `tables/${t}.tmdl`,
        {
          nodes: [
            tnode("table", t, {
              children: [
                ...Object.entries(cols).map(([c, dt]) => tnode("column", c, { props: [{ key: "dataType", value: { Text: dt } }] })),
                ...(measures[t] ?? []).map((m) =>
                  tnode("measure", m.name, { default: { text: m.expr, verbatim: false }, props: m.format ? [{ key: "formatString", value: { Text: m.format } }] : [] }),
                ),
              ],
            }),
          ],
        },
      ]),
    ),
  };
  p.report = {
    pbir: {},
    platform: null,
    files: {
      "version.json": { $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json", version: "2.0.0" },
      "report.json": { $schema: REPORT_SCHEMA, themeCollection: { baseTheme: { name: "CY24SU10", reportVersionAtImport: { visual: "1.8.0", page: "1.0.0", report: "1.0.0" }, type: "SharedResources" } } },
      "pages/pages.json": { $schema: PAGES_SCHEMA, pageOrder: ["page1"], activePageName: "page1" },
      "pages/page1/page.json": { $schema: PAGE_SCHEMA, name: "page1", displayName: "Page 1", displayOption: "FitToPage", height: 720, width: 1280 },
    },
    static_resources: {},
  };
  return p;
}
