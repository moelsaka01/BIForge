import { describe, expect, it } from "vitest";
import { SETTINGS_KEY, SettingsStore, defaultSettings, sanitizeSettings, MAX_PANE_WIDTH, MIN_PANE_WIDTH, type KeyValueStorage } from "./settings";
import { ShellStore } from "./shellStore";
import { STATUS_TEXT, allControls, ribbonFor, visibleTabs, type RibbonCtx, type RibbonMenuItem } from "./ribbon";
import { createRegistry } from "../commands/builtin";
import { Session } from "../session/session";
import { FakeDialogs, FakeIO, sampleProject } from "../testing/fakes";
import { FakeEngine } from "../testing/fakeEngine";
import { VIEW_IDS } from "./shellStore";

class MemStorage implements KeyValueStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe("settings", () => {
  it("round-trips through storage and keeps each shell's layout separate", () => {
    const st = new MemStorage();
    const a = new SettingsStore(st);
    a.setShell("modern");
    a.setTheme("dark");
    a.setPane("classic", "filters", { open: false, width: 300 });
    a.setPane("modern", "filters", { width: 333 });
    a.addRecent("C:\\p\\A.pbip", "A", 5);
    const b = new SettingsStore(st);
    const s = b.getSnapshot();
    expect(s.shell).toBe("modern");
    expect(s.theme).toBe("dark");
    expect(s.layouts.classic.panes.filters).toEqual({ open: false, width: 300 });
    expect(s.layouts.modern.panes.filters.open).toBe(true);
    expect(s.layouts.modern.panes.filters.width).toBe(333);
    expect(s.recent).toEqual([{ path: "C:\\p\\A.pbip", name: "A", openedAt: 5 }]);
  });

  it("falls back to the defaults for damaged or out-of-range storage", () => {
    const st = new MemStorage();
    st.setItem(SETTINGS_KEY, "{not json");
    expect(new SettingsStore(st).getSnapshot()).toEqual(defaultSettings());
    const s = sanitizeSettings({ shell: "bogus", theme: 3, recent: [{ path: 1 }, { path: "a", name: "b", openedAt: 1 }], layouts: { classic: { panes: { filters: { open: "yes", width: 99999 } } } } });
    expect(s.shell).toBe("classic");
    expect(s.theme).toBe("light");
    expect(s.recent).toHaveLength(1);
    expect(s.layouts.classic.panes.filters.width).toBe(MAX_PANE_WIDTH);
    expect(s.layouts.classic.panes.filters.open).toBe(true);
    new SettingsStore(st).setPane("classic", "data", { width: 1 });
    expect(JSON.parse(st.getItem(SETTINGS_KEY)!).layouts.classic.panes.data.width).toBe(MIN_PANE_WIDTH);
  });

  it("a storage that throws does not break the settings", () => {
    const bad: KeyValueStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    const s = new SettingsStore(bad);
    s.setTheme("dark");
    expect(s.getSnapshot().theme).toBe("dark");
  });

  it("recent projects: newest first, no duplicates (paths compare case-insensitively), capped", () => {
    const s = new SettingsStore(null);
    s.addRecent("C:\\a\\A.pbip", "A", 1);
    s.addRecent("C:\\b\\B.pbip", "B", 2);
    s.addRecent("c:/a/a.pbip", "A", 3);
    expect(s.getSnapshot().recent.map((r) => r.name)).toEqual(["A", "B"]);
    for (let i = 0; i < 40; i++) s.addRecent(`C:\\x\\${i}.pbip`, String(i), 10 + i);
    expect(s.getSnapshot().recent).toHaveLength(20);
    s.removeRecent("C:\\x\\39.pbip");
    expect(s.getSnapshot().recent[0].name).toBe("38");
  });

  it("resets one shell's layout without touching the other", () => {
    const s = new SettingsStore(null);
    s.setPane("classic", "data", { open: false });
    s.setPane("modern", "data", { open: false });
    s.resetLayout("classic");
    expect(s.getSnapshot().layouts.classic.panes.data.open).toBe(true);
    expect(s.getSnapshot().layouts.modern.panes.data.open).toBe(false);
  });
});

function ctx(over: Partial<RibbonCtx> = {}): RibbonCtx {
  return {
    view: "report",
    hasProject: true,
    pageName: "page1",
    pageCount: 1,
    selectedCount: 0,
    selectedGroups: 0,
    selectedGroupNames: [],
    visual: null,
    table: null,
    daxTab: "query",
    panes: { filters: true, visualizations: true, data: true, properties: true, bookmarks: false, selection: false, sync: false },
    themeName: "BIForge Default",
    paused: false,
    canvas: { smartGuides: true, gridlines: false, snapToGrid: false, lockObjects: false, gridSize: 10, visualHeader: true, crossDefault: "highlight", slicerSearch: false, changeFilterTypes: true, filterSearch: true, showHiddenPages: false },
    mobileLayout: false,
    zoom: "fit",
    ...over,
  };
}

