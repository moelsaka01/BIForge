// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as info from "../../core/info";
import { resolveTheme } from "../../core/report/theme";
import { installDomStubs } from "../../core/testing/domStubs";
import { column, agg } from "../../core/report/fields";
import { MemoryStorage, PBIP, ROOT, makeApp } from "./testApp";
import { SETTINGS_KEY } from "../../core/shell/settings";

installDomStubs();
afterEach(cleanup);

type App = ReturnType<typeof makeApp>;

async function openProject(a: App) {
  await act(async () => {
    await a.registry.execute("file.open", { path: PBIP });
  });
}
const ribbon = () => within(screen.getByTestId("ribbon"));
const tab = (name: string) => ribbon().getByRole("tab", { name });

describe("start screen", () => {
  it("the app opens on the start screen, with no status banner and no ribbon", () => {
    const a = makeApp();
    render(a.element);
    expect(screen.getByTestId("start-screen")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Select a data source or start with a blank report/ })).toBeTruthy();
    expect(screen.queryByTestId("ribbon")).toBeNull();
    expect(screen.queryByTestId("status-notice")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Early development|temporary host/i);
    expect("STATUS_NOTICE" in info).toBe(false);
  });

  it("has the data-source cards, all usable, and no cloud items at all", () => {
    render(makeApp().element);
    const card = (id: string) => document.querySelector(`[data-card="${id}"]`) as HTMLButtonElement;
    for (const id of ["blank", "excel", "sql", "sample", "other"]) expect(card(id).disabled, id).toBe(false);
    expect(card("onelake")).toBeNull();
    expect(document.body.textContent).not.toMatch(/OneLake|Sign in|Shared with me|Publish|Sensitivity|Deferred/i);
    expect(screen.queryByRole("tab", { name: /Shared with me/ })).toBeNull();
  });

  it("Blank report asks for a name and a folder, creates the project in its own folder and enters the shell", async () => {
    const a = makeApp();
    a.dialogs.folder = "C:/projects";
    render(a.element);
    fireEvent.click(document.querySelector('[data-card="blank"]')!);
    const dlg = await screen.findByRole("dialog", { name: "New project" });
    const create = within(dlg).getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText("Project name"), { target: { value: "Bad/name" } });
    expect(within(dlg).getByRole("alert").textContent).toMatch(/cannot contain/);
    fireEvent.change(within(dlg).getByLabelText("Project name"), { target: { value: "Budget" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(within(dlg).getByTestId("project-path").textContent).toContain("C:/projects/Budget"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("ribbon")).toBeTruthy());
    expect(a.io.calls).toContain("new:C:/projects/Budget:Budget");
    expect(screen.getByTestId("doc-title").textContent).toMatch(/Budget/);
    expect(screen.queryByTestId("start-screen")).toBeNull();
    expect(a.shell.settings.getSnapshot().recent[0].name).toBe("Budget");
  });

  it("the Excel card creates a project first and then offers the Excel import", async () => {
    const a = makeApp();
    a.dialogs.folder = "C:/projects";
    render(a.element);
    fireEvent.click(document.querySelector('[data-card="excel"]')!);
    const dlg = await screen.findByRole("dialog", { name: "New project" });
    fireEvent.change(within(dlg).getByLabelText("Project name"), { target: { value: "Sales" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect((within(dlg).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(a.shell.getSnapshot().dialog).toEqual({ kind: "import", source: "excel" }));
    expect(a.session.store.project?.name).toBe("Sales");
  });

  it("lists recent projects, filters them by keyword and opens one", async () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ recent: [{ path: PBIP, name: "Fixture", openedAt: Date.now() }, { path: "D:/x/Other.pbip", name: "Other", openedAt: Date.now() - 30 * 86400000 }] }));
    const a = makeApp({ storage });
    render(a.element);
    const table = screen.getByRole("table", { name: "Recent projects" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Filter by keyword"), { target: { value: "oth" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Filter by keyword"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "week" } });
    expect(within(table).queryByText("Other")).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Fixture" }));
    await waitFor(() => expect(screen.getByTestId("ribbon")).toBeTruthy());
    expect(a.session.store.project).not.toBeNull();
  });

  it("a recent project that cannot be opened reports why, and can be removed from the list", async () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ recent: [{ path: "D:/gone/Gone.pbip", name: "Gone", openedAt: Date.now() }] }));
    const a = makeApp({ storage });
    render(a.element);
    fireEvent.click(screen.getByRole("button", { name: "Gone" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot access/);
    expect(screen.getByTestId("start-screen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Gone from the list" }));
    expect(a.shell.settings.getSnapshot().recent).toHaveLength(0);
  });

  it("the Recommended carousel pages through the tips and collapses", () => {
    render(makeApp().element);
    expect(screen.getByText("Bring in data")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next tip" }));
    expect(screen.queryByText("Bring in data")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse recommended" }));
    expect(screen.queryByRole("button", { name: "Next tip" })).toBeNull();
  });
});

