// @vitest-environment jsdom
// Scope-change session: Table view columns line up with their headers; Model view cards are not clipped, show
// Power BI-style field icons and have a collapsible Properties pane.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDomStubs } from "../core/testing/domStubs";
import { DataView } from "./DataView";
import { layoutCards } from "./ModelView";
import { fieldIconKind } from "./fieldIcon";
import { FakeEngine, col } from "../core/testing/fakeEngine";
import { PBIP, makeApp } from "./shell/testApp";

installDomStubs();
afterEach(cleanup);

/** Outer width a CSS box takes: its width plus padding and borders unless it is border-box. */
function outerWidth(el: HTMLElement): number {
  const st = el.style;
  const num = (v: string) => parseFloat(v) || 0;
  const w = num(st.width);
  if (st.boxSizing === "border-box") return w;
  const pad = st.padding ? st.padding.split(/\s+/).map(num) : [0, 0, 0, 0];
  const horizontal = pad.length === 2 ? pad[1] * 2 : pad.length === 1 ? pad[0] * 2 : (pad[1] ?? 0) + (pad[3] ?? pad[1] ?? 0);
  return w + horizontal + num(st.borderRightWidth || (st.borderRight ? st.borderRight.split(" ")[0] : "0")) + num(st.borderLeftWidth);
}

describe("Table view: headers and cells share exact columns", () => {
  it("each header and each cell of a column have the same outer width, padding and alignment; text left, numbers right", async () => {
    const e = new FakeEngine();
    e.tables.set("T", { columns: [col("Name", "string"), col("Qty", "int64"), col("Price", "double"), col("Day", "dateTime")], rows: [["a", "1", "2.5", "2024-01-01"], ["b", "20", "3", "2024-01-02"]] });
    render(<DataView engine={e} table="T" reloadKey={0} />);
    const headers = await screen.findAllByRole("columnheader");
    await waitFor(() => expect(document.querySelector('[data-row="0"] [role="gridcell"]')).toBeTruthy());
    const cells = [...document.querySelectorAll('[data-row="0"] [role="gridcell"]')] as HTMLElement[];
    expect(headers).toHaveLength(4);
    expect(cells).toHaveLength(4);
    headers.forEach((h, i) => {
      expect(outerWidth(h), `column ${i} width`).toBe(outerWidth(cells[i]));
      expect(h.style.boxSizing).toBe("border-box");
      expect(cells[i].style.boxSizing).toBe("border-box");
      expect(h.style.paddingLeft || h.style.padding).toBe(cells[i].style.paddingLeft || cells[i].style.padding);
      expect(h.style.textAlign).toBe(cells[i].style.textAlign);
    });
    expect(headers.map((h) => h.style.textAlign)).toEqual(["left", "right", "right", "left"]);
    // the header row and the body rows are exactly as wide as the columns together
    const total = headers.reduce((n, h) => n + outerWidth(h), 0);
    const headerRow = headers[0].closest("[role=row]") as HTMLElement;
    const bodyRow = cells[0].parentElement as HTMLElement;
    expect(parseFloat(headerRow.style.width)).toBe(total);
    expect(parseFloat(bodyRow.style.width)).toBe(total);
  });
});

describe("Model view", () => {
  it("field icons: Σ for summarized numbers, calendar for dates, calculator for measures, none for text and key columns", () => {
    expect(fieldIconKind("int64", null)).toBe("sigma");
    expect(fieldIconKind("double", "sum")).toBe("sigma");
    expect(fieldIconKind("int64", "none")).toBe("none");
    expect(fieldIconKind("dateTime", "none")).toBe("calendar");
    expect(fieldIconKind("string", "none")).toBe("none");
    expect(fieldIconKind(null, null, true)).toBe("measure");
  });

  it("card height always fits every row (columns and measures), up to the scroll limit", () => {
    const boxes = layoutCards([{ name: "Sales", columns: Array(12).fill(0), measures: [1, 2] }, { name: "Tiny", columns: [] }]);
    const sales = boxes.get("Sales")!;
    expect(sales.h).toBeGreaterThanOrEqual(28 + 14 * 22);
    expect(boxes.get("Tiny")!.h).toBeGreaterThanOrEqual(28 + 22);
    // no two cards overlap
    for (const a of boxes.values()) for (const b of boxes.values()) if (a !== b) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
  });

  async function openModel() {
    const a = makeApp();
    render(a.element);
    await act(async () => void a.registry.execute("file.open", { path: PBIP }));
    await act(async () => void a.registry.execute("model.addMeasure", { table: "Sales", name: "Total", expression: "SUM(Sales[Quantity])" }));
    await act(async () => void a.registry.execute("view.model"));
    return a;
  }

  it("shows icons instead of type names and a measure row in the Sales card", async () => {
    const a = await openModel();
    const card = await screen.findByTestId("card-Sales");
    expect(card.textContent).not.toMatch(/int64|string|double|dateTime/);
    expect(within(card).getByTestId("measure-Sales.Total").querySelector('[data-field-icon="measure"]')).toBeTruthy();
    // a card that has an icon slot on every row keeps names aligned
    expect(card.querySelectorAll("[data-field-icon]").length).toBeGreaterThanOrEqual(3);
  });

  it("the Relationships panel is a collapsible Properties pane: select a table, column or measure to see its properties", async () => {
    const a = await openModel();
    const pane = await screen.findByLabelText("Properties");
    fireEvent.click(await screen.findByTestId("card-head-Sales"));
    expect(within(pane).getByTestId("table-properties").textContent).toMatch(/Sales/);
    fireEvent.click(screen.getByTestId("col-Sales.ProductKey"));
    expect(within(pane).getByTestId("column-properties").textContent).toMatch(/Whole number/);
    fireEvent.click(screen.getByTestId("measure-Sales.Total"));
    expect(within(pane).getByTestId("measure-properties").textContent).toMatch(/SUM\(Sales\[Quantity\]\)/);
    // collapse to the rail and expand again; the choice is remembered per shell
    fireEvent.click(screen.getByRole("button", { name: "Collapse Properties" }));
    expect(screen.queryByTestId("properties")).toBeNull();
    expect(a.shell.settings.getSnapshot().layouts.classic.panes.properties.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Expand Properties" }));
    expect(await screen.findByTestId("properties")).toBeTruthy();
  });

  it("the View tab of the Model ribbon toggles the Properties pane like the other panes", async () => {
    const a = await openModel();
    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("tab", { name: "View" }));
    const btn = within(screen.getByTestId("ribbon")).getByRole("button", { name: "Properties" });
    fireEvent.click(btn);
    await waitFor(() => expect(a.shell.settings.getSnapshot().layouts.classic.panes.properties.open).toBe(false));
    fireEvent.click(within(screen.getByTestId("ribbon")).getByRole("button", { name: "Properties" }));
    await waitFor(() => expect(a.shell.settings.getSnapshot().layouts.classic.panes.properties.open).toBe(true));
  });
});
