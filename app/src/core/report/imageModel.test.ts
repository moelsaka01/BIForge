import { describe, expect, it } from "vitest";
import { lit } from "./fields";
import { FormatReader } from "./formatReader";
import { imageModel } from "./staticModels";
import { DEFAULT_THEME } from "./theme";
import { setFormat, type VisualModel } from "./visualDoc";
import { visualOf } from "./testFixture";

const model = (set: (v: VisualModel) => void) => {
  const v = visualOf("image", {});
  set(v);
  return imageModel(new FormatReader(v.json, DEFAULT_THEME, "image"), 100, 80);
};

describe("image model: older homes of settings and stroke transparency", () => {
  it("takes the address from General > Image URL when Image > Source URL is empty, and the scaling from Image scaling unless Image > Fit is set", () => {
    expect(model(() => undefined).src).toBe("");
    expect(model((v) => setFormat(v.json, "general", "imageUrl", lit.str("data:image/png;base64,AA"))).src).toBe("data:image/png;base64,AA");
    expect(model((v) => { setFormat(v.json, "general", "imageUrl", lit.str("a")); setFormat(v.json, "image", "sourceUrl", lit.str("b")); }).src).toBe("b");
    expect(model((v) => setFormat(v.json, "imageScaling", "imageScalingType", lit.str("Fit"))).style.objectFit).toBe("contain");
    expect(model((v) => setFormat(v.json, "imageScaling", "imageScalingType", lit.str("Fill"))).style.objectFit).toBe("cover");
    expect(model((v) => { setFormat(v.json, "imageScaling", "imageScalingType", lit.str("Fill")); setFormat(v.json, "image", "fit", lit.str("Stretch")); }).style.objectFit).toBe("fill");
  });
  it("draws the stroke with its transparency and the corners with Corner radius", () => {
    const stroke = (t: number) => model((v) => { setFormat(v.json, "image", "strokeShow", lit.bool(true)); setFormat(v.json, "image", "strokeColor", lit.str("#ff0000")); setFormat(v.json, "image", "strokeTransparency", lit.num(t)); }).style.border;
    expect(stroke(0)).toContain("#ff0000 100%");
    expect(stroke(60)).toContain("#ff0000 40%");
    expect(model((v) => setFormat(v.json, "image", "cornerRadius", lit.num(12))).style.borderRadius).toBe(12);
  });
});
