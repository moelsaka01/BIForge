import { describe, expect, it } from "vitest";
import { daxFileName, resultToCsv, resultToTsv } from "./resultExport";

const r = { columns: ["A", "B,1"], rows: [[{ t: "int" as const, v: "1" }, { t: "text" as const, v: 'say "hi"\nnow' }], [{ t: "blank" as const, v: "" }, { t: "text" as const, v: "a\tb" }]], totalRows: 2, truncated: false };

describe("query result as text", () => {
  it("CSV quotes commas, quotes and line breaks and leaves blanks empty", () => {
    expect(resultToCsv(r)).toBe('A,"B,1"\r\n1,"say ""hi""\nnow"\r\n,a\tb\r\n');
  });
  it("tab-separated text for the clipboard flattens tabs and line breaks", () => {
    expect(resultToTsv(r)).toBe("A\tB,1\n1\tsay \"hi\" now\n\ta b");
  });
  it("a query file is named after its tab", () => {
    expect(daxFileName("Totals / 2024")).toBe("Totals _ 2024.dax");
    expect(daxFileName("  ")).toBe("Query.dax");
  });
});
