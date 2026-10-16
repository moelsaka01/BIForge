import { describe, expect, it } from "vitest";
import { agg, column, measure } from "./fields";
import { asValueField, fieldForRole, routeField, summarizesByDefault } from "./fieldRouting";
import { modelInfo } from "./modelInfo";
import * as ops from "./reportOps";
import { fixtureProject } from "./testFixture";
import { parsePage } from "./visualDoc";

const Cat = column("Product", "Category");
const Qty = column("Sales", "Quantity");

function setup(type: string, fields: { role: string; field: ReturnType<typeof column> | ReturnType<typeof agg> }[] = []) {
  const p = fixtureProject({ Sales: [{ name: "Total", expr: "SUM(Sales[Quantity])" }] });
  const v = ops.addVisual(p, "page1", type, { newId: () => "v1", fields });
  return { p, model: modelInfo(p), visual: () => parsePage(p, "page1")!.visuals.find((x) => x.name === v)! };
}

describe("routing fields to wells", () => {
  it("numeric columns are summed into value wells, text and dates group", () => {
    const s = setup("clusteredColumnChart");
    expect(routeField(s.p, s.model, s.visual(), Qty)).toEqual({ role: "Y", field: agg("Sales", "Quantity", 0) });
    expect(routeField(s.p, s.model, s.visual(), Cat)).toEqual({ role: "Category", field: Cat });
    expect(routeField(s.p, s.model, s.visual(), column("Date", "Date"))).toEqual({ role: "Category", field: column("Date", "Date") });
    expect(routeField(s.p, s.model, s.visual(), measure("Sales", "Total"))).toEqual({ role: "Y", field: measure("Sales", "Total") });
  });

  it("a column with summarize by none groups", () => {
    const s = setup("clusteredColumnChart");
    const t = s.p.model.tmdl["tables/Sales.tmdl"].nodes[0];
    t.children.find((c) => c.name === "Quantity")!.props.push({ key: "summarizeBy", value: { Text: "none" } });
    expect(summarizesByDefault(s.p, s.model, Qty)).toBe(false);
    expect(routeField(s.p, s.model, s.visual(), Qty)).toEqual({ role: "Category", field: Qty });
  });

  it("tables take columns and summed values in their one well", () => {
    const s = setup("tableEx");
    expect(routeField(s.p, s.model, s.visual(), Qty)).toEqual({ role: "Values", field: agg("Sales", "Quantity", 0) });
    expect(routeField(s.p, s.model, s.visual(), Cat)).toEqual({ role: "Values", field: Cat });
  });

  it("full single-field wells are replaced; a column goes to a value well when no grouping well is left", () => {
    const s = setup("pieChart", [{ role: "Category", field: Cat }, { role: "Y", field: agg("Sales", "Quantity", 0) }]);
    expect(routeField(s.p, s.model, s.visual(), column("Customer", "Country"))).toEqual({ role: "Category", field: column("Customer", "Country") });
    expect(routeField(s.p, s.model, s.visual(), measure("Sales", "Total"))).toEqual({ role: "Y", field: measure("Sales", "Total") });
    const card = setup("card");
    expect(routeField(card.p, card.model, card.visual(), Cat)).toEqual({ role: "Values", field: agg("Product", "Category", 2) });
  });

  it("value fields by type", () => {
    const s = setup("card");
    expect(asValueField(s.model, Cat)).toEqual(agg("Product", "Category", 2));
    expect(asValueField(s.model, column("Date", "Date"))).toEqual(agg("Date", "Date", 3));
    expect(asValueField(s.model, Qty)).toEqual(agg("Sales", "Quantity", 0));
    expect(asValueField(s.model, measure("Sales", "Total"))).toEqual(measure("Sales", "Total"));
    expect(fieldForRole(s.model, "column", Qty)).toEqual(Qty);
    expect(fieldForRole(s.model, "value", Qty)).toEqual(agg("Sales", "Quantity", 0));
  });

  it("returns null for a visual that cannot hold the field", () => {
    const s = setup("slicer", [{ role: "Values", field: Cat }]);
    // the slicer's single well is replaced
    expect(routeField(s.p, s.model, s.visual(), column("Customer", "City"))).toEqual({ role: "Values", field: column("Customer", "City") });
    const m = setup("map");
    expect(routeField(m.p, m.model, m.visual(), measure("Sales", "Total"))).toEqual({ role: "Size", field: measure("Sales", "Total") });
  });
});
