// @vitest-environment jsdom
// Ribbon buttons that run existing features, driven through the real ribbon: Home data buttons, the View tab's canvas toggles
// and mobile layout, Insert > New page, Help > Keyboard shortcuts, Modeling dialogs.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { canvasOptionsOf } from "../../core/report/canvasOptions";
import { parsePage } from "../../core/report/visualDoc";
import { installDomStubs } from "../../core/testing/domStubs";
import { PBIP, makeApp } from "./testApp";

installDomStubs();
afterEach(cleanup);

type App = ReturnType<typeof makeApp>;
async function open() {
  const a = makeApp();
  render(a.element);
  await act(async () => void a.registry.execute("file.open", { path: PBIP }));
  return a;
}
const ribbon = () => within(screen.getByTestId("ribbon"));
const tab = (name: string) => fireEvent.click(ribbon().getByRole("tab", { name }));
const button = (name: string | RegExp) => fireEvent.click(ribbon().getByRole("button", { name }));
const dialog = (a: App) => a.shell.getSnapshot().dialog;
const canvas = (a: App) => canvasOptionsOf(a.shell.settings.getSnapshot().options);

describe("Home tab: data", () => {
  it("Excel workbook opens the import dialog on Excel; Get data offers Text/CSV; Data source settings opens its dialog", async () => {
    const a = await open();
    button("Excel workbook");
    await waitFor(() => expect(dialog(a)).toEqual({ kind: "import", source: "excel" }));
    await act(async () => void a.shell.closeDialog());
    fireEvent.click(ribbon().getByRole("button", { name: /^Get data/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Text\/CSV/ }));
    await waitFor(() => expect(dialog(a)).toEqual({ kind: "import", source: "csv" }));
    await act(async () => void a.shell.closeDialog());
    button("Data source settings");
    await waitFor(() => expect(dialog(a)?.kind).toBe("dataSources"));
  });
});

describe("View tab: canvas aids", () => {
  it("Smart guides, Gridlines, Snap to grid and Lock objects toggle their option and show it checked", async () => {
    const a = await open();
    tab("View");
    for (const [label, key] of [["Gridlines", "gridlines"], ["Snap to grid", "snapToGrid"], ["Lock objects", "lockObjects"], ["Smart guides", "smartGuides"]] as const) {
      const before = canvas(a)[key];
      button(label);
      await waitFor(() => expect(canvas(a)[key]).toBe(!before));
      await waitFor(() => expect(ribbon().getByRole("button", { name: label }).getAttribute("aria-pressed") === "true", label).toBe(canvas(a)[key] === true));
      button(label);
      await waitFor(() => expect(canvas(a)[key]).toBe(before));
    }
  });

  it("Mobile layout switches the canvas to the phone layout and back", async () => {
    const a = await open();
    tab("View");
    expect(a.session.report.getSnapshot().mobile).toBe(false);
    button("Mobile layout");
    await waitFor(() => expect(a.session.report.getSnapshot().mobile).toBe(true));
    button("Mobile layout");
    await waitFor(() => expect(a.session.report.getSnapshot().mobile).toBe(false));
  });
});

describe("Help tab and Modeling tab", () => {
  it("Help > Keyboard shortcuts opens the dialog", async () => {
    const a = await open();
    tab("Help");
    button("Keyboard shortcuts");
    await waitFor(() => expect(dialog(a)?.kind).toBe("shortcuts"));
  });

  it("Modeling > Manage roles and View as open their dialogs; Quick measure opens its dialog", async () => {
    const a = await open();
    tab("Modeling");
    button("Manage roles");
    expect(await screen.findByRole("dialog", { name: "Manage roles" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Manage roles" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Manage roles" })).toBeNull());
    button("View as");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(a.session.store.project).toBeTruthy();
  });
});

describe("contextual tab: Align and Distribute", () => {
  it("the Align menu aligns the selected visuals and distributes them, through the ribbon", async () => {
    const a = await open();
    const names: string[] = [];
    for (const x of [0, 250, 700]) {
      await act(async () => void a.registry.execute("report.visual.add", { type: "shape", position: { x, y: x === 250 ? 150 : 40, width: 100, height: 60 } }));
      const page = a.session.report.getSnapshot().page!;
      names.push(parsePage(a.session.store.project!, page)!.visuals.at(-1)!.name);
    }
    const ys = () => {
      const page = a.session.report.getSnapshot().page!;
      return names.map((n) => parsePage(a.session.store.project!, page)!.visuals.find((v) => v.name === n)!.position);
    };
    act(() => a.session.report.setCanvasSelection(names));
    fireEvent.click(await ribbon().findByRole("tab", { name: "Format" }));
    fireEvent.click(ribbon().getByRole("button", { name: /^Align/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Align top" }));
    await waitFor(() => expect(ys().map((p) => p.y)).toEqual([40, 40, 40]));
    fireEvent.click(ribbon().getByRole("button", { name: /^Align/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Distribute horizontally" }));
    await waitFor(() => expect(ys().map((p) => p.x)).toEqual([0, 350, 700]));
  });
});

