import { describe, expect, it } from "vitest";
import type { Project } from "../model/types";
import { lit } from "./fields";
import { litExpr, readLitProp, type J } from "./pbir";
import { migrateProject, migrateVisual } from "./migrate";

const L = (l: Parameters<typeof litExpr>[0]) => litExpr(l);
const visual = (type: string, objects: J, container?: J): J => ({ name: "v", position: { x: 0, y: 0, width: 1, height: 1 }, visual: { visualType: type, objects, ...(container ? { visualContainerObjects: container } : {}) } });
const get = (j: J, o: string, p: string, sel?: J) => readLitProp(j.visual.objects[o]?.find((e: J) => JSON.stringify(e.selector ?? null) === JSON.stringify(sel ?? null))?.properties[p]);

describe("migrating report files written by earlier versions", () => {
  it("renames the stacked bar and column visual types", () => {
    const a = visual("stackedBarChart", {});
    const b = visual("stackedColumnChart", {});
    expect(migrateVisual(a)).toBe(true);
    expect(migrateVisual(b)).toBe(true);
    expect([a.visual.visualType, b.visual.visualType]).toEqual(["barChart", "columnChart"]);
  });

  it("alt text moves to the general object of the container; the report page tooltip type is Canvas", () => {
    const j = visual("card", {}, { altText: [{ properties: { text: L(lit.str("Logo")) } }], visualTooltip: [{ properties: { type: L(lit.str("ReportPage")) } }] });
    expect(migrateVisual(j)).toBe(true);
    expect(readLitProp(j.visual.visualContainerObjects.general[0].properties.altText)).toEqual(lit.str("Logo"));
    expect(j.visual.visualContainerObjects.altText).toBeUndefined();
    expect(readLitProp(j.visual.visualContainerObjects.visualTooltip[0].properties.type)).toEqual(lit.str("Canvas"));
  });

  it("axis titles, display units and decimals use the names of the schema", () => {
    const j = visual("clusteredColumnChart", {
      valueAxis: [{ properties: { axisTitle: L(lit.str("Qty")), displayUnits: L(lit.str("millions")), decimalPlaces: L(lit.num(2)) } }],
      labels: [{ properties: { displayUnits: L(lit.str("none")) } }],
    });
    expect(migrateVisual(j)).toBe(true);
    expect(get(j, "valueAxis", "titleText")).toEqual(lit.str("Qty"));
    expect(get(j, "valueAxis", "labelDisplayUnits")).toEqual(lit.num(1000000));
    expect(get(j, "valueAxis", "labelPrecision")).toEqual(lit.num(2));
    expect(get(j, "labels", "labelDisplayUnits")).toEqual(lit.num(1));
    expect(j.visual.objects.valueAxis[0].properties.axisTitle).toBeUndefined();
  });

  it("the secondary axis becomes the sec* properties of the value axis; smooth lines a line type", () => {
    const j = visual("lineClusteredColumnComboChart", {
      secondaryValueAxis: [{ properties: { show: L(lit.bool(false)), axisTitle: L(lit.str("Price")), start: L(lit.num(5)) } }],
      lineStyles: [{ properties: { smooth: L(lit.bool(true)), strokeWidth: L(lit.num(3)) } }],
    });
    migrateVisual(j);
    expect(get(j, "valueAxis", "secShow")).toEqual(lit.bool(false));
    expect(get(j, "valueAxis", "secTitleText")).toEqual(lit.str("Price"));
    expect(get(j, "valueAxis", "secStart")).toEqual(lit.num(5));
    expect(j.visual.objects.secondaryValueAxis).toBeUndefined();
    expect(get(j, "lineStyles", "lineChartType")).toEqual(lit.str("smooth"));
    expect(get(j, "lineStyles", "strokeWidth")).toEqual(lit.num(3));
    expect(j.visual.objects.lineStyles[0].properties.smooth).toBeUndefined();
  });

  it("Analytics lines move to the value axis reference line and to reference line instances", () => {
    const j = visual("lineChart", {
      constantLine: [{ properties: { show: L(lit.bool(true)), value: L(lit.num(25)), strokeWidth: L(lit.num(2)) } }],
      averageLine: [{ properties: { show: L(lit.bool(true)) } }],
      trendLine: [{ properties: { show: L(lit.bool(true)), strokeWidth: L(lit.num(3)) } }],
    });
    migrateVisual(j);
    expect(get(j, "y1AxisReferenceLine", "value", { id: "constant" })).toEqual(lit.num(25));
    expect(get(j, "y1AxisReferenceLine", "width", { id: "constant" })).toEqual(lit.num(2));
    expect(get(j, "referenceLine", "type", { id: "average" })).toEqual(lit.str("Average"));
    expect(get(j, "referenceLine", "show", { id: "average" })).toEqual(lit.bool(true));
    expect(get(j, "trend", "width")).toEqual(lit.num(3));
    expect(j.visual.objects.constantLine).toBeUndefined();
    expect(j.visual.objects.trendLine).toBeUndefined();
  });

  it("table units move to the column formatting; KPI direction to goals; gauge target to the axis", () => {
    const sel = { metadata: "Sum(Sales.Quantity)" };
    const t = visual("tableEx", { values: [{ selector: sel, properties: { displayUnits: L(lit.str("thousands")), dataBars: L(lit.bool(true)), backColor: { solid: { color: L(lit.str("#112233")) } } } }] });
    migrateVisual(t);
    expect(get(t, "columnFormatting", "labelDisplayUnits", sel)).toEqual(lit.num(1000));
    expect(t.visual.objects.columnFormatting[0].properties.dataBars.positiveColor).toBeTruthy();
    expect(get(t, "values", "backColor", sel)).toEqual(lit.str("#112233")); // plain colors stay where they were
    const k = visual("kpi", { indicator: [{ properties: { direction: L(lit.str("Low is good")) } }] });
    migrateVisual(k);
    expect(get(k, "goals", "direction")).toEqual(lit.str("Low is good"));
    const g = visual("gauge", { target: [{ properties: { target: L(lit.num(80)) } }] });
    migrateVisual(g);
    expect(get(g, "axis", "target")).toEqual(lit.num(80));
  });

  it("slicer, shape, image and pie label settings use the names and values of the schema", () => {
    const s = visual("slicer", { selection: [{ properties: { selectAllCheckbox: L(lit.bool(true)) } }], header: [{ properties: { search: L(lit.bool(true)) } }], data: [{ properties: { mode: L(lit.str("Tile")) } }] });
    migrateVisual(s);
    expect(get(s, "selection", "selectAllCheckboxEnabled")).toEqual(lit.bool(true));
    expect(get(s, "general", "selfFilterEnabled")).toEqual(lit.bool(true));
    expect(get(s, "data", "mode")).toEqual(lit.str("Basic"));
    expect(get(s, "general", "orientation")).toEqual(lit.num(1));
    const sh = visual("shape", { shape: [{ properties: { tileShape: L(lit.str("roundedRectangle")) } }] });
    migrateVisual(sh);
    expect(get(sh, "shape", "tileShape")).toEqual(lit.str("rectangleRounded"));
    const im = visual("image", { image: [{ properties: { imageUrl: L(lit.str("data:image/png;base64,AA")), scaling: L(lit.str("Fill")) } }] });
    migrateVisual(im);
    expect(get(im, "image", "sourceUrl")).toEqual(lit.str("data:image/png;base64,AA"));
    expect(get(im, "image", "sourceType")).toEqual(lit.str("imageUrl"));
    expect(get(im, "image", "fit")).toEqual(lit.str("Fill"));
    const pie = visual("pieChart", { labels: [{ properties: { labelStyle: L(lit.str("All detail labels")) } }] });
    migrateVisual(pie);
    expect(get(pie, "labels", "labelStyle")).toEqual(lit.str("Category, data value, percent of total"));
  });

  it("leaves current files alone and is idempotent", () => {
    const j = visual("barChart", { valueAxis: [{ properties: { titleText: L(lit.str("Qty")) } }] });
    const before = JSON.stringify(j);
    expect(migrateVisual(j)).toBe(false);
    expect(JSON.stringify(j)).toBe(before);
    const old = visual("stackedBarChart", { valueAxis: [{ properties: { axisTitle: L(lit.str("Q")) } }] });
    migrateVisual(old);
    expect(migrateVisual(old)).toBe(false);
  });

  it("a project is migrated as a copy, and returned as it is when up to date", () => {
    const files = { "pages/p1/visuals/v1/visual.json": visual("stackedColumnChart", {}), "pages/p1/page.json": { name: "p1" } };
    const p = { report: { files } } as unknown as Project;
    const m = migrateProject(p);
    expect(m).not.toBe(p);
    expect((m.report.files as J)["pages/p1/visuals/v1/visual.json"].visual.visualType).toBe("columnChart");
    expect((p.report.files as J)["pages/p1/visuals/v1/visual.json"].visual.visualType).toBe("stackedColumnChart");
    expect(migrateProject(m)).toBe(m);
  });
});
