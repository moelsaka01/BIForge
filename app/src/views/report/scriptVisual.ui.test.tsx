// @vitest-environment jsdom
// Script visuals (Python visual, R script visual): the script is saved with the visual, runs only when asked, gets the
// data of the visual as CSV, and shows the plot or the interpreter's own error.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column, lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { getFormat, parsePage } from "../../core/report/visualDoc";
import { datasetCsv } from "../../core/report/scriptVisual";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

function setup() {
  const io = new FakeIO();
  const session = new Session(io, new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = () => ({ results: [result(["a", "b"], [[cell("Bikes, big", "text"), cell("70")], [cell("Clothing", "text"), cell("30")]])], elapsedMs: 1 });
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  const visual = () => parsePage(session.store.project!, "page1")!.visuals[0];
  return { io, session, registry, dax, Host, visual };
}
const fields = [{ role: "Values", field: column("Product", "Category") }, { role: "Values", field: agg("Sales", "Quantity", 0) }];

describe("script visuals", () => {
  it("never run by themselves; Edit script saves the text, Run sends the data as CSV and shows the plot", async () => {
    const t = setup();
    await t.registry.execute("report.visual.add", { type: "pythonVisual", fields });
    render(<t.Host />);
    expect((await screen.findByTestId("script-idle")).textContent).toMatch(/No script yet/);
    expect(t.io.scriptRequests).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit the Python script" }));
    fireEvent.change(screen.getByLabelText("Python script"), { target: { value: "dataset.plot()" } });
    fireEvent.click(screen.getByRole("button", { name: "Save script" }));
    await waitFor(() => expect(getFormat(t.visual().json, "script", "source")).toEqual(lit.str("dataset.plot()")));
    fireEvent.click(screen.getByRole("button", { name: "Run the Python script" }));
    const plot = await screen.findByTestId("script-plot");
    expect(plot.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(t.io.scriptRequests).toHaveLength(1);
    expect(t.io.scriptRequests[0]).toMatchObject({ language: "python", code: "dataset.plot()" });
    expect(t.io.scriptRequests[0].csv).toBe('Category,Sum of Quantity\n"Bikes, big",70\nClothing,30\n');
  });

  it("an R script visual runs R with the R options; a failing script shows the interpreter's message", async () => {
    const t = setup();
    t.session.shell.settings.setOption("r.home", "C:\R\R-4.4");
    t.session.shell.settings.setOption("r.timeout", 5);
    await t.registry.execute("report.visual.add", { type: "scriptVisual", fields });
    t.io.scriptResult = new Error("Script error: Error in plot : object not found");
    render(<t.Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Run the R script" }));
    expect((await screen.findByTestId("script-error")).textContent).toMatch(/object not found/);
    expect(t.io.scriptRequests[0]).toMatchObject({ language: "r", home: "C:\R\R-4.4", timeoutMinutes: 5 });
    t.io.scriptResult = "data:image/png;base64,BBBB";
    fireEvent.click(screen.getByRole("button", { name: "Run the R script" }));
    await waitFor(() => expect(screen.getByTestId("script-plot").getAttribute("src")).toBe("data:image/png;base64,BBBB"));
    expect(screen.queryByTestId("script-error")).toBeNull();
  });

  it("the CSV quotes commas, quotes and line breaks and leaves blanks empty", () => {
    const loaded = { kind: "grouped", query: { columns: [{ role: "Values", kind: "group", order: 0, index: 0, label: 'Na"me', format: null }, { role: "Values", kind: "value", order: 1, index: 1, label: "N", format: null }] }, rows: [[{ kind: "text", text: 'a"b', num: null }, { kind: "blank", text: "", num: null }], [{ kind: "text", text: "x\ny", num: null }, { kind: "int", text: "5", num: 5 }]] } as never;
    expect(datasetCsv(loaded)).toBe('"Na""me",N\n"a""b",\n"x\ny",5\n');
  });
});

describe("script > provider", () => {
  it("the name of the script in the visual's buttons and notes is the provider of the card", async () => {
    const t = setup();
    await t.registry.execute("report.visual.add", { type: "pythonVisual", fields });
    await t.registry.execute("report.format.set", { page: "page1", visual: t.visual().name, object: "script", prop: "provider", value: lit.str("Zz") });
    render(<t.Host />);
    expect(await screen.findByRole("button", { name: "Run the Zz script" })).toBeTruthy();
    expect(screen.getByText(/Runs your own Zz on this computer/)).toBeTruthy();
  });
});