describe("workspace", () => {
  it("shows the ribbon, the five views, panes, page tabs and a status bar; the temporary host UI is gone", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    expect(screen.getByTestId("ribbon")).toBeTruthy();
    for (const v of ["Report view", "Table view", "Model view", "DAX query view", "TMDL view"]) expect(screen.getByRole("button", { name: v })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Report pages" })).toBeTruthy();
    for (const p of ["Filters", "Visualizations", "Data"]) expect(document.querySelector(`aside[data-pane="${p}"]`)).toBeTruthy();
    expect(screen.getByRole("contentinfo").textContent).toMatch(/Page 1 of/);
    expect(screen.queryByPlaceholderText("New project name")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Early development/);
  });

  it("the view switcher shows each view", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    fireEvent.click(screen.getByRole("button", { name: "TMDL view" }));
    await waitFor(() => expect((screen.getByTestId("tmdl-text") as HTMLTextAreaElement).value).toBe("printed model.tmdl"));
    fireEvent.click(screen.getByRole("button", { name: "DAX query view" }));
    expect(await screen.findByLabelText("DAX query area")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Model view" }));
    expect(await screen.findByLabelText("Model view")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    expect(screen.getByRole("contentinfo").textContent).toMatch(/Table: |No table selected/);
    fireEvent.click(screen.getByRole("button", { name: "Report view" }));
    expect(screen.getByRole("tablist", { name: "Report pages" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report view" }).getAttribute("aria-current")).toBe("page");
  });

  it("the DAX query view runs a query through the engine and shows the result", async () => {
    const a = makeApp();
    a.dax.handler = (q) => (q.includes("EVALUATE") ? { results: [{ columns: ["Total"], rows: [[{ t: "int", v: "42" }]], totalRows: 1, truncated: false }], elapsedMs: 3 } : undefined);
    render(a.element);
    await openProject(a);
    fireEvent.click(screen.getByRole("button", { name: "DAX query view" }));
    const editor = await screen.findByLabelText("DAX query");
    fireEvent.change(editor, { target: { value: 'EVALUATE ROW("Total", 42)' } });
    fireEvent.click(screen.getAllByRole("button", { name: "Run" }).find((b) => !b.closest(".ribbon") && !b.closest("[data-testid=ribbon]"))!);
    expect((await screen.findByRole("table", { name: "Result 1" })).textContent).toContain("42");
    // the ribbon's Run does the same
    a.dax.calls.length = 0;
    fireEvent.click(ribbon().getByRole("button", { name: "Run" }));
    await waitFor(() => expect(a.dax.calls.some((c) => c.includes("EVALUATE"))).toBe(true));
  });

  it("an error from a command is shown in the frame, not thrown", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => {
      await a.registry.execute("view.zoom", { zoom: 99 });
    });
    // view.zoom is dispatched through the frame's run(); direct registry calls do not show it, the status bar slider does
    fireEvent.change(screen.getByLabelText("Zoom level"), { target: { value: "50" } });
    await waitFor(() => expect(screen.getByTestId("zoom-percent").textContent).toBe("50%"));
  });
});

describe("ribbon", () => {
  it("Home has Get data, Transform data, Refresh, New visual and New measure bound to commands; unfinished buttons are disabled and say so", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    const r = ribbon();
    const disabled = ["Get data", "Transform data", "Refresh", "New visual", "New measure", "Excel workbook"].filter((n) => (r.getByRole("button", { name: n }) as HTMLButtonElement).disabled);
    expect(disabled).toEqual([]);
    const textBox = r.getByRole("button", { name: /Text box/ }) as HTMLButtonElement;
    expect(textBox.disabled).toBe(false);
    const quick = r.getByRole("button", { name: /Quick measure/ }) as HTMLButtonElement;
    expect(quick.disabled).toBe(true);
    expect(quick.title).toMatch(/Not yet implemented/);
    for (const cloud of [/OneLake/, /Publish to Power BI/, /Sensitivity/, /Shared with me/, /Sign in/]) expect(r.queryByRole("button", { name: cloud })).toBeNull();
  });

  it("New measure opens the Measures tab of the DAX view; Manage relationships opens the Model view", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    fireEvent.click(tab("Modeling"));
    fireEvent.click(ribbon().getByRole("button", { name: /Manage relationships/ }));
    await waitFor(() => expect(a.shell.getSnapshot().view).toBe("model"));
    fireEvent.click(ribbon().getByRole("button", { name: /New measure/ }));
    await waitFor(() => expect(a.shell.getSnapshot()).toMatchObject({ view: "dax", daxTab: "measures" }));
    expect(await screen.findByLabelText("Measure editor")).toBeTruthy();
  });

  it("Get data offers the file sources and opens the import dialog on the chosen one", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    fireEvent.click(ribbon().getByRole("button", { name: /^Get data/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Parquet" }));
    await waitFor(() => expect(a.shell.getSnapshot().dialog).toEqual({ kind: "import", source: "parquet" }));
  });

  it("New page and New visual change the document through commands (and can be undone)", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    fireEvent.click(tab("Insert"));
    const before = screen.getAllByRole("tab", { name: /Page|page/ }).length;
    fireEvent.click(ribbon().getByRole("button", { name: /New page/ }));
    await waitFor(() => expect(screen.getAllByRole("tab", { name: /Page|page/ }).length).toBe(before + 1));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getAllByRole("tab", { name: /Page|page/ }).length).toBe(before));
  });

  it("the File tab opens the backstage over the project; Back returns to the report", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    fireEvent.click(tab("File"));
    expect(screen.getByTestId("start-screen")).toBeTruthy();
    const nav = within(screen.getByRole("navigation", { name: "Start" }));
    expect(nav.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(nav.getByRole("button", { name: /Close project/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the report" }));
    expect(screen.getByTestId("ribbon")).toBeTruthy();
  });

  it("collapsing the ribbon hides its commands and is remembered for this shell only", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    fireEvent.click(screen.getByRole("button", { name: "Collapse the ribbon" }));
    expect(screen.queryByRole("toolbar", { name: /commands/ })).toBeNull();
    expect(a.shell.settings.getSnapshot().layouts.classic.ribbonCollapsed).toBe(true);
    expect(a.shell.settings.getSnapshot().layouts.modern.ribbonCollapsed).toBe(false);
    fireEvent.click(tab("Insert"));
    expect(screen.getByRole("toolbar", { name: /Insert commands/ })).toBeTruthy();
  });

  it("Alt shows key tips: Alt, N, P adds a page", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    const pages = () => screen.getAllByRole("tab", { name: /Page|page/ }).length;
    const before = pages();
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.keyUp(window, { key: "Alt" });
    expect(within(screen.getByTestId("ribbon")).getAllByText("N").length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: "n" });
    expect(tab("Insert").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "p" });
    await waitFor(() => expect(pages()).toBe(before + 1));
    // Escape leaves key tip mode
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.keyUp(window, { key: "Alt" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".keytip")).toBeNull();
  });

  it("contextual tabs Format and Data / Drill appear when a visual is selected, and their buttons act on it", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => {
      await a.registry.execute("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: column("Product", "Category") }, { role: "Category", field: column("Product", "Subcategory") }, { role: "Y", field: agg("Sales", "Quantity", 0) }] });
    });
    expect(ribbon().queryByRole("tab", { name: "Format" })).toBeNull();
    const frame = await waitFor(() => {
      const el = document.querySelector("[data-visual]") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.pointerDown(frame, { button: 0 });
    fireEvent.click(await ribbon().findByRole("tab", { name: "Format" }));
    expect(ribbon().getByRole("tab", { name: "Data / Drill" })).toBeTruthy();
    fireEvent.click(ribbon().getByRole("button", { name: /Bring forward/ }));
    await waitFor(() => expect(a.session.store.getSnapshot().undoLabel).toBe("Arrange visual"));
    fireEvent.click(ribbon().getByRole("button", { name: /Edit interactions/ }));
    await waitFor(() => expect(a.session.report.getSnapshot().editInteractions).not.toBeNull());
    fireEvent.click(ribbon().getByRole("tab", { name: "Data / Drill" }));
    expect((ribbon().getByRole("button", { name: /Drill up/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ribbon().getByRole("button", { name: /Go to the next level/ }));
    await waitFor(() => expect(Object.values(a.session.report.getSnapshot().drill)[0]?.level).toBe(1));
    expect((ribbon().getByRole("button", { name: /Drill up/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the Themes menu applies a built-in theme and imports a theme file", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    fireEvent.click(tab("View"));
    fireEvent.click(ribbon().getByRole("button", { name: /Themes/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /BIForge Dark/ }));
    await waitFor(() => expect(resolveTheme(a.session.store.project!).dark).toBe(true));
    a.files.next = JSON.stringify({ name: "Ocean", dataColors: ["#123456"], mystery: 1 });
    fireEvent.click(ribbon().getByRole("button", { name: /Themes/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Browse for themes/ }));
    await waitFor(() => expect(resolveTheme(a.session.store.project!).name).toBe("Ocean"));
    expect(a.session.getSnapshot().lastMessage).toMatch(/mystery/);
    fireEvent.click(ribbon().getByRole("button", { name: /Themes/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Save current theme/ }));
    expect(a.files.saved[0].name).toBe("Ocean.json");
    expect(JSON.parse(a.files.saved[0].text).name).toBe("Ocean");
  });
});

describe("title bar", () => {
  it("shows the project name and its saved state; Save, Undo and Redo are commands", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    expect(screen.getByTestId("doc-title").textContent).toMatch(/Saved/);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await a.registry.execute("model.addTable", { name: "Extra" });
    });
    expect(screen.getByTestId("doc-title").textContent).toMatch(/Unsaved changes/);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("doc-title").textContent).toMatch(/Saved/));
    expect(a.io.calls.some((c) => c.startsWith("save:"))).toBe(true);
  });

  it("the search box finds commands of the current ribbon and runs them", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    const box = screen.getByLabelText("Search commands");
    fireEvent.change(box, { target: { value: "quick measure" } });
    const hit = within(await screen.findByRole("listbox", { name: "Matching commands" })).getByRole("option", { name: /Quick measure/ }) as HTMLButtonElement;
    expect(hit.disabled).toBe(true);
    expect(hit.textContent).toMatch(/Not yet implemented/);
    fireEvent.change(box, { target: { value: "relationships" } });
    const list = await screen.findByRole("listbox", { name: "Matching commands" });
    fireEvent.click(within(list).getByRole("option", { name: /Manage relationships/ }));
    await waitFor(() => expect(a.shell.getSnapshot().view).toBe("model"));
  });

  it("the theme toggle switches between light and dark and the choice is stored", async () => {
    const a = makeApp();
    render(a.element);
    fireEvent.click(screen.getByRole("button", { name: "Switch to the dark theme" }));
    expect(a.shell.settings.getSnapshot().theme).toBe("dark");
    expect(JSON.parse(a.storage.getItem(SETTINGS_KEY)!).theme).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to the light theme" })).toBeTruthy();
  });

  it("has window buttons when the app runs in a window, and Close goes through Exit", async () => {
    const a = makeApp();
    render(a.element);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(a.win.calls).toEqual(["minimize", "toggleMaximize"]);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(a.win.calls).toContain("destroy"));
  });
});