describe("ribbon definitions", () => {
  const session = new Session(new FakeIO(), new FakeDialogs(), new FakeEngine());
  const registry = createRegistry(session);

  const menuItems = (items: RibbonMenuItem[] | undefined) => items ?? [];

  for (const shell of ["classic", "modern"] as const) {
    for (const view of VIEW_IDS) {
      it(`${shell}/${view}: every control is bound to a registered command or says why not`, () => {
        const tabs = ribbonFor(shell, view);
        for (const { tab, control } of allControls(tabs)) {
          const where = `${shell}/${view}/${tab}/${control.id}`;
          if (control.command) {
            expect(registry.get(control.command), `${where} -> ${control.command}`).toBeDefined();
            expect(control.status, where).toBeUndefined();
          } else {
            expect(control.status, `${where} has neither a command nor a status`).toBeDefined();
            expect(STATUS_TEXT[control.status!]).toBeTruthy();
          }
          for (const m of menuItems(control.menu)) {
            if (m.command) expect(registry.get(m.command), `${where} menu ${m.label}`).toBeDefined();
            else expect(m.ui || m.status, `${where} menu ${m.label}`).toBeTruthy();
          }
        }
      });

      it(`${shell}/${view}: control ids are unique within a tab and tab keytips are unique`, () => {
        const tabs = ribbonFor(shell, view);
        expect(new Set(tabs.map((t) => t.keytip)).size).toBe(tabs.length);
        for (const t of tabs) {
          const ids = t.groups.flatMap((g) => g.controls.map((c) => c.id));
          expect(new Set(ids).size, t.id).toBe(ids.length);
          const tips = t.groups.flatMap((g) => g.controls.map((c) => c.keytip)).filter(Boolean);
          expect(new Set(tips).size, `${t.id} keytips`).toBe(tips.length);
        }
      });
    }
  }

  it("Classic and Modern arrange the same commands differently (Modern has a Design tab that holds the themes)", () => {
    const classic = ribbonFor("classic", "report");
    const modern = ribbonFor("modern", "report");
    expect(classic.map((t) => t.id)).not.toContain("design");
    expect(modern.map((t) => t.id)).toContain("design");
    const hasThemes = (tab: string, tabs: typeof classic) => tabs.find((t) => t.id === tab)!.groups.some((g) => g.id === "themes");
    expect(hasThemes("view", classic)).toBe(true);
    expect(hasThemes("view", modern)).toBe(false);
    expect(hasThemes("design", modern)).toBe(true);
  });

  it("contextual tabs appear only while a visual is selected", () => {
    const tabs = ribbonFor("classic", "report");
    expect(visibleTabs(tabs, ctx()).map((t) => t.id)).not.toContain("format");
    const withVisual = ctx({ visual: { page: "p", name: "v", type: "x", categories: 2, drillLevel: 0, drillMode: false, editingInteractions: false } });
    expect(visibleTabs(tabs, withVisual).map((t) => t.id)).toEqual(expect.arrayContaining(["format", "drill"]));
    const t = ribbonFor("classic", "data");
    expect(visibleTabs(t, ctx({ view: "data" })).map((x) => x.id)).not.toContain("tableTools");
    expect(visibleTabs(t, ctx({ view: "data", table: "Sales" })).map((x) => x.id)).toContain("tableTools");
  });

  it("selection-dependent controls send the selected visual", () => {
    const tabs = ribbonFor("classic", "report");
    const c = ctx({ visual: { page: "pg", name: "vis", type: "x", categories: 3, drillLevel: 1, drillMode: false, editingInteractions: false } });
    const arrange = allControls(tabs).find((x) => x.control.id === "bringForward")!.control;
    expect(typeof arrange.args === "function" ? arrange.args(c) : arrange.args).toEqual({ page: "pg", visual: "vis", where: "front" });
    const next = allControls(tabs).find((x) => x.control.id === "nextLevel")!.control;
    expect(typeof next.args === "function" ? next.args(c) : null).toEqual({ visual: "vis", levels: 3 });
    expect(next.when!(c)).toBe(true);
    expect(next.when!({ ...c, visual: { ...c.visual!, drillLevel: 2 } })).toBe(false);
  });

  it("the unimplemented controls are counted (they are listed in docs/COVERAGE.md)", () => {
    const todo = allControls(ribbonFor("classic", "report")).filter((x) => x.control.status);
    expect(todo.length).toBeGreaterThan(5);
  });
});

