// @vitest-environment jsdom
// Export data (right-click a visual) and the export of the current page as a picture.
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column } from "../../core/report/fields";
import { canvasOptionsOf } from "../../core/report/canvasOptions";
import { fixtureProject } from "../../core/report/testFixture";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
let saved: { name: string; blob: Blob }[] = [];
beforeEach(() => {
  saved = [];
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => `blob:${saved.length}:${b.size}`;
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, blob: new Blob([this.href]) });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(options: Record<string, boolean | string> = {}, readOnly = false) {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = () => ({ results: [result(["a", "b"], [[cell("Bikes", "text"), cell("1200")], [cell("Clothing", "text"), cell("800")]])], elapsedMs: 1 });
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} readOnly={readOnly} canvas={canvasOptionsOf(options)} />;
  }
  return { session, registry, Host };
}
const add = (t: ReturnType<typeof setup>) => t.registry.execute("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: column("Product", "Category") }, { role: "Y", field: agg("Sales", "Quantity", 0) }] });

describe("Export data", () => {
  it("right-click a visual, Export data: a CSV file of its rows is handed to the user", async () => {
    const t = setup();
    await add(t);
    render(<t.Host />);
    const frame = await waitFor(() => document.querySelector("[data-visual]") as HTMLElement);
    await waitFor(() => expect(frame.querySelector("[role=img]")).toBeTruthy());
    fireEvent.contextMenu(frame);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export data" }));
    await waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0].name).toMatch(/\.csv$/);
  });

  it("in viewing mode the menu offers Export data only while the report allows it", async () => {
    for (const [opts, offered] of [[{}, true], [{ "file.report.showTablesDefault": false }, false]] as const) {
      const t = setup(opts, true);
      await add(t);
      render(<t.Host />);
      const frame = await waitFor(() => document.querySelector("[data-visual]") as HTMLElement);
      fireEvent.contextMenu(frame);
      await waitFor(() => expect(!!screen.queryByRole("menuitem", { name: "Export data" }), JSON.stringify(opts)).toBe(offered));
      cleanup();
    }
  });
});
