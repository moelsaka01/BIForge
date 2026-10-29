import { describe, expect, it } from "vitest";
import { lit } from "./fields";
import { FormatReader } from "./formatReader";
import { donutCentre } from "./donutCentre";
import { visualOf } from "./testFixture";
import { DEFAULT_THEME } from "./theme";
import { setFormat } from "./visualDoc";

describe("donut centre text", () => {
  const centre = (props: [string, string, ReturnType<typeof lit.bool> | ReturnType<typeof lit.str>][]) => {
    const v = visualOf("donutChart", {});
    setFormat(v.json, "centerValue", "show", lit.bool(true));
    for (const [o, p, val] of props) setFormat(v.json, o, p, val);
    const c = donutCentre(new FormatReader(v.json, DEFAULT_THEME, "donutChart"), DEFAULT_THEME, 1207, null, 60)!;
    return (c.graphic[0] as { children: { style: { text: string; width?: number; overflow?: string } }[] }).children;
  };
  it("Text wrap breaks the label and the value inside a box of fixed width, also a single long word", () => {
    const plain = centre([]);
    expect(plain.every((t) => t.style.overflow === undefined)).toBe(true);
    const wrapped = centre([["label", "textWrap", lit.bool(true)], ["value", "textWrap", lit.bool(true)]]);
    expect(wrapped.map((t) => [t.style.width, t.style.overflow])).toEqual([[90, "breakAll"], [90, "breakAll"]]);
  });
});
