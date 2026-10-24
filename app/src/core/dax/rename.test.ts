import { describe, expect, it } from "vitest";
import { daxTableName, renameInDax, tokenizeDax } from "./rename";

const ctx = (host: string | null = null, ...measures: string[]) => ({ host, measures: new Set(measures.map((m) => m.toLowerCase())) });

describe("tokenizeDax", () => {
  it("knows strings, quoted names, brackets and comments", () => {
    const t = tokenizeDax(`SUM('My ''T'''[a]]b]) // Sales[x]\n& "Sales[x]" /* [x] */`);
    expect(t.map((x) => x.kind)).toEqual(["ident", "other", "quoted", "bracket", "other", "other", "string"]);
    expect(t[2].name).toBe("My 'T'");
    expect(t[3].name).toBe("a]b");
  });
});

describe("renaming a table in DAX", () => {
  it("changes qualified references, table arguments and quoted names, keeping the style that is still valid", () => {
    expect(renameInDax("SUM(Sales[Qty]) + COUNTROWS(Sales) + CALCULATE([T], 'Sales'[Qty] > 1)", { kind: "table", from: "Sales", to: "Orders" }, ctx())).toBe("SUM(Orders[Qty]) + COUNTROWS(Orders) + CALCULATE([T], 'Orders'[Qty] > 1)");
    expect(renameInDax("SUM(Sales[Qty])", { kind: "table", from: "sales", to: "Order lines" }, ctx())).toBe("SUM('Order lines'[Qty])");
    expect(renameInDax("SUM('Order lines'[Qty])", { kind: "table", from: "Order lines", to: "Lines" }, ctx())).toBe("SUM('Lines'[Qty])");
  });

  it("leaves strings, comments, function names, variables and other tables alone", () => {
    const text = `VAR Sales = 3 RETURN "Sales[Qty]" & Sales + SALES(1) // Sales[Qty]\n + Other[Sales]`;
    expect(renameInDax(text, { kind: "table", from: "Sales", to: "Orders" }, ctx())).toBe(text);
  });

  it("quotes a new name that is not a plain identifier or is a keyword", () => {
    expect(daxTableName("Orders")).toBe("Orders");
    expect(daxTableName("Order 2")).toBe("'Order 2'");
    expect(daxTableName("Return")).toBe("'Return'");
    expect(daxTableName("It's")).toBe("'It''s'");
  });
});

describe("renaming a column in DAX", () => {
  const op = { kind: "column", table: "Sales", from: "Qty", to: "Quantity" } as const;
  it("changes Table[Column] of that table only", () => {
    expect(renameInDax("SUM(Sales[Qty]) + SUM('Sales'[qty]) + SUM(Product[Qty])", op, ctx())).toBe("SUM(Sales[Quantity]) + SUM('Sales'[Quantity]) + SUM(Product[Qty])");
  });
  it("changes an unqualified [Column] only in an expression of that table, and not when a measure has that name", () => {
    expect(renameInDax("[Qty] * 2", op, ctx("Sales"))).toBe("[Quantity] * 2");
    expect(renameInDax("[Qty] * 2", op, ctx("Product"))).toBe("[Qty] * 2");
    expect(renameInDax("[Qty] * 2", op, ctx(null))).toBe("[Qty] * 2");
    expect(renameInDax("[Qty] * 2", op, ctx("Sales", "Qty"))).toBe("[Qty] * 2");
  });
  it("escapes a closing bracket in the new name", () => {
    expect(renameInDax("Sales[Qty]", { ...op, to: "a]b" }, ctx())).toBe("Sales[a]]b]");
  });
});

describe("renaming a measure in DAX", () => {
  const op = { kind: "measure", table: "Sales", from: "Total", to: "Revenue" } as const;
  it("changes [Measure] and Table[Measure], also after RETURN and in a column's formula", () => {
    expect(renameInDax("VAR x = [Total] RETURN [Total] / x + Sales[Total]", op, ctx("Sales", "Total"))).toBe("VAR x = [Revenue] RETURN [Revenue] / x + Sales[Revenue]");
  });
  it("does not touch a column of the same name in another table or a qualified reference to another table", () => {
    expect(renameInDax("Product[Total] + Sales[Total]", op, ctx(null, "Total"))).toBe("Product[Total] + Sales[Revenue]");
  });
});
