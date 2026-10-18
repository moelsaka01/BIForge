// @vitest-environment jsdom
// Tests for the scope-change session: no cloud UI, the File menu, Save as, Options, the system theme, system keys.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDomStubs } from "../../core/testing/domStubs";
import { OPTION_PAGES } from "../../core/options/schema";
import { getModelCulture } from "../../core/model/ops";
import { SETTINGS_KEY } from "../../core/shell/settings";
import { agg, column, lit } from "../../core/report/fields";
import { MemoryStorage, PBIP, ROOT, makeApp } from "./testApp";

installDomStubs();
afterEach(cleanup);

type App = ReturnType<typeof makeApp>;
async function openProject(a: App) {
  await act(async () => {
    await a.registry.execute("file.open", { path: PBIP });
  });
}
const names = (els: HTMLElement[]) => els.map((e) => (e.textContent ?? "").trim());

describe("scope: no cloud features anywhere", () => {
  it("the start screen, backstage, title bar and every ribbon of every view show no cloud entry", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    // BIForge's own sharing ("Publish & Share", "Open shared report") is in scope; Microsoft's cloud is not
    const cloud = /OneLake|Sign in|Shared with me|Publish to Power BI|Power BI service|Sensitivity|Copilot|Dataverse|Fabric|datahub/i;
    for (const view of ["report", "data", "model", "dax", "tmdl"] as const) {
      await act(async () => void a.registry.execute(`view.${view}`));
      expect(screen.getByTestId("ribbon").textContent, view).not.toMatch(cloud);
      expect(screen.getByRole("banner").textContent, view).not.toMatch(cloud);
    }
    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("tab", { name: "File" }));
    expect(screen.getByTestId("start-screen").textContent).not.toMatch(cloud);
  });
});