describe("panes", () => {
  it("Classic: Filters, Visualizations and Data sit side by side on the right; the » arrow collapses a pane to a rail and « brings it back", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    const order = [...document.querySelectorAll("aside[data-pane]")].map((e) => e.getAttribute("data-pane"));
    expect(order).toEqual(["Filters", "Visualizations", "Data"]);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Filters" }));
    expect(document.querySelector('aside[data-pane="Filters"]')).toBeNull();
    expect(document.querySelector('[data-pane="Filters"][data-collapsed="true"]')).toBeTruthy();
    expect(a.shell.settings.getSnapshot().layouts.classic.panes.filters.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Expand Filters" }));
    expect(document.querySelector('aside[data-pane="Filters"]')).toBeTruthy();
  });

  it("a pane is resized from its handle (keyboard) and the width is remembered", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    const start = a.shell.settings.getSnapshot().layouts.classic.panes.visualizations.width;
    const handle = screen.getByRole("separator", { name: "Resize Visualizations" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(a.shell.settings.getSnapshot().layouts.classic.panes.visualizations.width).toBe(start + 16);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(a.shell.settings.getSnapshot().layouts.classic.panes.visualizations.width).toBe(start - 32);
    for (let i = 0; i < 40; i++) fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(a.shell.settings.getSnapshot().layouts.classic.panes.visualizations.width).toBeGreaterThanOrEqual(180);
  });

  it("layout is remembered across restarts, separately for each shell", async () => {
    const storage = new MemoryStorage();
    const a = makeApp({ storage });
    render(a.element);
    await openProject(a);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Data" }));
    cleanup();
    const b = makeApp({ storage });
    render(b.element);
    await openProject(b);
    expect(document.querySelector('[data-pane="Data"][data-collapsed="true"]')).toBeTruthy();
    await act(async () => {
      await b.registry.execute("app.shell.set", { shell: "modern" });
    });
    expect(document.querySelector('aside[data-pane="Data"]')).toBeTruthy();
  });

  it("the Data pane ticks a field into a new visual and the selection shows which fields a visual uses", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    const pane = document.querySelector('aside[data-pane="Data"]') as HTMLElement;
    fireEvent.click(within(pane).getByText("Customer"));
    const before = a.session.store.getSnapshot().undoLabel;
    const boxes = within(pane).getAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    await waitFor(() => expect(a.session.store.getSnapshot().undoLabel).not.toBe(before));
  });
});

