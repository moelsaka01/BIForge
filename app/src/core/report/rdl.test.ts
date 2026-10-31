// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import sample from "../../../e2e/fixtures/products.rdl?raw";
import { lengthMm, parseRdl } from "./rdl";

describe("report definitions (.rdl)", () => {
  it("reads lengths of every unit into millimetres", () => {
    expect(lengthMm("21cm")).toBeCloseTo(210);
    expect(lengthMm("8.5in")).toBeCloseTo(215.9);
    expect(lengthMm("72pt")).toBeCloseTo(25.4);
    expect(lengthMm("5mm")).toBe(5);
    expect(lengthMm("wide")).toBeNull();
  });

  it("reads the page, the first table with its header and detail row, the data set and the parameters", () => {
    const r = parseRdl(sample);
    expect(r.page).toMatchObject({ width: 120, height: 70, marginTop: 5, marginLeft: 5 });
    expect(r.title).toBe("Product list");
    expect(r.table?.dataSet).toBe("Products");
    expect(r.table?.columns.map((c) => [c.header, c.field, Math.round(c.width)])).toEqual([
      ["Product name", "Name", 50],
      ["Category", "Category", 40],
      ["List price", "Price", 30],
    ]);
    expect(r.table?.headerHeight).toBeCloseTo(6);
    expect(r.dataSets[0].fields).toEqual([
      { name: "Name", dataField: "Product[Product]" },
      { name: "Category", dataField: "Category" },
      { name: "Price", dataField: "Product.ListPrice" },
    ]);
    expect(r.parameters).toEqual([{ name: "Category", prompt: "Category", dataType: "String", multiValue: false, defaults: [], options: [{ value: "Bikes", label: "Bikes" }, { value: "Accessories", label: "Accessories" }] }]);
    expect(r.notes).toEqual([]);
  });

  it("says what it leaves out and refuses what is not a report definition", () => {
    const withChart = sample.replace('<Tablix Name="ProductTable">', '<Chart Name="c"/><Tablix Name="ProductTable">');
    expect(parseRdl(withChart).notes).toContain("Chart items are not drawn.");
    const expr = sample.replace("=Fields!Category.Value", "=UCase(Fields!Category.Value)");
    expect(parseRdl(expr).notes.some((n) => /expression/.test(n))).toBe(true);
    expect(() => parseRdl("<html/>")).toThrow(/not a report definition/);
    expect(() => parseRdl("<Report>")).toThrow(/XML/);
  });
});
