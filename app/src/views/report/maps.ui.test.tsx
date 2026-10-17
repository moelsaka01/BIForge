// @vitest-environment jsdom
// The bubble map and the filled map in the report view, drawn from the bundled outlines, over the fixture data.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { csvDax } from "../../core/testing/csvDax";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { agg, column } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

const City = column("Customer", "City");
const Country = column("Customer", "Country");
const Category = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);

function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  dax.handler = (q) => csvDax(q);
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  return { run, Host };
}

describe("maps", () => {
  it("a bubble map draws the world outlines and one bubble per located city", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "map", position: { width: 600, height: 400 }, fields: [{ role: "Category", field: City }, { role: "Size", field: Qty }] });
    render(<t.Host />);
    const chart = await screen.findByRole("img", { name: "Map" });
    // the country outlines are drawn as paths, from the registered Natural Earth data (no tiles are requested)
    await waitFor(() => expect(chart.querySelectorAll("path").length).toBeGreaterThan(100));
    // every city of the fixture is known; only the rows without a city (no customer) cannot be placed, and the notice says so
    expect(screen.getByTestId("chart-notice").textContent).toMatch(/1 location not drawn.*: \(Blank\)$/);
  });

  it("a filled map draws the countries; places the data does not know are listed under the map", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "filledMap", position: { width: 600, height: 400 }, fields: [{ role: "Category", field: Country }, { role: "Y", field: Qty }] });
    render(<t.Host />);
    const chart = await screen.findByRole("img", { name: "Filled map" });
    await waitFor(() => expect(chart.querySelectorAll("path").length).toBeGreaterThan(100));
    cleanup();
    const u = setup();
    await u.run("report.visual.add", { type: "filledMap", position: { width: 600, height: 400 }, fields: [{ role: "Category", field: Category }, { role: "Y", field: Qty }] });
    render(<u.Host />);
    // product categories are not places: nothing can be drawn, and the person is told which values were skipped
    await waitFor(() => expect(screen.getByText(/not drawn.*Accessories/)).toBeTruthy());
  });
});
