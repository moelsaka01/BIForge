// @vitest-environment jsdom
import { useState, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column, lit, measure } from "../../core/report/fields";
import { asValueField, routeField, usedIn } from "../../core/report/fieldRouting";
import { modelInfo } from "../../core/report/modelInfo";
import { fixtureProject } from "../../core/report/testFixture";
import { getRawProp, parseVisual, parsePage, visualKey } from "../../core/report/visualDoc";
import { resolveTheme } from "../../core/report/theme";
import { DataPane, type DataPaneProps } from "../DataPane";
import { ReportView } from "./ReportView";

installDomStubs();
afterEach(cleanup);

const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);
const text = (v: string) => cell(v, "text");
const rows = (...r: [string, number][]) => r.map(([a, b]) => [text(a), cell(String(b))]);

function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject({ Sales: [{ name: "Total", expr: "SUM(Sales[Quantity])", format: "#,0" }] }));
  const registry = createRegistry(session);
  const dax = new FakeDax();
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host({ withData = false }: { withData?: boolean }) {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    const [sel, setSel] = useState<{ page: string; visual: string } | null>(null);
    const project = doc.project!;
    const m = modelInfo(project);
    const visual = sel ? parseVisual(sel.page, project.report.files[visualKey(sel.page, sel.visual)]) : null;
    const fieldUse: DataPaneProps["fieldUse"] = {
      isUsed: (f) => !!visual && usedIn(visual, f) !== null,
      onToggle: (f) => {
        if (visual) {
          const u = usedIn(visual, f);
          if (u) return void run("report.field.remove", { page: visual.pageName, visual: visual.name, role: u.role, index: u.index });
          const r = routeField(project, m, visual, f);
          if (r) void run("report.field.add", { page: visual.pageName, visual: visual.name, role: r.role, field: r.field });
        } else void run("report.visual.add", { type: "tableEx", fields: [{ role: "Values", field: f.kind === "column" ? f : asValueField(m, f) }] });
      },
    };
    return (
      <div style={{ display: "flex" }}>
        {withData && <DataPane project={project} dataTables={[]} selected={null} canImport={false} onSelect={() => undefined} onRefresh={() => undefined} onRefreshAll={() => undefined} onImport={() => undefined} fieldUse={fieldUse} />}
        <ReportView project={project} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} onSelectVisual={(p, v) => setSel(p && v ? { page: p, visual: v } : null)} />
      </div>
    );
  }
  const page = () => parsePage(session.store.project!, "page1")!;
  return { session, dax, run, Host, page };
}

describe("ReportView: tables, matrices, drilling", () => {
  it("clicking a table header sorts ascending, then descending, then back to the default", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "tableEx", fields: [{ role: "Values", field: Cat }, { role: "Values", field: Qty }] });
    t.dax.handler = () => ({ results: [result(["a", "b"], rows(["Bikes", 270], ["Clothing", 181]))], elapsedMs: 1 });
    render(<t.Host />);
    const header = await screen.findByRole("columnheader", { name: /Category/ });
    fireEvent.click(header);
    await waitFor(() => expect(t.page().visuals[0].sort).toEqual({ field: Cat, dir: "asc" }));
    fireEvent.click(await screen.findByRole("columnheader", { name: /Category/ }));
    await waitFor(() => expect(t.page().visuals[0].sort?.dir).toBe("desc"));
    expect(await screen.findByRole("columnheader", { name: /Category/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Category/ }).getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(screen.getByRole("columnheader", { name: /Category/ }));
    await waitFor(() => expect(t.page().visuals[0].sort).toBeNull());
  });

  it("a matrix collapses and expands its row groups", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "pivotTable", position: { width: 600, height: 400 }, fields: [{ role: "Rows", field: Cat }, { role: "Rows", field: column("Product", "Subcategory") }, { role: "Values", field: Qty }] });
    t.dax.handler = (q) => {
      const statements = q.split("EVALUATE").length - 1;
      expect(statements).toBe(3);
      return {
        results: [
          result(["[m0]"], [[cell("451")]]),
          result(["Category", "[m0]"], rows(["Bikes", 270], ["Clothing", 181])),
          result(["Category", "Subcategory", "[m0]"], [[text("Bikes"), text("Road"), cell("170")], [text("Bikes"), text("Mountain"), cell("100")], [text("Clothing"), text("Tops"), cell("181")]]),
        ],
        elapsedMs: 1,
      };
    };
    render(<t.Host />);
    const matrix = await screen.findByTestId("matrix");
    await waitFor(() => expect(within(matrix).getByText("Road")).toBeTruthy());
    expect(within(matrix).getByText("Total")).toBeTruthy();
    fireEvent.click(within(matrix).getByRole("button", { name: "Collapse Bikes" }));
    await waitFor(() => expect(within(matrix).queryByText("Road")).toBeNull());
    expect(within(matrix).getByText("Tops")).toBeTruthy();
    fireEvent.click(within(matrix).getByRole("button", { name: "Expand Bikes" }));
    await waitFor(() => expect(within(matrix).getByText("Road")).toBeTruthy());
  });

  it("drill controls: down mode, up, next level and expand change the query", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", position: { width: 600, height: 300 }, fields: [{ role: "Category", field: Cat }, { role: "Category", field: column("Product", "Subcategory") }, { role: "Y", field: Qty }] });
    t.dax.handler = (q) => ({ results: [result(["a", "b"], rows([q.includes("Subcategory") ? "Road" : "Bikes", 1]))], elapsedMs: 1 });
    render(<t.Host />);
    const v = t.page().visuals[0].name;
    const frame = await waitFor(() => document.querySelector(`[data-visual="${v}"]`) as HTMLElement);
    fireEvent.pointerDown(frame, { button: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Go to the next level" }));
    await waitFor(() => expect(t.session.report.drillOf(v)).toEqual({ level: 1, path: [null], expand: false }));
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes("SUMMARIZECOLUMNS(Product[Subcategory]"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Drill up" }));
    expect(t.session.report.drillOf(v).level).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Expand all down one level" }));
    await waitFor(() => expect(t.session.report.drillOf(v).expand).toBe(true));
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes("SUMMARIZECOLUMNS(Product[Category], Product[Subcategory]"))).toBe(true));
    const mode = screen.getByRole("button", { name: "Drill down mode" });
    t.session.report.resetDrill(v);
    fireEvent.click(mode);
    expect(t.session.report.getSnapshot().drillMode).toBe(v);
  });
});

