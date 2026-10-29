import { describe, expect, it } from "vitest";
import { lit } from "./fields";
import { FormatReader } from "./formatReader";
import { DEFAULT_THEME } from "./theme";
import { tileLook } from "./tileLook";
import { visualOf } from "./testFixture";
import { setFormat } from "./visualDoc";

const reader = (type: string, set: [string, string, ReturnType<typeof lit.num> | ReturnType<typeof lit.bool> | ReturnType<typeof lit.str>][]) => {
  const v = visualOf(type, {});
  for (const [o, p, val] of set) setFormat(v.json, o, p, val);
  return new FormatReader(v.json, DEFAULT_THEME, type);
};

describe("tile look of Card (new), Slicer (new) and List slicer", () => {
  it("is empty until a card turns something on", () => {
    const t = tileLook(reader("cardVisual", []));
    expect(t.style.background).toBeUndefined();
    expect(t.style.boxShadow).toBeUndefined();
    expect(t.image).toBeNull();
  });

  it("draws fill, outline, shadow and glow as one box shadow list and the fill as background", () => {
    const t = tileLook(reader("listSlicer", [["fillCustom", "show", lit.bool(true)], ["fillCustom", "fillColor", lit.str("#123456")], ["outline", "show", lit.bool(true)], ["outline", "weight", lit.num(3)], ["shadowCustom", "show", lit.bool(true)], ["glowCustom", "show", lit.bool(true)]]), true);
    expect(String(t.style.background)).toContain("#123456");
    expect(String(t.style.boxShadow).split("), ")).toHaveLength(3);
    expect(String(t.style.boxShadow)).toContain("inset 0 0 0 3px");
  });

  it("reads the picture settings under the names of a card or of a slicer", () => {
    const base: [string, string, ReturnType<typeof lit.str> | ReturnType<typeof lit.bool>][] = [["fillCustom", "show", lit.bool(true)], ["fillCustom", "imageShow", lit.bool(true)]];
    expect(tileLook(reader("cardVisual", [...base, ["fillCustom", "imageUrl", lit.str("u1")]])).image?.backgroundImage).toBe('url("u1")');
    expect(tileLook(reader("advancedSlicerVisual", [...base, ["fillCustom", "url", lit.str("u2")]]), true).image?.backgroundImage).toBe('url("u2")');
  });

  it("rounds, snips and turns the tile", () => {
    const rounded = tileLook(reader("cardVisual", [["shapeCustomRectangle", "tileShape", lit.str("rectangleRounded")], ["shapeCustomRectangle", "rectangleRoundedCurve", lit.num(10)]]));
    expect(rounded.style.borderRadius).toBe("10%");
    const snipped = tileLook(reader("cardVisual", [["shapeCustomRectangle", "tileShape", lit.str("tabCutCorner")]]));
    expect(String(snipped.style.clipPath)).toContain("polygon(");
    const turned = tileLook(reader("cardVisual", [["rotation", "shapeAngle", lit.num(10)], ["rotation", "textAngle", lit.num(25)], ["rotation", "angle", lit.num(90)]]));
    expect(turned.style.transform).toBe("rotate(10deg)");
    expect(turned.contentTransform).toBe("rotate(15deg)");
    expect(turned.frameAngle).toBe(90);
  });
});
