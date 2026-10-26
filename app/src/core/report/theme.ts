// Report themes: the built-in palettes (original), import of a user's theme JSON file, and lookups used by
// the renderers. The theme JSON shape follows the publicly documented report theme file format.
import type { Project } from "../model/types";
import type { J } from "./pbir";

export interface TextClass {
  fontFace: string;
  fontSize: number;
  color: string;
}

export interface Theme {
  name: string;
  dark: boolean;
  dataColors: string[];
  /** Background of visuals. */
  background: string;
  /** Background of the page canvas. */
  pageBackground: string;
  foreground: string;
  /** Secondary text, grid lines. */
  muted: string;
  tableAccent: string;
  good: string;
  neutral: string;
  bad: string;
  minimum: string;
  center: string;
  maximum: string;
  textClasses: { title: TextClass; label: TextClass; callout: TextClass; header: TextClass };
  /** visualStyles section of an imported theme file: visualType -> style -> object -> [properties]. */
  visualStyles: Record<string, Record<string, Record<string, J[]>>>;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const SEGOE = "Segoe UI, sans-serif";

function make(name: string, dark: boolean, p: Partial<Theme> & Pick<Theme, "dataColors" | "background" | "pageBackground" | "foreground" | "muted">): Theme {
  const fg = p.foreground;
  const t: Theme = {
    name,
    dark,
    tableAccent: p.dataColors[0],
    good: "#2E9E6B",
    neutral: "#E0A800",
    bad: "#D13438",
    minimum: "#D13438",
    center: "#F2C811",
    maximum: "#2E9E6B",
    textClasses: {
      title: { fontFace: SEGOE, fontSize: 12, color: fg },
      label: { fontFace: SEGOE, fontSize: 10, color: p.muted },
      callout: { fontFace: SEGOE, fontSize: 28, color: fg },
      header: { fontFace: SEGOE, fontSize: 12, color: fg },
    },
    visualStyles: {},
    ...p,
  };
  for (const k of ["background", "pageBackground", "foreground", "muted", "tableAccent", "good", "neutral", "bad", "minimum", "center", "maximum"] as const) t[k] = normalizeColor(t[k]);
  t.dataColors = t.dataColors.map(normalizeColor);
  return t;
}

export const BUILTIN_THEMES: Theme[] = [
  make("BIForge Default", false, {
    dataColors: ["#0F6CBD", "#E8743B", "#2E9E6B", "#8E5BD0", "#D13438", "#00A3B4", "#C239B3", "#8A8D1E", "#5B6B7C", "#E0A800"],
    background: "#FFFFFF",
    pageBackground: "#F3F2F1",
    foreground: "#242424",
    muted: "#616161",
  }),
  make("BIForge Classic", false, {
    dataColors: ["#1B7F79", "#2F3E46", "#E4572E", "#F0B429", "#52616B", "#66A5AD", "#F18F01", "#9B5DE5"],
    background: "#FFFFFF",
    pageBackground: "#EAEAEA",
    foreground: "#252423",
    muted: "#605E5C",
  }),
  make("BIForge Dark", true, {
    dataColors: ["#4DA3FF", "#FFA14D", "#4CD699", "#B58CFF", "#FF6B6B", "#3DDBE8", "#F078D8", "#CFD34B"],
    background: "#1F1F1F",
    pageBackground: "#111111",
    foreground: "#F5F5F5",
    muted: "#B3B3B3",
    good: "#4CD699",
    bad: "#FF6B6B",
  }),
  make("Colorblind safe", false, {
    dataColors: ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#6B7280"],
    background: "#FFFFFF",
    pageBackground: "#F5F5F5",
    foreground: "#1A1A1A",
    muted: "#555555",
    minimum: "#D55E00",
    center: "#F0E442",
    maximum: "#0072B2",
  }),
  make("High contrast", true, {
    dataColors: ["#FFFF00", "#00FFFF", "#FF66FF", "#66FF66", "#FF9933", "#99CCFF", "#FFFFFF", "#FF5050"],
    background: "#000000",
    pageBackground: "#000000",
    foreground: "#FFFFFF",
    muted: "#FFFFFF",
    good: "#66FF66",
    bad: "#FF5050",
  }),
];

export const DEFAULT_THEME = BUILTIN_THEMES[0];
export const CLASSIC_THEME = BUILTIN_THEMES[1];

// ---- import -----------------------------------------------------------------------------------


export class ThemeError extends Error {}

const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

/** Hex color as the theme and the renderers use it, "#rrggbb". Short forms are expanded; alpha is dropped. */
export function normalizeColor(c: string): string {
  const m = HEX.exec(c);
  if (!m) return c;
  let h = m[1];
  if (h.length === 3) h = [...h].map((x) => x + x).join("");
  return `#${h.slice(0, 6).toLowerCase()}`;
}

export interface ThemeImport {
  theme: Theme;
  /** Settings of the file that BIForge does not use (reported to the user). */
  ignored: string[];
}

const KNOWN_TOP = new Set(["name", "dataColors", "background", "secondaryBackground", "tertiaryBackground", "foreground", "firstLevelElements", "secondLevelElements", "thirdLevelElements", "fourthLevelElements", "tableAccent", "good", "neutral", "bad", "maximum", "center", "minimum", "textClasses", "visualStyles"]);
const KNOWN_OBJECTS = new Set(["title", "background", "border", "legend", "categoryAxis", "valueAxis", "labels", "dropShadow", "subTitle"]);

/** Reads a user's theme file. Colors that are not valid hex are an error (the message names the setting). */
export function parseThemeJson(json: unknown, base: Theme = DEFAULT_THEME): ThemeImport {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new ThemeError("A theme file must contain a JSON object.");
  const j = json as J;
  const ignored: string[] = [];
  const t: Theme = structuredClone(base);
  if (typeof j.name !== "string" || !j.name.trim()) throw new ThemeError('The theme needs a "name".');
  t.name = j.name.trim();
  const color = (key: string): string | null => {
    if (j[key] === undefined) return null;
    if (!isHex(j[key])) throw new ThemeError(`"${key}" must be a hex color such as #1A2B3C.`);
    return normalizeColor(j[key]);
  };
  if (j.dataColors !== undefined) {
    if (!Array.isArray(j.dataColors) || j.dataColors.length === 0 || !j.dataColors.every(isHex)) throw new ThemeError('"dataColors" must be a list of hex colors.');
    t.dataColors = j.dataColors.map(normalizeColor);
    t.tableAccent = t.dataColors[0];
  }
  const bg = color("background");
  if (bg) t.background = bg;
  const pbg = color("secondaryBackground");
  if (pbg) t.pageBackground = pbg;
  const fg = color("foreground") ?? color("firstLevelElements");
  if (fg) {
    t.foreground = fg;
    t.textClasses.title.color = fg;
    t.textClasses.callout.color = fg;
    t.textClasses.header.color = fg;
  }
  const muted = color("secondLevelElements");
  if (muted) {
    t.muted = muted;
    t.textClasses.label.color = muted;
  }
  for (const k of ["tableAccent", "good", "neutral", "bad", "maximum", "center", "minimum"] as const) {
    const c = color(k);
    if (c) t[k] = c;
  }
  t.dark = luminance(t.pageBackground) < 0.4;
  for (const [cls, v] of Object.entries<J>(j.textClasses ?? {})) {
    const target = (t.textClasses as Record<string, TextClass>)[cls];
    if (!target) {
      ignored.push(`textClasses.${cls}`);
      continue;
    }
    if (typeof v.fontFace === "string") target.fontFace = v.fontFace;
    if (typeof v.fontSize === "number" && v.fontSize > 0) target.fontSize = v.fontSize;
    if (isHex(v.color)) target.color = normalizeColor(v.color);
  }
  for (const [vt, styles] of Object.entries<J>(j.visualStyles ?? {})) {
    for (const [style, objs] of Object.entries<J>(styles ?? {})) {
      for (const [obj, list] of Object.entries<J>(objs ?? {})) {
        if (!KNOWN_OBJECTS.has(obj) || !Array.isArray(list)) {
          ignored.push(`visualStyles.${vt}.${style}.${obj}`);
          continue;
        }
        ((t.visualStyles[vt] ??= {})[style] ??= {})[obj] = list;
      }
    }
  }
  for (const k of Object.keys(j)) if (!KNOWN_TOP.has(k)) ignored.push(k);
  return { theme: t, ignored };
}

export function luminance(hex: string): number {
  const m = HEX.exec(hex);
  if (!m) return 1;
  const h = normalizeColor(hex).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The theme file for export: the same shape the importer reads. */
export function themeToJson(t: Theme): J {
  return {
    name: t.name,
    dataColors: t.dataColors,
    background: t.background,
    secondaryBackground: t.pageBackground,
    foreground: t.foreground,
    secondLevelElements: t.muted,
    tableAccent: t.tableAccent,
    good: t.good,
    neutral: t.neutral,
    bad: t.bad,
    maximum: t.maximum,
    center: t.center,
    minimum: t.minimum,
    textClasses: Object.fromEntries(Object.entries(t.textClasses).map(([k, v]) => [k, { ...v }])),
    ...(Object.keys(t.visualStyles).length ? { visualStyles: t.visualStyles } : {}),
  };
}

// ---- lookups -----------------------------------------------------------------------------------

export const seriesColor = (t: Theme, i: number): string => t.dataColors[i % t.dataColors.length];

function plain(v: J): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") {
    const c = v.solid?.color;
    return typeof c === "string" ? c : null;
  }
  return v;
}

