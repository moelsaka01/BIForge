import { describe, expect, it } from "vitest";
import { decodeCell } from "./cells";
import type { Loaded } from "./dataLoader";
import { exportFileName, loadedToCsv } from "./exportData";

const col = (index: number, label: string, kind: "group" | "value" | "helper", format: string | null = null) => ({ index, label, kind, role: "x", order: index, format, field: { kind: "column", table: "T", name: label } });
const loaded = (rows: Parameters<typeof decodeCell>[0][][]): Loaded =>
  ({ kind: "grouped", query: { columns: [col(1, "Total, units", "value"), col(0, "Category", "group"), col(2, "sort", "helper")] }, rows: rows.map((r) => r.map(decodeCell)), highlightRows: null, totals: null, truncated: false, ms: 0 }) as never;

describe("export data", () => {
  it("writes the rows of the visual as CSV: header from the labels, numbers as numbers, blanks empty, helper columns left out", () => {
    const csv = loadedToCsv(loaded([[{ t: "text", v: 'Bikes "big"' }, { t: "int", v: "1200" }, { t: "int", v: "9" }], [{ t: "blank", v: "" }, { t: "real", v: "3.5" }, { t: "int", v: "8" }]]));
    expect(csv).toBe('Category,"Total, units"\r\n"Bikes ""big""",1200\r\n,3.5\r\n');
  });
  it("a visual without a table of rows has nothing to export", () => {
    expect(loadedToCsv({ kind: "empty" } as never)).toBeNull();
    expect(loadedToCsv({ kind: "slicer" } as never)).toBeNull();
  });
  it("the file name comes from the title, without characters Windows does not allow", () => {
    expect(exportFileName("Sales: 2024/25", "csv")).toBe("Sales_ 2024_25.csv");
    expect(exportFileName("  ", "csv")).toBe("data.csv");
  });
});
