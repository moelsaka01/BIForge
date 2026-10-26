import { describe, expect, it } from "vitest";
import { PAGE_SIZES, layerStyle, pageLook, readCanvasBackground, readWallpaper, sizePresetOf } from "./pageFormat";
import { DEFAULT_THEME } from "./theme";
import { litExpr } from "./pbir";
import { lit } from "./fields";

describe("page format", () => {
  it("a page takes the theme default style of pages (visualStyles.page), its own setting wins, and the default of every visual does not reach it", () => {
    const theme = { ...DEFAULT_THEME, visualStyles: { page: { "*": { background: [{ color: "#abcdef", transparency: 30 }], outspace: [{ color: "#101010" }], displayArea: [{ verticalAlignment: "Middle" }] } }, "*": { "*": { background: [{ color: "#ff0000" }] } } } } as never;
    expect(readCanvasBackground({ name: "p" }, theme)).toMatchObject({ color: "#abcdef", transparency: 30 });
    expect(readCanvasBackground({ name: "p", objects: { background: [{ properties: { color: litExpr(lit.str("#112233")) } }] } }, theme)).toMatchObject({ color: "#112233", transparency: 30 });
    expect(readWallpaper({ name: "p" }, theme).color).toBe("#101010");
    expect(pageLook({ name: "p" }, theme).verticalAlignment).toBe("Middle");
    expect(readCanvasBackground({ name: "p" }, DEFAULT_THEME).color).toBeNull();
  });

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
