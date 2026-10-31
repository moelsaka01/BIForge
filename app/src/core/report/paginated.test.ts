// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import sample from "../../../e2e/fixtures/products.rdl?raw";
import { DEFAULT_THEME } from "./theme";
import { lit } from "./fields";
import { defaultValues, mapTable, mhtml, pagesHtml, paginate, paginatedLook, parameterFilters, resolveField, rowsPerPage, tableCsv, tableXml } from "./paginated";
import { parseRdl } from "./rdl";
import { parseVisual } from "./visualDoc";
import type { ModelInfo } from "./modelInfo";

const model: ModelInfo = {
  tables: () => ["Product", "Sales"],
  columns: (t) => (t === "Product" ? ["Product", "Category", "ListPrice"] : ["Quantity", "Region"]),
  measures: (t) => (t === "Sales" ? ["Total"] : []),
  columnType: () => "string",
  sortByColumn: () => null,
  formatString: () => null,
  fieldParameter: () => null,
};

const literal = (v: unknown) => (typeof v === "string" ? `'${v}'` : typeof v === "number" ? `${v}L` : String(v));
const visualWith = (objects: Record<string, Record<string, unknown>>) =>
  parseVisual("p", {
    name: "v",
    position: { x: 0, y: 0, z: 0, width: 100, height: 100 },
    visual: {
      visualType: "rdlVisual",
      objects: Object.fromEntries(Object.entries(objects).map(([o, props]) => [o, [{ properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { expr: { Literal: { Value: literal(v) } } }])) }]])),
    },
  })!;

describe("paginated report format", () => {
  it("has the toolbar, every export format and the auto filter on by default", () => {
    const look = paginatedLook(visualWith({}), DEFAULT_THEME);
    expect(look.toolbar).toEqual({ show: true, position: "Top", floating: false, pageNavigation: true, parameters: true });
    expect(look.exports.map((e) => e.id)).toEqual(["CSV", "XML", "MHTML", "PDF", "Excel", "Word"]);
    expect(look.exportShown && look.autoFilter).toBe(true);
  });
  it("reads the settings of the cards and the parameter mapping", () => {
    const look = paginatedLook(visualWith({ toolbar: { position: 1, useFloatingToolbar: true, pageNavigation: false }, export: { exportXML: false, show: false }, autoFilter: { show: false }, parameterMapping: { mappings: '{"Cat":"Product[Category]"}' }, reportInfo: { rdl: "<Report/>", rdlName: "a.rdl" } }), DEFAULT_THEME);
    expect(look.toolbar).toMatchObject({ position: "Bottom", floating: true, pageNavigation: false });
    expect(look.exports.map((e) => e.id)).toEqual(["CSV", "MHTML", "PDF", "Excel", "Word"]);
    expect(look.exportShown).toBe(false);
    expect(look.autoFilter).toBe(false);
    expect(look.mappings).toEqual({ Cat: "Product[Category]" });
    expect(look.source).toEqual({ xml: "<Report/>", name: "a.rdl" });
    expect(paginatedLook(visualWith({ parameterMapping: { mappings: "not json" } }), DEFAULT_THEME).mappings).toEqual({});
  });
});

describe("paginated report data", () => {
  const rdl = parseRdl(sample);
  it("finds the model columns of the data set fields in every spelling, and names the ones it cannot find", () => {
    expect(resolveField("Product[Category]", model)).toEqual({ kind: "column", table: "Product", name: "Category" });
    expect(resolveField("'Sales'.Total", model)).toEqual({ kind: "measure", table: "Sales", name: "Total" });
    expect(resolveField("ListPrice", model)).toEqual({ kind: "column", table: "Product", name: "ListPrice" });
    expect(resolveField("Quantity", model)).toEqual({ kind: "column", table: "Sales", name: "Quantity" });
    expect(resolveField("Nothing", model)).toBeNull();
    const m = mapTable(rdl, model)!;
    expect(m.fields.map((f) => f.name)).toEqual(["Product", "Category", "ListPrice"]);
    expect(m.problems).toEqual([]);
    const bad = mapTable(parseRdl(sample.replace("Product.ListPrice", "Nope[X]")), model)!;
    expect(bad.problems[0]).toMatch(/Nope\[X\]/);
  });
  it("turns the chosen parameter values into filters on the mapped (or same-named) column", () => {
    const look = paginatedLook(visualWith({}), DEFAULT_THEME);
    const m = mapTable(rdl, model);
    expect(defaultValues(rdl)).toEqual({ Category: [] });
    expect(parameterFilters(rdl, look, m, { Category: [] }, model)).toEqual([]);
    expect(parameterFilters(rdl, look, m, { Category: ["Bikes"] }, model)).toEqual([{ name: "rdl-param-Category", field: { kind: "column", table: "Product", name: "Category" }, cond: { kind: "in", values: [lit.str("Bikes")] } }]);
    const mapped = paginatedLook(visualWith({ parameterMapping: { mappings: '{"Category":"Sales[Region]"}' } }), DEFAULT_THEME);
    expect(parameterFilters(rdl, mapped, m, { Category: ["x"] }, model)[0].field).toEqual({ kind: "column", table: "Sales", name: "Region" });
  });
  it("splits the rows into pages by the page size of the report", () => {
    expect(rowsPerPage(rdl)).toBe(7); // 70 - 10 margins - 6 header - 12 title = 42 mm, 6 mm rows
    const rows = Array.from({ length: 8 }, (_, i) => [String(i)]);
    expect(paginate(rows, 7).map((p) => p.length)).toEqual([7, 1]);
    expect(paginate([], 7)).toEqual([[]]);
  });
});

describe("paginated report export", () => {
  const rdl = parseRdl(sample);
  const t = { title: "Product list", headers: ["Product name", "List price"], rows: [['Ridge, "MTB"', "1450"], ["Orbit <Helmet>", "59"]] };
  it("writes CSV, XML, the pages as HTML and a web archive", () => {
    expect(tableCsv(t)).toBe('Product name,List price\r\n"Ridge, ""MTB""",1450\r\nOrbit <Helmet>,59\r\n');
    expect(tableXml(t)).toContain("<Row><Product_name>Orbit &lt;Helmet&gt;</Product_name><List_price>59</List_price></Row>");
    const html = pagesHtml(t, rdl, 1);
    expect(html).toContain("Page 2 of 2");
    expect(html).toContain("@page{size:120mm 70mm");
    const m = mhtml(html, "Product list");
    expect(m).toMatch(/^MIME-Version: 1.0/);
    expect(m).toContain("Content-Transfer-Encoding: base64");
    const body = m.split("\r\n\r\n")[2].split("\r\n").filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).join("");
    expect(new TextDecoder().decode(Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0)))).toBe(html);
  });
});
