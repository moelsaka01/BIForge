// Style presets (General tab > Style preset), with the names and stored values Power BI uses.
// * Every visual can use a preset that the report theme defines: in the theme file's `visualStyles` a style name other
//   than "*" is a custom style preset for that visual type, and `stylePreset.name` of the visual selects it. The first
//   choice, Base, is no preset (the name is empty).
// * Tables and matrices also have built-in presets. Their stored names are the ids below (Default, None, Minimal,
//   BoldHeader, AlternatingRowsNew, ContrastAlternatingRows, FlashyRows, BoldHeaderFlashyRows, Sparse, Condensed; the
//   older AlternatingRows is kept for files that use it). Each one is a set of grid, header, value and total colors
//   computed from the theme's palette (notes: research/ui-style-presets.md). Default and None leave BIForge's own
//   look as it is.
import type { Theme } from "./theme";

export interface PresetChoice {
  value: string;
  label: string;
}

/** The built-in presets of tables and matrices, in the order the Style preset list shows them. */
export const TABLE_PRESETS: (PresetChoice & { deprecated?: boolean })[] = [
  { value: "Default", label: "Default" },
  { value: "None", label: "None" },
  { value: "Minimal", label: "Minimal" },
  { value: "BoldHeader", label: "Bold header" },
  { value: "AlternatingRows", label: "Alternating rows (deprecated)", deprecated: true },
  { value: "AlternatingRowsNew", label: "Alternating rows" },
  { value: "ContrastAlternatingRows", label: "Contrast alternating rows" },
  { value: "FlashyRows", label: "Flashy rows" },
  { value: "BoldHeaderFlashyRows", label: "Bold header flashy rows" },
  { value: "Sparse", label: "Sparse" },
  { value: "Condensed", label: "Condensed" },
];

export const hasBuiltinPresets = (visualType: string) => visualType === "tableEx" || visualType === "pivotTable";

/** The name a visual has when none is stored. */
export const defaultPreset = (visualType: string) => (hasBuiltinPresets(visualType) ? "Default" : "");

/** The names of the presets the theme defines for a visual type (its own styles and those of every visual type). */
export function themePresetNames(theme: Theme, visualType: string): string[] {
  const names = new Set<string>();
  for (const vt of [visualType, "*"]) for (const k of Object.keys(theme.visualStyles[vt] ?? {})) if (k !== "*") names.add(k);
  return [...names];
}

/** What the Style preset list offers: Base, the built-in presets, the theme's presets, and the stored name when it is none of them. */
export function presetChoices(visualType: string, theme: Theme, current: string | null): PresetChoice[] {
  const out: PresetChoice[] = hasBuiltinPresets(visualType)
    ? TABLE_PRESETS.filter((p) => !p.deprecated || current === p.value).map(({ value, label }) => ({ value, label }))
    : [{ value: "", label: "Base" }];
  for (const n of themePresetNames(theme, visualType)) if (!out.some((o) => o.value === n)) out.push({ value: n, label: n });
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: `${current} (not in the theme)` });
  return out;
}

// ---- colors ----

function rgb(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `fg` laid over `bg` with the given share (0 to 1) of `fg`. */
export function mix(fg: string, share: number, bg: string): string {
  const a = rgb(fg);
  const b = rgb(bg);
  if (!a || !b) return bg;
  const c = a.map((x, i) => Math.round(x * share + b[i] * (1 - share)));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

type Props = Record<string, string | number | boolean>;

/** The grid, header, value and total settings of a built-in table preset, by "object.property". */
function tableProps(preset: string, theme: Theme): Props | null {
  const bg = theme.background;
  const fg = theme.foreground;
  const accent = theme.tableAccent;
  const grid = (color: string, h: boolean, v: boolean, pad: number): Props => ({
    "grid.gridHorizontalColor": color,
    "grid.gridVerticalColor": color,
    "grid.gridHorizontal": h,
    "grid.gridVertical": v,
    "grid.rowPadding": pad,
  });
  const headerLight: Props = { "columnHeaders.fontColor": fg, "columnHeaders.backColor": bg };
  const headerInverse: Props = { "columnHeaders.fontColor": bg, "columnHeaders.backColor": fg };
  const plain: Props = { "values.fontColorPrimary": fg, "values.backColorPrimary": bg, "values.fontColorSecondary": fg, "values.backColorSecondary": bg };
  const zebra = (share: number): Props => ({ ...plain, "values.backColorSecondary": mix(fg, share, bg) });
  const totals = (inverse: boolean): Props => {
    const p = inverse ? { fontColor: bg, backColor: fg } : { fontColor: fg, backColor: bg };
    return Object.fromEntries(["total", "rowTotal", "columnTotal", "subTotals"].flatMap((o) => [[`${o}.fontColor`, p.fontColor], [`${o}.backColor`, p.backColor]]));
  };
  const line = mix(fg, 0.12, bg);
  switch (preset) {
    case "Minimal":
      return { ...grid(line, true, false, 3), ...headerLight, ...plain, ...totals(false) };
    case "BoldHeader":
      return { ...grid(line, true, false, 3), ...headerInverse, ...plain, ...totals(false) };
    case "AlternatingRows":
    case "AlternatingRowsNew":
      return { ...grid(line, true, false, 3), ...headerInverse, ...zebra(0.08), ...totals(true) };
    case "ContrastAlternatingRows":
      return {
        ...grid(line, true, false, 3),
        ...headerInverse,
        "values.fontColorPrimary": bg,
        "values.backColorPrimary": mix(fg, 0.75, bg),
        "values.fontColorSecondary": fg,
        "values.backColorSecondary": mix(fg, 0.25, bg),
        ...totals(true),
      };
    case "FlashyRows":
      return { ...grid(bg, false, false, 3), ...headerLight, ...plain, "values.backColorPrimary": mix(accent, 0.4, bg), "values.backColorSecondary": mix(accent, 0.8, bg), ...totals(false) };
    case "BoldHeaderFlashyRows":
      return { ...grid(bg, false, false, 3), ...headerInverse, ...plain, "values.backColorPrimary": mix(accent, 0.4, bg), "values.backColorSecondary": mix(accent, 0.8, bg), ...totals(true) };
    case "Sparse":
      return { ...grid(mix(fg, 0.2, bg), false, false, 6), ...headerInverse, ...plain, ...totals(true) };
    case "Condensed":
      return { ...grid(mix(fg, 0.2, bg), true, true, 0), ...headerInverse, ...plain, ...totals(true) };
    default:
      return null; // Default, None and a name no preset has: BIForge's own look
  }
}

/** The value a preset gives to a setting, or null when it gives none (the theme's default or the built-in default applies then). */
export function presetValue(theme: Theme, visualType: string, preset: string, object: string, prop: string): string | number | boolean | null {
  if (!preset) return null;
  // a preset the theme defines
  for (const vt of [visualType, "*"]) {
    const v = theme.visualStyles[vt]?.[preset]?.[object]?.[0]?.[prop];
    if (v !== undefined && v !== null) return typeof v === "object" ? (typeof v.solid?.color === "string" ? v.solid.color : null) : v;
  }
  if (!hasBuiltinPresets(visualType)) return null;
  const v = tableProps(preset, theme)?.[`${object}.${prop}`];
  return v === undefined ? null : v;
}