describe("File menu (backstage)", () => {
  it("has New, Open, Save, Save as, Get data, Import, Export, Options and settings, About and Exit, all working commands", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("tab", { name: "File" }));
    const nav = within(screen.getByRole("navigation", { name: "Start" }));
    const labels = names(nav.getAllByRole("button"));
    for (const l of ["New", "Open", "Save", "Save as", "Get data", "Import", "Export", "Options and settings", "About", "Exit"]) expect(labels, l).toContain(l);
    for (const b of nav.getAllByRole("button")) {
      if (/Back to the report/.test(b.getAttribute("aria-label") ?? "")) continue;
      expect((b as HTMLButtonElement).disabled, b.textContent ?? "").toBe(false);
      expect(b.textContent).not.toMatch(/Not implemented|Deferred/);
    }
  });

  it("without a project the menu is New, Open, Open shared report, Options and settings, About, Exit", () => {
    render(makeApp().element);
    const nav = within(screen.getByRole("navigation", { name: "Start" }));
    const labels = names(nav.getAllByRole("button"));
    expect(labels).toEqual(["Home", "New", "Open", "Open shared report", "Host and collaborate", "Join a server", "Options and settings", "About", "Exit"]);
  });

  it("Exit asks about unsaved changes and then closes the window", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => void a.registry.execute("model.addTable", { name: "Extra" }));
    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("tab", { name: "File" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Start" })).getByRole("button", { name: "Exit" }));
    const dlg = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Don't save" }));
    await waitFor(() => expect(a.win.calls).toContain("destroy"));
  });

  it("Save as writes the project and its data to a new folder under a new name and continues there", async () => {
    const a = makeApp();
    a.dialogs.folder = "D:/saved";
    render(a.element);
    await openProject(a);
    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("tab", { name: "File" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Start" })).getByRole("button", { name: "Save as" }));
    const dlg = await screen.findByRole("dialog", { name: "Save as" });
    fireEvent.change(within(dlg).getByLabelText("Project name"), { target: { value: "Renamed" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect((within(dlg).getByLabelText("Location") as HTMLInputElement).value).toBe("D:/saved"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.session.root).toBe("D:/saved/Renamed"));
    expect(a.io.disk.get("D:/saved/Renamed")?.name).toBe("Renamed");
    expect(a.engine.calls.some((c) => c === `copy:${ROOT}->D:/saved/Renamed`)).toBe(true);
    expect(a.session.store.project?.name).toBe("Renamed");
    expect(a.session.store.getSnapshot().isDirty).toBe(false);
    expect(a.session.shell.settings.getSnapshot().recent[0].path).toBe("D:/saved/Renamed/Renamed.pbip");
    expect(a.io.disk.get(ROOT)?.name).toBe("Fixture");
  });

  it("Export > Project copy leaves the open project where it is", async () => {
    const a = makeApp();
    a.dialogs.folder = "D:/copies";
    render(a.element);
    await openProject(a);
    await act(async () => void a.registry.execute("app.showStart"));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Start" })).getByRole("button", { name: "Export" }));
    fireEvent.click(await screen.findByRole("button", { name: /Project copy/ }));
    const dlg = await screen.findByRole("dialog", { name: "Save a copy" });
    fireEvent.change(within(dlg).getByLabelText("Project name"), { target: { value: "Backup" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect((within(dlg).getByLabelText("Location") as HTMLInputElement).value).toBe("D:/copies"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save a copy" }));
    await waitFor(() => expect(a.io.disk.has("D:/copies/Backup")).toBe(true));
    expect(a.session.root).toBe(ROOT);
    expect(a.session.store.project?.name).toBe("Fixture");
  });

  it("Export > Report theme hands out the theme JSON; Import > Report theme applies one", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => void a.registry.execute("app.showStart"));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Start" })).getByRole("button", { name: "Export" }));
    fireEvent.click(await screen.findByRole("button", { name: /Report theme/ }));
    await waitFor(() => expect(a.files.saved).toHaveLength(1));
    expect(JSON.parse(a.files.saved[0].text).name).toBeTruthy();
    a.files.next = JSON.stringify({ name: "Imported scope theme", dataColors: ["#112233", "#445566"] });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Start" })).getByRole("button", { name: "Import" }));
    fireEvent.click(await screen.findByRole("button", { name: /Report theme/ }));
    await waitFor(() => expect(JSON.stringify(a.session.store.project)).toMatch(/Imported scope theme/));
  });
});

describe("Options dialog", () => {
  it("lists every page of GLOBAL and CURRENT FILE; each page opens with its settings, and unimplemented ones say so", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => void a.registry.execute("app.options"));
    const dlg = await screen.findByRole("dialog", { name: "Options" });
    expect(dlg.textContent).toMatch(/GLOBAL/);
    expect(dlg.textContent).toMatch(/CURRENT FILE/);
    const tabs = within(dlg).getAllByRole("tab");
    expect(tabs).toHaveLength(OPTION_PAGES.length);
    for (const page of OPTION_PAGES) {
      fireEvent.click(tabs.find((t) => t.getAttribute("data-page") === page.id)!);
      const panel = within(dlg).getByRole("tabpanel", { name: page.label });
      for (const s of page.settings) {
        const row = panel.querySelector(`[data-option="${s.id}"]`);
        expect(row, `${page.id}/${s.id}`).toBeTruthy();
        if (s.type !== "info") expect(row!.textContent!.includes("Not yet implemented"), s.id).toBe(!s.implemented);
      }
    }
    expect(OPTION_PAGES.filter((p) => p.scope === "global").map((p) => p.label)).toEqual(
      expect.arrayContaining(["Data Load", "Power Query Editor", "DirectQuery", "R scripting", "Python scripting", "Security", "Privacy", "Regional Settings", "Updates", "Usage Data", "Diagnostics", "Preview features", "Auto recovery", "Report settings"]),
    );
    expect(OPTION_PAGES.filter((p) => p.scope === "file").map((p) => p.label)).toEqual(expect.arrayContaining(["Data Load", "Regional Settings", "Privacy", "Auto recovery", "Query reduction", "Report settings"]));
  });

  it("changes real settings: autosave delay and switch, start screen tips, and the model language of the file", async () => {
    const storage = new MemoryStorage();
    const a = makeApp({ storage });
    render(a.element);
    await openProject(a);
    await act(async () => void a.registry.execute("app.options", { page: "g.autoRecovery" }));
    const dlg = await screen.findByRole("dialog", { name: "Options" });
    fireEvent.change(within(dlg).getByLabelText(/Seconds of inactivity/), { target: { value: "30" } });
    expect(a.session.shell.settings.getSnapshot().options["autosave.seconds"]).toBe(30);
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /Save a recovery copy/ }));
    expect(a.session.shell.settings.getSnapshot().options["autosave.enabled"]).toBe(false);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!).options["autosave.seconds"]).toBe(30);

    fireEvent.click(within(dlg).getAllByRole("tab").find((t) => t.getAttribute("data-page") === "f.regional")!);
    const culture = within(dlg).getByRole("combobox", { name: /Model language/ }) as HTMLSelectElement;
    expect(culture.value).toBe("en-US"); // the default shows when the file names none
    const before = getModelCulture(a.session.store.project!);
    fireEvent.change(culture, { target: { value: "de-DE" } });
    await waitFor(() => expect(getModelCulture(a.session.store.project!)).toBe("de-DE"));
    expect(a.session.store.getSnapshot().isDirty).toBe(true);
    await act(async () => void a.registry.execute("edit.undo"));
    expect(getModelCulture(a.session.store.project!)).toBe(before);
  });

  it("file pages need an open project", async () => {
    const a = makeApp();
    render(a.element);
    await act(async () => void a.registry.execute("app.options", { page: "f.regional" }));
    const dlg = await screen.findByRole("dialog", { name: "Options" });
    expect(dlg.textContent).toMatch(/Open a project to change the settings of the current file/);
    expect((within(dlg).getByRole("combobox", { name: /Model language/ }) as HTMLSelectElement).disabled).toBe(true);
  });

  it("rejects settings that do not exist or are not implemented", async () => {
    const a = makeApp();
    const r1 = await a.registry.execute("app.option.set", { id: "nope", value: true });
    const r2 = await a.registry.execute("app.option.set", { id: "dataLoad.parallel", value: false });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });
});

