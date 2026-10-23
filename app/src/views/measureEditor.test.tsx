// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MeasureEditor } from "./MeasureEditor";
import { DaxEditor } from "./DaxEditor";
import { FakeDax, cell, result } from "../core/testing/fakeDax";
import { FakeEngine } from "../core/testing/fakeEngine";
import { FakeDialogs, FakeIO } from "../core/testing/fakes";
import { Session } from "../core/session/session";
import { createRegistry } from "../core/commands/builtin";
import { listTables } from "../core/model/ops";
import type { EditorFactory, EditorHandle } from "../core/dax/editorTypes";
import type { MarkerSpec } from "../core/dax/language";

afterEach(cleanup);

// Fluent UI's MessageBar observes its size; jsdom has no ResizeObserver
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const failingFactory: EditorFactory = async () => {
  throw new Error("no editor in tests");
};

async function setup() {
  const session = new Session(new FakeIO(), new FakeDialogs(), new FakeEngine());
  const registry = createRegistry(session);
  await session.newProject("C:/p", "Demo");
  const dax = new FakeDax();
  const errors: (string | null)[] = [];
  function Harness() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <MeasureEditor project={doc.project!} dax={dax} registry={registry} factory={failingFactory} onError={(m) => errors.push(m)} />;
  }
  render(<Harness />);
  return { session, registry, dax, errors };
}

const type = async (text: string) => {
  const box = (await screen.findByLabelText("DAX expression")) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
};

