import { describe, expect, it } from "vitest";
import { parseDefinitions } from "./defineBlocks";

describe("parseDefinitions", () => {
  it("reads measures, columns and tables of a DEFINE block, with the expression text as written", () => {
    const q = [
      "DEFINE",
      "    MEASURE Sales[Total] = SUM ( Sales[Amount] ) // keep this",
      "    MEASURE 'My Table'[Share] =",
      "        VAR t = [Total]",
      "        RETURN DIVIDE ( t, CALCULATE ( [Total], ALL ( Sales ) ) )",
      "    COLUMN Sales[Margin] = Sales[Amount] - Sales[Cost]",
      "    TABLE Top3 = TOPN ( 3, Sales )",
      "EVALUATE",
      "    ROW ( \"x\", [Total] )",
      "ORDER BY [x]",
    ].join("\n");
    const d = parseDefinitions(q);
    expect(d.map((x) => [x.kind, x.table, x.name])).toEqual([
      ["measure", "Sales", "Total"],
      ["measure", "My Table", "Share"],
      ["column", "Sales", "Margin"],
      ["table", "Top3", "Top3"],
    ]);
    expect(d[0].expression).toBe("SUM ( Sales[Amount] )");
    expect(d[1].expression).toBe("VAR t = [Total]\n        RETURN DIVIDE ( t, CALCULATE ( [Total], ALL ( Sales ) ) )");
    expect(d[2].expression).toBe("Sales[Amount] - Sales[Cost]");
    expect(d[3].expression).toBe("TOPN ( 3, Sales )");
  });

  it("returns nothing for a query without definitions and explains broken ones", () => {
    expect(parseDefinitions("EVALUATE Sales")).toEqual([]);
    expect(() => parseDefinitions("DEFINE MEASURE Sales[A]")).toThrow("needs =");
    expect(() => parseDefinitions("DEFINE MEASURE Sales[A] = EVALUATE Sales")).toThrow("empty");
    expect(() => parseDefinitions("DEFINE MEASURE Total = 1")).toThrow("table and a name");
  });
});
