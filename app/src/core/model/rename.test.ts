// Renaming a table, column or measure: the model, the DAX in it, the M of other queries and every place of the report.
import { describe, expect, it } from "vitest";
import { buildRichReport } from "../report/richReport";
import { createRegistry } from "../commands/builtin";
import { Session } from "../session/session";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { FakeEngine, col } from "../testing/fakeEngine";
import { FakeM } from "../testing/fakeM";
import { addMeasure, findTable, textProp } from "./ops";
import { addCalculatedColumn, addHierarchy, setProperty, setRole } from "./modeling";
import { addRelationship, listRelationships } from "./relationships";
import { renameColumn, renameMeasure, renameTable } from "./rename";
import { fixtureProject } from "../report/testFixture";
import type { Project } from "./types";

const report = (p: Project) => JSON.stringify(p.report.files);

async function rich() {
  const r = await buildRichReport();
  const p = structuredClone(r.session.store.project!);
  addMeasure(p, "Sales", "PerCategory", `CALCULATE([Total], Product[Category] = "Bikes", 'Product'[Color] = "Red") + COUNTROWS(Product)`);
  addCalculatedColumn(p, "Sales", "Big", "IF([Quantity] > 5, 1, 0)");
  addHierarchy(p, "Product", "Cat", ["Category", "Subcategory"]);
  setProperty(p, { kind: "column", table: "Product", column: "Subcategory" }, "sortByColumn", "Category");
  setRole(p, { name: "Bike riders", filters: [{ table: "Product", expression: `Product[Category] = "Bikes"` }] } as never);
  addRelationship(p, { fromTable: "Sales", fromColumn: "ProductKey", toTable: "Product", toColumn: "ProductKey" });
  return p;
}