describe("Theme: Use system setting", () => {
  it("follows the Windows light/dark mode and the title bar toggle flips what is on screen", async () => {
    const a = makeApp();
    render(a.element);
    await act(async () => void a.registry.execute("app.theme.set", { theme: "system" }));
    expect(a.shell.settings.getSnapshot().theme).toBe("system");
    expect(a.shell.resolvedTheme()).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to the dark theme" })).toBeTruthy();
    act(() => a.shell.setSystemDark(true));
    expect(a.shell.resolvedTheme()).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to the light theme" })).toBeTruthy();
    // the toggle picks the opposite of what is shown, as an explicit choice
    fireEvent.click(screen.getByRole("button", { name: "Switch to the light theme" }));
    expect(a.shell.settings.getSnapshot().theme).toBe("light");
    act(() => a.shell.setSystemDark(false));
    expect(a.shell.resolvedTheme()).toBe("light");
  });

  it("is a choice in the Options dialog and survives a restart", async () => {
    const storage = new MemoryStorage();
    const a = makeApp({ storage });
    render(a.element);
    await act(async () => void a.registry.execute("app.options"));
    const dlg = await screen.findByRole("dialog", { name: "Options" });
    fireEvent.click(within(dlg).getByLabelText("Use system setting"));
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!).theme).toBe("system");
    cleanup();
    const b = makeApp({ storage });
    expect(b.shell.settings.getSnapshot().theme).toBe("system");
  });
});

