// @vitest-environment jsdom
// Q&A visual: a question typed into the visual becomes a chart; the question is saved where Desktop keeps it.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { getFormat, parsePage } from "../../core/report/visualDoc";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = () => ({ results: [result(["a", "b"], [[cell("Bikes", "text"), cell("70")], [cell("Clothing", "text"), cell("30")]])], elapsedMs: 1 });
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  const visual = () => parsePage(session.store.project!, "page1")!.visuals[0];
  return { session, registry, dax, Host, visual };
}

describe("Q&A visual", () => {
  it("shows examples first; a question builds the chart, says how it was read, and is saved in hiddenProperties.savedUtterance", async () => {
    const t = setup();
    await t.registry.execute("report.visual.add", { type: "qnaVisual" });
    render(<t.Host />);
    expect(await screen.findByTestId("qna-suggestions")).toBeTruthy();
    const box = screen.getByLabelText("Ask a question about your data");
    fireEvent.change(box, { target: { value: "quantity by category" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(getFormat(t.visual().json, "hiddenProperties", "savedUtterance")).toEqual(lit.str("quantity by category")));
    expect((await screen.findByTestId("qna-restated")).textContent).toMatch(/total Quantity by Category/);
    expect(screen.getByTestId("qna-assumed").textContent).toMatch(/added up/);
    await waitFor(() => expect(t.dax.calls.some((c) => c.includes("Product[Category]") && c.includes("SUM(Sales[Quantity])"))).toBe(true));
    expect(screen.queryByTestId("qna-suggestions")).toBeNull();
  });

  it("a question it cannot read is explained; clicking a suggestion asks it", async () => {
    const t = setup();
    await t.registry.execute("report.visual.add", { type: "qnaVisual" });
    render(<t.Host />);
    const box = await screen.findByLabelText("Ask a question about your data");
    fireEvent.change(box, { target: { value: "hello world" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not understand/);
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "total quantity by category" }));
    await waitFor(() => expect(getFormat(t.visual().json, "hiddenProperties", "savedUtterance")).toEqual(lit.str("total quantity by category")));
  });
});

describe("Q&A visual hover colour", () => {
  it("a suggestion takes the input box's hover colour while the pointer is over it and gives it back after", async () => {
    const t = setup();
    await t.registry.execute("report.visual.add", { type: "qnaVisual" });
    const v = t.visual().name;
    await t.registry.execute("report.format.set", { page: "page1", visual: v, object: "inputBox", prop: "hoverColor", value: lit.str("#ff0000") });
    render(<t.Host />);
    const s = (await screen.findAllByRole("button", { name: /quantity|category|by/i }))[0] as HTMLElement;
    const before = s.style.background;
    fireEvent.mouseEnter(s);
    expect(s.style.background).toMatch(/rgb\(255, 0, 0\)|#ff0000/);
    fireEvent.mouseLeave(s);
    expect(s.style.background).toBe(before === "" ? "transparent" : before);
  });
});