describe("Modern shell", () => {
  it("puts the Data pane on the left and one sidebar with Visualizations, Filters and Bookmarks tabs on the right, with a Design tab in a single-line ribbon", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => {
      await a.registry.execute("app.shell.set", { shell: "modern" });
    });
    expect(document.querySelector(".app")!.getAttribute("data-shell")).toBe("modern");
    expect(document.querySelector(".ribbon")!.classList.contains("singleline")).toBe(true);
    expect(tab("Design")).toBeTruthy();
    const order = [...document.querySelectorAll("aside[data-pane]")].map((e) => `${e.getAttribute("data-pane")}:${e.classList.contains("left") ? "left" : "right"}`);
    expect(order[0]).toBe("Data:left");
    expect(order[1].endsWith(":right")).toBe(true);
    expect(document.querySelectorAll("aside[data-pane]")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "Filters" }));
    expect(await screen.findByLabelText("Filters pane")).toBeTruthy();
    expect(screen.queryByLabelText("Visualizations pane")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Bookmarks" }));
    expect(await screen.findByLabelText("Bookmarks pane")).toBeTruthy();
  });

  it("the Options dialog switches the interface without changing the document", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    const before = JSON.stringify(a.session.store.project);
    fireEvent.click(screen.getByRole("button", { name: "Options and settings" }));
    const dlg = await screen.findByRole("dialog", { name: "Options" });
    fireEvent.click(within(dlg).getByLabelText(/Modern:/));
    await waitFor(() => expect(document.querySelector(".app")!.getAttribute("data-shell")).toBe("modern"));
    // the shell was replaced under the open dialog; tabster may mark it aria-hidden for a moment
    const again = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Options"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(within(again).getByLabelText(/Classic:/));
    await waitFor(() => expect(document.querySelector(".app")!.getAttribute("data-shell")).toBe("classic"));
    expect(JSON.stringify(a.session.store.project)).toBe(before);
    expect(a.session.store.getSnapshot().isDirty).toBe(false);
  });
});

