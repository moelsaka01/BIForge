import { describe, expect, it } from "vitest";
import { PAGE_SIZES, layerStyle, pageLook, readCanvasBackground, sizePresetOf } from "./pageFormat";
import { litExpr } from "./pbir";
import { lit } from "./fields";

describe("page format", () => {
  it("the size presets are 16:9, 4:3, Letter and Tooltip; anything else is Custom", () => {
    expect(PAGE_SIZES.map((s) => [s.id, s.width, s.height])).toEqual([["16:9", 1280, 720], ["4:3", 960, 720], ["Letter", 816, 1056], ["Tooltip", 320, 240]]);
    for (const s of PAGE_SIZES) expect(sizePresetOf(s.width, s.height)).toBe(s.id);
    expect(sizePresetOf(500, 500)).toBe("Custom");
  });

  it("a layer is drawn as a color with its transparency, a picture and how it fits", () => {
    const json = { name: "p", objects: { background: [{ properties: { color: litExpr(lit.str("#ff0000")), transparency: litExpr(lit.num(25)), image: { image: { name: litExpr(lit.str("a.png")), url: litExpr(lit.str("data:image/png;base64,AA")), scaling: litExpr(lit.str("Fit")) } } } }] } };
    const st = layerStyle(readCanvasBackground(json), null);
    expect(st.backgroundColor).toBe("rgba(255, 0, 0, 0.75)");
    expect(st.backgroundImage).toContain("data:image/png");
    expect(st.backgroundSize).toBe("contain");
    expect(pageLook(json)).not.toEqual(pageLook({ name: "p" }));
  });
});
