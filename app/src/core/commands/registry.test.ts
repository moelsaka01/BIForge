import { describe, expect, it } from "vitest";
import { CommandRegistry, eventToShortcut, normalizeShortcut } from "./registry";

describe("normalizeShortcut", () => {
  it.each([
    ["ctrl+z", "Ctrl+Z"],
    ["Shift+Ctrl+S", "Ctrl+Shift+S"],
    ["alt+f4", "Alt+F4"],
    ["CMD+K", "Meta+K"],
    ["delete", "Delete"],
  ])("%s -> %s", (a, b) => expect(normalizeShortcut(a)).toBe(b));

  it("rejects a shortcut without a key", () => {
    expect(() => normalizeShortcut("Ctrl+")).toThrow(/no key/);
  });
});

describe("eventToShortcut", () => {
  const ev = (key: string, m: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...m,
  });
  it("maps key events to normalized shortcuts", () => {
    expect(eventToShortcut(ev("z", { ctrlKey: true }))).toBe("Ctrl+Z");
    expect(eventToShortcut(ev("S", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+S");
  });
  it("ignores bare modifier presses", () => {
    expect(eventToShortcut(ev("Control", { ctrlKey: true }))).toBeNull();
  });
});

describe("CommandRegistry", () => {
  const make = () => {
    const calls: string[] = [];
    const ctx = { enabled: true };
    const r = new CommandRegistry(ctx);
    r.register({ id: "a.run", label: "Run", shortcut: "ctrl+r", keytip: "R", run: (_c, args) => void calls.push(`run:${JSON.stringify(args)}`) });
    r.register({ id: "a.gated", label: "Gated", isEnabled: (c) => c.enabled, run: () => void calls.push("gated") });
    r.register({
      id: "a.fail",
      label: "Fail",
      run: async () => {
        throw new Error("nope");
      },
    });
    return { r, ctx, calls };
  };

  it("executes with arguments and reports success", async () => {
    const { r, calls } = make();
    expect(await r.execute("a.run", { x: 1 })).toEqual({ ok: true });
    expect(calls).toEqual(['run:{"x":1}']);
  });

  it("returns a result instead of throwing for unknown, disabled and failing commands", async () => {
    const { r, ctx, calls } = make();
    expect(await r.execute("zzz")).toMatchObject({ ok: false, reason: "unknown" });
    ctx.enabled = false;
    expect(await r.execute("a.gated")).toMatchObject({ ok: false, reason: "disabled" });
    expect(calls).toEqual([]);
    expect(await r.execute("a.fail")).toEqual({ ok: false, reason: "failed", message: "nope" });
  });

  it("reflects enabled state and finds commands by shortcut", () => {
    const { r, ctx } = make();
    expect(r.isEnabled("a.gated")).toBe(true);
    ctx.enabled = false;
    expect(r.isEnabled("a.gated")).toBe(false);
    expect(r.isEnabled("missing")).toBe(false);
    expect(r.byShortcut("Ctrl+R")?.id).toBe("a.run");
    expect(r.get("a.run")?.keytip).toBe("R");
  });

  it("rejects duplicate ids and duplicate shortcuts", () => {
    const { r } = make();
    expect(() => r.register({ id: "a.run", label: "x", run: () => {} })).toThrow(/already registered/);
    expect(() => r.register({ id: "b", label: "x", shortcut: "Ctrl+R", run: () => {} })).toThrow(/already used by "a.run"/);
  });
});
