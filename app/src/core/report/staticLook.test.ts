import { describe, expect, it } from "vitest";
import { lit } from "./fields";
import { FormatReader } from "./formatReader";
import { boxEffects, buttonModel, navigatorModel, rotationParts, shapeEffects, shapeLook } from "./staticModels";
import { DEFAULT_THEME } from "./theme";
import { visualOf } from "./testFixture";
import { setFormat } from "./visualDoc";

const reader = (type: string, set: [string, string, ReturnType<typeof lit.num> | ReturnType<typeof lit.str> | ReturnType<typeof lit.bool>][]) => {
  const v = visualOf(type, {});
  for (const [o, p, val] of set) setFormat(v.json, o, p, val);
  return new FormatReader(v.json, DEFAULT_THEME, type);
};

describe("shadow, glow and rotation of the objects that show no data", () => {
  it("a shadow preset decides the direction; a glow is centered; both off give nothing", () => {
    expect(boxEffects(reader("shape", []))).toBeUndefined();
    const f = reader("shape", [["shadow", "show", lit.bool(true)], ["shadow", "shadowPositionPreset", lit.str("topLeft")], ["shadow", "shadowDistance", lit.num(10)], ["glow", "show", lit.bool(true)]]);
    const b = boxEffects(f)!;
    expect(b.split("), ").length).toBe(2);
    expect(b).toMatch(/^-?[0-9.]+px -?[0-9.]+px 4px/);
    expect(b.startsWith("-2.1px -2.1px")).toBe(true); // top left at the preset's distance of 3
    expect(b).toMatch(/0px 0px 8px/);
    expect(shapeEffects(f)).toMatch(/^drop-shadow\(-2\.1px -2\.1px 4px .*\) drop-shadow\(0px 0px 8px/);
  });
  it("rotation has three parts: the object, the shape alone, the text alone", () => {
    const f = reader("shape", [["rotation", "angle", lit.num(10)], ["rotation", "shapeAngle", lit.num(20)], ["rotation", "textAngle", lit.num(30)]]);
    expect(rotationParts(f)).toEqual({ frame: 10, shape: 20, text: 30 });
    const look = shapeLook(f, DEFAULT_THEME);
    expect(look.shapeTransform).toBe("rotate(20deg)");
    expect(look.textTransform).toBe("rotate(30deg)");
    expect(look.frameAngle).toBe(10);
    const b = buttonModel(reader("actionButton", [["rotation", "shapeAngle", lit.num(20)], ["rotation", "textAngle", lit.num(30)]]), DEFAULT_THEME, 100, 40, false, true);
    expect(b.style.transform).toBe("rotate(20deg)");
    expect(b.textStyle.transform).toBe("rotate(10deg)"); // the text turns against the shape, so its own angle shows
  });
  it("a navigator entry has the outline transparency, text margins and alignment, and can hide the names", () => {
    const f = reader("pageNavigator", [["outline", "transparency", lit.num(50)], ["text", "topMargin", lit.num(4)], ["text", "leftMargin", lit.num(6)], ["text", "verticalAlignment", lit.str("bottom")], ["text", "show", lit.bool(false)]]);
    const m = navigatorModel(f, DEFAULT_THEME, 400, 40);
    const e = m.entry(false);
    expect(String(e.border)).toContain("50%, transparent");
    expect(e.padding).toBe("4px 0px 0px 6px");
    expect(e.alignItems).toBe("flex-end");
    expect(m.showText).toBe(false);
  });
  it("a shape shows its text inside, with its own font and margins", () => {
    const f = reader("shape", [["text", "show", lit.bool(true)], ["text", "text", lit.str("Hello")], ["text", "bold", lit.bool(true)], ["text", "horizontalAlignment", lit.str("left")], ["text", "topMargin", lit.num(5)]]);
    const t = shapeLook(f, DEFAULT_THEME).text!;
    expect(t.content).toBe("Hello");
    expect(t.style.fontWeight).toBe(700);
    expect(t.box.justifyContent).toBe("flex-start");
    expect(String(t.box.padding)).toBe("5px 0px 0px 0px");
    expect(shapeLook(reader("shape", []), DEFAULT_THEME).text).toBeNull();
  });
});
