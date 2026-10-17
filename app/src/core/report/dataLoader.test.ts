import { describe, expect, it } from "vitest";
import { FakeDax, cell, result } from "../testing/fakeDax";
import { EMPTY_VIEW, ReportData } from "./dataLoader";
import { agg, column, lit } from "./fields";
import * as ops from "./reportOps";
import { fixtureProject } from "./testFixture";
import { parsePage } from "./visualDoc";

const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Qty = agg("Sales", "Quantity", 0);
let n = 0;
const id = () => `v${++n}`;

function setup() {
  n = 0;
  const p = fixtureProject();
  const dax = new FakeDax();
  const data = new ReportData(dax);
  const add = (type: string, fields: { role: string; field: Parameters<typeof ops.addField>[4] }[]) => ops.addVisual(p, "page1", type, { newId: id, fields });
  return { p, dax, data, add, page: () => parsePage(p, "page1")! };
}
const text = (v: string) => cell(v, "text");

describe("loading visuals", () => {
  it("runs the query and decodes the rows", async () => {
    const s = setup();
    const v = s.add("clusteredColumnChart", [{ role: "Category", field: Cat }, { role: "Y", field: Qty }]);
    s.dax.answers.push({ match: "SUMMARIZECOLUMNS(Product[Category]", outcome: { results: [result(["Product[Category]", "[m0]"], [[text("Bikes"), cell("10")]])], elapsedMs: 1 } });
    const r = await s.data.load(s.p, s.page(), s.page().visuals.find((x) => x.name === v)!, EMPTY_VIEW);
    expect(r.kind).toBe("grouped");
    if (r.kind === "grouped") {
      expect(r.rows[0].map((x) => x.text)).toEqual(["Bikes", "10"]);
      expect(r.highlightRows).toBeNull();
    }
  });

  it("identical queries are sent once; a new epoch or model edit sends again", async () => {
    const s = setup();
    const v = s.add("card", [{ role: "Values", field: Qty }]);
    s.dax.answers.push({ match: "SUMMARIZECOLUMNS", outcome: { results: [result(["[m0]"], [[cell("5")]])], elapsedMs: 1 } });
    const vis = () => s.page().visuals.find((x) => x.name === v)!;
    await s.data.load(s.p, s.page(), vis(), EMPTY_VIEW);
    await s.data.load(s.p, s.page(), vis(), EMPTY_VIEW);
    expect(s.data.sent).toBe(1);
    await s.data.load(s.p, s.page(), vis(), { ...EMPTY_VIEW, epoch: 1 });
    expect(s.data.sent).toBe(2);
    s.p.model.tmdl = { ...s.p.model.tmdl, "x.tmdl": { nodes: [] } };
    await s.data.load(s.p, s.page(), vis(), { ...EMPTY_VIEW, epoch: 1 });
    expect(s.data.sent).toBe(3);
  });

  it("errors are returned, not thrown, and are not cached", async () => {
    const s = setup();
    const v = s.add("card", [{ role: "Values", field: Qty }]);
    s.dax.answers.push({ match: "SUMMARIZECOLUMNS", outcome: new Error("The function X is not implemented") });
    const vis = s.page().visuals.find((x) => x.name === v)!;
    const r = await s.data.load(s.p, s.page(), vis, EMPTY_VIEW);
    expect(r).toEqual({ kind: "error", message: "The function X is not implemented" });
    s.dax.answers = [{ match: "SUMMARIZECOLUMNS", outcome: { results: [result(["[m0]"], [[cell("5")]])], elapsedMs: 1 } }];
    expect((await s.data.load(s.p, s.page(), vis, EMPTY_VIEW)).kind).toBe("grouped");
  });

  it("an unbound visual loads as empty", async () => {
    const s = setup();
    const a = s.add("clusteredColumnChart", []);
    const m = s.add("map", []);
    expect((await s.data.load(s.p, s.page(), s.page().visuals.find((x) => x.name === a)!, EMPTY_VIEW)).kind).toBe("empty");
    expect((await s.data.load(s.p, s.page(), s.page().visuals.find((x) => x.name === m)!, EMPTY_VIEW)).kind).toBe("empty");
    expect(s.dax.calls).toEqual([]);
  });

  it("a selection in another visual filters a table and highlights a chart", async () => {
    const s = setup();
    const src = s.add("clusteredColumnChart", [{ role: "Category", field: Cat }, { role: "Y", field: Qty }]);
    const tbl = s.add("tableEx", [{ role: "Values", field: Country }, { role: "Values", field: Qty }]);
    const line = s.add("lineChart", [{ role: "Category", field: column("Date", "YearMonth") }, { role: "Y", field: Qty }]);
    s.dax.answers.push({ match: "TREATAS", outcome: { results: [result(["a", "b"], [[text("x"), cell("1")]])], elapsedMs: 1 } });
    s.dax.answers.push({ match: "SUMMARIZECOLUMNS", outcome: { results: [result(["a", "b"], [[text("y"), cell("2")], [text("z"), cell("3")]])], elapsedMs: 1 } });
    const view = { ...EMPTY_VIEW, selection: { page: "page1", visual: src, points: [{ fields: [Cat], values: [lit.str("Bikes")] }] } };
    const page = s.page();
    const t = await s.data.load(s.p, page, page.visuals.find((x) => x.name === tbl)!, view);
    expect(s.dax.calls.some((c) => c.includes('TREATAS({"Bikes"}, Product[Category])') && c.includes("Customer[Country]"))).toBe(true);
    expect(t.kind === "grouped" && t.highlightRows).toBeNull();
    s.dax.calls.length = 0;
    const l = await s.data.load(s.p, page, page.visuals.find((x) => x.name === line)!, view);
    expect(l.kind === "grouped" && l.rows).toHaveLength(2);
    expect(l.kind === "grouped" && l.highlightRows).toHaveLength(1);
    expect(s.dax.calls).toHaveLength(2);
    // a selection that belongs to another page is ignored
    s.dax.calls.length = 0;
    await s.data.load(s.p, page, page.visuals.find((x) => x.name === line)!, { ...view, selection: { ...view.selection, page: "other" } });
    expect(s.dax.calls.every((c) => !c.includes("TREATAS"))).toBe(true);
  });

  it("slicers load their values and numeric or date ranges", async () => {
    const s = setup();
    const a = s.add("slicer", [{ role: "Values", field: Country }]);
    const b = s.add("slicer", [{ role: "Values", field: column("Sales", "Quantity") }]);
    s.dax.answers.push({ match: "ROW(", outcome: { results: [result(["a", "b"], [[cell("-2"), cell("5")]])], elapsedMs: 1 } });
    s.dax.answers.push({ match: "VALUES(Customer[Country])", outcome: { results: [result(["x"], [[text("France")], [text("Japan")]])], elapsedMs: 1 } });
    s.dax.answers.push({ match: "VALUES(Sales[Quantity])", outcome: { results: [result(["x"], [[cell("1")], [cell("2")]])], elapsedMs: 1 } });
    const ra = await s.data.load(s.p, s.page(), s.page().visuals.find((x) => x.name === a)!, EMPTY_VIEW);
    expect(ra.kind === "slicer" && ra.values.map((v) => v.text)).toEqual(["France", "Japan"]);
    expect(ra.kind === "slicer" && ra.range).toBeNull();
    const rb = await s.data.load(s.p, s.page(), s.page().visuals.find((x) => x.name === b)!, EMPTY_VIEW);
    expect(rb.kind === "slicer" && [rb.range?.min.num, rb.range?.max.num]).toEqual([-2, 5]);
  });

  it("table totals are loaded with a second query", async () => {
    const s = setup();
    const t = s.add("tableEx", [{ role: "Values", field: Cat }, { role: "Values", field: Qty }]);
    s.dax.answers.push({ match: 'SUMMARIZECOLUMNS("m0"', outcome: { results: [result(["[m0]"], [[cell("99")]])], elapsedMs: 1 } });
    s.dax.answers.push({ match: "SUMMARIZECOLUMNS(Product", outcome: { results: [result(["a", "b"], [[text("Bikes"), cell("99")]])], elapsedMs: 1 } });
    const r = await s.data.load(s.p, s.page(), s.page().visuals.find((x) => x.name === t)!, EMPTY_VIEW);
    expect(r.kind === "grouped" && r.totals?.map((v) => v.text)).toEqual(["99"]);
  });
});
