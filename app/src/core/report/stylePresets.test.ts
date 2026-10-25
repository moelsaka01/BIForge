import { describe, expect, it } from "vitest";
import { buildContainer } from "./containerModel";
import { agg, column, lit } from "./fields";
import { FormatReader } from "./formatReader";
import { defaultPreset, mix, presetChoices, presetValue, TABLE_PRESETS, themePresetNames } from "./stylePresets";
import { buildMatrix, buildTable } from "./tableModels";
import { buildMatrixQuery, buildVisualQuery } from "./queryBuilder";
import { decodeCell } from "./cells";
import type { Loaded } from "./dataLoader";
import { fixtureModel, visualOf } from "./testFixture";
import { DEFAULT_THEME, parseThemeJson, type Theme } from "./theme";
import { setFormat, type VisualModel } from "./visualDoc";

const model = fixtureModel();
const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);

const withStyles = (styles: Theme["visualStyles"]): Theme => ({ ...DEFAULT_THEME, visualStyles: styles });
const t = (s: string) => decodeCell({ t: "text", v: s });
const n = (x: number) => decodeCell({ t: "int", v: String(x) });
const grouped = (v: VisualModel): Extract<Loaded, { kind: "grouped" }> => ({ kind: "grouped", query: buildVisualQuery(v, model, { filters: [] })!, rows: [[t("Bikes"), n(10)], [t("Clothing"), n(30)], [t("Shoes"), n(20)]], highlightRows: null, totals: null, truncated: false, ms: 0 });
const table = (preset: string | null, extra: [string, string, ReturnType<typeof lit.str>][] = []) => {
  const v = visualOf("tableEx", { Values: [Cat, Qty] });
  if (preset !== null) setFormat(v.json, "stylePreset", "name", lit.str(preset));
  for (const [o, p, val] of extra) setFormat(v.json, o, p, val);
  return buildTable(v, grouped(v), DEFAULT_THEME, [n(60)]);
};

describe("the names Power BI uses", () => {
  it("tables and matrices offer Power BI's built-in presets under the ids Power BI stores", () => {
    expect(TABLE_PRESETS.map((p) => p.value)).toEqual(["Default", "None", "Minimal", "BoldHeader", "AlternatingRows", "AlternatingRowsNew", "ContrastAlternatingRows", "FlashyRows", "BoldHeaderFlashyRows", "Sparse", "Condensed"]);
    expect(TABLE_PRESETS.map((p) => p.label).filter((l) => !l.includes("deprecated"))).toEqual(["Default", "None", "Minimal", "Bold header", "Alternating rows", "Contrast alternating rows", "Flashy rows", "Bold header flashy rows", "Sparse", "Condensed"]);
    expect(defaultPreset("tableEx")).toBe("Default");
    expect(defaultPreset("pivotTable")).toBe("Default");
    expect(defaultPreset("clusteredColumnChart")).toBe("");
  });

  it("the list: the deprecated preset only for a file that uses it, Base for other visuals, and the presets of the theme", () => {
    expect(presetChoices("tableEx", DEFAULT_THEME, null).map((o) => o.value)).not.toContain("AlternatingRows");
    expect(presetChoices("tableEx", DEFAULT_THEME, "AlternatingRows").map((o) => o.value)).toContain("AlternatingRows");
    expect(presetChoices("clusteredColumnChart", DEFAULT_THEME, null)).toEqual([{ value: "", label: "Base" }]);
    const theme = withStyles({ clusteredColumnChart: { "*": {}, Calm: {} }, "*": { Loud: {} } });
    expect(themePresetNames(theme, "clusteredColumnChart")).toEqual(["Calm", "Loud"]);
    expect(themePresetNames(theme, "card")).toEqual(["Loud"]);
    expect(presetChoices("clusteredColumnChart", theme, null).map((o) => o.value)).toEqual(["", "Calm", "Loud"]);
    // a name from a file that no theme here defines stays selectable instead of being silently replaced
    expect(presetChoices("clusteredColumnChart", theme, "Gone")).toContainEqual({ value: "Gone", label: "Gone (not in the theme)" });
  });
});

describe("custom presets of the theme", () => {
  const theme = withStyles({
    "*": { Boxed: { border: [{ show: true, radius: 4 }], dropShadow: [{ show: true }] }, Plain: { background: [{ show: false }] } },
    clusteredColumnChart: { Boxed: { border: [{ show: true, radius: 9 }] } },
  });
  const look = (visualType: string, preset: string | null, extra: [string, string, ReturnType<typeof lit.bool> | ReturnType<typeof lit.num>][] = []) => {
    const v = visualOf(visualType, {});
    if (preset !== null) setFormat(v.json, "stylePreset", "name", lit.str(preset));
    for (const [o, p, val] of extra) setFormat(v.json, o, p, val);
    return buildContainer({ f: new FormatReader(v.json, theme, v.visualType), theme, autoTitle: "", titleByDefault: false, noAutoText: true }).look;
  };

  it("a preset the visual names gives its settings; Base, no name or an unknown name give none", () => {
    const base = look("card", null);
    expect(look("card", "")).toEqual(base);
    expect(look("card", "Nobody")).toEqual(base);
    const boxed = look("card", "Boxed");
    expect(boxed.borderRadius).toBe(4);
    expect(boxed.boxShadow).toBeTruthy();
    expect(base.boxShadow).toBeFalsy();
    expect(look("card", "Plain").background).toBe("transparent");
  });

  it("the style of the visual type comes before the one for every visual, and the visual's own settings win", () => {
    expect(look("clusteredColumnChart", "Boxed").borderRadius).toBe(9);
    expect(look("clusteredColumnChart", "Boxed").boxShadow).toBeTruthy(); // from the wildcard style
    expect(look("card", "Boxed", [["border", "radius", lit.num(2)]]).borderRadius).toBe(2);
    expect(look("card", "Boxed", [["dropShadow", "show", lit.bool(false)]]).boxShadow).toBeFalsy();
  });

  it("an imported theme file keeps its presets", () => {
    const { theme: t2 } = parseThemeJson({ name: "T", visualStyles: { card: { "*": { border: [{ show: false }] }, Fancy: { border: [{ show: true, radius: 6 }] } } } });
    expect(themePresetNames(t2, "card")).toEqual(["Fancy"]);
    expect(presetValue(t2, "card", "Fancy", "border", "radius")).toBe(6);
  });
});

