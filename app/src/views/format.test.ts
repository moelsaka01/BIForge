import { describe, expect, it } from "vitest";
import { formatCell, formatGeneralNumber } from "./format";

describe("default number format (Power BI General)", () => {
  it("drops the trailing .0 that DuckDB adds to whole decimals", () => {
    expect(formatCell("1504210000000.0", "double")).toBe("1504210000000");
    expect(formatCell("42.0", "double")).toBe("42");
    expect(formatCell("-2.50", "decimal")).toBe("-2.5");
  });

  it("keeps fractions, rounded to 15 significant digits", () => {
    expect(formatGeneralNumber(123.456)).toBe("123.456");
    expect(formatGeneralNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatGeneralNumber(1 / 3)).toBe("0.333333333333333");
    expect(formatGeneralNumber(2 / 3)).toBe("0.666666666666667");
    expect(formatGeneralNumber(0.00001)).toBe("0.00001");
  });

  it("uses scientific notation only for very large or very small values", () => {
    expect(formatGeneralNumber(999999999999999)).toBe("999999999999999");
    expect(formatGeneralNumber(1e15)).toBe("1E+15");
    expect(formatGeneralNumber(1.5e20)).toBe("1.5E+20");
    expect(formatGeneralNumber(1.5e-7)).toBe("1.5E-07");
    expect(formatGeneralNumber(-1e-6)).toBe("-1E-06");
  });

  it("handles zero, negative zero and non-finite values", () => {
    expect(formatGeneralNumber(0)).toBe("0");
    expect(formatGeneralNumber(-0)).toBe("0");
    expect(formatCell("inf", "double")).toBe("inf");
    expect(formatGeneralNumber(Infinity)).toBe("Infinity");
  });

  it("leaves blanks empty and other types untouched", () => {
    expect(formatCell(null, "double")).toBe("");
    expect(formatCell("12", "int64")).toBe("12");
    expect(formatCell("1.0", "string")).toBe("1.0");
  });
});

describe("dates in the model's language", () => {
  it("are written the way the culture writes them, with the time when there is one", () => {
    expect(formatCell("2024-05-06", "dateTime", "en-US")).toBe("5/6/2024");
    expect(formatCell("2024-05-06", "dateTime", "de-DE")).toBe("6.5.2024");
    expect(formatCell("2024-05-06", "dateTime", "ja-JP")).toBe("2024/5/6");
    expect(formatCell("2024-05-06 13:45:30", "dateTime", "en-US")).toBe("5/6/2024 1:45:30 PM");
    expect(formatCell("2024-05-06 13:45:30.123456", "dateTime", "de-DE")).toContain("13:45:30");
  });

  it("show as sent without a culture, and anything that is not a date stays as it is", () => {
    expect(formatCell("2024-05-06", "dateTime")).toBe("2024-05-06");
    expect(formatCell("not a date", "dateTime", "de-DE")).toBe("not a date");
    expect(formatCell(null, "dateTime", "de-DE")).toBe("");
    expect(formatCell("2024-05-06", "string", "de-DE")).toBe("2024-05-06");
    expect(formatCell("2024-05-06", "dateTime", "xx-invalid-culture-name-zzz")).toBe("2024-05-06");
  });
});
