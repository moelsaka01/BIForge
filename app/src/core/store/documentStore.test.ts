import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "./documentStore";
import { sampleProject } from "../testing/fakes";

function loaded() {
  const s = new DocumentStore();
  s.load(sampleProject());
  return s;
}

const rename = (to: string) => (p: { name: string }) => {
  p.name = to;
};

describe("DocumentStore", () => {
  it("starts empty and refuses edits without a project", () => {
    const s = new DocumentStore();
    expect(s.getSnapshot().project).toBeNull();
    expect(() => s.transact("x", () => {})).toThrow(/No project/);
  });

  it("applies a transaction as one undoable step and redo restores it", () => {
    const s = loaded();
    expect(s.transact("Rename", rename("A"))).toBe(true);
    expect(s.project!.name).toBe("A");
    expect(s.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "Rename", isDirty: true });
    expect(s.undo()).toBe(true);
    expect(s.project!.name).toBe("Retail");
    expect(s.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: "Rename" });
    expect(s.redo()).toBe(true);
    expect(s.project!.name).toBe("A");
  });

  it("does not mutate earlier states (history is safe)", () => {
    const s = loaded();
    const original = s.project!;
    s.transact("Rename", rename("A"));
    expect(original.name).toBe("Retail");
  });

  it("undo/redo with nothing to do returns false", () => {
    const s = loaded();
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(false);
  });

  it("a throwing edit changes nothing and records nothing", () => {
    const s = loaded();
    expect(() =>
      s.transact("bad", (p) => {
        p.name = "half-done";
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.project!.name).toBe("Retail");
    expect(s.getSnapshot().canUndo).toBe(false);
    expect(s.getSnapshot().isDirty).toBe(false);
  });

  it("an edit that changes nothing is not recorded", () => {
    const s = loaded();
    expect(s.transact("noop", () => {})).toBe(false);
    expect(s.transact("same", rename("Retail"))).toBe(false);
    expect(s.getSnapshot().canUndo).toBe(false);
  });

  it("a new edit clears the redo stack", () => {
    const s = loaded();
    s.transact("one", rename("A"));
    s.undo();
    s.transact("two", rename("B"));
    expect(s.getSnapshot().canRedo).toBe(false);
  });

  it("tracks dirty state, including returning to the saved state by undo", () => {
    const s = loaded();
    expect(s.getSnapshot().isDirty).toBe(false);
    s.transact("one", rename("A"));
    expect(s.getSnapshot().isDirty).toBe(true);
    s.undo();
    expect(s.getSnapshot().isDirty).toBe(false);
    s.redo();
    s.markSaved(s.project!);
    expect(s.getSnapshot().isDirty).toBe(false);
    s.undo();
    expect(s.getSnapshot().isDirty).toBe(true);
  });

  it("an edit made while saving keeps the document dirty", () => {
    const s = loaded();
    s.transact("one", rename("A"));
    const savingNow = s.project!;
    s.transact("two", rename("B")); // user types during the save
    s.markSaved(savingNow);
    expect(s.getSnapshot().isDirty).toBe(true);
  });

  it("limits history to 100 steps", () => {
    const s = loaded();
    for (let i = 0; i < 120; i++) s.transact(`e${i}`, rename(`N${i}`));
    let n = 0;
    while (s.undo()) n++;
    expect(n).toBe(100);
  });

  it("notifies subscribers once per change and stops after unsubscribe", () => {
    const s = loaded();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.transact("one", rename("A"));
    s.undo();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    s.redo();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("load clears history; close empties the store", () => {
    const s = loaded();
    s.transact("one", rename("A"));
    s.load(sampleProject("Other"));
    expect(s.getSnapshot()).toMatchObject({ canUndo: false, isDirty: false });
    s.close();
    expect(s.project).toBeNull();
  });

  it("loadUnsaved keeps the baseline so the restored document is dirty", () => {
    const s = new DocumentStore();
    const disk = sampleProject();
    const recovered = { ...structuredClone(disk), name: "Edited" };
    s.loadUnsaved(recovered, disk);
    expect(s.getSnapshot().isDirty).toBe(true);
  });
});