describe("system keys are never intercepted", () => {
  it("Print Screen (alone, with Alt, with Ctrl, with Win) and Alt+Tab are not cancelled in any state of the key tips", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    const fire = (type: "keydown" | "keyup", init: KeyboardEventInit) => {
      const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const system: KeyboardEventInit[] = [{ key: "PrintScreen", code: "PrintScreen" }, { key: "PrintScreen", code: "PrintScreen", altKey: true }, { key: "PrintScreen", code: "PrintScreen", ctrlKey: true }, { key: "PrintScreen", code: "PrintScreen", metaKey: true }, { key: "Tab", code: "Tab", altKey: true }, { key: "Meta", code: "MetaLeft" }];
    const run = () => {
      for (const init of system) {
        expect(fire("keydown", init), JSON.stringify(init) + " down").toBe(false);
        expect(fire("keyup", init), JSON.stringify(init) + " up").toBe(false);
      }
    };
    run(); // key tips off
    // Alt alone turns the key tips on, and the keys still are not cancelled
    expect(fire("keydown", { key: "Alt", code: "AltLeft", altKey: true })).toBe(false);
    expect(fire("keyup", { key: "Alt", code: "AltLeft" })).toBe(false);
    await waitFor(() => expect(within(screen.getByTestId("ribbon")).getAllByText("N").length).toBeGreaterThan(0));
    run(); // key tips on
    // a key that is not a key tip ends the key tip mode without being cancelled
    expect(fire("keydown", { key: "PrintScreen", code: "PrintScreen" })).toBe(false);
  });
});

describe("TMDL view is editable", () => {
  async function openTmdl() {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    fireEvent.click(screen.getByRole("button", { name: "TMDL view" }));
    const box = (await screen.findByTestId("tmdl-text")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("printed model.tmdl"));
    return { a, box };
  }

  it("Apply parses the edited file, replaces it in the model as one undoable step, and undo brings the old text back", async () => {
    const { a, box } = await openTmdl();
    const before = JSON.stringify(a.session.store.project!.model.tmdl["model.tmdl"]);
    fireEvent.change(box, { target: { value: "table Added\ntable Another" } });
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(a.session.store.project!.model.tmdl["model.tmdl"].nodes.map((n) => n.name)).toEqual(["Added", "Another"]));
    expect(a.session.store.getSnapshot().isDirty).toBe(true);
    expect(a.session.store.getSnapshot().undoLabel).toBe("Edit model.tmdl");
    await act(async () => void a.registry.execute("edit.undo"));
    expect(JSON.stringify(a.session.store.project!.model.tmdl["model.tmdl"])).toBe(before);
    expect(a.session.store.getSnapshot().isDirty).toBe(false);
    await act(async () => void a.registry.execute("edit.redo"));
    expect(a.session.store.project!.model.tmdl["model.tmdl"].nodes).toHaveLength(2);
  });

  it("text that does not parse is refused with the line, and the model is untouched", async () => {
    const { a, box } = await openTmdl();
    const before = a.session.store.project;
    fireEvent.change(box, { target: { value: "table X\n!!!" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/model\.tmdl: line 2: unexpected indentation/);
    expect(a.session.store.project).toBe(before);
    expect(a.session.store.getSnapshot().canUndo).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(box.value).toBe("printed model.tmdl");
  });

  it("the ribbon's Apply changes applies the open file; a path outside the model is refused", async () => {
    const { a, box } = await openTmdl();
    fireEvent.change(box, { target: { value: "table ViaRibbon" } });
    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(a.session.store.project!.model.tmdl["model.tmdl"].nodes[0].name).toBe("ViaRibbon"));
    const doc = { nodes: [] };
    for (const path of ["../evil.tmdl", "nope.tmdl", "/abs.tmdl", "model.txt"]) {
      expect((await a.registry.execute("model.setTmdlDocument", { path, document: doc })).ok, path).toBe(false);
    }
  });
});