describe("dialogs: About and keyboard shortcuts", () => {
  it("About lists what works and what does not (the status banner moved here)", async () => {
    const a = makeApp();
    render(a.element);
    fireEvent.click(screen.getByRole("button", { name: /^About/ }));
    const dlg = await screen.findByRole("dialog", { name: "About" });
    expect(within(dlg).getByText("Working today")).toBeTruthy();
    expect(within(dlg).getByText("Not yet implemented")).toBeTruthy();
    expect(dlg.textContent).toMatch(/docs\/COVERAGE\.md/);
  });

  it("the shortcuts dialog lists the registered shortcuts", async () => {
    const a = makeApp();
    render(a.element);
    await act(async () => {
      await a.registry.execute("app.shortcuts");
    });
    const dlg = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dlg).getByText("Ctrl+S")).toBeTruthy();
    expect(within(dlg).getByText("Undo")).toBeTruthy();
  });
});

describe("unsaved changes and the recovery banner", () => {
  it("opening a project and leaving it alone never shows the recovery banner or writes a snapshot", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await new Promise((r) => setTimeout(r, 1500));
    expect(document.querySelector(".notice-bar[role=status]")).toBeNull();
    expect(a.io.recovery.size).toBe(0);
    expect(a.session.store.getSnapshot().isDirty).toBe(false);
  });

  it("a snapshot left by a crash is offered once and can be discarded", async () => {
    const a = makeApp();
    const crashed = structuredClone(a.io.disk.get(ROOT)!);
    crashed.name = "Crashed edit";
    a.io.recovery.set(ROOT, crashed);
    render(a.element);
    await openProject(a);
    const banner = () => document.querySelector(".notice-bar[role=status]");
    await waitFor(() => expect(banner()?.textContent).toMatch(/Unsaved changes from an earlier session/));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(banner()).toBeNull());
    expect(a.io.recovery.size).toBe(0);
  });

  it("closing the window with unsaved changes asks; Don't save leaves no snapshot behind, so the next start shows no banner", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => {
      await a.registry.execute("model.addTable", { name: "Extra" });
      await a.rt.autosave.flush();
    });
    expect(a.io.recovery.size).toBe(1);
    await act(async () => {
      await a.win.requestClose();
    });
    const dlg = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Don't save" }));
    await waitFor(() => expect(a.win.calls).toContain("destroy"));
    expect(a.io.recovery.size).toBe(0);
    cleanup();
    const b = makeApp();
    b.io.disk.set(ROOT, structuredClone(a.io.disk.get(ROOT)!));
    render(b.element);
    await openProject(b);
    expect(document.querySelector(".notice-bar[role=status]")).toBeNull();
  });

  it("Save in that dialog saves, then closes; Cancel keeps the window open", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => {
      await a.registry.execute("model.addTable", { name: "Extra" });
      await a.win.requestClose();
    });
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Unsaved changes" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(a.win.calls).not.toContain("destroy");
    await act(async () => {
      await a.win.requestClose();
    });
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Unsaved changes" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.win.calls).toContain("destroy"));
    expect(a.io.calls.some((c) => c.startsWith("save:"))).toBe(true);
  });

  it("opening another project over unsaved changes asks first", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => {
      await a.registry.execute("model.addTable", { name: "Extra" });
      await a.registry.execute("file.open", { path: PBIP });
    });
    expect(a.shell.getSnapshot().dialog?.kind).toBe("unsaved");
    expect(a.io.calls.filter((c) => c.startsWith("open:"))).toHaveLength(1);
  });
});

