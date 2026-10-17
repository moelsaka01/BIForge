// Builds a report that uses every visual type, filter type, formatting path, bookmarks, page types and a theme, and
// writes its PBIR files to the file named by PBIR_DUMP. tools/pbir-validate checks that file against the public
// JSON schemas. Skipped unless PBIR_DUMP is set.
import { it } from "vitest";
import { createRegistry } from "../commands/builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { agg, column, lit, measure } from "./fields";
import { condFormatToPbir } from "./condFormat";
import { fixtureProject } from "./testFixture";
import { parsePage } from "./visualDoc";
import { VISUAL_TYPES } from "./visualTypes";
import { queryRefOf } from "./pbir";

const DUMP = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PBIR_DUMP;

it.skipIf(!DUMP)("writes a rich report for schema validation", async () => {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject({ Sales: [{ name: "Total", expr: "SUM(Sales[Quantity])", format: "#,0" }] }));
  const reg = createRegistry(session);
  const run = async (id: string, a?: unknown) => {
    const r = await reg.execute(id, a);
    if (!r.ok) throw new Error(`${id}: ${r.message}`);
  };
  const Cat = column("Product", "Category");
  const Qty = agg("Sales", "Quantity", 0);
  const T = measure("Sales", "Total");
  const fieldsFor: Record<string, { role: string; field: unknown }[]> = {
    clusteredBarChart: [{ role: "Category", field: Cat }, { role: "Y", field: T }],
    barChart: [{ role: "Category", field: Cat }, { role: "Series", field: column("Customer", "Country") }, { role: "Y", field: Qty }],
    hundredPercentStackedBarChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
    clusteredColumnChart: [{ role: "Category", field: Cat }, { role: "Category", field: column("Product", "Subcategory") }, { role: "Y", field: Qty }],
    columnChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
    hundredPercentStackedColumnChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
    lineChart: [{ role: "Category", field: column("Date", "Month") }, { role: "Y", field: Qty }],
    areaChart: [{ role: "Category", field: column("Date", "Month") }, { role: "Y", field: Qty }],
    stackedAreaChart: [{ role: "Category", field: column("Date", "Month") }, { role: "Y", field: Qty }],
    lineClusteredColumnComboChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }, { role: "Y2", field: agg("Sales", "UnitPrice", 1) }],
    pieChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
    donutChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
    scatterChart: [{ role: "Category", field: column("Product", "Product") }, { role: "X", field: agg("Product", "ListPrice", 1) }, { role: "Y", field: Qty }],
    tableEx: [{ role: "Values", field: Cat }, { role: "Values", field: Qty }],
    pivotTable: [{ role: "Rows", field: Cat }, { role: "Columns", field: column("Sales", "Channel") }, { role: "Values", field: Qty }],
    card: [{ role: "Values", field: T }],
    multiRowCard: [{ role: "Values", field: Cat }, { role: "Values", field: Qty }],
    kpi: [{ role: "Indicator", field: Qty }, { role: "TrendAxis", field: column("Date", "YearMonth") }],
    gauge: [{ role: "Y", field: Qty }],
    treemap: [{ role: "Group", field: Cat }, { role: "Values", field: Qty }],
    funnel: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
    waterfallChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
    slicer: [{ role: "Values", field: column("Customer", "Country") }],
    map: [{ role: "Category", field: column("Customer", "City") }],
  };
  for (const t of VISUAL_TYPES) await run("report.visual.add", { page: "page1", type: t.id, fields: fieldsFor[t.id] ?? [] });
  const vis = parsePage(session.store.project!, "page1")!.visuals;
  const chart = vis.find((v) => v.visualType === "clusteredBarChart")!;
  const tbl = vis.find((v) => v.visualType === "tableEx")!;
  const slicer = vis.find((v) => v.visualType === "slicer")!;
  const f = (obj: string, prop: string, value: unknown, selector?: string) => run("report.format.set", { page: "page1", visual: chart.name, object: obj, prop, value, selector });
  await f("title", "text", lit.str("My title"));
  await f("title", "fontSize", lit.num(14));
  await f("title", "bold", lit.bool(true));
  await f("background", "color", lit.str("#ffffff"));
  await f("border", "show", lit.bool(true));
  await f("legend", "position", lit.str("Bottom"));
  await f("dataPoint", "fill", lit.str("#ff0000"), "Sum(Sales.Quantity)");
  await f("labels", "show", lit.bool(true));
  await run("report.format.setRaw", { page: "page1", visual: tbl.name, object: "values", prop: "backColor", selector: queryRefOf(Qty), node: condFormatToPbir({ kind: "gradient", input: Qty, min: { color: "#ffffff" }, max: { color: "#00ff00" } }) });
  await run("report.format.setRaw", { page: "page1", visual: tbl.name, object: "values", prop: "fontColor", selector: queryRefOf(Qty), node: condFormatToPbir({ kind: "rules", input: Qty, cases: [{ conds: [{ op: "gt", value: 5 }], color: "#ff0000" }], fallback: "#000000" }) });
  const flt = (scope: unknown, name: string, cond: unknown, field: unknown = Cat) => run("report.filter.upsert", { scope, filter: { name, field, cond } });
  const vs = { level: "visual", page: "page1", visual: chart.name };
  await flt(vs, "a", { kind: "in", values: [lit.str("Bikes")] });
  await flt(vs, "b", { kind: "notIn", values: [lit.str("Clothing")] }, column("Product", "Color"));
  await flt(vs, "c", { kind: "cmp", op: "gt", value: lit.num(3) }, column("Sales", "Quantity"));
  await flt(vs, "d", { kind: "between", lo: lit.date("2024-01-01"), hi: lit.date("2024-02-01") }, column("Sales", "OrderDate"));
  await flt(vs, "e", { kind: "text", op: "contains", value: "x" }, column("Product", "Product"));
  await flt(vs, "f", { kind: "compound", op: "or", a: { kind: "blank" }, b: { kind: "cmp", op: "eq", value: lit.num(0) } }, column("Sales", "Discount"));
  await flt(vs, "g", { kind: "topN", n: 3, dir: "top", by: Qty }, column("Product", "Product"));
  await flt({ level: "page", page: "page1" }, "p1", { kind: "in", values: [lit.str("France")] }, column("Customer", "Country"));
  await flt({ level: "report" }, "r1", { kind: "in", values: [lit.num(2024)] }, column("Date", "Year"));
  await run("report.slicer.select", { page: "page1", visual: slicer.name, field: column("Customer", "Country"), cond: { kind: "in", values: [lit.str("France")] } });
  await run("report.interaction.set", { page: "page1", source: chart.name, target: tbl.name, type: "NoFilter" });
  await run("report.interaction.set", { page: "page1", source: chart.name, target: vis[0].name === chart.name ? vis[1].name : vis[0].name, type: "HighlightFilter" });
  await run("report.visual.setSort", { page: "page1", visual: chart.name, sort: { field: Cat, dir: "desc" } });
  await run("report.visual.setHidden", { page: "page1", visual: vis[2].name, hidden: true });
  await run("report.page.add", { name: "Drill", type: "Drillthrough" });
  const dt = session.report.getSnapshot().page!;
  await run("report.page.setDrillthroughFields", { page: dt, fields: [Cat] });
  await run("report.page.add", { name: "Tip", type: "Tooltip" });
  await run("report.page.go", { page: "page1" });
  await run("report.bookmark.add", { name: "B1" });
  await run("report.theme.apply", { builtin: "BIForge Dark" });
  const proj = session.store.project!;
  const fsName = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync(path: string, data: string): void };
  fs.writeFileSync(DUMP!, JSON.stringify({ files: proj.report.files, resources: proj.report.static_resources }, null, 1));
});
