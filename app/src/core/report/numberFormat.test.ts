import { describe, expect, it } from "vitest";
import { formatCompact, formatNumber, roundHalfAway } from "./numberFormat";

describe("formatNumber", () => {
  it("General is the default display", () => {
    expect(formatNumber(1234.5, null)).toBe("1234.5");
    expect(formatNumber(0.1 + 0.2, "General")).toBe("0.3");
    expect(formatNumber(NaN, "0.0")).toBe("NaN");
  });

  it("fixed decimals, grouping and rounding half away from zero", () => {
    expect(formatNumber(1234.5, "0")).toBe("1235");
    expect(formatNumber(2.5, "0")).toBe("3");
    expect(formatNumber(-2.5, "0")).toBe("-3");
    expect(formatNumber(1.005, "0.00")).toBe("1.01");
    expect(formatNumber(1234567.891, "#,0.00")).toBe("1,234,567.89");
    expect(formatNumber(1234567.891, "#,##0")).toBe("1,234,568");
    expect(formatNumber(5, "000")).toBe("005");
    expect(formatNumber(3.14159, "0.###")).toBe("3.142");
    expect(formatNumber(3.1, "0.###")).toBe("3.1");
    expect(formatNumber(3, "0.0#")).toBe("3.0");
    expect(formatNumber(0.5, "#.##")).toBe(".5");
    expect(formatNumber(0, "#,0")).toBe("0");
  });

  it("percent, currency symbols, literals and scaling commas", () => {
    expect(formatNumber(0.256, "0.0%")).toBe("25.6%");
    expect(formatNumber(0.5, "0%")).toBe("50%");
    expect(formatNumber(1234.5, "$#,0.00")).toBe("$1,234.50");
    expect(formatNumber(1234.5, '"EUR "#,0')).toBe("EUR 1,235");
    expect(formatNumber(1234.5, "\\$0.0")).toBe("$1234.5");
    expect(formatNumber(1500000, "0.0,,")).toBe("1.5");
    expect(formatNumber(1500000, '0.0,,"M"')).toBe("1.5M");
    expect(formatNumber(12000, "0,")).toBe("12");
  });

  it("sections for negative and zero values", () => {
    expect(formatNumber(-5, "0;(0)")).toBe("(5)");
    expect(formatNumber(5, "0;(0)")).toBe("5");
    expect(formatNumber(0, "0;(0);\"zero\"")).toBe("zero");
    expect(formatNumber(-5, "0.0")).toBe("-5.0");
    expect(formatNumber(-0.001, "0.0")).toBe("0.0");
  });

  it("scientific and named formats", () => {
    expect(formatNumber(1234.5, "0.00E+00")).toBe("1.23E+03");
    expect(formatNumber(0.00012, "0.0E+00")).toBe("1.2E-04");
    expect(formatNumber(1234.5, "Fixed")).toBe("1234.50");
    expect(formatNumber(1234.5, "Standard")).toBe("1,234.50");
    expect(formatNumber(0.5, "Percent")).toBe("50.00%");
    expect(formatNumber(-1234.5, "Currency")).toBe("($1,234.50)");
    expect(formatNumber(1, "Yes/No")).toBe("Yes");
    expect(formatNumber(0, "True/False")).toBe("False");
  });
});

describe("display units", () => {
  it("auto picks K, M, bn, T", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1234)).toBe("1.2K");
    expect(formatCompact(1500000)).toBe("1.5M");
    expect(formatCompact(-2500000000)).toBe("-2.5bn");
    expect(formatCompact(3e12)).toBe("3T");
  });
  it("fixed units and decimals", () => {
    expect(formatCompact(1234567, "thousands", 0)).toBe("1235K");
    expect(formatCompact(1234567, "none", 0)).toBe("1234567");
    expect(formatCompact(1234567, "millions", 2)).toBe("1.23M");
    expect(formatCompact(0.456, "auto", 2, "0.0%")).toBe("45.6%");
  });
  it("rounding helper", () => {
    expect(roundHalfAway(-1.005, 2)).toBe(-1.01);
    expect(roundHalfAway(2.675, 2)).toBe(2.68);
  });
});
