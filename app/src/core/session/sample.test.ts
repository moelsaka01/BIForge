import { describe, expect, it } from "vitest";
import { Session } from "./session";
import { createRegistry } from "../commands/builtin";
import { FakeEngine } from "../testing/fakeEngine";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { listRelationships } from "../model/relationships";
import { listTables } from "../model/ops";
import { listPageNames } from "../report/visualDoc";
import { createSampleProject, SAMPLE_MEASURES } from "./sample";
import { ShellStore } from "../shell/shellStore";
import type { ColumnInfo } from "../data/types";

const col = (name: string, biType: ColumnInfo["biType"]): ColumnInfo => ({ name, biType, duckdbType: biType });
const COLUMNS: Record<string, ColumnInfo[]> = {
  Date: [col("Date", "dateTime"), col("Year", "int64"), col("Quarter", "string"), col("MonthNumber", "int64"), col("Month", "string"), col("YearMonth", "int64")],
  Customer: [col("CustomerKey", "int64"), col("Customer", "string"), col("City", "string"), col("Region", "string"), col("Segment", "string")],
  Product: [col("ProductKey", "int64"), col("Product", "string"), col("Category", "string"), col("Subcategory", "string"), col("ListPrice", "double"), col("Cost", "double")],
  Sales: [col("SalesKey", "int64"), col("OrderDate", "dateTime"), col("CustomerKey", "int64"), col("ProductKey", "int64"), col("Quantity", "int64"), col("UnitPrice", "double"), col("Channel", "string")],
};

function setup() {
  const io = new FakeIO();
  const engine = new FakeEngine();
  for (const [t, columns] of Object.entries(COLUMNS)) engine.sources.set(`D:/s/Cycle/data/${t}.csv`, { columns, rows: [] });
  const session = new Session(io, new FakeDialogs(), engine, null, new ShellStore(null));
  return { io, engine, session, registry: createRegistry(session) };
}

describe("Learn with sample data", () => {
  it("creates a project with four tables, three relationships, measures and a report page of visuals, saved and clean", async () => {
    const { io, session, engine } = setup();
    await createSampleProject(session, "D:/s/Cycle", "Cycle");
    const p = session.store.project!;
    expect(listTables(p).map((t) => t.name)).toEqual(expect.arrayContaining(["Customer", "Date", "Product", "Sales"])); // the fake disk also starts with its own demo tables
    expect(listRelationships(p).map((r) => `${r.fromTable}[${r.fromColumn}]->${r.toTable}[${r.toColumn}]:${r.isActive}`).sort()).toEqual(expect.arrayContaining([
      "Sales[CustomerKey]->Customer[CustomerKey]:true",
      "Sales[OrderDate]->Date[Date]:true",
      "Sales[ProductKey]->Product[ProductKey]:true",
    ]));
    expect(listTables(p).find((t) => t.name === "Sales")!.measures.map((m) => m.name)).toEqual(expect.arrayContaining(SAMPLE_MEASURES.map(([n]) => n)));
    const page = listPageNames(p)[0];
    const visuals = Object.keys(p.report.files).filter((k) => k.startsWith(`pages/${page}/visuals/`) && k.endsWith("/visual.json"));
    expect(visuals).toHaveLength(6);
    expect(session.store.getSnapshot().isDirty).toBe(false);
    expect(io.disk.get("D:/s/Cycle")?.name).toBe("Cycle");
    expect(io.calls).toContain("sample:D:/s/Cycle");
    expect([...engine.tables.keys()].sort()).toEqual(["Customer", "Date", "Product", "Sales"]);
  });

  it("is started by the Learn with sample data command through the name dialog and the same project path", async () => {
    const { registry, session } = setup();
    await registry.execute("file.newSample");
    expect(session.shell.getSnapshot().dialog).toEqual({ kind: "newProject", sample: true });
    const r = await registry.execute("file.newSample.run", { name: "Cycle", folder: "D:/s/Cycle" });
    expect(r.ok).toBe(true);
    expect(session.store.project?.name).toBe("Cycle");
  });
});
