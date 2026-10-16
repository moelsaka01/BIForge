import { describe, expect, it } from "vitest";
import { colorFn, condFormatFromPbir, condFormatToPbir, textOn, type CondFormat } from "./condFormat";
import { agg, measure } from "./fields";

const Qty = agg("Sales", "Quantity", 0);

const specs: CondFormat[] = [
  { kind: "gradient", input: Qty, min: { color: "#ff0000" }, max: { color: "#00ff00", value: 100 } },
  { kind: "gradient", input: Qty, min: { color: "#ff0000", value: 0 }, mid: { color: "#ffff00", value: 50 }, max: { color: "#00ff00" }, nullAsZero: true },
  { kind: "rules", input: measure("Sales", "Total"), cases: [{ conds: [{ op: "gt", value: 100 }], color: "#00aa00" }, { conds: [{ op: "ge", value: 10 }, { op: "le", value: 100 }], color: "#ffaa00" }], fallback: "#cc0000" },
  { kind: "fieldValue", input: measure("Sales", "Color") },
];

describe("conditional format storage", () => {
  it("round-trips every kind through the PBIR property shape", () => {
    for (const s of specs) expect(condFormatFromPbir(condFormatToPbir(s)), s.kind).toEqual(s);
  });

  it("uses the expression kinds of the schema", () => {
    const g = condFormatToPbir(specs[0]);
    expect(g.solid.color.expr.FillRule.FillRule.linearGradient2.max.value.Literal.Value).toBe("100L");
    expect(g.solid.color.expr.FillRule.FillRule.linearGradient2.min.color.Literal.Value).toBe("'#ff0000'");
    const r = condFormatToPbir(specs[2]);
    expect(r.solid.color.expr.Conditional.Cases).toHaveLength(2);
    expect(r.solid.color.expr.Conditional.Cases[1].Condition.And).toBeDefined();
  });

  it("returns null for plain colors and unknown shapes", () => {
    expect(condFormatFromPbir({ solid: { color: { expr: { Literal: { Value: "'#fff'" } } } } })).toBeNull();
    expect(condFormatFromPbir(undefined)).toBeNull();
    expect(condFormatFromPbir({ solid: { color: { expr: { FillRule: { Input: {}, FillRule: {} } } } } })).toBeNull();
  });
});

describe("evaluation", () => {
  it("gradient between the data minimum and maximum", () => {
    const f = colorFn({ kind: "gradient", input: Qty, min: { color: "#000000" }, max: { color: "#ffffff" } }, [10, 20, 30, null]);
    expect(f(10)).toBe("#000000");
    expect(f(30)).toBe("#ffffff");
    expect(f(20)).toBe("#808080");
    expect(f(null)).toBeNull();
    expect(f(5)).toBe("#000000");
  });

  it("three-color gradient and fixed stops", () => {
    const f = colorFn(specs[1], [0, 100]);
    expect(f(0)).toBe("#ff0000");
    expect(f(50)).toBe("#ffff00");
    expect(f(25)).toBe("#ff8000");
    expect(f(null)).toBe("#ff0000");
  });

  it("rules: first matching case wins, fallback otherwise", () => {
    const f = colorFn(specs[2], []);
    expect(f(150)).toBe("#00aa00");
    expect(f(50)).toBe("#ffaa00");
    expect(f(5)).toBe("#cc0000");
    expect(f(null)).toBe("#cc0000");
  });

  it("field value uses the value itself when it is a color", () => {
    const f = colorFn(specs[3], []);
    expect(f("#123456")).toBe("#123456");
    expect(f("not a color!")).toBeNull();
    expect(f(5)).toBeNull();
  });

  it("text color contrasts with the background", () => {
    expect(textOn("#ffffff")).toBe("#1a1a1a");
    expect(textOn("#000000")).toBe("#ffffff");
  });
});
