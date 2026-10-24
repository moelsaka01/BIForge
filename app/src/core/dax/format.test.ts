import { describe, expect, it } from "vitest";
import { formatDax, tokenize } from "./format";

// keywords are written in capitals, so tokens compare without case
const words = (s: string) => tokenize(s).map((t) => t.s.toLowerCase());

describe("formatDax", () => {
  it("spaces operators and commas, keeps short calls on one line, glues Table[Column]", () => {
    expect(formatDax("sum(Sales[Amount])*2+1")).toBe("sum(Sales[Amount]) * 2 + 1");
    expect(formatDax("CALCULATE(SUM(Sales[Amount]),Sales[Year]=2024)")).toBe("CALCULATE(SUM(Sales[Amount]), Sales[Year] = 2024)");
    expect(formatDax("  -  [x]   +  -3 ")).toBe("-[x] + -3");
    expect(formatDax("'My Table'[Col] && NOT [Flag]")).toBe("'My Table'[Col] && NOT [Flag]");
    expect(formatDax("{1,2,3}")).toBe("{1, 2, 3}");
    expect(formatDax("")).toBe("");
  });

  it("breaks a call that does not fit, one argument per line, and nested ones only as needed", () => {
    const text = 'CALCULATE(SUM(Sales[Amount]), FILTER(ALL(Product), Product[Category] = "Bikes" && Product[Color] = "Red"), Sales[Year] = 2024)';
    expect(formatDax(text)).toBe(
      [
        "CALCULATE(",
        "    SUM(Sales[Amount]),",
        "    FILTER(",
        "        ALL(Product),",
        '        Product[Category] = "Bikes" && Product[Color] = "Red"',
        "    ),",
        "    Sales[Year] = 2024",
        ")",
      ].join("\n"),
    );
  });

  it("puts every VAR on a line and the result under RETURN", () => {
    expect(formatDax("VAR a = SUM(Sales[Amount]) VAR b = 2 RETURN a / b")).toBe(["VAR a = SUM(Sales[Amount])", "VAR b = 2", "RETURN", "    a / b"].join("\n"));
  });

  it("formats a query: DEFINE with measures, EVALUATE, ORDER BY", () => {
    const q = 'define measure Sales[Total]=sum(Sales[Amount]) evaluate summarizecolumns(Product[Category],"T",[Total]) order by Product[Category] desc, [T]';
    expect(formatDax(q)).toBe(
      ["DEFINE", "    MEASURE Sales[Total] =", "        sum(Sales[Amount])", "EVALUATE", '    summarizecolumns(Product[Category], "T", [Total])', "ORDER BY", "    Product[Category] desc,", "    [T]"].join("\n"),
    );
  });

  it("keeps comments on their own lines and strings, quoted names and doubled quotes untouched", () => {
    const f = formatDax('// total\nSUM(Sales[Amount]) /* x */ + "a ""b"" // not a comment"');
    expect(f).toContain("// total");
    expect(f).toContain('"a ""b"" // not a comment"');
    expect(f.split("\n")[0]).toBe("// total");
  });

  it("never changes a token: the formatted text has the same tokens in the same order", () => {
    const samples = [
      "CALCULATE(SUM(Sales[Amount]),FILTER(ALL('Date'),'Date'[Year]>=2020&&'Date'[Year]<=2024),USERELATIONSHIP(Sales[A],'Date'[D]))",
      "VAR t=TOPN(5,VALUES(Product[Name]),[Total],DESC) VAR n=COUNTROWS(t) RETURN IF(n>3,DIVIDE([Total],n,0),BLANK())",
      "define var x=1 measure T[m]=x*2 evaluate row(\"a\",[m]) order by [a]",
      "SWITCH(TRUE(),[a]<1,\"low\",[a]<5,\"mid\",\"high\") // trailing",
      "1e3+0.5*(2-1)",
    ];
    for (const s of samples) {
      const f = formatDax(s);
      expect(words(f), s).toEqual(words(s));
      // formatting twice changes nothing more
      expect(formatDax(f), s).toBe(f);
    }
  });

  it("explains unbalanced brackets and stray characters instead of guessing", () => {
    expect(() => formatDax("SUM(Sales[Amount]")).toThrow("not closed");
    expect(() => formatDax("SUM(1))")).toThrow("closing parenthesis");
    expect(() => formatDax("1 # 2")).toThrow('Unexpected character "#"');
  });
});
