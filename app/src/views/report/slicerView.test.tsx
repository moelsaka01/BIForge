// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { decodeCell } from "../../core/report/cells";
import type { Loaded } from "../../core/report/dataLoader";
import { lit } from "../../core/report/fields";
import type { Cond } from "../../core/report/filters";
import { DEFAULT_THEME } from "../../core/report/theme";
import { SlicerView, toggleItem, type SlicerMode, type SlicerViewProps } from "./SlicerView";

afterEach(cleanup);

const slicerData = (values: string[], range?: [number, number]): Extract<Loaded, { kind: "slicer" }> => ({
  kind: "slicer",
  query: { dax: "", field: { kind: "column", table: "T", name: "C" }, sortHelper: false },
  values: values.map((v) => decodeCell({ t: "text", v })),
  range: range ? { min: decodeCell({ t: "int", v: String(range[0]) }), max: decodeCell({ t: "int", v: String(range[1]) }) } : null,
  ms: 0,
});

function props(over: Partial<SlicerViewProps> & { mode?: SlicerMode } = {}): SlicerViewProps & { onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  return { loaded: slicerData(["Canada", "France", "Japan"]), mode: "Basic", cond: null, singleSelect: false, selectAll: false, search: false, isDate: false, theme: DEFAULT_THEME, width: 220, height: 260, onChange, ...over } as never;
}

describe("toggleItem", () => {
  const all = [lit.str("a"), lit.str("b"), lit.str("c")];
  it("multi-select adds and removes values; the last removal clears the filter", () => {
    let c: Cond | null = toggleItem(null, lit.str("a"), all, false);
    expect(c).toEqual({ kind: "in", values: [lit.str("a")] });
    c = toggleItem(c, lit.str("b"), all, false);
    expect(c).toEqual({ kind: "in", values: [lit.str("a"), lit.str("b")] });
    c = toggleItem(c, lit.str("a"), all, false);
    c = toggleItem(c, lit.str("b"), all, false);
    expect(c).toBeNull();
  });
  it("single select replaces, and clicking the selected value clears", () => {
    const c = toggleItem({ kind: "in", values: [lit.str("a")] }, lit.str("b"), all, true);
    expect(c).toEqual({ kind: "in", values: [lit.str("b")] });
    expect(toggleItem(c, lit.str("b"), all, true)).toBeNull();
  });
  it("after Select all, unticking values builds an exclusion; ticking one back keeps the rest; excluding everything clears", () => {
    let c: Cond | null = { kind: "notIn", values: [] };
    c = toggleItem(c, lit.str("a"), all, false);
    expect(c).toEqual({ kind: "notIn", values: [lit.str("a")] });
    c = toggleItem(c, lit.str("a"), all, false);
    expect(c).toEqual({ kind: "notIn", values: [] });
    c = toggleItem(toggleItem(toggleItem(c, lit.str("a"), all, false), lit.str("b"), all, false), lit.str("c"), all, false);
    expect(c).toBeNull();
  });
});