describe("ReportView: Data pane, conditional formatting, themes", () => {
  it("a checkbox adds a field to the selected visual (a sum for numbers) and removes it again", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", position: { width: 500, height: 300 } });
    t.dax.handler = () => ({ results: [result(["a", "b"], rows(["Bikes", 1]))], elapsedMs: 1 });
    render(<t.Host withData />);
    const frame = await waitFor(() => document.querySelector(`[data-visual="${t.page().visuals[0].name}"]`) as HTMLElement);
    fireEvent.pointerDown(frame, { button: 0 });
    fireEvent.click(await screen.findByText("Sales"));
    fireEvent.click(await screen.findByLabelText("Use Quantity in the selected visual"));
    await waitFor(() => expect(t.page().visuals[0].roles.Y?.[0].field).toEqual(Qty));
    await waitFor(() => expect((screen.getByLabelText("Use Quantity in the selected visual") as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByLabelText("Use Quantity in the selected visual"));
    await waitFor(() => expect(t.page().visuals[0].roles.Y).toBeUndefined());
    fireEvent.click(screen.getByLabelText("Use Total in the selected visual"));
    await waitFor(() => expect(t.page().visuals[0].roles.Y?.[0].field).toEqual(measure("Sales", "Total")));
  });

  it("a hierarchy lists its levels, adds all of them to the selected visual, and hidden fields are left out", async () => {
    const t = setup();
    await t.run("model.addHierarchy", { table: "Product", name: "Categories", columns: ["Category", "Subcategory"] });
    await t.run("model.setProperty", { target: { kind: "column", table: "Sales", column: "Quantity" }, key: "isHidden", value: true });
    await t.run("report.visual.add", { page: "page1", type: "clusteredColumnChart", position: { width: 500, height: 300 } });
    t.dax.handler = () => ({ results: [result(["a", "b"], rows(["Bikes", 1]))], elapsedMs: 1 });
    render(<t.Host withData />);
    const frame = await waitFor(() => document.querySelector(`[data-visual="${t.page().visuals[0].name}"]`) as HTMLElement);
    fireEvent.pointerDown(frame, { button: 0 });
    fireEvent.click(await screen.findByText("Sales"));
    expect(screen.queryByLabelText("Use Quantity in the selected visual")).toBeNull();
    fireEvent.click(await screen.findByText("Product"));
    fireEvent.click(await screen.findByLabelText("Use the hierarchy Categories in the selected visual"));
    await waitFor(() => expect(t.page().visuals[0].roles.Category?.map((x) => x.field)).toEqual([column("Product", "Category"), column("Product", "Subcategory")]));
    expect((screen.getByLabelText("Use the hierarchy Categories in the selected visual") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Use the hierarchy Categories in the selected visual"));
    await waitFor(() => expect(t.page().visuals[0].roles.Category).toBeUndefined());
  });

  it("with nothing selected, checking a field starts a table", async () => {
    const t = setup();
    t.dax.handler = () => ({ results: [result(["a"], [[text("Bikes")]])], elapsedMs: 1 });
    render(<t.Host withData />);
    fireEvent.click(await screen.findByText("Product"));
    fireEvent.click(await screen.findByLabelText("Use Category in the selected visual"));
    await waitFor(() => expect(t.page().visuals.map((v) => v.visualType)).toEqual(["tableEx"]));
  });

  it("the conditional-format dialog stores a rule format on the card", async () => {
    const t = setup();
    await t.run("report.visual.add", { page: "page1", type: "card", fields: [{ role: "Values", field: measure("Sales", "Total") }] });
    t.dax.handler = () => ({ results: [result(["m"], [[cell("5")]])], elapsedMs: 1 });
    render(<t.Host />);
    const v = t.page().visuals[0];
    fireEvent.pointerDown(await waitFor(() => document.querySelector(`[data-visual="${v.name}"]`) as HTMLElement), { button: 0 });
    fireEvent.click(await screen.findByRole("tab", { name: "Format visual" }));
    fireEvent.click(await screen.findByRole("button", { name: "Value color by rules (fx)" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Format style"), { target: { value: "rules" } });
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "100" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(getRawProp(t.session.store.project!.report.files[visualKey("page1", v.name)], "labels", "color")?.solid?.color?.expr?.Conditional?.Cases).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("card-value").getAttribute("style")).toMatch(/color: rgb\(|color: #/));
  });
});
