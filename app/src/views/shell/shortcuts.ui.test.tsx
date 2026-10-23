// @vitest-environment jsdom
// Keyboard shortcuts of the whole window (Frame's key handler over the command registry): each shortcut runs its command.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { installDomStubs } from "../../core/testing/domStubs";
import { PBIP, makeApp } from "./testApp";

installDomStubs();
afterEach(cleanup);

async function open() {
  const a = makeApp();
  render(a.element);
  await act(async () => void a.registry.execute("file.open", { path: PBIP }));
  return a;
}
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...init });
const dialogKind = (a: Awaited<ReturnType<typeof open>>) => a.shell.getSnapshot().dialog?.kind;

describe("window shortcuts", () => {
  it("Ctrl+N opens the new project dialog", async () => {
    const a = await open();
    press("n", { ctrlKey: true });
    await act(async () => {});
    expect(dialogKind(a)).toBe("newProject");
  });

  it("Ctrl+O opens a project through the file dialog", async () => {
    const a = await open();
    let asked = 0;
    a.dialogs.pickPbip = async () => {
      asked++;
      return null;
    };
    press("o", { ctrlKey: true });
    await act(async () => {});
    expect(asked).toBe(1);
  });

  it("Ctrl+Shift+S opens Save as, Ctrl+S saves", async () => {
    const a = await open();
    await act(async () => void a.registry.execute("model.addTable", { name: "Extra" }));
    expect(a.session.store.getSnapshot().isDirty).toBe(true);
    press("s", { ctrlKey: true });
    await act(async () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(a.session.store.getSnapshot().isDirty).toBe(false);
    press("S", { ctrlKey: true, shiftKey: true });
    await act(async () => {});
    expect(dialogKind(a)).toBe("saveAs");
  });

  it("Ctrl+Z undoes and Ctrl+Y redoes the last edit", async () => {
    const a = await open();
    await act(async () => void a.registry.execute("model.addTable", { name: "Extra" }));
    const has = () => JSON.stringify(a.session.store.project).includes("Extra");
    expect(has()).toBe(true);
    press("z", { ctrlKey: true });
    await act(async () => {});
    expect(has()).toBe(false);
    press("y", { ctrlKey: true });
    await act(async () => {});
    expect(has()).toBe(true);
  });

  it("F11 toggles full screen", async () => {
    const a = await open();
    press("F11");
    await act(async () => {});
    expect(a.win.calls).toContain("toggleFullscreen");
  });

  it("the space bar is not a shortcut and does not throw", async () => {
    const a = await open();
    const before = a.shell.getSnapshot().dialog;
    expect(() => press(" ")).not.toThrow();
    expect(a.shell.getSnapshot().dialog).toBe(before);
  });
});
