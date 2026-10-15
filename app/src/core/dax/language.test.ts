import { describe, expect, it } from "vitest";
import { completionsAt, consumeAfterCursor, enclosingCall, insideStringOrComment, monarchLanguage, signatureHelpAt, signatureParameters, toMarkerSpecs, type DaxContext } from "./language";
import { byColumnQuery, columnRef, quoteBracket, quoteTable, valueQuery } from "./measureQuery";
import type { FunctionInfo } from "./types";

const fn = (name: string, signature: string, implemented = true, returnsTable = false): FunctionInfo => ({
  name,
  category: "Test",
  signature,
  returnsTable,
  description: `${name} description`,
  implemented,
  minArgs: 0,
  maxArgs: null,
});

const ctx: DaxContext = {
  catalog: [
    fn("SUM", "SUM(column)"),
    fn("SUMX", "SUMX(table, expression)"),
    fn("CALCULATE", "CALCULATE(expression, filter*)"),
    fn("SUMMARIZE", "SUMMARIZE(table, groupBy*, (name, expression)*)", true, true),
    fn("XIRR", "XIRR(table, values, dates, guess?)", false),
    fn("STDEV.S", "STDEV.S(column)"),
  ],
  tables: [
    { name: "Sales", columns: ["Quantity", "Unit Price", "Odd]Name"], measures: ["Total Quantity"] },
    { name: "Product Info", columns: ["Category", "Color"], measures: [] },
  ],
};

const labels = (r: { items: { label: string }[] }) => r.items.map((i) => i.label);

describe("tokenizer definition", () => {
  it("has only valid, non-empty-matching regular expressions", () => {
    for (const [state, rules] of Object.entries(monarchLanguage.tokenizer)) {
      for (const rule of rules as unknown[][]) {
        const re = rule[0] as RegExp;
        expect(re, state).toBeInstanceOf(RegExp);
        expect(re.test(""), `${state}: ${re}`).toBe(false);
      }
    }
  });

  it("recognizes the lexical classes of DAX", () => {
    const first = (text: string) => {
      for (const rule of monarchLanguage.tokenizer.root as unknown[][]) {
        const m = new RegExp((rule[0] as RegExp).source, "iy").exec(text);
        if (m) return { token: rule[1], matched: m[0] };
      }
      return null;
    };
    expect(first("// note")?.token).toBe("comment");
    expect(first("-- note")?.token).toBe("comment");
    expect(first('"text"')?.token).toBe("string");
    expect(first("'My table'[Col]")?.token).toBe("type");
    expect(first("[Total]")?.token).toBe("variable");
    expect(first("3.14e2")?.matched).toBe("3.14e2");
    expect(first('dt"2024-01-01"')?.token).toBe("number");
    expect(first("SUM(")?.matched).toBe("SUM");
    expect(first("<=")?.token).toBe("operator");
  });
});

describe("insideStringOrComment", () => {
  it("detects open strings and comments", () => {
    expect(insideStringOrComment('"abc')).toBe(true);
    expect(insideStringOrComment('"abc"')).toBe(false);
    expect(insideStringOrComment('"a""b')).toBe(true);
    expect(insideStringOrComment('"a""b"')).toBe(false);
    expect(insideStringOrComment("// c")).toBe(true);
    expect(insideStringOrComment("// c\nx")).toBe(false);
    expect(insideStringOrComment("/* c")).toBe(true);
    expect(insideStringOrComment("/* c */ x")).toBe(false);
    expect(insideStringOrComment("'Open")).toBe(false);
  });
});

describe("completions", () => {
  it("offers functions, keywords and tables for a word prefix, implemented functions first", () => {
    const r = completionsAt("SU", ctx);
    expect(labels(r)).toEqual(expect.arrayContaining(["SUM", "SUMX", "SUMMARIZE"]));
    expect(r.replaceLength).toBe(2);
    const sum = r.items.find((i) => i.label === "SUM")!;
    expect(sum.insertText).toBe("SUM(");
    expect(sum.detail).toContain("SUM(column)");
    expect(sum.documentation).toBe("SUM description");
  });

  it("marks functions BIForge cannot evaluate yet", () => {
    const r = completionsAt("XI", ctx);
    const x = r.items.find((i) => i.label === "XIRR")!;
    expect(x.detail).toContain("not implemented");
    const ok = completionsAt("SUM", ctx).items.find((i) => i.label === "SUM")!;
    expect(x.sortText > ok.sortText).toBe(true);
  });

  it("matches names with dots and keywords", () => {
    expect(labels(completionsAt("STDEV.", ctx))).toContain("STDEV.S");
    expect(labels(completionsAt("RET", ctx))).toContain("RETURN");
    expect(labels(completionsAt("var x = 1 RETU", ctx))).toContain("RETURN");
  });

  it("quotes table names that need it", () => {
    const r = completionsAt("Prod", ctx);
    const t = r.items.find((i) => i.kind === "table")!;
    expect(t.label).toBe("Product Info");
    expect(t.insertText).toBe("'Product Info'");
  });

  it("offers qualified columns and measures for a prefix", () => {
    const r = completionsAt("Quan", ctx);
    expect(labels(r)).toContain("Sales[Quantity]");
    expect(labels(completionsAt("Tot", ctx))).toContain("[Total Quantity]");
  });

  it("offers the columns of a table after Table[ and filters by the typed part", () => {
    const r = completionsAt("SUM(Sales[", ctx);
    expect(labels(r)).toEqual(["Quantity", "Unit Price", "Odd]Name", "Total Quantity"]);
    expect(r.items.find((i) => i.label === "Odd]Name")!.insertText).toBe("Odd]]Name]");
    const r2 = completionsAt("SUM(Sales[Un", ctx);
    expect(labels(r2)).toEqual(["Unit Price"]);
    expect(r2.replaceLength).toBe(2);
    expect(labels(completionsAt("SUM('Product Info'[", ctx))).toEqual(["Category", "Color"]);
    expect(labels(completionsAt("SUM(sales[q", ctx))).toEqual(["Quantity"]);
  });

  it("offers measures after a bare [ and nothing for unknown tables", () => {
    expect(labels(completionsAt("1 + [", ctx))).toEqual(["Total Quantity"]);
    expect(completionsAt("Nope[", ctx).items).toEqual([]);
  });

  it("offers table names inside an open quote", () => {
    const r = completionsAt("CALCULATE(COUNTROWS('Pro", ctx);
    expect(labels(r)).toEqual(["Product Info"]);
    expect(r.items[0].insertText).toBe("Product Info'");
    expect(r.replaceLength).toBe(3);
  });

  it("stays silent in strings, comments, after numbers and closing brackets", () => {
    expect(completionsAt('"SU', ctx).items).toEqual([]);
    expect(completionsAt("// SU", ctx).items).toEqual([]);
    expect(completionsAt("SUM(Sales[Quantity]) ", ctx).items.length).toBeGreaterThan(0);
    expect(completionsAt("12", ctx).items).toEqual([]);
    expect(completionsAt("SUM(Sales[Quantity])", ctx).items).toEqual([]);
  });
});