describe("SlicerView", () => {
  it("list: ticking a value reports the selection; the selected value is checked", () => {
    const p = props();
    const { rerender } = render(<SlicerView {...p} />);
    fireEvent.click(screen.getByLabelText("France"));
    expect(p.onChange).toHaveBeenCalledWith({ kind: "in", values: [lit.str("France")] });
    rerender(<SlicerView {...p} cond={{ kind: "in", values: [lit.str("France")] }} />);
    expect((screen.getByLabelText("France") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Japan") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(p.onChange).toHaveBeenLastCalledWith(null);
  });

  it("list: Select all, search filter", () => {
    const p = props({ selectAll: true, search: true });
    render(<SlicerView {...p} />);
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(p.onChange).toHaveBeenCalledWith({ kind: "notIn", values: [] });
    fireEvent.change(screen.getByLabelText("Search values"), { target: { value: "jap" } });
    expect(screen.queryByLabelText("France")).toBeNull();
    expect(screen.getByLabelText("Japan")).toBeTruthy();
    expect(screen.queryByLabelText("Select all")).toBeNull();
  });

  it("single-select list uses radio buttons", () => {
    const p = props({ singleSelect: true });
    render(<SlicerView {...p} />);
    fireEvent.click(screen.getByLabelText("Japan"));
    expect(p.onChange).toHaveBeenCalledWith({ kind: "in", values: [lit.str("Japan")] });
    expect(document.querySelectorAll("input[type=radio]").length).toBe(3);
  });

  it("tiles select like the list", () => {
    const p = props({ mode: "Tile" });
    render(<SlicerView {...p} />);
    fireEvent.click(screen.getByRole("option", { name: "Canada" }));
    expect(p.onChange).toHaveBeenCalledWith({ kind: "in", values: [lit.str("Canada")] });
  });

  it("dropdown shows a summary and opens the list", async () => {
    const p = props({ mode: "Dropdown", cond: { kind: "in", values: [lit.str("France"), lit.str("Japan")] } });
    render(<SlicerView {...p} />);
    const trigger = screen.getByRole("button", { name: "Open the list of values" });
    expect(trigger.textContent).toContain("2 selected");
    fireEvent.click(trigger);
    expect(await screen.findByLabelText("Canada")).toBeTruthy();
  });

  it("between: typing a number or moving the slider sets a range; the full range clears", () => {
    const p = props({ mode: "Between", loaded: slicerData([], [1, 100]) });
    const { rerender } = render(<SlicerView {...p} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "10" } });
    expect(p.onChange).toHaveBeenLastCalledWith({ kind: "between", lo: lit.num(10), hi: lit.num(100) });
    fireEvent.change(screen.getByLabelText("Upper bound"), { target: { value: "50" } });
    expect(p.onChange).toHaveBeenLastCalledWith({ kind: "between", lo: lit.num(1), hi: lit.num(50) });
    rerender(<SlicerView {...p} cond={{ kind: "between", lo: lit.num(10), hi: lit.num(100) }} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "1" } });
    expect(p.onChange).toHaveBeenLastCalledWith(null);
  });

  it("before and after use one-sided conditions", () => {
    const before = props({ mode: "Before", loaded: slicerData([], [1, 100]) });
    const { unmount } = render(<SlicerView {...before} />);
    fireEvent.change(screen.getByLabelText("Before"), { target: { value: "40" } });
    expect(before.onChange).toHaveBeenLastCalledWith({ kind: "cmp", op: "le", value: lit.num(40) });
    unmount();
    const after = props({ mode: "After", loaded: slicerData([], [1, 100]) });
    render(<SlicerView {...after} />);
    fireEvent.change(screen.getByLabelText("After"), { target: { value: "60" } });
    expect(after.onChange).toHaveBeenLastCalledWith({ kind: "cmp", op: "ge", value: lit.num(60) });
  });

  it("date range uses date inputs and date literals", () => {
    const d = (s: string) => decodeCell({ t: "datetime", v: s });
    const loaded: Extract<Loaded, { kind: "slicer" }> = { ...slicerData([]), range: { min: d("1/1/2023"), max: d("12/31/2024") } };
    const p = props({ mode: "Between", loaded, isDate: true });
    render(<SlicerView {...p} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2024-03-01" } });
    expect(p.onChange).toHaveBeenLastCalledWith({ kind: "between", lo: lit.date("2024-03-01"), hi: lit.date("2024-12-31") });
  });

  it("relative date: period, number and unit produce a relative-date condition", async () => {
    const p = props({ mode: "Relative" });
    render(<SlicerView {...p} />);
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "months" } });
    expect(p.onChange).toHaveBeenLastCalledWith({ kind: "relativeDate", op: "last", n: 7, unit: "months", includeToday: false });
    fireEvent.change(screen.getByLabelText("Number of units"), { target: { value: "3" } });
    expect(p.onChange).toHaveBeenLastCalledWith({ kind: "relativeDate", op: "last", n: 3, unit: "months", includeToday: false });
    fireEvent.click(screen.getByLabelText("Include today"));
    await waitFor(() => expect(p.onChange).toHaveBeenLastCalledWith({ kind: "relativeDate", op: "last", n: 3, unit: "months", includeToday: true }));
  });

  it("a range slicer without data says so", () => {
    render(<SlicerView {...props({ mode: "Between" })} />);
    expect(screen.getByText("No values")).toBeTruthy();
  });
});

describe("SlicerView look", () => {
  const look = (items: { color?: string; bold?: boolean }, header: { bold?: boolean } = {}) =>
    ({ header: { show: true, text: "Region", font: { ...header }, background: undefined }, items: { font: { ...items }, background: undefined, padding: 0 } }) as unknown as SlicerViewProps["look"];
  it("the item font is the font of the value labels (the checkbox label does not inherit it)", () => {
    render(<SlicerView {...props({ look: look({ color: "#aa0000" }) })} />);
    expect((screen.getByText("France") as HTMLElement).style.color).toMatch(/rgb\(170, 0, 0\)|#aa0000/);
  });
  it("the header is bold when its font says so, semibold otherwise", () => {
    const { rerender } = render(<SlicerView {...props({ look: look({}) })} />);
    expect((screen.getByTestId("slicer-header") as HTMLElement).style.fontWeight).toBe("600");
    rerender(<SlicerView {...props({ look: look({}, { bold: true }) })} />);
    expect((screen.getByTestId("slicer-header") as HTMLElement).style.fontWeight).toBe("700");
  });
});

describe("SlicerView tile mode", () => {
  it("Select all is a chip of its own, and not offered for a single-select slicer", () => {
    const p = props({ mode: "Tile", selectAll: true });
    const { rerender } = render(<SlicerView {...p} />);
    fireEvent.click(screen.getByRole("option", { name: "Select all" }));
    expect(p.onChange).toHaveBeenCalledWith({ kind: "notIn", values: [] });
    rerender(<SlicerView {...p} singleSelect />);
    expect(screen.queryByRole("option", { name: "Select all" })).toBeNull();
  });
});
