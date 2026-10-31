// @vitest-environment jsdom
// The Paginated report visual: Insert > Paginated report reads an .rdl, the visual draws its table as pages over the model.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import sample from "../../../e2e/fixtures/products.rdl?raw";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
import { browserFiles } from "../shell/files";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PRODUCTS: [string, string, string][] = [
  ["Ridge Mountain Bike", "Bikes", "1450"],
  ["Harbor Road Bike", "Bikes", "1100"],
  ["Pebble Kids Bike", "Bikes", "320"],
  ["Orbit Helmet", "Accessories", "59"],
  ["Flow Bottle", "Accessories", "12"],
  ["Beam Light Set", "Accessories", "34"],
  ["Crest Jersey", "Clothing", "72"],
  ["Grip Gloves", "Clothing", "24"],
];

function setup() {
  const io = new FakeIO();
  (io as unknown as { readReportDefinition: (p: string) => Promise<string> }).readReportDefinition = async () => sample;
  const dialogs = new FakeDialogs();
  dialogs.file = "C:\\reports\\products.rdl";
  const session = new Session(io, dialogs);
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  // the query of the visual: the products (only the bikes when the query carries that filter)
  dax.handler = (q) => ({ results: [result(["Product[Product]", "Product[Category]", "Product[ListPrice]"], PRODUCTS.filter((p) => !q.includes('"Bikes"') || p[1] === "Bikes").map(([a, b, c]) => [cell(a, "text"), cell(b, "text"), cell(c, "real")]))], elapsedMs: 1 });
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} readOnly={false} />;
  }
  const visual = () => parsePage(session.store.project!, "page1")!.visuals[0];
  const format = (object: string, prop: string, value: ReturnType<typeof lit.bool>) => run("report.format.set", { page: "page1", visual: visual().name, object, prop, value });
  return { run, Host, visual, format, dialogs, dax };
}

const rows = (sheet: HTMLElement) => within(sheet).getAllByRole("row").slice(1).map((r) => r.textContent);

describe("Paginated report visual", () => {
  it("Insert > Paginated report reads the .rdl and draws its table in pages of the report's size", async () => {
    const t = setup();
    await t.run("report.paginated.insert");
    expect(t.visual().visualType).toBe("rdlVisual");
    render(<t.Host />);
    const sheet = (await screen.findAllByTestId("paginated-sheet"))[0];
    const view = within(sheet.closest("[data-testid=paginated]") as HTMLElement);
    await waitFor(() => expect(within(sheet).getByText("Ridge Mountain Bike")).toBeTruthy());
    expect(within(sheet).getByText("Product list")).toBeTruthy();
    expect(within(sheet).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Product name", "Category", "List price"]);
    // 7 rows fit the 70 mm page, the 8th is on the second page
    expect(rows(sheet)).toHaveLength(7);
    expect(view.getByTestId("paginated-page-number").textContent).toBe("Page 1 of 2");
    fireEvent.click(view.getByRole("button", { name: "Next page" }));
    expect(view.getByTestId("paginated-page-number").textContent).toBe("Page 2 of 2");
    expect(rows(sheet)).toEqual(["Grip GlovesClothing24"]);
    expect((view.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a file that is not a report definition", async () => {
    const io = new FakeIO();
    (io as unknown as { readReportDefinition: (p: string) => Promise<string> }).readReportDefinition = async () => "<html/>";
    const dialogs = new FakeDialogs();
    dialogs.file = "C:/reports/x.rdl";
    const bad = new Session(io, dialogs);
    bad.store.load(fixtureProject());
    const reg = createRegistry(bad);
    bad.report.goToPage("page1");
    const r = await reg.execute("report.paginated.insert");
    expect(r.ok).toBe(false);
    expect(parsePage(bad.store.project!, "page1")!.visuals).toHaveLength(0);
  });

  it("a report parameter filters the data through the column it names, and the page count follows", async () => {
    const t = setup();
    await t.run("report.paginated.insert");
    render(<t.Host />);
    await screen.findByText("Ridge Mountain Bike");
    fireEvent.click(screen.getByRole("button", { name: "Parameters" }));
    const pane = await screen.findByTestId("paginated-parameters");
    fireEvent.change(within(pane).getByLabelText("Category"), { target: { value: "Bikes" } });
    await waitFor(() => expect(screen.getByTestId("paginated-page-number").textContent).toBe("Page 1 of 1"));
    expect(rows(screen.getByTestId("paginated-sheet"))).toHaveLength(3);
    expect(t.dax.calls.some((c) => c.includes('"Bikes"'))).toBe(true);
  });

  it("Export lists the formats that are turned on and hands the data over", async () => {
    const t = setup();
    await t.run("report.paginated.insert");
    const save = vi.spyOn(browserFiles, "save").mockImplementation(() => undefined);
    render(<t.Host />);
    await screen.findByText("Ridge Mountain Bike");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const menu = screen.getByTestId("paginated-export-menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["CSV (comma delimited)", "XML", "MHTML (web archive)", "PDF (print)"]);
    expect(menu.textContent).toContain("Not available yet: Excel, Word, PowerPoint, Accessible PDF.");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /CSV/ }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBe("Product list.csv");
    expect(save.mock.calls[0][1]).toMatch(/^Product name,Category,List price\r\nRidge Mountain Bike,Bikes,1450\r\n/);
  });

  it("the Format pane's cards change the toolbar and the export menu", async () => {
    const t = setup();
    await t.run("report.paginated.insert");
    render(<t.Host />);
    await screen.findByText("Ridge Mountain Bike");
    await t.format("export", "exportXML", lit.bool(false));
    fireEvent.click(await screen.findByRole("button", { name: "Export" }));
    await waitFor(() => expect(within(screen.getByTestId("paginated-export-menu")).queryByRole("menuitem", { name: "XML" })).toBeNull());
    await t.format("toolbar", "pageNavigation", lit.bool(false));
    await waitFor(() => expect(screen.queryByTestId("paginated-page-number")).toBeNull());
    await t.format("toolbar", "show", lit.bool(false));
    await waitFor(() => expect(screen.queryByTestId("paginated-toolbar")).toBeNull());
  });
});