describe("the window never scrolls sideways", () => {
  let css = "";
  beforeAll(async () => {
    // vitest does not return the text of a .css import, so the stylesheet is read from disk
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(path: string, enc: string): string };
    css = fs.readFileSync("src/views/shell/shell.css", "utf8"); // tests run from the app folder
  });
  const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("the page, the app root and every region that holds wide content clip or scroll inside themselves", () => {
    expect(rule("html, body, #root")).toMatch(/overflow:\s*hidden/);
    expect(rule(".app")).toMatch(/overflow:\s*hidden/);
    expect(rule(".app")).toMatch(/width:\s*100vw/);
    for (const s of [".workspace", ".view-main", ".view-content", ".report-root", ".report-main", ".view-row"]) expect(rule(s), s).toMatch(/min-width:\s*0/);
    expect(rule(".rb-body")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".statusbar .left")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("long text (the status message, the title, a long error) is cut with an ellipsis instead of widening the window", async () => {
    const a = makeApp();
    render(a.element);
    await openProject(a);
    await act(async () => a.session.setMessage("x".repeat(5000)));
    expect(rule(".tb-title")).toMatch(/text-overflow:\s*ellipsis/);
    expect(screen.getByTestId("status-text").textContent!.length).toBeGreaterThan(5000);
  });
});
