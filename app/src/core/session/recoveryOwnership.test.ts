import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session, canonicalJson } from "./session";
import { AutosaveController } from "./autosave";
import { createRegistry } from "../commands/builtin";
import { FakeDialogs, FakeIO, sampleProject } from "../testing/fakes";
import { FakeEngine, col } from "../testing/fakeEngine";

// Regression: "Unsaved changes from an earlier session were found" appeared in a fresh session right after
// importing data. The autosave snapshot written by this same run was being offered as a crash recovery.
describe("recovery banner only for snapshots from an earlier run", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function freshRunWithImport() {
    const io = new FakeIO();
    const engine = new FakeEngine();
    engine.sources.set("C:/o.csv", { columns: [col("Id", "int64")], rows: [["1"]] });
    const session = new Session(io, new FakeDialogs(), engine);
    const reg = createRegistry(session);
    const auto = new AutosaveController(session, 1000);
    await reg.execute("file.new", { name: "Demo", folder: "C:/p" });
    await reg.execute("data.import", { name: "Orders", spec: { kind: "csv", path: "C:/o.csv" } });
    await vi.advanceTimersByTimeAsync(1500); // autosave writes the snapshot
    expect(io.recovery.has("C:/p")).toBe(true);
    return { io, engine, session, reg, auto };
  }

  it("re-opening the project in the same run does not offer this run's own autosave", async () => {
    const { session, reg } = await freshRunWithImport();
    const r = await reg.execute("file.open", { path: "C:/p/Demo.pbip" });
    expect(r.ok).toBe(true);
    expect(session.getSnapshot().pendingRecovery).toBeNull();
    expect(session.getSnapshot().lastMessage).not.toMatch(/earlier session/);
    expect(reg.isEnabled("file.restoreRecovery")).toBe(false);
  });

  it("the same snapshot is offered after a restart (a genuinely recovered session)", async () => {
    const { io, engine } = await freshRunWithImport();
    // simulate a crash: a new app run with the same disk and recovery file
    const next = new Session(io, new FakeDialogs(), engine);
    await next.openProject("C:/p/Demo.pbip");
    expect(next.getSnapshot().pendingRecovery).not.toBeNull();
    expect(next.getSnapshot().lastMessage).toMatch(/earlier session/);
  });

  it("a new project clears a snapshot another project left in the folder", async () => {
    const io = new FakeIO();
    io.recovery.set("C:/p", { ...sampleProject(), name: "Old" });
    const session = new Session(io, new FakeDialogs());
    await session.newProject("C:/p", "Demo");
    expect(io.recovery.has("C:/p")).toBe(false);
  });

  it("a snapshot that equals the saved project with keys in another order is not offered", async () => {
    const io = new FakeIO();
    const p = sampleProject();
    io.disk.set("C:/w", p);
    const reordered = Object.fromEntries(Object.entries(structuredClone(p)).reverse()) as typeof p;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(p));
    expect(canonicalJson(reordered)).toBe(canonicalJson(p));
    io.recovery.set("C:/w", reordered);
    const session = new Session(io, new FakeDialogs());
    await session.openProject("C:/w/Retail.pbip");
    expect(session.getSnapshot().pendingRecovery).toBeNull();
  });
});