describe("shell commands", () => {
  async function open() {
    const io = new FakeIO();
    io.disk.set("C:\\w", sampleProject());
    const shell = new ShellStore(null);
    const session = new Session(io, new FakeDialogs(), new FakeEngine(), null, shell);
    const reg = createRegistry(session);
    return { io, session, reg, shell };
  }

  it("the app opens on the start screen; opening a project enters the workspace and records it as recent", async () => {
    const { reg, shell } = await open();
    expect(shell.getSnapshot().screen).toBe("start");
    const r = await reg.execute("file.open", { path: "C:\\w\\Retail.pbip" });
    expect(r.ok).toBe(true);
    expect(shell.getSnapshot().screen).toBe("workspace");
    expect(shell.settings.getSnapshot().recent[0]).toMatchObject({ path: "C:\\w\\Retail.pbip", name: "Retail" });
  });

  it("creating a project enters the workspace", async () => {
    const { reg, shell } = await open();
    const r = await reg.execute("file.new", { name: "Demo", folder: "C:\\p\\Demo" });
    expect(r.ok).toBe(true);
    expect(shell.getSnapshot().screen).toBe("workspace");
    expect(shell.settings.getSnapshot().recent[0].path).toBe("C:\\p\\Demo\\Demo.pbip");
  });

  it("Get data without a project asks for a project first and then for the source", async () => {
    const { reg, shell } = await open();
    await reg.execute("data.getData", { source: "excel" });
    expect(shell.getSnapshot().dialog).toEqual({ kind: "newProject", thenImport: "excel" });
    await reg.execute("file.open", { path: "C:\\w\\Retail.pbip" });
    shell.closeDialog();
    await reg.execute("data.getData", { source: "csv" });
    expect(shell.getSnapshot().dialog).toEqual({ kind: "import", source: "csv" });
  });

  it("the File tab shows the backstage over the open project and Back returns to the same view", async () => {
    const { reg, shell } = await open();
    await reg.execute("file.open", { path: "C:\\w\\Retail.pbip" });
    await reg.execute("view.model");
    await reg.execute("app.showStart");
    expect(shell.getSnapshot().screen).toBe("start");
    await reg.execute("app.backToDocument");
    expect(shell.getSnapshot()).toMatchObject({ screen: "workspace", view: "model" });
  });

  it("closing a project with unsaved changes asks first; Don't save discards it and returns to the start screen", async () => {
    const { reg, shell, session, io } = await open();
    await reg.execute("file.open", { path: "C:\\w\\Retail.pbip" });
    await reg.execute("model.addTable", { name: "Extra" });
    await reg.execute("file.close");
    expect(shell.getSnapshot().dialog).toEqual({ kind: "unsaved", resume: { id: "file.close", args: { discard: true } } });
    expect(session.store.project).not.toBeNull();
    await reg.execute("file.close", { discard: true });
    expect(session.store.project).toBeNull();
    expect(shell.getSnapshot().screen).toBe("start");
    expect(io.recovery.size).toBe(0);
  });

  it("views, panes, theme and shell choice change settings through commands only", async () => {
    const { reg, shell } = await open();
    await reg.execute("file.open", { path: "C:\\w\\Retail.pbip" });
    for (const v of VIEW_IDS) {
      await reg.execute(`view.${v}`);
      expect(shell.getSnapshot().view).toBe(v);
    }
    await reg.execute("pane.toggle", { pane: "filters" });
    expect(shell.settings.getSnapshot().layouts.classic.panes.filters.open).toBe(false);
    await reg.execute("app.shell.set", { shell: "modern" });
    // the Modern sidebar shows one pane at a time: Filters becomes its tab; toggling the same tab again closes it
    await reg.execute("pane.toggle", { pane: "filters" });
    expect(shell.getSnapshot().sideTab).toBe("filters");
    expect(shell.settings.getSnapshot().layouts.modern.panes.visualizations.open).toBe(true);
    await reg.execute("pane.toggle", { pane: "filters" });
    expect(shell.settings.getSnapshot().layouts.modern.panes.visualizations.open).toBe(false);
    await reg.execute("pane.toggle", { pane: "bookmarks" });
    expect(shell.getSnapshot().sideTab).toBe("bookmarks");
    expect(shell.settings.getSnapshot().layouts.modern.panes.visualizations.open).toBe(true);
    expect(shell.settings.getSnapshot().layouts.classic.panes.filters.open).toBe(false);
    await reg.execute("app.theme.toggle");
    expect(shell.settings.getSnapshot().theme).toBe("dark");
    expect((await reg.execute("app.shell.set", { shell: "huge" })).ok).toBe(false);
    expect((await reg.execute("pane.toggle", { pane: "nope" })).ok).toBe(false);
    expect((await reg.execute("view.zoom", { zoom: 99 })).ok).toBe(false);
  });

  it("switching the shell does not change the document", async () => {
    const { reg, session } = await open();
    await reg.execute("file.open", { path: "C:\\w\\Retail.pbip" });
    const before = JSON.stringify(session.store.project);
    await reg.execute("app.shell.set", { shell: "modern" });
    await reg.execute("app.shell.set", { shell: "classic" });
    expect(JSON.stringify(session.store.project)).toBe(before);
    expect(session.store.getSnapshot().isDirty).toBe(false);
  });
});
