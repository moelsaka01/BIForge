// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column, lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { getFormat, parsePage } from "../../core/report/visualDoc";
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
  return { session, run, Host, visuals: () => parsePage(session.store.project!, "page1")!.visuals };
}
const select = async (name: string) => fireEvent.pointerDown(await waitFor(() => document.querySelector(`[data-visual="${name}"]`) as HTMLElement), { button: 0 });

describe("the Analytics tab", () => {
  it("lists reference lines and the trend line for a line chart and writes their settings", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "lineChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    const v = t.visuals()[0];
    render(<t.Host />);
    await select(v.name);
    fireEvent.click(await screen.findByRole("tab", { name: "Analytics" }));
    const card = (await waitFor(() => document.querySelector('[data-card="y1AxisReferenceLine#constant"]'))) as HTMLElement;
    expect(document.querySelector('[data-card="trend"]')).toBeTruthy();
    fireEvent.click(within(card).getByRole("switch", { name: "Show" }));
    await waitFor(() => expect(getFormat(t.visuals()[0].json, "y1AxisReferenceLine", "show", "id:constant")).toEqual(lit.bool(true)));
    fireEvent.change(within(card).getByLabelText("Value"), { target: { value: "42" } });
    await waitFor(() => expect(getFormat(t.visuals()[0].json, "y1AxisReferenceLine", "value", "id:constant")).toEqual(lit.num(42)));
  });

  it("is disabled for visuals without Analytics (a pie chart) and offers the lines the visual type has", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "pieChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    render(<t.Host />);
    await select(t.visuals()[0].name);
    expect((await screen.findByRole("tab", { name: "Analytics" })).hasAttribute("disabled")).toBe(true);
    cleanup();
    const u = setup();
    await u.run("report.visual.add", { type: "columnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
    render(<u.Host />);
    await select(u.visuals()[0].name);
    fireEvent.click(await screen.findByRole("tab", { name: "Analytics" }));
    await waitFor(() => expect(document.querySelector('[data-card="y1AxisReferenceLine#constant"]')).toBeTruthy());
    // a stacked column chart has the constant line but not the statistic lines
    expect(document.querySelector('[data-card="referenceLine#average"]')).toBeNull();
  });
});