describe("renaming a table", () => {
  it("changes the table, its file, refs, relationships, roles, DAX and every place of the report", async () => {
    const p = await rich();
    expect(report(p)).toContain('"Entity":"Product"');
    const res = renameTable(p, "Product", "Products");
    expect(res.expressions).toBeGreaterThanOrEqual(2);
    expect(res.reportReferences).toBeGreaterThan(5);
    // model
    expect(findTable(p, "Product")).toBeUndefined();
    expect(findTable(p, "Products")).toBeDefined();
    expect(Object.keys(p.model.tmdl)).toContain("tables/Products.tmdl");
    expect(Object.keys(p.model.tmdl)).not.toContain("tables/Product.tmdl");
    const sales = findTable(p, "Sales")!.node;
    expect(sales.children.find((c) => c.name === "PerCategory")!.default!.text).toBe(`CALCULATE([Total], Products[Category] = "Bikes", 'Products'[Color] = "Red") + COUNTROWS(Products)`);
    expect(listRelationships(p).map((r) => `${r.toTable}.${r.toColumn}`)).toContain("Products.ProductKey");
    const role = Object.values(p.model.tmdl).flatMap((d) => d.nodes).find((n) => n.kind === "role")!;
    expect(role.children[0].name).toBe("Products");
    expect(role.children[0].default!.text).toBe(`Products[Category] = "Bikes"`);
    // report: no reference to the old name is left, the new one is used everywhere the old one was
    const json = report(p);
    expect(json).not.toContain('"Entity":"Product"');
    expect(json).not.toMatch(/"(queryRef|metadata)":"(\w+\()?Product\./);
    expect(json).toContain('"Entity":"Products"');
    expect(json).toMatch(/"queryRef":"Products\.Category"/);
    // a bookmark keeps its slicer and filter fields in an annotation: those follow too
    expect(json).not.toMatch(/\\"table\\":\\"Product\\"/);
  });

  it("refuses a name that is taken and changes nothing", async () => {
    const p = await rich();
    const before = JSON.stringify(p);
    expect(() => renameTable(p, "Product", "customer")).toThrow(/already exists/);
    expect(() => renameTable(p, "Product", "  ")).toThrow(/empty/);
    expect(() => renameTable(p, "Nope", "X")).toThrow(/does not exist/);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("a new name that differs only in case is allowed", async () => {
    const p = await rich();
    renameTable(p, "Product", "PRODUCT");
    expect(findTable(p, "PRODUCT")).toBeDefined();
  });
});

describe("renaming a column", () => {
  it("changes DAX, sort-by, hierarchy levels, relationships and the report, and remembers the source name", async () => {
    const p = await rich();
    expect(report(p)).toContain('"Property":"Quantity"');
    const res = renameColumn(p, "Sales", "Quantity", "Qty");
    expect(res.reportReferences).toBeGreaterThan(5);
    const sales = findTable(p, "Sales")!.node;
    expect(sales.children.find((c) => c.name === "Total")!.default!.text).toBe("SUM(Sales[Qty])");
    expect(sales.children.find((c) => c.name === "Big")!.default!.text).toBe("IF([Qty] > 5, 1, 0)");
    const col = sales.children.find((c) => c.name === "Qty")!;
    expect(textProp(col, "sourceColumn")).toBe("Quantity");
    const json = report(p);
    expect(json.replace("Quantity by category", "")).not.toContain("Quantity"); // the alt text is the author's own words
    expect(json).toContain('"Property":"Qty"');
    expect(json).toContain("Sum(Sales.Qty)");
    expect(json).toContain("Sum of Qty");
  });

  it("follows sort-by columns and hierarchy levels of the same table, not of others", async () => {
    const p = await rich();
    renameColumn(p, "Product", "Category", "Group");
    const prod = findTable(p, "Product")!.node;
    expect(textProp(prod.children.find((c) => c.name === "Subcategory")!, "sortByColumn")).toBe("Group");
    expect(prod.children.find((c) => c.kind === "hierarchy")!.children.map((l) => textProp(l, "column"))).toEqual(["Group", "Subcategory"]);
    expect(findTable(p, "Sales")!.node.children.find((c) => c.name === "PerCategory")!.default!.text).toContain("Product[Group]");
  });

  it("refuses a column, measure or hierarchy name that is taken", async () => {
    const p = await rich();
    expect(() => renameColumn(p, "Sales", "Quantity", "UnitPrice")).toThrow(/already has/);
    expect(() => renameColumn(p, "Sales", "Quantity", "Total")).toThrow(/already has/);
    expect(() => renameColumn(p, "Sales", "Nope", "X")).toThrow(/does not exist/);
  });
});

describe("renaming a measure", () => {
  it("changes [Measure] and Table[Measure] in other measures and the report", async () => {
    const p = await rich();
    renameMeasure(p, "Total", "Revenue");
    const sales = findTable(p, "Sales")!.node;
    expect(sales.children.find((c) => c.name === "Revenue")).toBeDefined();
    expect(sales.children.find((c) => c.name === "PerCategory")!.default!.text).toContain("CALCULATE([Revenue],");
    expect(() => renameMeasure(p, "Revenue", "Quantity")).toThrow(/already exists/);
  });
});

describe("through the session", () => {
  async function setup() {
    const engine = new FakeEngine();
    const m = new FakeM();
    const session = new Session(new FakeIO(), new FakeDialogs(), engine, m);
    const registry = createRegistry(session);
    await session.newProject("C:/p", "Demo");
    engine.sources.set("C:/o.csv", { columns: [col("Id", "int64"), col("Amount", "double")], rows: [["1", "2.5"]] });
    await registry.execute("data.import", { name: "Orders", spec: { kind: "csv", path: "C:/o.csv" } });
    await registry.execute("model.addMeasure", { table: "Orders", name: "Total", expression: "SUM(Orders[Amount])" }).catch(() => undefined);
    return { engine, m, session, registry };
  }

  it("renames the data with the table and the column, in one undo step, and undo and redo bring the data back with the model", async () => {
    const { engine, session, registry } = await setup();
    const steps = () => session.store.getSnapshot();
    const r1 = await registry.execute("model.rename", { kind: "table", table: "Orders", to: "Invoices" });
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    expect(engine.calls).toContain("renameTable:Orders->Invoices");
    expect(session.getSnapshot().dataTables).toEqual(["Invoices"]);
    const r2 = await registry.execute("model.rename", { kind: "column", table: "Invoices", name: "Amount", to: "Value" });
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    expect(engine.calls).toContain("renameColumn:Invoices:Amount->Value");
    expect(engine.tables.get("Invoices")!.columns.map((c) => c.name)).toEqual(["Id", "Value"]);
    expect(session.getSnapshot().lastMessage).toContain("Renamed to");

    await registry.execute("edit.undo");
    expect(engine.tables.get("Invoices")!.columns.map((c) => c.name)).toEqual(["Id", "Amount"]);
    expect(findTable(session.store.project!, "Invoices")).toBeDefined();
    await registry.execute("edit.undo");
    expect(findTable(session.store.project!, "Orders")).toBeDefined();
    expect(engine.tables.has("Orders")).toBe(true);
    expect(engine.tables.has("Invoices")).toBe(false);
    expect(session.getSnapshot().dataTables).toEqual(["Orders"]);
    await registry.execute("edit.redo");
    await registry.execute("edit.redo");
    expect(findTable(session.store.project!, "Invoices")).toBeDefined();
    expect(engine.tables.get("Invoices")!.columns.map((c) => c.name)).toEqual(["Id", "Value"]);
    void steps;
  });

  it("a refused name changes neither the model nor the data", async () => {
    const { engine, session, registry } = await setup();
    engine.calls.length = 0;
    const r = await registry.execute("model.rename", { kind: "table", table: "Orders", to: "Orders" });
    expect(r.ok).toBe(true);
    const bad = await registry.execute("model.rename", { kind: "column", table: "Orders", name: "Amount", to: "Id" });
    expect(bad.ok).toBe(false);
    expect(engine.calls.filter((c) => c.startsWith("rename"))).toEqual([]);
    expect(findTable(session.store.project!, "Orders")).toBeDefined();
  });

  it("a renamed imported column is found again after a refresh: the model keeps its name, the data keeps the new name", async () => {
    const { engine, session, registry } = await setup();
    await registry.execute("model.rename", { kind: "column", table: "Orders", name: "Amount", to: "Value" });
    engine.sources.set("C:/o.csv", { columns: [col("Id", "int64"), col("Amount", "double")], rows: [["1", "2.5"], ["2", "4"]] });
    await registry.execute("data.refreshTable", { name: "Orders" });
    const names = findTable(session.store.project!, "Orders")!.node.children.filter((c) => c.kind === "column").map((c) => c.name);
    expect(names).toEqual(["Id", "Value"]);
    expect(engine.calls).toContain("renameColumn:Orders:Amount->Value");
  });

  it("queries (M) that use a renamed table are rewritten", async () => {
    const { session, registry } = await setup();
    // a second query that reads the first one
    const p = session.store.project!;
    const orders = Object.values(p.model.tmdl).flatMap((d) => d.nodes).find((n) => n.kind === "table" && n.name === "Orders")!;
    void orders;
    session.store.transact("add expression", (pr) => {
      pr.model.tmdl["expressions.tmdl"] = { nodes: [{ description: [], kind: "expression", name: "Other", default: { text: "let\n    Source = Orders\nin\n    Source", verbatim: false }, props: [], children: [] }] };
    });
    const r = await registry.execute("model.rename", { kind: "table", table: "Orders", to: "Invoices" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const other = Object.values(session.store.project!.model.tmdl).flatMap((d) => d.nodes).find((n) => n.kind === "expression" && n.name === "Other")!;
    expect(other.default!.text).toContain("Source = Invoices");
  });
});

void fixtureProject;
