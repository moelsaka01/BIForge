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

describe("donut centre background and blank value", () => {
  const read = (props: [string, string, ReturnType<typeof lit.bool> | ReturnType<typeof lit.str>][]) => {
    const v = visualOf("donutChart", {});
    setFormat(v.json, "centerValue", "show", lit.bool(true));
    for (const [o, p, val] of props) setFormat(v.json, o, p, val);
    return new FormatReader(v.json, DEFAULT_THEME, "donutChart");
  };
  const bg = [["centerBackground", "show", lit.bool(true)], ["centerBackground", "imageUrl", lit.str("data:image/png;base64,AA")]] as [string, string, ReturnType<typeof lit.bool> | ReturnType<typeof lit.str>][];
  it("Fit, Stretch and Fill set how the picture covers the disc", () => {
    const size = (fit?: string) => donutCentre(read([...bg, ...(fit ? [["centerBackground", "fit", lit.str(fit)] as never] : [])]), DEFAULT_THEME, 1, null, 60)!.background;
    expect(size()?.fit).toBe("contain");
    expect(size("Stretch")?.fit).toBe("100% 100%");
    expect(size("Fill")?.fit).toBe("cover");
    // a picture is a layer; without one the disc is a series
    expect(donutCentre(read(bg), DEFAULT_THEME, 1, null, 60)!.discs).toEqual([]);
  });
  it("Show blank as is the centre text when the slices have no value", () => {
    const f = read([["value", "showBlankAs", lit.str("n/a")]]);
    const text = (total: number | null) => (donutCentre(f, DEFAULT_THEME, total, null, 60)!.graphic[0] as { children: { style: { text: string } }[] }).children.map((c) => c.style.text);
    expect(text(null)).toContain("n/a");
    expect(text(5)).not.toContain("n/a");
  });
});
