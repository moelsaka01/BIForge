import { describe, expect, it } from "vitest";
import { FORMAT_PRESETS, applyFormatOp, formatExample } from "./formatPresets";

describe("format presets and steps", () => {
  it("every preset is a format the number formatter understands", () => {
    expect(FORMAT_PRESETS.map((p) => formatExample(p.format))).toEqual(["1234.5678", "1,235", "1,234.57", "$1,234.57", "123456.78%", "1.23E+03"]);
  });
  it("currency and percent toggle", () => {
    expect(applyFormatOp(null, "currency")).toBe("$#,0.00");
    expect(applyFormatOp("$#,0.00", "currency")).toBe("#,0.00");
    expect(applyFormatOp(null, "percent")).toBe("0.00%");
    expect(applyFormatOp("0.00%", "percent")).toBe("0.00");
    expect(formatExample(applyFormatOp("#,0.00", "percent"))).toBe("123456.78%");
  });
  it("the thousands separator toggles", () => {
    expect(applyFormatOp("0.00", "thousands")).toBe("#,0.00");
    expect(applyFormatOp("#,0.00", "thousands")).toBe("0.00");
    expect(applyFormatOp("$#,0.00", "thousands")).toBe("$0.00");
    expect(applyFormatOp(null, "thousands")).toBe("#,0.00");
  });
  it("one more or one less decimal place, also with a currency sign or a percent sign", () => {
    expect(applyFormatOp("#,0.00", "moreDecimals")).toBe("#,0.000");
    expect(applyFormatOp("#,0.00", "fewerDecimals")).toBe("#,0.0");
    expect(applyFormatOp("#,0.0", "fewerDecimals")).toBe("#,0");
    expect(applyFormatOp("0", "moreDecimals")).toBe("0.0");
    expect(applyFormatOp("0.00%", "moreDecimals")).toBe("0.000%");
    expect(applyFormatOp("$#,0.00", "fewerDecimals")).toBe("$#,0.0");
    expect(applyFormatOp(null, "moreDecimals")).toBe("0.0");
    expect(applyFormatOp("0", "fewerDecimals")).toBe("0");
    expect(formatExample(applyFormatOp("#,0.00", "moreDecimals"))).toBe("1,234.568");
  });
});