describe("MeasureEditor", () => {
  it("lists the project's measures and loads one into the editor", async () => {
    await setup();
    fireEvent.click(await screen.findByRole("button", { name: "Total" }));
    const box = (await screen.findByLabelText("DAX expression")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("SUM(Sales[Amount])"));
    expect((screen.getByLabelText("Measure name") as HTMLInputElement).value).toBe("Total");
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("falls back to a plain text box, visibly, when the code editor cannot load", async () => {
    await setup();
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
  });

  it("checks the expression against the project's documents and shows problems", async () => {
    const s = await setup();
    s.dax.diagnostics.set("SUM(Sales[Nope])", [{ severity: "error", code: "unrecognizedIdentifier", message: "Column 'Nope' cannot be found", start: 4, end: 15 }]);
    await type("SUM(Sales[Nope])");
    await screen.findByText(/Error: Column 'Nope' cannot be found/);
    const last = s.dax.checkedDocuments.at(-1)!;
    expect(last.length).toBeGreaterThan(0);
    expect(last).toEqual(Object.values(s.session.store.project!.model.tmdl));
    // errors block evaluation and saving
    expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Measure name"), { target: { value: "Bad" } });
    expect((screen.getByRole("button", { name: "Add measure" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows warnings for functions that are not implemented without blocking the text", async () => {
    const s = await setup();
    s.dax.diagnostics.set("XIRR(a)", [{ severity: "warning", code: "notImplemented", message: "The function XIRR is not implemented in BIForge yet.", start: 0, end: 4 }]);
    await type("XIRR(a)");
    await screen.findByText(/Warning: The function XIRR is not implemented/);
    expect((screen.getByRole("button", { name: "Evaluate" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("evaluates the draft and shows the value and the split by a column", async () => {
    const s = await setup();
    s.dax.answers.push(
      { match: "ROW(", outcome: { results: [result(["[Value]"], [[cell("1234")]])], elapsedMs: 3 } },
      { match: "SUMMARIZECOLUMNS", outcome: { results: [result(["'Product Info'[ProductKey]", "[Value]"], [[cell("1"), cell("10")], [cell("2"), cell("", "blank")]])], elapsedMs: 4 } },
    );
    await type("SUM(Sales[Amount])");
    fireEvent.change(screen.getByLabelText("Show by"), { target: { value: "Product Info\u0000ProductKey" } });
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
    await waitFor(() => expect(screen.getByTestId("measure-value").textContent).toBe("1234"));
    const q = s.dax.calls.filter((c) => c.startsWith("query:"));
    expect(q[0]).toContain("DEFINE MEASURE Sales[BIForge draft measure] = SUM(Sales[Amount])");
    expect(q[1]).toContain("SUMMARIZECOLUMNS('Product Info'[ProductKey]");
    const grid = screen.getByRole("table", { name: "Measure by column" });
    expect(grid.textContent).toContain("(Blank)");
    expect(screen.getByText("2 rows")).toBeTruthy();
    expect(screen.getByText("7 ms")).toBeTruthy();
  });

  it("shows engine errors instead of a value", async () => {
    const s = await setup();
    s.dax.answers.push({ match: "ROW(", outcome: new Error("A single value for column 'Amount' cannot be determined.") });
    await type("Sales[Amount]");
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
    await screen.findByText(/cannot be determined/);
    expect(screen.queryByTestId("measure-value")).toBeNull();
  });

  it("adds a new measure through the command registry, undoably", async () => {
    const s = await setup();
    await type("SUM(Sales[Amount]) * 2");
    fireEvent.change(screen.getByLabelText("Measure name"), { target: { value: "Double" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Add measure" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Add measure" }));
    await waitFor(() => expect(listTables(s.session.store.project!).flatMap((t) => t.measures).map((m) => m.name)).toContain("Double"));
    expect(s.errors.at(-1)).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(s.session.store.getSnapshot().undoLabel).toContain("Double");
  });

  it("rejects a duplicate name with the model's message", async () => {
    const s = await setup();
    await type("1");
    fireEvent.change(screen.getByLabelText("Measure name"), { target: { value: "Total" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Add measure" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Add measure" }));
    await waitFor(() => expect(s.errors.at(-1)).toMatch(/already exists/));
  });

  it("edits and deletes an existing measure", async () => {
    const s = await setup();
    fireEvent.click(await screen.findByRole("button", { name: "Total" }));
    await waitFor(() => expect((screen.getByLabelText("DAX expression") as HTMLTextAreaElement).value).toBe("SUM(Sales[Amount])"));
    await type("SUM(Sales[Amount]) + 1");
    expect(screen.getByText("Edited, not saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(listTables(s.session.store.project!).flatMap((t) => t.measures).find((m) => m.name === "Total")!.expression).toBe("SUM(Sales[Amount]) + 1"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(listTables(s.session.store.project!).flatMap((t) => t.measures)).toEqual([]));
  });
});

describe("DaxEditor with an injected editor", () => {
  it("keeps the editor and React state in sync and passes markers", async () => {
    const calls: string[] = [];
    let onChange: (v: string) => void = () => {};
    let ctxGetter: (() => unknown) | null = null;
    const handle: EditorHandle = {
      getValue: () => "",
      setValue: (v) => calls.push(`set:${v}`),
      setMarkers: (m: MarkerSpec[]) => calls.push(`markers:${m.length}`),
      focus: () => {},
      dispose: () => calls.push("dispose"),
    };
    const factory: EditorFactory = async (_c, init) => {
      onChange = init.onChange;
      ctxGetter = init.getContext;
      return handle;
    };
    const changes: string[] = [];
    const ctx1 = { catalog: [], tables: [{ name: "A", columns: [], measures: [] }] };
    const { rerender, unmount } = render(<DaxEditor value="a" onChange={(v) => changes.push(v)} context={ctx1} markers={[]} ariaLabel="x" factory={factory} />);
    await waitFor(() => expect(calls).toContain("set:a"));
    act(() => onChange("b"));
    expect(changes).toEqual(["b"]);
    rerender(
      <DaxEditor
        value="c"
        onChange={() => {}}
        context={{ catalog: [], tables: [{ name: "B", columns: [], measures: [] }] }}
        markers={[{ severity: "error", message: "m", start: 0, end: 1 }]}
        ariaLabel="x"
        factory={factory}
      />,
    );
    await waitFor(() => expect(calls).toContain("set:c"));
    expect(calls).toContain("markers:1");
    // the editor reads the latest context when it needs one
    expect((ctxGetter!() as { tables: { name: string }[] }).tables[0].name).toBe("B");
    unmount();
    expect(calls).toContain("dispose");
  });

  it("does not write stale props back into the editor while the user types quickly", async () => {
    let model = "";
    const writes: string[] = [];
    let onChange: (v: string) => void = () => {};
    const handle: EditorHandle = {
      getValue: () => model,
      setValue: (v) => {
        if (v !== model) writes.push(v); // Monaco's setValue on different text resets the caret to the start
        model = v;
      },
      setMarkers: () => {},
      focus: () => {},
      dispose: () => {},
    };
    const factory: EditorFactory = async (_c, init) => {
      onChange = init.onChange;
      return handle;
    };
    const ctx = { catalog: [], tables: [] };
    const el = (value: string) => <DaxEditor value={value} onChange={() => {}} context={ctx} markers={[]} ariaLabel="x" factory={factory} />;
    const { rerender } = render(el(""));
    await waitFor(() => expect(onChange).not.toBe(undefined));
    await act(async () => {});
    // three keystrokes land before React hands the first value back
    act(() => {
      for (const v of ["S", "SU", "SUM"]) {
        model = v;
        onChange(v);
      }
    });
    rerender(el("S"));
    rerender(el("SU"));
    expect(writes).toEqual([]);
    expect(model).toBe("SUM");
    rerender(el("SUM"));
    expect(writes).toEqual([]);
    // a value the editor did not produce (the parent changed it) is still written
    rerender(el("COUNT()"));
    expect(writes).toEqual(["COUNT()"]);
    expect(model).toBe("COUNT()");
  });

  it("disposes an editor that finishes loading after the component went away", async () => {
    const calls: string[] = [];
    let release: (h: EditorHandle) => void = () => {};
    const factory: EditorFactory = () => new Promise<EditorHandle>((res) => (release = res));
    const { unmount } = render(<DaxEditor value="" onChange={() => {}} context={{ catalog: [], tables: [] }} markers={[]} ariaLabel="x" factory={factory} />);
    unmount();
    release({ getValue: () => "", setValue: () => {}, setMarkers: () => {}, focus: () => {}, dispose: () => calls.push("dispose") });
    await waitFor(() => expect(calls).toEqual(["dispose"]));
  });
});
