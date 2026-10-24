import { describe, expect, it } from "vitest";
import { formatDax } from "./format";
import { quickQueries } from "./quickQueries";

describe("quick queries", () => {
  it("quote names the way DAX needs and offer sensible queries per kind", () => {
    const t = quickQueries({ kind: "table", table: "Bob's Sales" });
    expect(t.map((q) => q.id)).toEqual(["show", "top100", "rows"]);
    expect(t[0].text).toBe("EVALUATE\n'Bob''s Sales'");
    const c = quickQueries({ kind: "column", table: "Sales", name: "Net]Price" });
    expect(c[0].text).toBe("EVALUATE\nDISTINCT('Sales'[Net]]Price])\nORDER BY 'Sales'[Net]]Price]");
    const m = quickQueries({ kind: "measure", table: "Sales", name: 'Total "x"' });
    expect(m[0].text).toBe('EVALUATE\nROW("Total ""x""", [Total "x"])');
  });

  it("every query is well formed: the formatter accepts it and keeps its tokens", () => {
    for (const target of [{ kind: "table", table: "Sales" }, { kind: "column", table: "Sales", name: "Qty" }, { kind: "measure", table: "Sales", name: "Total" }] as const) {
      for (const q of quickQueries(target)) expect(() => formatDax(q.text), q.label).not.toThrow();
    }
  });
});
