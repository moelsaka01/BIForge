import { describe, expect, it } from "vitest";
import { Session } from "../session/session";
import { createRegistry } from "../commands/builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { FakeEngine, col } from "../testing/fakeEngine";
import { FakeM } from "../testing/fakeM";
import { listTables } from "../model/ops";
import { importedTables } from "../model/tables";
import { listQueries, userMTables } from "./queries";

async function setup() {
  const engine = new FakeEngine();
  const m = new FakeM();
  const session = new Session(new FakeIO(), new FakeDialogs(), engine, m);
  const registry = createRegistry(session);
  await session.newProject("C:/p", "Demo");
  engine.sources.set("C:/o.csv", { columns: [col("Id", "int64"), col("Name")], rows: [["1", "a"], ["2", "b"]] });
  await registry.execute("data.import", { name: "Orders", spec: { kind: "csv", path: "C:/o.csv" } });
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  return { engine, m, session, registry, run };
}

const loadedOrders = { columns: [col("Id", "int64"), col("Name"), col("Big", "boolean")], rows: [["1", "a", "false"]] };

describe("queries of a project", () => {
  it("an imported table is a generated loaded query with the M BIForge wrote", async () => {
    const { session } = await setup();
    const qs = listQueries(session.store.project!);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ name: "Orders", loaded: true, generated: true });
    expect(qs[0].text).toContain("Csv.Document");
    expect(userMTables(session.store.project!)).toEqual([]);
  });

  it("editing a query then applying loads it, drops the generated marker and the import source", async () => {
    const { session, m, run, engine } = await setup();
    m.tables.set("Orders", loadedOrders);
    await run("query.editor.open", { query: "Orders" });
    expect(session.queries.getSnapshot().selected).toBe("Orders");
    expect(session.queries.dirty).toBe(false);
    await run("query.transform", { transform: { kind: "filterRows", conditions: [] } });
    const snap = session.queries.getSnapshot();
    expect(snap.step).toBe("FilterRows");
    expect(session.queries.dirty).toBe(true);
    // the document is untouched until Apply
    expect(listQueries(session.store.project!)[0].generated).toBe(true);
    await run("query.apply");
    const p = session.store.project!;
    expect(m.calls).toContain("load:Orders->Orders");
    expect(listQueries(p)[0]).toMatchObject({ generated: false });
    expect(listQueries(p)[0].text).toContain("Fake.filterRows");
    expect(listTables(p).find((t) => t.name === "Orders")!.columns.map((c) => c.name)).toEqual(["Id", "Name", "Big"]);
    expect(importedTables(p)).toEqual([]);
    expect(userMTables(p)).toEqual(["Orders"]);
    expect(session.queries.dirty).toBe(false);
    expect(session.getSnapshot().lastMessage).toContain("Applied query changes");
    void engine;
  });

  it("a table with edited M refreshes by running its M", async () => {
    const { session, m, run, registry } = await setup();
    m.tables.set("Orders", loadedOrders);
    await run("query.editor.open");
    await run("query.transform", { transform: { kind: "removeTopRows", count: 1 } });
    await run("query.apply");
    m.calls.length = 0;
    m.tables.set("Orders", { columns: [col("Id", "int64")], rows: [["7"], ["8"], ["9"]] });
    const r = await registry.execute("data.refreshTable", { name: "Orders" });
    expect(r.ok).toBe(true);
    expect(m.calls).toEqual(["load:Orders->Orders"]);
    expect(session.getSnapshot().lastMessage).toContain("3 rows");
    expect(listTables(session.store.project!).find((t) => t.name === "Orders")!.columns.map((c) => c.name)).toEqual(["Id"]);
    const all = await session.refreshAll();
    expect(all).toEqual([]);
  });

  it("unchanged generated queries keep their marker when only a dependency made them reload", async () => {
    const { session, m, run, engine } = await setup();
    engine.sources.set("C:/c.csv", { columns: [col("K", "int64")], rows: [["1"]] });
    await run("data.import", { name: "Cust", spec: { kind: "csv", path: "C:/c.csv" } });
    m.tables.set("Orders", loadedOrders);
    m.tables.set("Cust", { columns: [col("K", "int64")], rows: [["1"]] });
    m.tables.set("Helper", { columns: [col("X")], rows: [] });
    await run("query.editor.open");
    // a new, not loaded helper; Orders (loaded) will use it
    await run("query.add", { name: "Helper", text: "let\n    Source = 1\nin\n    Source", loaded: false });
    await run("query.setText", { query: "Orders", text: "let\n    Source = Helper\nin\n    Source" });
    await run("query.apply");
    const qs = Object.fromEntries(listQueries(session.store.project!).map((q) => [q.name, q]));
    expect(qs.Helper).toMatchObject({ loaded: false });
    expect(qs.Orders).toMatchObject({ loaded: true, generated: false });
    expect(qs.Cust.generated).toBe(true);
    expect(m.calls.filter((c) => c.startsWith("load:"))).toEqual(["load:Orders->Orders"]);
    // changing the helper reloads Orders (which uses it) but not Cust
    m.calls.length = 0;
    await run("query.setText", { query: "Helper", text: "let\n    Source = 2\nin\n    Source" });
    await run("query.apply");
    expect(m.calls.filter((c) => c.startsWith("load:"))).toEqual(["load:Orders->Orders"]);
    expect(session.store.project!.model.tmdl["model.tmdl"].nodes.some((n) => n.kind === "ref expression" && n.name === "Helper")).toBe(true);
  });

  it("a failing query stays in the editor while the others are applied", async () => {
    const { session, m, run, engine, registry } = await setup();
    engine.sources.set("C:/c.csv", { columns: [col("K", "int64")], rows: [["1"]] });
    await run("data.import", { name: "Cust", spec: { kind: "csv", path: "C:/c.csv" } });
    m.tables.set("Orders", loadedOrders);
    m.tables.set("Cust", { columns: [col("K", "int64")], rows: [] });
    m.failLoad.set("Orders", "The column 'x' of the table wasn't found.");
    await run("query.editor.open");
    await run("query.setText", { query: "Orders", text: "let\n    Source = 1\nin\n    Source" });
    await run("query.setText", { query: "Cust", text: "let\n    Source = 2\nin\n    Source" });
    const r = await session.applyQueries();
    expect(r.loaded).toEqual(["Cust"]);
    expect(r.failures).toEqual([{ query: "Orders", error: "The column 'x' of the table wasn't found." }]);
    expect(listQueries(session.store.project!).find((q) => q.name === "Orders")!.generated).toBe(true);
    expect(listQueries(session.store.project!).find((q) => q.name === "Cust")!.generated).toBe(false);
    expect(session.queries.getSnapshot().queries.find((q) => q.name === "Orders")!.original!.text).toContain("Csv.Document");
    // Close & Apply keeps the editor open and says why
    const c2 = await registry.execute("query.applyAndClose");
    expect(c2.ok === false && c2.message).toContain("Orders");
    expect(session.queries.getSnapshot().open).toBe(true);
  });

  it("new queries, deletion rules and renaming", async () => {
    const { session, m, run } = await setup();
    m.tables.set("Orders", loadedOrders);
    await run("query.editor.open");
    await run("query.add", { name: "Lookup", text: "let\n    Source = 1\nin\n    Source", loaded: false });
    await run("query.add", { name: "Lookup" });
    expect(session.queries.getSnapshot().queries.map((q) => q.name)).toEqual(["Orders", "Lookup", "Lookup (2)"]);
    await run("query.setText", { query: "Orders", text: "let\n    Source = Lookup\nin\n    Source" });
    await expect(run("query.delete", { name: "Lookup" })).rejects.toThrow('"Orders" uses it');
    await run("query.rename", { name: "Lookup", to: "Dim" });
    expect(session.queries.get("Orders")!.text).toContain("Source = Dim");
    expect(session.queries.getSnapshot().queries.map((q) => q.name)).toContain("Dim");
    await expect(run("query.rename", { name: "Orders", to: "Sales" })).rejects.toThrow("cannot be renamed yet");
    await expect(run("query.rename", { name: "Dim", to: "orders" })).rejects.toThrow("already exists");
    await run("query.delete", { name: "Lookup (2)" });
    await expect(run("query.setLoad", { name: "Orders", loaded: false })).rejects.toThrow("Loading cannot be switched off");
    await run("query.setLoad", { name: "Dim", loaded: true });
    await run("query.apply");
    expect(session.store.project!.model.tmdl["model.tmdl"].nodes.some((n) => n.kind === "ref expression")).toBe(false);
    // the loaded query Dim became a table
    expect(listTables(session.store.project!).some((t) => t.name === "Dim")).toBe(false);
  });

  it("removing a query deletes its expression or table", async () => {
    const { session, m, run, engine } = await setup();
    m.tables.set("Orders", loadedOrders);
    await run("query.editor.open");
    await run("query.add", { name: "Temp", text: "let\n    Source = 1\nin\n    Source", loaded: false });
    await run("query.apply");
    expect(listQueries(session.store.project!).some((q) => q.name === "Temp")).toBe(true);
    await run("query.delete", { name: "Temp" });
    await run("query.delete", { name: "Orders" });
    await run("query.apply");
    expect(listQueries(session.store.project!)).toEqual([]);
    expect(listTables(session.store.project!).some((t) => t.name === "Orders")).toBe(false);
    expect(engine.calls).toContain("drop:Orders");
    expect(session.getSnapshot().dataTables).not.toContain("Orders");
  });

  it("step commands edit the selected query's text and move the step selection", async () => {
    const { session, m, run } = await setup();
    m.tables.set("Orders", loadedOrders);
    await run("query.editor.open");
    const first = session.queries.get("Orders")!.text;
    await run("query.transform", { transform: { kind: "promoteHeaders" } });
    await run("query.transform", { transform: { kind: "sort", keys: [{ column: "Id" }] }, after: "Source" });
    expect(session.queries.getSnapshot().step).toBe("Sort");
    const text = session.queries.get("Orders")!.text;
    expect(text.indexOf("Sort")).toBeLessThan(text.indexOf("PromoteHeaders"));
    await run("query.step.edit", { edit: { op: "rename", old: "Sort", new: "Sorted by Id" } });
    expect(session.queries.getSnapshot().step).toBe("Sorted by Id");
    await run("query.step.edit", { edit: { op: "delete", name: "Sorted by Id" } });
    expect(session.queries.getSnapshot().step).toBeNull();
    expect(m.calls.filter((c) => c.startsWith("edit:"))).toEqual(["edit:insert", "edit:insert", "edit:rename", "edit:delete"]);
    await run("query.step.edit", { edit: { op: "deleteFrom", name: "PromoteHeaders" } });
    const parsed = await m.parseQuery(session.queries.get("Orders")!.text);
    expect(parsed.steps.map((x) => x.name)).toEqual(["Source", "Promoted Headers", "Changed Type"]);
    expect(first).toContain("Promoted Headers");
    await run("query.editor.close");
    expect(session.queries.getSnapshot().open).toBe(false);
    expect(listQueries(session.store.project!)[0].generated).toBe(true);
  });

  it("commands are disabled without the editor, a project or the query engine", async () => {
    const { registry, session } = await setup();
    expect(registry.isEnabled("query.transform")).toBe(false);
    expect(registry.isEnabled("query.editor.open")).toBe(true);
    const noM = new Session(new FakeIO(), new FakeDialogs(), new FakeEngine());
    expect(createRegistry(noM).isEnabled("query.editor.open")).toBe(false);
    session.queries.open([]);
    expect(registry.isEnabled("query.transform")).toBe(true);
    const r = await registry.execute("query.transform", { transform: { kind: "promoteHeaders" } });
    expect(r.ok === false && r.message).toContain("Select a query first");
  });

  it("a folder query comes from the engine's template", async () => {
    const { session, run } = await setup();
    await run("query.editor.open");
    await run("query.addFromFolder", { folder: "C:/data/Sales Files", extension: "csv" });
    const q = session.queries.getSnapshot().queries.find((x) => x.name === "Sales Files")!;
    expect(q.isNew).toBe(true);
    expect(q.text).toContain("Folder.Files");
    expect(session.queries.getSnapshot().selected).toBe("Sales Files");
  });
});
