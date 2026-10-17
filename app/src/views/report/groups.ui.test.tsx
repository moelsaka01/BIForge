// @vitest-environment jsdom
// Groups on the canvas, in the Selection pane and in the Visualizations pane.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { fixtureProject } from "../../core/report/testFixture";
import { parsePage } from "../../core/report/visualDoc";
import { ReportView, plainDocks } from "./ReportView";
import { SelectionPane } from "./SelectionPane";

installDomStubs();
afterEach(cleanup);

function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return (
      <ReportView
        project={doc.project!}
        runtime={session.report}
        dax={dax}
        dispatch={(id, a) => void registry.execute(id, a)}
        dataEpoch={0}
        docks={(api) => ({ right: <>{plainDocks(api).right}<div style={{ width: 240 }}><SelectionPane /></div></> })}
      />
    );
  }
  const page = () => parsePage(session.store.project!, "page1")!;
  const add = async (x: number, y: number) => {
    await run("report.visual.add", { type: "shape", position: { x, y, width: 100, height: 60 } });
    return page().visuals.at(-1)!.name;
  };
  const frame = (name: string) => document.querySelector(`[data-visual="${name}"]`) as HTMLElement;
  return { session, run, Host, page, add, frame };
}

describe("groups on the canvas", () => {
  it("a click selects the group, a second click the member; Ctrl+G groups the selection and Ctrl+Shift+G ungroups", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(300, 0);
    render(<t.Host />);
    await waitFor(() => expect(t.frame(a)).toBeTruthy());
    const region = screen.getByRole("region", { name: /^Page / });
    fireEvent.pointerDown(t.frame(a), { button: 0 });
    fireEvent.pointerDown(t.frame(b), { button: 0, shiftKey: true });
    fireEvent.keyDown(region, { key: "g", ctrlKey: true });
    await waitFor(() => expect(t.page().groups).toHaveLength(1));
    const g = t.page().groups[0].name;
    expect(t.session.report.getSnapshot().canvas).toEqual([g]);
    expect(document.querySelector(`[data-group="${g}"]`)?.getAttribute("data-selected")).toBe("true");
    // another click on a member, while the group is selected, selects the member
    fireEvent.pointerDown(t.frame(a), { button: 0 });
    await waitFor(() => expect(t.session.report.getSnapshot().canvas).toEqual([a]));
    // a click elsewhere then on a member selects the group again
    fireEvent.pointerDown(region, { button: 0 });
    fireEvent.pointerDown(t.frame(b), { button: 0 });
    await waitFor(() => expect(t.session.report.getSnapshot().canvas).toEqual([g]));
    fireEvent.keyDown(region, { key: "G", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(t.page().groups).toHaveLength(0));
    expect(t.session.report.getSnapshot().canvas.sort()).toEqual([a, b].sort());
  });

  it("dragging a member of a selected group moves the group and every member in one step", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(300, 100);
    await t.run("report.visuals.group", { visuals: [a, b] });
    render(<t.Host />);
    await waitFor(() => expect(t.frame(a)).toBeTruthy());
    const region = screen.getByRole("region", { name: /^Page / });
    const scale = parseFloat(/scale\(([\d.]+)\)/.exec(region.style.transform)![1]);
    fireEvent.pointerEnter(t.frame(a));
    const bar = t.frame(a).querySelector("[data-testid=visual-bar]") as HTMLElement;
    fireEvent.pointerDown(bar, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(region, { clientX: 100 + 40 * scale, clientY: 100 + 30 * scale });
    // while dragging, the members are drawn at their new places
    expect(t.frame(b).style.left).toBe("340px");
    fireEvent.pointerUp(region);
    await waitFor(() => expect(t.page().visuals.map((v) => [v.position.x, v.position.y])).toEqual([[40, 30], [340, 130]]));
    expect(t.page().groups[0].position).toMatchObject({ x: 40, y: 30 });
    await t.run("edit.undo");
    expect(t.page().visuals.map((v) => v.position.x)).toEqual([0, 300]);
  });

  it("a hidden group hides its members on a reading canvas", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(300, 0);
    await t.run("report.visuals.group", { visuals: [a, b] });
    await t.run("report.visual.setHidden", { page: "page1", visual: t.page().groups[0].name, hidden: true });
    expect(t.page().groups[0].hidden).toBe(true);
    render(<t.Host />);
    await waitFor(() => expect(t.frame(a)).toBeTruthy()); // still drawn (dimmed) while editing
    expect(t.frame(a).style.opacity).toBe("0.4");
  });
});

describe("groups in the panes", () => {
  it("the Selection pane shows the group above its members, collapses it, renames it and hides it", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(300, 0);
    await t.run("report.visuals.group", { visuals: [a, b] });
    render(<t.Host />);
    const pane = await screen.findByLabelText("Selection pane");
    await waitFor(() => expect(within(pane).getAllByRole("treeitem")).toHaveLength(3));
    expect(within(pane).getAllByRole("treeitem").map((i) => i.getAttribute("aria-level"))).toEqual(["1", "2", "2"]);
    fireEvent.click(within(pane).getByRole("button", { name: "Collapse Group 1" }));
    await waitFor(() => expect(within(pane).getAllByRole("treeitem")).toHaveLength(1));
    fireEvent.doubleClick(within(pane).getByRole("button", { name: "Select Group 1" }));
    const input = within(pane).getByLabelText("Group name");
    fireEvent.change(input, { target: { value: "Header" } });
    fireEvent.blur(input);
    await waitFor(() => expect(t.page().groups[0].displayName).toBe("Header"));
    fireEvent.click(within(pane).getByRole("button", { name: "Hide Header" }));
    await waitFor(() => expect(t.page().groups[0].hidden).toBe(true));
  });

  it("a selected group shows its own settings: layout mode, background and alt text", async () => {
    const t = setup();
    const a = await t.add(0, 0);
    const b = await t.add(300, 0);
    await t.run("report.visuals.group", { visuals: [a, b] });
    render(<t.Host />);
    const pane = await screen.findByLabelText("Group pane");
    fireEvent.change(within(pane).getByLabelText("Group layout"), { target: { value: "ScrollMode" } });
    await waitFor(() => expect(t.page().groups[0].mode).toBe("ScrollMode"));
    fireEvent.click(within(pane).getByRole("switch", { name: "Background" }));
    await waitFor(() => expect(t.page().groups[0].json.visualGroup.objects.background[0].properties.show.expr.Literal.Value).toBe("true"));
    fireEvent.change(within(pane).getByLabelText("Alt text"), { target: { value: "Top row" } });
    fireEvent.blur(within(pane).getByLabelText("Alt text"));
    await waitFor(() => expect(t.page().groups[0].json.visualGroup.objects.general[0].properties.altText.expr.Literal.Value).toBe("'Top row'"));
  });
});
