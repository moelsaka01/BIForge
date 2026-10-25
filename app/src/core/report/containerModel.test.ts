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

describe("header", () => {
  const header = (props: [string, string, ReturnType<typeof lit.bool> | ReturnType<typeof lit.num>][], ctx?: Parameters<typeof buildContainer>[0]["header"]) => {
    const v = visualOf("clusteredColumnChart", {});
    for (const [o, p, val] of props) setFormat(v.json, o, p, val);
    return buildContainer({ f: new FormatReader(v.json, DEFAULT_THEME, v.visualType), theme: DEFAULT_THEME, autoTitle: "", titleByDefault: false, noAutoText: true, header: ctx });
  };
  const all = { drillRoles: ["Rows", "Columns"] as ("Rows" | "Columns")[], filters: 1, focusable: true, tabular: true, status: { information: "i", warning: "w", error: "e" } };

  it("a button shows when the card has it on and the visual's situation calls for it", () => {
    expect(header([], all).headerButtons).toMatchObject({ roleSelector: true, filters: true, focus: true, seeData: true, copyImage: false, tooltip: true, information: true, warning: true, error: true });
    // nothing to offer: the situational buttons are off, the plain ones stay
    expect(header([]).headerButtons).toMatchObject({ roleSelector: false, filters: false, focus: false, seeData: false, information: false, warning: false, error: false, tooltip: true });
    expect(header([["visualHeader", "showCopyVisualImageButton", lit.bool(true)]], all).headerButtons.copyImage).toBe(true);
    expect(header([["visualHeader", "showFocusModeButton", lit.bool(false)], ["visualHeader", "showTooltipButton", lit.bool(false)]], all).headerButtons).toMatchObject({ focus: false, tooltip: false });
    expect(header([], { ...all, drillRoles: ["Rows"] }).headerButtons.roleSelector).toBe(false);
  });

  it("transparency lets the visual show through the header", () => {
    expect(header([]).headerStyle.background).toBe("#ffffffd9");
    expect(header([["visualHeader", "transparency", lit.num(40)]]).headerStyle.background).toBe("color-mix(in srgb, #ffffff 60%, transparent)");
  });
});