/** A default from the theme file's visualStyles for (visual type, object, property); "*" is the wildcard type. */
export function themeStyle(t: Theme, visualType: string, object: string, prop: string): string | number | boolean | null {
  for (const vt of [visualType, "*"]) {
    const list = t.visualStyles[vt]?.["*"]?.[object];
    if (list?.[0] && list[0][prop] !== undefined) return plain(list[0][prop]);
  }
  return null;
}

/** The theme default style for exactly this visual type (no "*" wildcard): what a page or a group takes from the theme. */
export function themeStyleExact(t: Theme, visualType: string, object: string, prop: string): string | number | boolean | null {
  const list = t.visualStyles[visualType]?.["*"]?.[object];
  return list?.[0] && list[0][prop] !== undefined ? plain(list[0][prop]) : null;
}

// ---- theme of a project ----------------------------------------------------------------------

const REGISTERED = "RegisteredResources";

/** The theme in effect: the report's custom theme if its file is present, else a built-in by name. */
export function resolveTheme(p: Project): Theme {
  const tc = (p.report.files["report.json"] as J)?.themeCollection;
  const custom = tc?.customTheme;
  if (custom?.type === REGISTERED) {
    const file = p.report.static_resources?.[`${custom.name}.json`] ?? p.report.static_resources?.[custom.name];
    if (file) {
      try {
        return parseThemeJson(file).theme;
      } catch {
        /* a damaged theme file falls back to the built-in below */
      }
    }
  }
  const builtin = BUILTIN_THEMES.find((b) => b.name === (custom?.name ?? tc?.baseTheme?.name));
  return builtin ?? DEFAULT_THEME;
}

