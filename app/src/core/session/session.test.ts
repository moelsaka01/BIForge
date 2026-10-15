import { describe, expect, it } from "vitest";
import { Session } from "./session";
import { createRegistry } from "../commands/builtin";
import { FakeDialogs, FakeIO, sampleProject } from "../testing/fakes";

async function openSession() {
  const io = new FakeIO();
  io.disk.set("C:\\work\\retail", sampleProject());
  const dialogs = new FakeDialogs();
  const session = new Session(io, dialogs);
  const reg = createRegistry(session);
  await session.openProject("C:\\work\\retail\\Retail.pbip");
  return { io, dialogs, session, reg };
}

describe("commands drive the document", () => {
  it("disables project commands until a project is open", async () => {
    const session = new Session(new FakeIO(), new FakeDialogs());
    const reg = createRegistry(session);
    for (const id of ["file.save", "edit.undo", "edit.redo", "model.addTable", "model.addMeasure"]) {
      expect(reg.isEnabled(id), id).toBe(false);
    }
    expect(reg.isEnabled("file.new")).toBe(true);
    expect(await reg.execute("model.addTable", { name: "T" })).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("file.new asks for a folder when none is given, and does nothing if the dialog is cancelled", async () => {
    const io = new FakeIO();
    const dialogs = new FakeDialogs();
    const session = new Session(io, dialogs);
    const reg = createRegistry(session);
    expect(await reg.execute("file.new", { name: "X" })).toEqual({ ok: true });
    expect(session.store.project).toBeNull();
    dialogs.folder = "C:\\p";
    await reg.execute("file.new", { name: "X" });
    expect(session.store.project?.name).toBe("X");
    expect(session.root).toBe("C:\\p");
  });

  it("file.new without a name fails with a readable message", async () => {
    const session = new Session(new FakeIO(), new FakeDialogs());
    const reg = createRegistry(session);
    expect(await reg.execute("file.new", {})).toEqual({ ok: false, reason: "failed", message: "Missing value: name." });
  });

  it("edit commands go through undo/redo and mark the document dirty", async () => {
    const { reg, session } = await openSession();
    await reg.execute("model.addTable", { name: "Orders" });
    await reg.execute("model.addMeasure", { table: "Orders", name: "Count", expression: "COUNTROWS(Orders)" });
    expect(session.store.getSnapshot().isDirty).toBe(true);
    expect(session.store.getSnapshot().undoLabel).toBe('New measure "Count"');
    await reg.execute("edit.undo");
    expect(session.store.project!.model.tmdl["tables/Orders.tmdl"].nodes[0].children).toHaveLength(0);
    await reg.execute("edit.redo");
    expect(session.store.project!.model.tmdl["tables/Orders.tmdl"].nodes[0].children).toHaveLength(1);
    await reg.execute("edit.undo");
    await reg.execute("edit.undo");
    expect(session.store.getSnapshot().isDirty).toBe(false);
    expect(reg.isEnabled("edit.undo")).toBe(false);
  });

  it("an invalid edit reports an error and leaves the document alone", async () => {
    const { reg, session } = await openSession();
    const r = await reg.execute("model.addTable", { name: "sales" });
    expect(r).toMatchObject({ ok: false, reason: "failed" });
    expect((r as { message: string }).message).toMatch(/already exists/);
    expect(session.store.getSnapshot()).toMatchObject({ isDirty: false, canUndo: false });
  });

  it("keyboard shortcuts resolve to the same commands", async () => {
    const { reg } = await openSession();
    expect(reg.byShortcut("ctrl+z")?.id).toBe("edit.undo");
    expect(reg.byShortcut("Ctrl+S")?.id).toBe("file.save");
  });
});

describe("save", () => {
  it("writes the project, marks it clean and clears the recovery file", async () => {
    const { io, reg, session } = await openSession();
    await reg.execute("model.addTable", { name: "Orders" });
    io.recovery.set("C:\\work\\retail", sampleProject());
    expect(await reg.execute("file.save")).toEqual({ ok: true });
    expect(io.disk.get("C:\\work\\retail")!.model.tmdl["tables/Orders.tmdl"]).toBeDefined();
    expect(session.store.getSnapshot().isDirty).toBe(false);
    expect(io.recovery.size).toBe(0);
    expect(session.store.getSnapshot().canUndo).toBe(true); // history survives a save
  });

  it("a failed save keeps the document dirty and reports the reason", async () => {
    const { io, reg, session } = await openSession();
    await reg.execute("model.addTable", { name: "Orders" });
    io.failSave = true;
    expect(await reg.execute("file.save")).toEqual({ ok: false, reason: "failed", message: "disk full" });
    expect(session.store.getSnapshot().isDirty).toBe(true);
    expect(io.disk.get("C:\\work\\retail")!.model.tmdl["tables/Orders.tmdl"]).toBeUndefined();
  });

  it("edits made during the save keep the document dirty", async () => {
    const { io, reg, session } = await openSession();
    await reg.execute("model.addTable", { name: "Orders" });
    const realSave = io.saveProject.bind(io);
    io.saveProject = async (root, project) => {
      session.store.transact("typing during save", (p) => {
        p.name = "Changed";
      });
      return realSave(root, project);
    };
    await reg.execute("file.save");
    expect(session.store.getSnapshot().isDirty).toBe(true);
  });
});

describe("open and recovery", () => {
  it("opening a missing project fails without replacing the current document", async () => {
    const { reg, session } = await openSession();
    const r = await reg.execute("file.open", { path: "C:\\nowhere\\X.pbip" });
    expect(r).toMatchObject({ ok: false, reason: "failed" });
    expect(session.store.project?.name).toBe("Retail");
  });

  it("offers a differing recovery snapshot and restores it as unsaved edits", async () => {
    const io = new FakeIO();
    const onDisk = sampleProject();
    io.disk.set("C:\\work\\retail", onDisk);
    const recovered = { ...structuredClone(onDisk), name: "Recovered" };
    io.recovery.set("C:\\work\\retail", recovered);
    const session = new Session(io, new FakeDialogs());
    const reg = createRegistry(session);
    await session.openProject("C:\\work\\retail\\Retail.pbip");
    expect(session.store.project?.name).toBe("Retail");
    expect(session.getSnapshot().pendingRecovery).not.toBeNull();
    expect(reg.isEnabled("file.restoreRecovery")).toBe(true);
    await reg.execute("file.restoreRecovery");
    expect(session.store.project?.name).toBe("Recovered");
    expect(session.store.getSnapshot().isDirty).toBe(true);
    expect(session.getSnapshot().pendingRecovery).toBeNull();
    expect(reg.isEnabled("file.restoreRecovery")).toBe(false);
  });

  it("discarding removes the recovery file", async () => {
    const io = new FakeIO();
    io.disk.set("C:\\work\\retail", sampleProject());
    io.recovery.set("C:\\work\\retail", { ...sampleProject(), name: "Recovered" });
    const session = new Session(io, new FakeDialogs());
    const reg = createRegistry(session);
    await session.openProject("C:\\work\\retail\\Retail.pbip");
    await reg.execute("file.discardRecovery");
    expect(io.recovery.size).toBe(0);
    expect(session.getSnapshot().pendingRecovery).toBeNull();
    expect(session.store.project?.name).toBe("Retail");
  });

  it("a recovery snapshot equal to the saved project is dropped silently", async () => {
    const io = new FakeIO();
    io.disk.set("C:\\work\\retail", sampleProject());
    io.recovery.set("C:\\work\\retail", sampleProject());
    const session = new Session(io, new FakeDialogs());
    await session.openProject("C:\\work\\retail\\Retail.pbip");
    expect(session.getSnapshot().pendingRecovery).toBeNull();
    expect(io.recovery.size).toBe(0);
  });

  it("a damaged recovery file does not block opening and is mentioned to the user", async () => {
    const io = new FakeIO();
    io.disk.set("C:\\work\\retail", sampleProject());
    io.failRecoveryRead = true;
    const session = new Session(io, new FakeDialogs());
    await session.openProject("C:\\work\\retail\\Retail.pbip");
    expect(session.store.project?.name).toBe("Retail");
    expect(session.getSnapshot().lastMessage).toMatch(/recovery file could not be read: recovery file is damaged/);
  });
});
