// Test support: builds a report that uses every visual type, filter type, formatting object, a bookmark, a drillthrough
// page, a tooltip page, static objects, Analytics lines and a theme, through the same commands the app uses. The files
// of it are what pbirSchema.test.ts validates against the published PBIR schemas.
import { createRegistry } from "../commands/builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { visualObjects, type Kind } from "../format/capabilities";
import { condFormatToPbir } from "./condFormat";
import { agg, column, lit, measure, type Lit } from "./fields";
import { litExpr, queryRefOf, type J } from "./pbir";
import { fixtureProject } from "./testFixture";
import { getFormat, parsePage, setFormat, visualKey } from "./visualDoc";
import { VISUAL_TYPES } from "./visualTypes";

const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);
const T = measure("Sales", "Total");

const FIELDS: Record<string, { role: string; field: unknown }[]> = {
  clusteredBarChart: [{ role: "Category", field: Cat }, { role: "Y", field: T }],
  barChart: [{ role: "Category", field: Cat }, { role: "Series", field: column("Customer", "Country") }, { role: "Y", field: Qty }],
  hundredPercentStackedBarChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
  clusteredColumnChart: [{ role: "Category", field: Cat }, { role: "Category", field: column("Product", "Subcategory") }, { role: "Y", field: Qty }, { role: "Rows", field: column("Sales", "Channel") }],
  columnChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
  hundredPercentStackedColumnChart: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }],
  lineChart: [{ role: "Category", field: column("Date", "Month") }, { role: "Y", field: Qty }],
  areaChart: [{ role: "Category", field: column("Date", "Month") }, { role: "Y", field: Qty }],
  stackedAreaChart: [{ role: "Category", field: column("Date", "Month") }, { role: "Y", field: Qty }],
  hundredPercentStackedAreaChart: [{ role: "Category", field: column("Date", "Month") }, { role: "Y", field: Qty }],
  ribbonChart: [{ role: "Category", field: Cat }, { role: "Series", field: column("Customer", "Country") }, { role: "Y", field: Qty }],
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
  decompositionTreeVisual: [{ role: "Analyze", field: Qty }, { role: "ExplainBy", field: Cat }, { role: "ExplainBy", field: column("Customer", "Country") }],
  keyDriversVisual: [{ role: "Target", field: column("Sales", "Channel") }, { role: "ExplainBy", field: Cat }],
  slicer: [{ role: "Values", field: column("Customer", "Country") }],
  map: [{ role: "Category", field: column("Customer", "City") }],
};

/** A value of the right shape for a property of the given kind, different from any default. */
export function sampleValue(kind: Kind): Lit | null {
  switch (kind[0]) {
    case "b":
      return lit.bool(true);
    case "c":
      return lit.str("#336699");
    case "s":
      return lit.str("sample");
    case "f":
      return lit.num(Math.min(kind[2], Math.max(kind[1], 14)));
    case "n":
      return lit.num(Math.min(kind[2] ?? 100, Math.max(kind[1] ?? 0, 5)));
    case "e": {
      const v = kind[1][kind[1].length - 1];
      return typeof v === "number" ? lit.num(v) : lit.str(v);
    }
    default:
      return null;
  }
}

export interface RichReport {
  files: Record<string, J>;
  resources: Record<string, unknown>;
  session: Session;
}

