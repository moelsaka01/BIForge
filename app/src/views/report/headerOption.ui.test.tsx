// @vitest-environment jsdom
// Options > Report settings > Show the visual header on hover: the default for visuals that do not set their own Visual header.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { canvasOptionsOf } from "../../core/report/canvasOptions";
import { lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

function setup(options: Record<string, boolean>) {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} canvas={canvasOptionsOf(options)} />;
  }
  const add = async () => {
    await act(async () => void registry.execute("report.visual.add", { type: "shape", position: { x: 0, y: 0, width: 200, height: 120 } }));
    return parsePage(session.store.project!, "page1")!.visuals.at(-1)!.name;
  };
  const frame = (name: string) => document.querySelector(`[data-visual="${name}"]`) as HTMLElement;
  return { session, registry, Host, add, frame };
}

describe("Show the visual header on hover", () => {
  it("on by default; off hides the header of visuals that do not decide for themselves; a visual's own setting wins", async () => {
    const on = setup({});
    const a = await on.add();
    const r1 = render(<on.Host />);
    await waitFor(() => expect(on.frame(a)).toBeTruthy());
    fireEvent.pointerDown(on.frame(a), { button: 0 });
    await waitFor(() => expect(r1.container.querySelector("[data-testid=visual-bar]")).toBeTruthy());
    cleanup();

    const off = setup({ "report.visualHeader": false });
    const b = await off.add();
    render(<off.Host />);
    await waitFor(() => expect(off.frame(b)).toBeTruthy());
    fireEvent.pointerDown(off.frame(b), { button: 0 });
    expect(document.querySelector("[data-testid=visual-bar]")).toBeNull();
    // the visual says Show for itself: the report-wide default no longer applies to it
    await act(async () => void off.registry.execute("report.format.set", { page: "page1", visual: b, object: "visualHeader", prop: "show", value: lit.bool(true) }));
    fireEvent.pointerDown(off.frame(b), { button: 0 });
    await waitFor(() => expect(document.querySelector("[data-testid=visual-bar]")).toBeTruthy());
  });
});
