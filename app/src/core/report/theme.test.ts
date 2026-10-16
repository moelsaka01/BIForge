import { describe, expect, it } from "vitest";
import { applyThemeToProject, BUILTIN_THEMES, clearCustomTheme, DEFAULT_THEME, parseThemeJson, resolveTheme, seriesColor, themeStyle, themeToJson, ThemeError } from "./theme";
import { fixtureProject } from "./testFixture";

describe("built-in themes", () => {
  it("have valid hex palettes of at least eight colors and distinct names", () => {
    expect(new Set(BUILTIN_THEMES.map((t) => t.name)).size).toBe(BUILTIN_THEMES.length);
    for (const t of BUILTIN_THEMES) {
      expect(t.dataColors.length).toBeGreaterThanOrEqual(8);
      expect(t.dataColors.every((c) => /^#[0-9a-f]{6}$/i.test(c)), t.name).toBe(true);
    }
    expect(seriesColor(DEFAULT_THEME, DEFAULT_THEME.dataColors.length + 1)).toBe(DEFAULT_THEME.dataColors[1]);
  });
});

describe("importing a theme file", () => {
  const file = {
    name: "Ocean",
    dataColors: ["#123", "#456789", "#ABCDEF"],
    background: "#FFFFFF",
    secondaryBackground: "#101820",
    foreground: "#222222",
    tableAccent: "#00AAFF",
    good: "#0A0",
    textClasses: { title: { fontSize: 16, fontFace: "Georgia", color: "#333333" }, weird: { fontSize: 1 } },
    visualStyles: { "*": { "*": { title: [{ fontSize: 14, show: true }], border: [{ show: true, color: { solid: { color: "#999999" } } }], somethingNew: [{}] } }, card: { "*": { background: [{ color: { solid: { color: "#EEEEEE" } } }] } } },
    unknownKey: 1,
  };

  it("reads colors, text classes and visual styles; reports what it ignores", () => {
    const { theme, ignored } = parseThemeJson(file);
    expect(theme.name).toBe("Ocean");
    expect(theme.dataColors).toEqual(["#112233", "#456789", "#abcdef"]);
    expect(theme.pageBackground).toBe("#101820");
    expect(theme.dark).toBe(true);
    expect(theme.good).toBe("#00aa00");
    expect(theme.textClasses.title).toEqual({ fontFace: "Georgia", fontSize: 16, color: "#333333" });
    expect(ignored.sort()).toEqual(["textClasses.weird", "unknownKey", "visualStyles.*.*.somethingNew"].sort());
    expect(themeStyle(theme, "clusteredColumnChart", "title", "fontSize")).toBe(14);
    expect(themeStyle(theme, "card", "background", "color")).toBe("#EEEEEE");
    expect(themeStyle(theme, "clusteredColumnChart", "border", "color")).toBe("#999999");
    expect(themeStyle(theme, "card", "legend", "show")).toBeNull();
  });

  it("rejects what it cannot use, naming the setting", () => {
    expect(() => parseThemeJson(null)).toThrow(ThemeError);
    expect(() => parseThemeJson({})).toThrow(/"name"/);
    expect(() => parseThemeJson({ name: "x", dataColors: [] })).toThrow(/dataColors/);
    expect(() => parseThemeJson({ name: "x", dataColors: ["red"] })).toThrow(/dataColors/);
    expect(() => parseThemeJson({ name: "x", background: "white" })).toThrow(/"background"/);
  });

  it("exports in the shape it imports", () => {
    const a = parseThemeJson(file).theme;
    const b = parseThemeJson(themeToJson(a)).theme;
    expect(b).toEqual(a);
  });
});

describe("the theme of a project", () => {
  it("defaults to the built-in default, resolves a built-in base theme by name", () => {
    const p = fixtureProject();
    expect(resolveTheme(p).name).toBe("BIForge Default");
    (p.report.files["report.json"] as { themeCollection: { baseTheme: { name: string } } }).themeCollection.baseTheme.name = "BIForge Dark";
    expect(resolveTheme(p).dark).toBe(true);
  });

  it("applying a theme stores the file as a registered resource and a custom theme entry", () => {
    const p = fixtureProject();
    const t = parseThemeJson({ name: "Ocean", dataColors: ["#112233"] }).theme;
    applyThemeToProject(p, t);
    const report = p.report.files["report.json"] as { themeCollection: Record<string, unknown>; resourcePackages: { items: { name: string; type: string }[] }[] };
    expect(report.themeCollection.customTheme).toMatchObject({ name: "Ocean", type: "RegisteredResources" });
    expect(report.themeCollection.baseTheme).toBeDefined();
    expect(report.resourcePackages[0].items).toEqual([{ name: "Ocean.json", path: "Ocean.json", type: "CustomTheme" }]);
    expect(Object.keys(p.report.static_resources!)).toEqual(["Ocean.json"]);
    expect(resolveTheme(p).dataColors).toEqual(["#112233"]);
    // replacing it removes the old file
    applyThemeToProject(p, parseThemeJson({ name: "Forest", dataColors: ["#003300"] }).theme);
    expect(Object.keys(p.report.static_resources!)).toEqual(["Forest.json"]);
    expect(report.resourcePackages[0].items).toHaveLength(1);
    clearCustomTheme(p);
    expect(p.report.static_resources).toEqual({});
    expect(report.themeCollection.customTheme).toBeUndefined();
    expect(report.resourcePackages).toBeUndefined();
    expect(resolveTheme(p).name).toBe("BIForge Default");
  });

  it("a damaged theme file falls back instead of breaking the report", () => {
    const p = fixtureProject();
    applyThemeToProject(p, parseThemeJson({ name: "Ocean" }).theme);
    p.report.static_resources!["Ocean.json"] = { name: 5 };
    expect(resolveTheme(p).name).toBe("BIForge Default");
  });
});
