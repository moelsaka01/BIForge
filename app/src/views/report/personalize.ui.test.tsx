// @vitest-environment jsdom
// Personalize visuals: the button in the header of a visual in a shared report, and what it may change.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { personalizeOn } from "../../core/report/reportOps";
import { parsePage } from "../../core/report/visualDoc";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);

/** An editable session with a column chart, then the same project opened for viewing. */
async function setup(personalize: boolean) {
  const edit = new Session(new FakeIO(), new FakeDialogs());
  edit.store.load(fixtureProject());
  const er = createRegistry(edit);
  edit.report.goToPage("page1");
  const runEdit = async (id: string, args?: unknown) => {
    const r = await er.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  await runEdit("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: Cat }, { role: "Y", field: Qty }] });
  if (personalize) await runEdit("report.personalize.set", { enabled: true });
  const session = new Session(new FakeIO(), new FakeDialogs());
  const registry = createRegistry(session);
  session.store.loadReadOnly(edit.store.project!);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = () => ({ results: [result(["a", "b"], [])], elapsedMs: 1 });
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} readOnly />;
  }
  const visual = () => parsePage(session.store.project!, "page1")!.visuals[0];
  return { session, run, registry, Host, visual, edit };
}

describe("personalize visuals", () => {
  it("the report setting is stored on every page and can be turned off again", async () => {
    const t = await setup(true);
    expect(personalizeOn(t.session.store.project!, "page1")).toBe(true);
    const e = t.edit;
    const reg = createRegistry(e);
    await reg.execute("report.personalize.set", { enabled: false });
    expect(personalizeOn(e.store.project!, "page1")).toBe(false);
    expect(e.store.project!.report.files["pages/page1/page.json"].objects).toBeUndefined();
  });

  it("a reader can change the type and the fields of a visual; it is a view change that Reset takes back", async () => {
    const t = await setup(true);
    render(<t.Host />);
    const v = t.visual();
    const frame = await waitFor(() => document.querySelector(`[data-visual="${v.name}"]`) as HTMLElement);
    fireEvent.pointerEnter(frame);
    fireEvent.click(await within(frame).findByRole("button", { name: "Personalize this visual" }));
    const panel = await screen.findByRole("dialog", { name: "Personalize this visual" });
    fireEvent.change(within(panel).getByLabelText("Visual type"), { target: { value: "lineChart" } });
    await waitFor(() => expect(t.visual().visualType).toBe("lineChart"));
    fireEvent.click(within(panel).getByRole("button", { name: /^Remove Sum of Quantity$/ }));
    await waitFor(() => expect(t.visual().roles.Y ?? []).toHaveLength(0));
    fireEvent.change(within(panel).getByLabelText("Add a field"), { target: { value: "c|Sales|Channel" } });
    await waitFor(() => expect(Object.values(t.visual().roles).flat().some((x) => x.field.kind === "column" && x.field.name === "Channel")).toBe(true));
    expect(t.session.store.getSnapshot()).toMatchObject({ isDirty: false, viewChanged: true, canUndo: false });
    fireEvent.click(within(panel).getByRole("button", { name: "Reset all changes" }));
    await waitFor(() => expect(t.visual().visualType).toBe("clusteredColumnChart"));
    expect(t.visual().roles.Y).toHaveLength(1);
  });

  it("without the setting there is no button and the commands refuse; an editable report is not affected", async () => {
    const t = await setup(false);
    render(<t.Host />);
    const v = t.visual();
    const frame = await waitFor(() => document.querySelector(`[data-visual="${v.name}"]`) as HTMLElement);
    fireEvent.pointerEnter(frame);
    expect(within(frame).queryByRole("button", { name: "Personalize this visual" })).toBeNull();
    const r = await t.registry.execute("report.visual.setType", { page: "page1", visual: v.name, type: "lineChart" });
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/personalize/);
    expect(t.visual().visualType).toBe("clusteredColumnChart");
  });
});
