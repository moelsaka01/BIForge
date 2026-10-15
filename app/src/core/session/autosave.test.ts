import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session } from "./session";
import { AutosaveController } from "./autosave";
import { createRegistry } from "../commands/builtin";
import { FakeDialogs, FakeIO, sampleProject } from "../testing/fakes";

const ROOT = "C:\\work\\retail";

async function setup(debounce = 1000) {
  const io = new FakeIO();
  io.disk.set(ROOT, sampleProject());
  const session = new Session(io, new FakeDialogs());
  const reg = createRegistry(session);
  await session.openProject(`${ROOT}\\Retail.pbip`);
  const auto = new AutosaveController(session, debounce);
  return { io, session, reg, auto };
}

const writes = (io: FakeIO) => io.calls.filter((c) => c.startsWith("writeRecovery")).length;

describe("autosave / crash recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does nothing while the document is clean", async () => {
    const { io } = await setup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes(io)).toBe(0);
  });

  it("writes one snapshot with the latest state after edits settle", async () => {
    const { io, reg } = await setup();
    await reg.execute("model.addTable", { name: "A" });
    await vi.advanceTimersByTimeAsync(600);
    await reg.execute("model.addTable", { name: "B" });
    await vi.advanceTimersByTimeAsync(600); // first debounce would have fired by now
    expect(writes(io)).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(writes(io)).toBe(1);
    const snap = io.recovery.get(ROOT)!;
    expect(Object.keys(snap.model.tmdl)).toEqual(expect.arrayContaining(["tables/A.tmdl", "tables/B.tmdl"]));
  });

  it("does not write when undo returns the document to its saved state", async () => {
    const { io, reg } = await setup();
    await reg.execute("model.addTable", { name: "A" });
    await reg.execute("edit.undo");
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes(io)).toBe(0);
  });

  it("saving removes the snapshot and stops pending writes", async () => {
    const { io, reg } = await setup();
    await reg.execute("model.addTable", { name: "A" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(io.recovery.has(ROOT)).toBe(true);
    await reg.execute("model.addTable", { name: "B" });
    await reg.execute("file.save");
    await vi.advanceTimersByTimeAsync(5000);
    expect(io.recovery.has(ROOT)).toBe(false);
  });

  it("simulated crash: a new session offers the unsaved edits from the snapshot", async () => {
    const { io, reg } = await setup();
    await reg.execute("model.addTable", { name: "Unsaved" });
    await vi.advanceTimersByTimeAsync(1100);
    // app dies here; a new process opens the same project
    const session2 = new Session(io, new FakeDialogs());
    const reg2 = createRegistry(session2);
    await session2.openProject(`${ROOT}\\Retail.pbip`);
    expect(session2.store.project!.model.tmdl["tables/Unsaved.tmdl"]).toBeUndefined();
    await reg2.execute("file.restoreRecovery");
    expect(session2.store.project!.model.tmdl["tables/Unsaved.tmdl"]).toBeDefined();
    expect(session2.store.getSnapshot().isDirty).toBe(true);
  });

  it("flush writes immediately and a failing write is recorded, not thrown", async () => {
    const { io, reg, auto } = await setup(60_000);
    await reg.execute("model.addTable", { name: "A" });
    await auto.flush();
    expect(writes(io)).toBe(1);
    io.failRecoveryWrite = true;
    await reg.execute("model.addTable", { name: "B" });
    await expect(auto.flush()).resolves.toBeUndefined();
    expect(auto.lastError).toBe("recovery write failed");
    io.failRecoveryWrite = false;
    await auto.flush();
    expect(auto.lastError).toBeNull();
  });

  it("dispose stops the timer", async () => {
    const { io, reg, auto } = await setup();
    await reg.execute("model.addTable", { name: "A" });
    auto.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes(io)).toBe(0);
  });
});
