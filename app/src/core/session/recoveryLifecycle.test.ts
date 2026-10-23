import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session } from "./session";
import { AutosaveController } from "./autosave";
import { createRegistry } from "../commands/builtin";
import { FakeDialogs, FakeIO, sampleProject } from "../testing/fakes";

// Regression: "Unsaved changes from an earlier session were found" kept coming back when a project was opened.
// Causes found: (1) edits undone back to the saved state left the snapshot of the edited state on disk, (2) a
// snapshot write still in flight when the user saved landed after the clear, (3) closing the window with unsaved
// edits (on purpose, not a crash) left the snapshot behind.
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

describe("recovery snapshot lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opening a project and leaving it alone writes nothing and offers nothing", async () => {
    const { io, session } = await setup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(io.recovery.size).toBe(0);
    expect(session.getSnapshot().pendingRecovery).toBeNull();
    expect(session.store.getSnapshot().isDirty).toBe(false);
  });

  it("an autosave that was already scheduled does not bring the snapshot back after Don't save", async () => {
    const { io, reg, session } = await setup();
    await reg.execute("model.addTable", { name: "A" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(io.recovery.has(ROOT)).toBe(true);
    // a second edit schedules a debounced write; the user then closes without saving, before the timer fires
    await reg.execute("model.addTable", { name: "B" });
    await session.discardUnsavedForExit();
    expect(io.recovery.has(ROOT)).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(io.recovery.has(ROOT)).toBe(false);
    // opening the project again later works as before
    session.closeProject();
    await session.openProject(`${ROOT}\\Retail.pbip`);
    await reg.execute("model.addTable", { name: "C" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(io.recovery.has(ROOT)).toBe(true);
  });

  it("undoing every edit removes the snapshot, so the next open offers nothing", async () => {
    const { io, reg, session } = await setup();
    await reg.execute("model.addTable", { name: "A" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(io.recovery.has(ROOT)).toBe(true);
    await reg.execute("edit.undo");
    expect(session.store.getSnapshot().isDirty).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(io.recovery.has(ROOT)).toBe(false);

    const next = new Session(io, new FakeDialogs());
    await next.openProject(`${ROOT}\\Retail.pbip`);
    expect(next.getSnapshot().pendingRecovery).toBeNull();
  });

  it("a snapshot write that is still running when the user saves does not outlive the save", async () => {
    const { io, reg, session } = await setup();
    // make the write slow: it completes only after the save finished
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const write = io.writeRecovery.bind(io);
    io.writeRecovery = async (root, project) => {
      await gate;
      await write(root, project);
    };
    await reg.execute("model.addTable", { name: "A" });
    await vi.advanceTimersByTimeAsync(1100); // autosave starts writing, blocked on the gate
    const saving = reg.execute("file.save");
    release();
    await saving;
    await vi.advanceTimersByTimeAsync(50);
    expect(session.store.getSnapshot().isDirty).toBe(false);
    expect(io.recovery.has(ROOT)).toBe(false);
  });

  it("leaving on purpose without saving discards the snapshot", async () => {
    const { io, reg, session } = await setup();
    await reg.execute("model.addTable", { name: "A" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(io.recovery.has(ROOT)).toBe(true);
    await session.discardUnsavedForExit();
    expect(io.recovery.has(ROOT)).toBe(false);
    const next = new Session(io, new FakeDialogs());
    await next.openProject(`${ROOT}\\Retail.pbip`);
    expect(next.getSnapshot().pendingRecovery).toBeNull();
  });

  it("a crash (no clean exit) still offers the snapshot", async () => {
    const { io, reg } = await setup();
    await reg.execute("model.addTable", { name: "A" });
    await vi.advanceTimersByTimeAsync(1500);
    const next = new Session(io, new FakeDialogs());
    await next.openProject(`${ROOT}\\Retail.pbip`);
    expect(next.getSnapshot().pendingRecovery).not.toBeNull();
  });

  it("closing the project with unsaved edits keeps the snapshot only when asked to", async () => {
    const { io, reg, session } = await setup();
    await reg.execute("model.addTable", { name: "A" });
    await vi.advanceTimersByTimeAsync(1500);
    await session.closeProjectDiscarding();
    expect(io.recovery.has(ROOT)).toBe(false);
    expect(session.store.project).toBeNull();
  });
});