export async function buildRichReport(): Promise<RichReport> {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject({ Sales: [{ name: "Total", expr: "SUM(Sales[Quantity])", format: "#,0" }] }));
  const reg = createRegistry(session);
  const run = async (id: string, a?: unknown) => {
    const r = await reg.execute(id, a);
    if (!r.ok) throw new Error(`${id}: ${r.message}`);
  };
  for (const t of VISUAL_TYPES) await run("report.visual.add", { page: "page1", type: t.id, fields: FIELDS[t.id] ?? [] });
  const vis = parsePage(session.store.project!, "page1")!.visuals;
  const byType = (id: string) => vis.find((v) => v.visualType === id)!;
  const chart = byType("clusteredBarChart");
  const tbl = byType("tableEx");
  const slicer = byType("slicer");
  const f = (v: { name: string }, obj: string, prop: string, value: unknown, selector?: string) => run("report.format.set", { page: "page1", visual: v.name, object: obj, prop, value, selector });
  await f(chart, "title", "text", lit.str("My title"));
  await f(chart, "title", "fontSize", lit.num(14));
  await f(chart, "title", "bold", lit.bool(true));
  await f(chart, "background", "color", lit.str("#ffffff"));
  await f(chart, "border", "show", lit.bool(true));
  await f(chart, "legend", "position", lit.str("Bottom"));
  await f(chart, "dataPoint", "fill", lit.str("#ff0000"), "Sum(Sales.Quantity)");
  await f(chart, "labels", "show", lit.bool(true));
  await f(chart, "general", "altText", lit.str("Quantity by category"));
  await f(chart, "valueAxis", "labelDisplayUnits", lit.num(1000000));
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
  await run("report.visual.rename", { page: "page1", visual: chart.name, name: "Sales chart" });
  await run("report.page.add", { name: "Drill", type: "Drillthrough" });
  const dt = session.report.getSnapshot().page!;
  await run("report.page.setDrillthroughFields", { page: dt, fields: [Cat] });
  await run("report.page.add", { name: "Tip", type: "Tooltip" });
  await run("report.page.go", { page: "page1" });
  // static objects and a button that goes to the drillthrough page
  const text = byType("textbox");
  await run("report.textbox.set", { page: "page1", visual: text.name, patch: { text: "Hello", bold: true, fontSize: 18, color: "#112233" } });
  const btn = byType("actionButton");
  await f(btn, "visualLink", "type", lit.str("PageNavigation"));
  await f(btn, "visualLink", "navigationSection", lit.str(dt));
  await f(btn, "text", "text", lit.str("Go"));
  await f(btn, "shape", "tileShape", lit.str("rectangleRounded"));
  const img = byType("image");
  await f(img, "image", "sourceType", lit.str("imageUrl"));
  await f(img, "image", "sourceUrl", lit.str("data:image/png;base64,AAAA"));
  // Analytics lines
  const line = byType("lineChart");
  await f(line, "y1AxisReferenceLine", "show", lit.bool(true), "id:constant");
  await f(line, "y1AxisReferenceLine", "value", lit.num(25), "id:constant");
  await run("report.format.set", { page: "page1", visual: line.name, object: "referenceLine", prop: "show", value: lit.bool(true), selector: "id:average", fixed: { type: "Average" } });
  await f(line, "trend", "show", lit.bool(true));
  await run("report.slicer.setSync", { page: "page1", visual: slicer.name, group: "Country", pages: [{ page: dt, sync: true, visible: false }] });
  // a group of two static objects, with its own formatting
  const grouped = parsePage(session.store.project!, "page1")!.visuals.filter((v) => v.visualType === "shape" || v.visualType === "textbox").map((v) => v.name);
  await run("report.visuals.group", { visuals: grouped });
  const groupName = parsePage(session.store.project!, "page1")!.groups[0].name;
  await run("report.group.rename", { page: "page1", group: groupName, name: "Header" });
  await run("report.group.format", { page: "page1", group: groupName, object: "background", prop: "show", value: lit.bool(true) });
  await run("report.group.format", { page: "page1", group: groupName, object: "background", prop: "color", value: lit.str("#eeeeee") });
  await run("report.group.format", { page: "page1", group: groupName, object: "general", prop: "altText", value: lit.str("Header group") });
  await run("report.personalize.set", { enabled: true });
  // the chart is also on the phone layout
  await run("report.mobile.place", { page: "page1", visual: chart.name });
  await run("report.mobile.setPositions", { page: "page1", items: [{ visual: chart.name, position: { x: 10, y: 20, width: 300, height: 200 } }] });
  await run("report.bookmark.add", { name: "B1" });
  await run("report.theme.apply", { builtin: "BIForge Dark" });

  // every property of every formatting object of every authored visual, set on one more visual of each type
  for (const t of VISUAL_TYPES) {
    const caps = visualObjects(t.id);
    if (!caps || t.static) continue;
    await run("report.visual.add", { page: "page1", type: t.id, fields: FIELDS[t.id] ?? [] });
    const all = parsePage(session.store.project!, "page1")!.visuals;
    const v = all[all.length - 1];
    const json = session.store.project!.report.files[visualKey("page1", v.name)] as J;
    for (const [object, props] of Object.entries(caps)) {
      for (const [prop, kind] of Object.entries(props)) {
        const value = sampleValue(kind);
        if (value) setFormat(json, object, prop, value);
      }
    }
  }
  const proj = session.store.project!;
  return { files: proj.report.files as Record<string, J>, resources: (proj.report.static_resources ?? {}) as Record<string, unknown>, session };
}

export { getFormat, litExpr };
