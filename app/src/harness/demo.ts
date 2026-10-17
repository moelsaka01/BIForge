// The demo report the development harnesses build (several pages, every common visual). Not part of the product.
import type { Session } from "../core/session/session";
import { agg, column, lit, measure } from "../core/report/fields";

type Cmd = [string, unknown?];

export async function buildDemo(session: Session, run: (id: string, a?: unknown) => Promise<void>) {
  const page1 = "page1";
  const Cat = column("Product", "Category");
  const Qty = measure("Sales", "Total Quantity");
  const Amount = measure("Sales", "Sales Amount");
  const add = (type: string, x: number, y: number, w: number, h: number, fields: { role: string; field: unknown }[], page = page1) =>
    run("report.visual.add", { page, type, position: { x, y, width: w, height: h }, fields });
  await add("card", 20, 16, 190, 90, [{ role: "Values", field: Qty }]);
  await add("card", 220, 16, 190, 90, [{ role: "Values", field: Amount }]);
  await add("card", 420, 16, 190, 90, [{ role: "Values", field: measure("Sales", "Orders") }]);
  await add("slicer", 1060, 16, 200, 250, [{ role: "Values", field: column("Customer", "Country") }]);
  await add("slicer", 620, 16, 430, 90, [{ role: "Values", field: column("Date", "Year") }]);
  await add("clusteredColumnChart", 20, 120, 520, 280, [{ role: "Category", field: Cat }, { role: "Series", field: column("Sales", "Channel") }, { role: "Y", field: Qty }]);
  await add("lineChart", 550, 120, 500, 280, [{ role: "Category", field: column("Date", "Month") }, { role: "Y", field: Amount }, { role: "Y", field: measure("Sales", "Quantity PY") }]);
  await add("donutChart", 1060, 276, 200, 240, [{ role: "Category", field: column("Sales", "Channel") }, { role: "Y", field: Qty }]);
  await add("tableEx", 20, 410, 520, 290, [{ role: "Values", field: column("Product", "Product") }, { role: "Values", field: Qty }, { role: "Values", field: Amount }, { role: "Values", field: measure("Sales", "Average Price") }]);
  await add("pivotTable", 550, 410, 500, 290, [{ role: "Rows", field: Cat }, { role: "Rows", field: column("Product", "Subcategory") }, { role: "Columns", field: column("Sales", "Channel") }, { role: "Values", field: Qty }]);
  await run("report.page.rename", { page: page1, name: "Overview" });
  // page 2: other chart types
  await run("report.page.add", { name: "Charts" });
  const p2 = session.report.getSnapshot().page!;
  await add("barChart", 20, 20, 400, 300, [{ role: "Category", field: column("Customer", "Country") }, { role: "Series", field: Cat }, { role: "Y", field: Qty }], p2);
  await add("treemap", 430, 20, 400, 300, [{ role: "Group", field: Cat }, { role: "Group", field: column("Product", "Subcategory") }, { role: "Values", field: Amount }], p2);
  await add("funnel", 840, 20, 380, 300, [{ role: "Category", field: column("Customer", "Segment") }, { role: "Y", field: Qty }], p2);
  await add("scatterChart", 20, 330, 400, 340, [{ role: "Category", field: column("Product", "Product") }, { role: "X", field: agg("Product", "ListPrice", 1) }, { role: "Y", field: Qty }, { role: "Size", field: Amount }], p2);
  await add("waterfallChart", 430, 330, 400, 340, [{ role: "Category", field: column("Date", "Quarter") }, { role: "Y", field: Qty }], p2);
  await add("gauge", 840, 330, 380, 240, [{ role: "Y", field: Qty }, { role: "TargetValue", field: agg("Sales", "Quantity", 4) }], p2);
  await add("kpi", 840, 580, 380, 110, [{ role: "Indicator", field: measure("Sales", "Quantity YTD") }, { role: "TrendLine", field: column("Date", "YearMonth") }], p2);
  // page 3: drillthrough target
  await run("report.page.add", { name: "Customer detail", type: "Drillthrough" });
  const p3 = session.report.getSnapshot().page!;
  await run("report.page.setDrillthroughFields", { page: p3, fields: [column("Customer", "Country")] });
  await add("tableEx", 20, 20, 700, 400, [{ role: "Values", field: column("Customer", "Customer") }, { role: "Values", field: column("Customer", "City") }, { role: "Values", field: Qty }], p3);
  // page 4: tooltip page
  await run("report.page.add", { name: "Category tooltip", type: "Tooltip" });
  const p4 = session.report.getSnapshot().page!;
  await add("card", 10, 10, 140, 80, [{ role: "Values", field: Qty }], p4);
  await add("card", 160, 10, 140, 80, [{ role: "Values", field: Amount }], p4);
  await run("report.page.go", { page: page1 });
  // tooltip on the column chart
  const pages = session.store.project!.report.files;
  const key = Object.keys(pages).find((k) => k.startsWith(`pages/${page1}/visuals/`) && (pages[k] as { visual: { visualType: string } }).visual.visualType === "clusteredColumnChart")!;
  const v = (pages[key] as { name: string }).name;
  await run("report.format.set", { page: page1, visual: v, object: "visualTooltip", prop: "type", value: lit.str("Canvas") });
  await run("report.format.set", { page: page1, visual: v, object: "visualTooltip", prop: "section", value: lit.str(p4) });
  void ([] as Cmd[]);
}

