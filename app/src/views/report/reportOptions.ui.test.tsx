// @vitest-environment jsdom
// Options > Report settings / Query reduction with a real effect on the report: the search box of slicers and what a selection does by default.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { canvasOptionsOf } from "../../core/report/canvasOptions";
import { column, lit } from "../../core/report/fields";
import { resolveInteraction } from "../../core/report/interactions";
import { fixtureProject } from "../../core/report/testFixture";
import { listPageNames, parsePage } from "../../core/report/visualDoc";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax, cell, result } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

function setup(options: Record<string, boolean | string>, readOnly = false) {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = () => ({ results: [result(["a"], [[cell("France", "text")], [cell("Canada", "text")]])], elapsedMs: 1 });
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} canvas={canvasOptionsOf(options)} readOnly={readOnly} />;
  }
  const run = (id: string, a?: unknown) => act(async () => void (await registry.execute(id, a)));
  return { session, run, Host };
}

describe("slicer search", () => {
  const search = () => document.querySelector("input[aria-label='Search values']");
  it("the report settings put the search box on slicers that do not decide for themselves; a slicer's own setting wins", async () => {
    for (const [opts, expected] of [[{}, false], [{ "report.slicerSearch": true }, true], [{ "file.report.slicerSearch": true }, true]] as const) {
      const t = setup(opts);
      await t.run("report.visual.add", { type: "slicer", fields: [{ role: "Values", field: column("Customer", "Country") }], position: { x: 0, y: 0, width: 200, height: 200 } });
      const r = render(<t.Host />);
      await waitFor(() => expect(r.container.querySelector("[role=checkbox], input[type=checkbox]")).toBeTruthy());
      expect(!!search(), JSON.stringify(opts)).toBe(expected);
      cleanup();
    }
    const t = setup({ "report.slicerSearch": true });
    await t.run("report.visual.add", { type: "slicer", fields: [{ role: "Values", field: column("Customer", "Country") }], position: { x: 0, y: 0, width: 200, height: 200 } });
    const name = parsePage(t.session.store.project!, "page1")!.visuals[0].name;
    await t.run("report.format.set", { page: "page1", visual: name, object: "general", prop: "selfFilterEnabled", value: lit.bool(false) });
    const r = render(<t.Host />);
    await waitFor(() => expect(r.container.querySelector("input[type=checkbox], [role=checkbox]")).toBeTruthy());
    expect(search()).toBeNull();
  });
});

describe("what a selection does by default", () => {
  it("the options choose highlight, filter or nothing where the page has no Edit interactions setting, which still wins", async () => {
    const t = setup({});
    await t.run("report.visual.add", { type: "clusteredColumnChart", fields: [{ role: "Category", field: column("Product", "Category") }, { role: "Y", field: { kind: "agg", table: "Sales", name: "Quantity", fn: 0 } as never }] });
    await t.run("report.visual.add", { type: "clusteredBarChart", fields: [{ role: "Category", field: column("Customer", "Country") }, { role: "Y", field: { kind: "agg", table: "Sales", name: "Quantity", fn: 0 } as never }] });
    const page = parsePage(t.session.store.project!, "page1")!;
    const [a, b] = page.visuals;
    expect(canvasOptionsOf({}).crossDefault).toBe("highlight");
    expect(canvasOptionsOf({ "report.crossFilter": "filter" }).crossDefault).toBe("filter");
    expect(canvasOptionsOf({ "report.crossFilter": "filter", "file.qr.disableCross": true }).crossDefault).toBe("none");
    expect(resolveInteraction(page, a, b)).toBe("highlight");
    expect(resolveInteraction(page, a, b, "highlight")).toBe("highlight");
    expect(resolveInteraction(page, a, b, "filter")).toBe("filter");
    expect(resolveInteraction(page, a, b, "none")).toBe("none");
    await t.run("report.interaction.set", { page: "page1", source: a.name, target: b.name, type: "DataFilter" });
    const set = parsePage(t.session.store.project!, "page1")!;
    expect(resolveInteraction(set, set.visuals[0], set.visuals[1], "none")).toBe("filter"); // Edit interactions wins
  });
});

describe("viewing-mode report settings", () => {
  it("hidden pages are not listed to readers unless Options > Current File > Show hidden pages is on", async () => {
    for (const [opts, shown] of [[{}, false], [{ "file.report.hiddenPages": true }, true]] as const) {
      const t = setup(opts, true);
      await t.run("report.page.add", { name: "Secret" });
      const pageName = listPageNames(t.session.store.project!).find((n) => parsePage(t.session.store.project!, n)!.displayName === "Secret")!;
      await t.run("report.page.setHidden", { page: pageName, hidden: true });
      await t.run("report.page.go", { page: "page1" });
      render(<t.Host />);
      await screen.findAllByRole("tab");
      expect(!!screen.queryByRole("tab", { name: /Secret/ }), JSON.stringify(opts)).toBe(shown);
      cleanup();
    }
  });

  it("readers can switch a filter type only when Allow users to change filter types is on; the filter search follows its option", async () => {
    for (const [opts, locked, search] of [[{}, false, true], [{ "report.changeFilterTypes": false }, true, true], [{ "file.report.changeFilterTypes": false }, true, true], [{ "report.filterSearch": false }, false, false]] as const) {
      const t = setup(opts, true);
      await t.run("report.filter.upsert", { scope: { level: "page", page: "page1" }, filter: { name: "f1", field: column("Product", "Category"), cond: { kind: "in", values: [] } } });
      render(<t.Host />);
      const type = await screen.findByLabelText("Filter type for Category");
      expect((type as HTMLSelectElement).disabled, JSON.stringify(opts)).toBe(locked);
      expect(!!screen.queryByLabelText("Search filters"), JSON.stringify(opts)).toBe(search);
      cleanup();
    }
  });
});
