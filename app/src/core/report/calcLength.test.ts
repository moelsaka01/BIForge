import { describe, expect, it } from "vitest";
import { calcLength, resolveCalc } from "./calcLength";

describe("calcLength", () => {
  it("adds and subtracts percentages and pixels, nested", () => {
    expect(calcLength("calc(25% + 8px)", 400)).toBe(108);
    expect(calcLength("calc(calc(50% + 30px) + -4px)", 200)).toBe(126);
    expect(calcLength("calc(100% - 12px)", 300)).toBe(288);
    expect(calcLength("10%", 300)).toBe(30);
  });
  it("is null for something that is not a length", () => {
    expect(calcLength("calc(25% * 2)", 400)).toBeNull();
    expect(calcLength("auto", 400)).toBeNull();
  });
  it("resolves the positions of grids and titles against the chart size, horizontal ones by the width", () => {
    const o = resolveCalc({ grid: [{ left: "calc(50% + 10px)", top: "calc(50% + 10px)", width: "calc(50% - 20px)", height: 40 }], title: [{ left: "calc(10% + 4px)", top: "calc(10% + 4px)" }] }, 400, 200) as { grid: Record<string, number>[]; title: Record<string, number>[] };
    expect(o.grid[0]).toEqual({ left: 210, top: 110, width: 180, height: 40 });
    expect(o.title[0]).toEqual({ left: 44, top: 24 });
  });
  it("returns the same option when nothing is a calc", () => {
    const o = { grid: [{ left: "10%" }] };
    expect(resolveCalc(o, 100, 100)).toBe(o);
  });
});
