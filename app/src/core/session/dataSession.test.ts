import { describe, expect, it } from "vitest";
import { Session } from "./session";
import { createRegistry } from "../commands/builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { FakeEngine, col } from "../testing/fakeEngine";
import { listTables } from "../model/ops";
import { listRelationships } from "../model/relationships";
import { importedTables } from "../model/tables";

async function setup() {
  const io = new FakeIO();
  const engine = new FakeEngine();
  const session = new Session(io, new FakeDialogs(), engine);
  const registry = createRegistry(session);
  await session.newProject("C:/p", "Demo");
  return { io, engine, session, registry };
}

const orders = {
  columns: [col("Id", "int64"), col("Name")],
  rows: [
    ["1", "a"],
    ["2", "b"],
  ],
};

describe("data import through commands", () => {
  it("imports, shows the table in the model, and is one undo step", async () => {
    const { engine, session, registry } = await setup();
    engine.sources.set("C:/o.csv", orders);
    const r = await registry.execute("data.import", { name: "Orders", spec: { kind: "csv", path: "C:/o.csv" } });
    expect(r.ok).toBe(true);
    expect(listTables(session.store.project!).map((t) => t.name)).toContain("Orders");
    expect(session.getSnapshot().dataTables).toEqual(["Orders"]);
    expect(session.getSnapshot().lastMessage).toContain("2 rows");
    session.store.undo();
    expect(listTables(session.store.project!).map((t) => t.name)).not.toContain("Orders");
  });

  it("a failing import leaves the document untouched and reports the error", async () => {
    const { session, registry } = await setup();
    const before = session.store.project;
    const r = await registry.execute("data.import", { name: "X", spec: { kind: "csv", path: "C:/missing.csv" } });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("File not found");
    expect(session.store.project).toBe(before);
    expect(session.store.getSnapshot().canUndo).toBe(false);
  });

  it("refresh re-reads the source and drops relationships on vanished columns", async () => {
    const { engine, session, registry } = await setup();
    engine.sources.set("C:/o.csv", orders);
    engine.sources.set("C:/c.csv", { columns: [col("Id", "int64")], rows: [["1"]] });
    await registry.execute("data.import", { name: "Orders", spec: { kind: "csv", path: "C:/o.csv" } });
    await registry.execute("data.import", { name: "Cust", spec: { kind: "csv", path: "C:/c.csv" } });
    await registry.execute("model.addRelationship", { fromTable: "Orders", fromColumn: "Id", toTable: "Cust", toColumn: "Id" });
    const orderRels = () => listRelationships(session.store.project!).filter((x) => x.fromTable === "Orders");
    expect(orderRels()).toHaveLength(1);

    engine.sources.set("C:/o.csv", { columns: [col("Name"), col("Extra", "double")], rows: [["a", "1.5"]] });
    const r = await registry.execute("data.refreshTable", { name: "Orders" });
    expect(r.ok).toBe(true);
    expect(orderRels()).toHaveLength(0);
    expect(session.getSnapshot().lastMessage).toContain("relationship(s) removed");
    expect(listTables(session.store.project!).find((t) => t.name === "Orders")!.columns.map((c) => c.name)).toEqual(["Name", "Extra"]);
  });

  it("refresh all continues past a failing table and reports it", async () => {
    const { engine, session, registry } = await setup();
    engine.sources.set("C:/o.csv", orders);
    engine.sources.set("C:/c.csv", orders);
    await registry.execute("data.import", { name: "A", spec: { kind: "csv", path: "C:/o.csv" } });
    await registry.execute("data.import", { name: "B", spec: { kind: "csv", path: "C:/c.csv" } });
    engine.sources.delete("C:/o.csv");
    const r = await registry.execute("data.refreshAll");
    expect(r.ok).toBe(false);
    expect(session.getSnapshot().lastMessage).toContain("Refreshed 1 of 2");
    expect(engine.calls.filter((c) => c === "import:B")).toHaveLength(2);
  });

  it("refresh of a table without a source is a clear error; commands are disabled without a project", async () => {
    const { session, registry } = await setup();
    const r = await registry.execute("data.refreshTable", { name: "Sales" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("cannot be refreshed");
    session.closeProject();
    expect(registry.isEnabled("data.import")).toBe(false);
  });

  it("opening a project drops stored tables that left the model and flags missing data", async () => {
    const { engine, session } = await setup();
    engine.sources.set("C:/o.csv", orders);
    await session.importTable("Orders", { kind: "csv", path: "C:/o.csv" });
    await session.save();
    engine.tables.set("Ghost", { columns: [], rows: [] });
    engine.tables.delete("Orders");
    await session.openProject("C:/p/Demo.pbip");
    expect(engine.calls).toContain("drop:Ghost");
    expect(session.getSnapshot().lastMessage).toContain("not loaded");
    expect(importedTables(session.store.project!)).toEqual(["Orders"]);
  });
});

describe("relationship commands", () => {
  it("add, edit and delete are undoable transactions", async () => {
    const { session, registry } = await setup();
    const spec = { fromTable: "Sales", fromColumn: "ProductKey", toTable: "Calendar", toColumn: "DateKey" };
    expect((await registry.execute("model.addRelationship", spec)).ok).toBe(true);
    const id = listRelationships(session.store.project!).find((r) => r.toTable === "Calendar" && r.fromColumn === "ProductKey")!.id;
    expect((await registry.execute("model.updateRelationship", { id, patch: { crossFilter: "both" } })).ok).toBe(true);
    expect(listRelationships(session.store.project!).find((r) => r.id === id)!.crossFilter).toBe("both");
    expect((await registry.execute("model.deleteRelationship", { id })).ok).toBe(true);
    session.store.undo();
    session.store.undo();
    expect(listRelationships(session.store.project!).find((r) => r.id === id)!.crossFilter).toBe("single");
    const bad = await registry.execute("model.addRelationship", { ...spec, fromColumn: "Nope" });
    expect(bad.ok).toBe(false);
  });
});
