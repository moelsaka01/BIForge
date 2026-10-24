import { describe, expect, it } from "vitest";
import { buildContainer } from "./containerModel";
import { lit } from "./fields";
import { FormatReader } from "./formatReader";
import { visualOf } from "./testFixture";
import { DEFAULT_THEME } from "./theme";
import { setFormat } from "./visualDoc";

const build = (props: [string, string, ReturnType<typeof lit.bool> | ReturnType<typeof lit.num> | ReturnType<typeof lit.str>][]) => {
  const v = visualOf("clusteredColumnChart", {});
  setFormat(v.json, "subTitle", "show", lit.bool(true));
  setFormat(v.json, "subTitle", "text", lit.str("Sub"));
  setFormat(v.json, "divider", "show", lit.bool(true));
  for (const [o, p, val] of props) setFormat(v.json, o, p, val);
  return buildContainer({ f: new FormatReader(v.json, DEFAULT_THEME, v.visualType), theme: DEFAULT_THEME, autoTitle: "Auto", titleByDefault: true, noAutoText: false });
};

describe("container spacing and shadow", () => {
  it("custom spacing moves the subtitle, the divider and the plot area down; without the switch nothing moves", () => {
    const base = build([]);
    expect(build([["spacing", "spaceAboveSubtitle", lit.num(10)]]).body.top).toBe(base.body.top);
    const on = (prop: string) => build([["spacing", "customizeSpacing", lit.bool(true)], ["spacing", prop, lit.num(10)]]);
    for (const prop of ["spaceAboveSubtitle", "spaceBelowSubTitle", "spaceAboveDivider", "spaceAbovePlotArea"]) expect(on(prop).body.top, prop).toBe(base.body.top + 10);
    expect(on("spaceAboveDivider").divider!.top).toBe(base.divider!.top + 10);
    expect(on("spaceAbovePlotArea").divider!.top).toBe(base.divider!.top); // the plot area gap does not move the divider
  });

  it("a shadow preset sets the direction; Custom uses the angle and distance", () => {
    const shadow = (props: [string, ReturnType<typeof lit.str> | ReturnType<typeof lit.num>][]) => build([["dropShadow", "show", lit.bool(true)], ...props.map(([p, v]) => ["dropShadow", p, v] as [string, string, typeof v]), ]).look.boxShadow as string;
    const px = (s: string) => /^(-?[\d.]+)px (-?[\d.]+)px/.exec(s)!.slice(1).map(Number);
    expect(px(shadow([["preset", lit.str("BottomRight")]]))).toEqual([2.1, 2.1]);
    expect(px(shadow([["preset", lit.str("TopLeft")]]))).toEqual([-2.1, -2.1]);
    expect(px(shadow([["preset", lit.str("Center")]]))).toEqual([0, 0]);
    expect(px(shadow([["preset", lit.str("Custom")], ["angle", lit.num(0)], ["shadowDistance", lit.num(5)]]))).toEqual([5, 0]);
  });
});

describe("style presets", () => {
  it("Default changes nothing, Boxed turns on border, radius and shadow, Minimal drops the background; explicit settings still win", () => {
    const look = (props: Parameters<typeof build>[0]) => build(props).look;
    const dflt = look([]);
    expect(look([["stylePreset", "name", lit.str("Default")]])).toEqual(dflt);
    const boxed = look([["stylePreset", "name", lit.str("Boxed")]]);
    expect(boxed.border).not.toBe(dflt.border);
    expect(boxed.borderRadius).toBe(4);
    expect(boxed.boxShadow).toBeTruthy();
    expect(dflt.boxShadow).toBeFalsy();
    expect(look([["stylePreset", "name", lit.str("Minimal")]]).background).toBe("transparent");
    // a name nobody defined (a file from elsewhere) behaves like Default
    expect(look([["stylePreset", "name", lit.str("Fancy")]])).toEqual(dflt);
    // the visual's own border setting overrides the preset
    expect(look([["stylePreset", "name", lit.str("Boxed")], ["border", "show", lit.bool(false)]]).border).toBe(dflt.border);
    expect(look([["stylePreset", "name", lit.str("Boxed")], ["border", "radius", lit.num(9)]]).borderRadius).toBe(9);
  });
});
