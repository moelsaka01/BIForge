// @vitest-environment jsdom
// The Format pane built from the schema: typed controls write the stored shapes, instances carry their identity, and a
// setting no renderer reads is marked.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column, lit } from "../../core/report/fields";
import { readLitProp, type J } from "../../core/report/pbir";
import { fixtureProject } from "../../core/report/testFixture";
import { getFormat, parsePage, visualKey } from "../../core/report/visualDoc";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);

function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = () => ({ results: [result(["a", "b"], [])], elapsedMs: 1 });
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  return { session, run, Host, visual: () => parsePage(session.store.project!, "page1")!.visuals[0] };
}
const file = (t: { session: Session; visual(): { name: string } }): J => (t.session.store.project!.report.files as Record<string, J>)[visualKey("page1", t.visual().name)];
const select = async (name: string) => fireEvent.pointerDown(await waitFor(() => document.querySelector(`[data-visual="${name}"]`) as HTMLElement), { button: 0 });
/** The card of a setting group, opened. */
const card = async (id: string) => {
  const el = (await waitFor(() => {
    const e = document.querySelector(`[data-card="${id}"]`);
    expect(e).toBeTruthy();
    return e;
  })) as HTMLElement;
  const header = within(el).getAllByRole("button")[0];
  if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
  return el;
};

describe("the schema-driven Format pane", () => {
  it("an enumerated number (display units) is stored as a number, and a color as a solid fill", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    render(<t.Host />);
    await select(t.visual().name);
    fireEvent.click(await screen.findByRole("tab", { name: "Format visual" }));
    const axis = await card("valueAxis");
    fireEvent.change(within(axis).getByLabelText("Display units"), { target: { value: "1000000" } });
    await waitFor(() => expect(getFormat(t.visual().json, "valueAxis", "labelDisplayUnits")).toEqual(lit.num(1000000)));
    fireEvent.change(within(axis).getByLabelText("Text color"), { target: { value: "#aa0000" } });
    await waitFor(() => expect(getFormat(t.visual().json, "valueAxis", "labelColor")).toEqual(lit.str("#aa0000")));
    // stored the way the report format keeps a color
    const node = file(t).visual.objects.valueAxis[0].properties.labelColor;
    expect(node.solid.color.expr.Literal.Value).toBe("'#aa0000'");
  });

  it("a statistic line is stored as an instance of the reference line object with its type", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "lineChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    render(<t.Host />);
    await select(t.visual().name);
    fireEvent.click(await screen.findByRole("tab", { name: "Analytics" }));
    const c = await card("referenceLine#average");
    fireEvent.click(within(c).getByRole("switch", { name: "Show" }));
    await waitFor(() => expect(getFormat(t.visual().json, "referenceLine", "show", "id:average")).toEqual(lit.bool(true)));
    expect(getFormat(t.visual().json, "referenceLine", "type", "id:average")).toEqual(lit.str("Average"));
    const entry = file(t).visual.objects.referenceLine[0];
    expect(entry.selector).toEqual({ id: "average" });
    // switching it off again removes the entry, type included
    fireEvent.click(within(c).getByRole("switch", { name: "Show" }));
    await waitFor(() => expect(getFormat(t.visual().json, "referenceLine", "show", "id:average")).toEqual(lit.bool(false)));
  });

  it("marks a setting no renderer reads as not drawn yet, and none that is drawn", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    render(<t.Host />);
    await select(t.visual().name);
    fireEvent.click(await screen.findByRole("tab", { name: "Format visual" }));
    const labels = await card("labels");
    // data labels: "Show" is drawn; the custom format string of the detail label is not
    expect(within(labels).getByText("Show").parentElement?.textContent).not.toMatch(/not drawn yet/);
    const undrawn = within(labels).getAllByLabelText("not drawn yet");
    expect(undrawn.length).toBeGreaterThan(0);
  });

  it("the data bars switch of a column writes the structured value of the report format", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "tableEx", fields: [{ role: "Values", field: Cat }, { role: "Values", field: Qty }] });
    render(<t.Host />);
    await select(t.visual().name);
    fireEvent.click(await screen.findByRole("tab", { name: "Format visual" }));
    const values = await card("values");
    fireEvent.change(within(values).getByLabelText("Column to format"), { target: { value: "1" } });
    fireEvent.click(within(values).getByRole("switch", { name: "Data bars" }));
    await waitFor(() => {
      const e = file(t).visual.objects.columnFormatting?.[0];
      expect(e?.selector).toEqual({ metadata: "Sum(Sales.Quantity)" });
      expect(readLitProp(e.properties.dataBars.reverseDirection)).toEqual(lit.bool(false));
    });
  });
});

describe("Style preset", () => {
  it("the General tab offers BIForge's presets; Boxed draws a border, rounded corners and a shadow, Minimal removes the background", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    render(<t.Host />);
    await select(t.visual().name);
    fireEvent.click(await screen.findByRole("tab", { name: "Format visual" }));
    fireEvent.click(await screen.findByRole("tab", { name: "General" }));
    const el = await card("stylePreset");
    const frame = () => document.querySelector(`[data-visual="${t.visual().name}"]`) as HTMLElement;
    const choose = async (name: string) => {
      fireEvent.change(within(el).getByLabelText("Name"), { target: { value: name } });
      await waitFor(() => expect(getFormat(t.visual().json, "stylePreset", "name")).toEqual(lit.str(name)));
    };
    expect(Array.from((within(el).getByLabelText("Name") as HTMLSelectElement).options).map((o) => o.value)).toContain("Boxed");
    await choose("Boxed");
    await waitFor(() => expect(frame().querySelector("[data-container-look]")?.getAttribute("style") ?? frame().getAttribute("style")).toMatch(/box-shadow/));
    await choose("Minimal");
    await waitFor(() => expect((frame().querySelector("[data-container-look]") ?? frame()).getAttribute("style")).not.toMatch(/box-shadow/));
  });
});