async function visualApp(shell: "classic" | "modern") {
  const a = makeApp();
  render(a.element);
  await openProject(a);
  if (shell === "modern") await act(async () => void a.registry.execute("app.shell.set", { shell: "modern" }));
  await act(async () => {
    await a.registry.execute("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: column("Product", "Category") }, { role: "Y", field: agg("Sales", "Quantity", 0) }] });
  });
  const frame = await waitFor(() => {
    const el = document.querySelector("[data-visual]") as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  });
  fireEvent.pointerDown(frame, { button: 0 });
  return { a, frame };
}

describe("On-object formatting (Modern)", () => {
  it("a selected visual shows formatting handles in Modern, none in Classic", async () => {
    await visualApp("classic");
    expect(screen.queryByTestId("on-object")).toBeNull();
    cleanup();
    await visualApp("modern");
    expect(await screen.findByTestId("on-object")).toBeTruthy();
  });

  it("the handles change the visual's own formatting through commands (undoable), and Format opens the card in the Format pane", async () => {
    const { a, frame } = await visualApp("modern");
    const bar = await screen.findByTestId("on-object");
    const legend = within(bar).getByRole("button", { name: /legend/i });
    const wasOn = legend.getAttribute("aria-pressed") === "true";
    fireEvent.click(legend);
    await waitFor(() => expect(within(screen.getByTestId("on-object")).getByRole("button", { name: /legend/i }).getAttribute("aria-pressed")).toBe(String(!wasOn)));
    expect(a.session.store.getSnapshot().undoLabel).toMatch(/format/i);
    await act(async () => void a.registry.execute("edit.undo"));
    await waitFor(() => expect(within(screen.getByTestId("on-object")).getByRole("button", { name: /legend/i }).getAttribute("aria-pressed")).toBe(String(wasOn)));

    fireEvent.click(within(screen.getByTestId("on-object")).getByRole("button", { name: /Open the formatting options/ }));
    const pane = await screen.findByLabelText("Format pane");
    expect(pane).toBeTruthy();
    expect(a.session.report.getSnapshot().formatFocus?.visual).toBe(frame.getAttribute("data-visual"));
    // the card asked for is open
    await waitFor(() => expect(document.querySelector('[data-card] [aria-expanded="true"]')).toBeTruthy());
  });

  it("the Options switch turns the handles off", async () => {
    const { a } = await visualApp("modern");
    expect(await screen.findByTestId("on-object")).toBeTruthy();
    await act(async () => void a.registry.execute("app.option.set", { id: "preview.onObject", value: false }));
    await waitFor(() => expect(screen.queryByTestId("on-object")).toBeNull());
  });
});

describe("Optimize tab: pause and refresh visuals", () => {
  it("is in both interfaces; while paused a selection sends no new query, and Refresh visuals catches up", async () => {
    const { a } = await visualApp("classic");
    expect(within(screen.getByTestId("ribbon")).getByRole("tab", { name: "Optimize" })).toBeTruthy();
    await act(async () => {
      await a.registry.execute("report.visual.add", { type: "card", fields: [{ role: "Values", field: agg("Sales", "Quantity", 0) }] });
    });
    const page = a.session.report.getSnapshot().page!;
    const visual = (document.querySelector("[data-visual]") as HTMLElement).getAttribute("data-visual")!;
    const queries = () => a.dax.calls.filter((c) => c.startsWith("query:")).length;
    await waitFor(() => expect(queries()).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 100));

    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("tab", { name: "Optimize" }));
    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("button", { name: "Pause visuals" }));
    await waitFor(() => expect(a.session.report.getSnapshot().paused).toBe(true));
    expect(within(screen.getByTestId("ribbon")).getByRole("button", { name: "Pause visuals" }).getAttribute("aria-pressed")).toBe("true");
    await new Promise((r) => setTimeout(r, 100));

    const paused = queries();
    await act(async () => void a.session.report.select(page, visual, { fields: [column("Product", "Category")], values: [lit.str("Bikes")] }, false));
    await new Promise((r) => setTimeout(r, 200));
    expect(queries(), "no query while paused").toBe(paused);

    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("button", { name: "Refresh visuals" }));
    await waitFor(() => expect(queries()).toBeGreaterThan(paused));

    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("button", { name: "Pause visuals" }));
    await waitFor(() => expect(a.session.report.getSnapshot().paused).toBe(false));
  });
});