describe("auto-closed brackets", () => {
  it("replaces a closing character that already follows the cursor", () => {
    expect(consumeAfterCursor("Quantity]", "]")).toBe(1);
    expect(consumeAfterCursor("Quantity]", ")")).toBe(0);
    expect(consumeAfterCursor("Quantity]", undefined)).toBe(0);
    expect(consumeAfterCursor("Product Info'", "'")).toBe(1);
    expect(consumeAfterCursor("SUM(", ")")).toBe(0);
  });
});

describe("signature help", () => {
  it("splits parameters, keeping groups together", () => {
    expect(signatureParameters("SUMMARIZE(table, groupBy*, (name, expression)*)")).toEqual(["table", "groupBy*", "(name, expression)*"]);
    expect(signatureParameters("TRUE()")).toEqual([]);
  });

  it("finds the enclosing call and argument index", () => {
    expect(enclosingCall("SUM(")).toEqual({ name: "SUM", argIndex: 0 });
    expect(enclosingCall("CALCULATE(SUM(Sales[Quantity]), Product[Color] = ")).toEqual({ name: "CALCULATE", argIndex: 1 });
    expect(enclosingCall('CALCULATE(SUM(Sales[A]), "a,b", ')).toEqual({ name: "CALCULATE", argIndex: 2 });
    expect(enclosingCall("CALCULATE(SUM(Sales[A]), IF(x, y), ")).toEqual({ name: "CALCULATE", argIndex: 2 });
    expect(enclosingCall("SUM(Sales[A])")).toBeNull();
    expect(enclosingCall("(1 + 2) * (")).toBeNull();
    expect(enclosingCall("// SUM(\nx")).toBeNull();
  });

  it("returns the signature with the active parameter", () => {
    const s = signatureHelpAt("SUMX(Sales, ", ctx.catalog)!;
    expect(s.label).toBe("SUMX(table, expression)");
    expect(s.parameters).toEqual(["table", "expression"]);
    expect(s.activeParameter).toBe(1);
    // repeating parameters keep the last one active
    expect(signatureHelpAt("CALCULATE(a, b, c, d, ", ctx.catalog)!.activeParameter).toBe(1);
    expect(signatureHelpAt("calculate(", ctx.catalog)!.parameters[0]).toBe("expression");
    expect(signatureHelpAt("Unknown(", ctx.catalog)).toBeNull();
  });
});

describe("markers", () => {
  it("clamps ranges to the text and widens empty ones", () => {
    const m = toMarkerSpecs(
      [
        { severity: "error", code: "x", message: "a", start: 2, end: 2 },
        { severity: "warning", code: "x", message: "b", start: 3, end: 99 },
        { severity: "error", code: "x", message: "c", start: 10, end: 12 },
      ],
      5,
    );
    expect(m).toEqual([
      { severity: "error", message: "a", start: 2, end: 3 },
      { severity: "warning", message: "b", start: 3, end: 5 },
      { severity: "error", message: "c", start: 5, end: 5 },
    ]);
  });
});

describe("measure queries", () => {
  it("quotes names", () => {
    expect(quoteTable("Sales")).toBe("Sales");
    expect(quoteTable("My table")).toBe("'My table'");
    expect(quoteTable("O'Neil")).toBe("'O''Neil'");
    expect(quoteBracket("a]b")).toBe("[a]]b]");
    expect(columnRef("Product Info", "Color")).toBe("'Product Info'[Color]");
  });

  it("evaluates a draft through DEFINE MEASURE", () => {
    const q = valueQuery("Sales", "SUM(Sales[Quantity])");
    expect(q).toContain("DEFINE MEASURE Sales[BIForge draft measure] = SUM(Sales[Quantity])");
    expect(q).toContain('EVALUATE ROW("Value", [BIForge draft measure])');
    const b = byColumnQuery("Sales", "SUM(Sales[Quantity])", "Product Info", "Color");
    expect(b).toContain("EVALUATE SUMMARIZECOLUMNS('Product Info'[Color]");
    expect(b).toContain("ORDER BY 'Product Info'[Color]");
  });
});