const THEME_VERSION = { visual: "2.13.0", page: "2.1.0", report: "3.3.0" };

/** Makes `theme` the report's custom theme and stores its file (the base theme entry is left alone). */
export function applyThemeToProject(p: Project, theme: Theme): void {
  const report = (p.report.files["report.json"] ??= {}) as J;
  p.report.static_resources ??= {};
  const prev = report.themeCollection?.customTheme;
  if (prev?.type === REGISTERED && prev.name !== theme.name) delete p.report.static_resources[`${prev.name}.json`];
  const fileName = `${safeFile(theme.name)}.json`;
  p.report.static_resources[fileName] = themeToJson(theme);
  report.themeCollection = { ...(report.themeCollection ?? {}), customTheme: { name: safeFile(theme.name), reportVersionAtImport: { ...THEME_VERSION }, type: REGISTERED } };
  const pkgs: J[] = (report.resourcePackages ??= []);
  let pkg = pkgs.find((x) => x.type === REGISTERED);
  if (!pkg) {
    pkg = { name: REGISTERED, type: REGISTERED, items: [] };
    pkgs.push(pkg);
  }
  pkg.items = (pkg.items ?? []).filter((i: J) => i.type !== "CustomTheme");
  pkg.items.push({ name: fileName, path: fileName, type: "CustomTheme" });
}

/** Removes the custom theme: the report falls back to its base theme. */
export function clearCustomTheme(p: Project): void {
  const report = p.report.files["report.json"] as J;
  const prev = report?.themeCollection?.customTheme;
  if (!prev) return;
  delete p.report.static_resources?.[`${prev.name}.json`];
  delete report.themeCollection.customTheme;
  for (const pkg of report.resourcePackages ?? []) pkg.items = (pkg.items ?? []).filter((i: J) => i.type !== "CustomTheme");
  report.resourcePackages = (report.resourcePackages ?? []).filter((x: J) => x.items.length > 0);
  if (!report.resourcePackages.length) delete report.resourcePackages;
}

function safeFile(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") || "Theme";
}