describe("built-in table presets", () => {
  it("colors are mixed from the palette: the foreground laid over the background in the given share", () => {
    expect(mix("#000000", 0.5, "#ffffff")).toBe("#808080");
    expect(mix("#ff0000", 0, "#00ff00")).toBe("#00ff00");
    expect(mix("#ff0000", 1, "#00ff00")).toBe("#ff0000");
    expect(mix("#fff", 0.12, "#000")).toBe("#1f1f1f");
  });

  it("Default and None keep BIForge's own look; an unknown name does too", () => {
    const base = table(null);
    for (const p of ["Default", "None", "Nobody"]) expect(table(p).style.header).toEqual(base.style.header);
  });

  const fg = DEFAULT_THEME.foreground;
  const bg = DEFAULT_THEME.background;
  it("Bold header inverts the header; Minimal keeps it light", () => {
    expect(table("BoldHeader").style.header.background).toBe(fg);
    expect(table("BoldHeader").style.header.color).toBe(bg);
    expect(table("Minimal").style.header.background).toBe(bg);
    expect(table("Minimal").style.header.color).toBe(fg);
  });

  it("Alternating rows shades every other row; Contrast alternating rows uses the strong shares; Flashy rows uses the accent", () => {
    const rows = (p: string) => [0, 1, 2].map((i) => table(p).style.cell(i).background);
    expect(rows("AlternatingRowsNew")).toEqual([bg, mix(fg, 0.08, bg), bg]);
    expect(rows("ContrastAlternatingRows")).toEqual([mix(fg, 0.75, bg), mix(fg, 0.25, bg), mix(fg, 0.75, bg)]);
    expect(rows("FlashyRows")).toEqual([mix(DEFAULT_THEME.tableAccent, 0.4, bg), mix(DEFAULT_THEME.tableAccent, 0.8, bg), mix(DEFAULT_THEME.tableAccent, 0.4, bg)]);
    expect(table("FlashyRows").style.header.background).toBe(bg);
    expect(table("BoldHeaderFlashyRows").style.header.background).toBe(fg);
  });

  it("Sparse is airy and Condensed is tight with vertical lines", () => {
    expect(presetValue(DEFAULT_THEME, "tableEx", "Sparse", "grid", "rowPadding")).toBe(6);
    expect(presetValue(DEFAULT_THEME, "tableEx", "Condensed", "grid", "rowPadding")).toBe(0);
    expect(presetValue(DEFAULT_THEME, "tableEx", "Condensed", "grid", "gridVertical")).toBe(true);
    expect(presetValue(DEFAULT_THEME, "tableEx", "Sparse", "grid", "gridVertical")).toBe(false);
    expect(table("Sparse").style.rowHeight).toBeGreaterThan(table("Condensed").style.rowHeight);
  });

  it("the visual's own settings win over the preset; the totals row follows the preset", () => {
    expect(table("BoldHeader", [["columnHeaders", "backColor", lit.str("#123456")]]).style.header.background).toBe("#123456");
    expect(table("AlternatingRowsNew").style.total.background).toBe(fg);
  });

  it("a matrix has the presets too", () => {
    const Ch = column("Sales", "Channel");
    const v = visualOf("pivotTable", { Rows: [Cat], Columns: [Ch], Values: [Qty] });
    const q = buildMatrixQuery(v, model, { filters: [] })!;
    const parts = [[[n(100)]], [[t("Online"), n(70)]], [[t("Bikes"), n(60)]], [[t("Bikes"), t("Online"), n(40)]]].map((p) => p.map((r) => r));
    const head = (preset: string | null) => {
      const w = visualOf("pivotTable", { Rows: [Cat], Columns: [Ch], Values: [Qty] });
      if (preset) setFormat(w.json, "stylePreset", "name", lit.str(preset));
      return buildMatrix(w, parts as never, buildMatrixQuery(w, model, { filters: [] })!, DEFAULT_THEME, new Set());
    };
    void q;
    expect(head("BoldHeader").style.header.background).toBe(fg);
    expect(head("Minimal").style.header.background).toBe(bg);
    expect(head("BoldHeader").style.header.background).not.toBe(head(null).style.header.background);
  });
});
