// The Options dialog as data: every page and setting (Global and Current File). A setting with `implemented: true`
// really changes behavior and is stored (global: app settings; file: the project). The others are listed so the
// dialog is complete, drawn disabled with "Not yet implemented"; docs/INVENTORY.md sections 23 and 24 track them.

export type OptionValue = boolean | number | string;

export interface OptionDef {
  id: string;
  label: string;
  type: "bool" | "enum" | "number" | "text" | "info";
  default: OptionValue;
  /** For enums: value and label pairs. */
  choices?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** True when BIForge reads the setting. */
  implemented: boolean;
  /** Extra line under the setting. */
  note?: string;
}

export interface OptionPage {
  id: string;
  scope: "global" | "file";
  label: string;
  settings: OptionDef[];
}

const b = (id: string, label: string, def: boolean, implemented = false, note?: string): OptionDef => ({ id, label, type: "bool", default: def, implemented, note });
const e = (id: string, label: string, def: string, choices: [string, string][], implemented = false, note?: string): OptionDef => ({
  id, label, type: "enum", default: def, choices: choices.map(([value, l]) => ({ value, label: l })), implemented, note,
});
const n = (id: string, label: string, def: number, min: number, max: number, implemented = false, note?: string): OptionDef => ({ id, label, type: "number", default: def, min, max, implemented, note });
const t = (id: string, label: string, def: string, implemented = false, note?: string): OptionDef => ({ id, label, type: "text", default: def, implemented, note });
const info = (id: string, label: string): OptionDef => ({ id, label, type: "info", default: "", implemented: true });

const CULTURES: [string, string][] = [
  ["en-US", "English (United States)"], ["en-GB", "English (United Kingdom)"], ["de-DE", "German (Germany)"], ["fr-FR", "French (France)"],
  ["es-ES", "Spanish (Spain)"], ["it-IT", "Italian (Italy)"], ["pt-BR", "Portuguese (Brazil)"], ["nl-NL", "Dutch (Netherlands)"], ["ja-JP", "Japanese (Japan)"], ["zh-CN", "Chinese (China)"], ["ar-EG", "Arabic (Egypt)"],
];

export const OPTION_PAGES: OptionPage[] = [
  // ---- Global ----
  {
    id: "g.interface", scope: "global", label: "Interface",
    settings: [
      e("interface.shell", "Interface", "classic", [["classic", "Classic: multi-line ribbon, panes side by side on the right"], ["modern", "Modern: single-line ribbon, Data pane on the left, one pane switcher on the right"]], true),
      e("interface.theme", "Theme", "light", [["light", "Light"], ["dark", "Dark"], ["system", "Use system setting"]], true, "\"Use system setting\" follows the Windows light or dark mode and changes with it."),
      e("interface.ribbonMode", "Ribbon (this interface)", "multiline", [["multiline", "Multi-line"], ["singleline", "Single line"]], true),
      b("interface.showRecommended", "Show the Recommended section on the start screen", true, true),
      n("interface.recentCount", "Number of recent projects to remember", 20, 1, 50, true),
      e("interface.language", "Display language", "en", [["en", "English"]], false, "Only English is available."),
      b("interface.restoreWindow", "Remember window size and position", false),
    ],
  },
  {
    id: "g.dataLoad", scope: "global", label: "Data Load",
    settings: [
      e("dataLoad.typeDetection", "Type detection", "always", [["always", "Always detect column types and headers for unstructured sources"], ["file", "Detect per file"], ["never", "Never detect"]]),
      b("dataLoad.backgroundData", "Allow data preview to download in the background", true),
      b("dataLoad.parallel", "Enable parallel loading of tables", true),
      b("dataLoad.autoDateTime", "Auto date/time for new files", true),
      b("dataLoad.nullAsEmpty", "Load empty text fields as empty strings", true),
    ],
  },
  {
    id: "g.pq", scope: "global", label: "Power Query Editor",
    settings: [
      b("pq.formulaBar", "Display the formula bar", true, true),
      b("pq.monospace", "Display text in monospace font", false, true),
      b("pq.whitespace", "Show whitespace", false, true, "Spaces show as a middle dot and tabs as an arrow in the data preview."),
      b("pq.nativeQuery", "Show native queries", false),
      b("pq.parameterizedSource", "Always allow parameterized data source and native queries", false),
      b("pq.dependencies", "Show Query dependencies when the editor opens", false, true),
      n("pq.previewRows", "Rows in the preview", 1000, 100, 10000, true),
    ],
  },
  {
    id: "g.dq", scope: "global", label: "DirectQuery",
    settings: [b("dq.latestSchema", "Use the latest schema", false), b("dq.unrestricted", "Allow unrestricted measures in DirectQuery mode", false), info("dq.note", "DirectQuery is not available: BIForge imports data into its local store.")],
  },
  {
    id: "g.r", scope: "global", label: "R scripting",
    settings: [t("r.home", "R home directory", "", true, "Used by R script visuals."), t("r.ide", "R IDE", ""), n("r.timeout", "Script timeout (minutes)", 30, 1, 600, true, "Used by R script visuals.")],
  },
  {
    id: "g.python", scope: "global", label: "Python scripting",
    settings: [t("python.home", "Python home directory", "", true, "Used by Python visuals."), t("python.ide", "Python IDE", ""), n("python.timeout", "Script timeout (minutes)", 30, 1, 600, true, "Used by Python visuals.")],
  },
  {
    id: "g.security", scope: "global", label: "Security",
    settings: [
      e("security.nativeQueries", "Native database queries", "ask", [["ask", "Require user approval for new native database queries"], ["allow", "Do not require approval"]]),
      b("security.webWarning", "Show a security warning when using the Web connector", true),
      e("security.customVisuals", "Custom visuals", "disabled", [["disabled", "Do not load custom visuals"], ["ask", "Ask before loading"]]),
      b("security.credentialStore", "Store credentials in the Windows Credential Manager (always on)", true, true, "Passwords are never written to project files or logs."),
    ],
  },
  {
    id: "g.privacy", scope: "global", label: "Privacy",
    settings: [e("privacy.levels", "Privacy levels", "ask", [["ask", "Combine data according to each file's Privacy Level settings"], ["always", "Always combine data according to privacy level settings"], ["ignore", "Ignore the Privacy Levels"]])],
  },
  {
    id: "g.regional", scope: "global", label: "Regional Settings",
    settings: [e("regional.locale", "Locale for import", "en-US", CULTURES)],
  },
  {
    id: "g.updates", scope: "global", label: "Updates",
    settings: [info("updates.note", "BIForge does not check for updates by itself. Releases are published on GitHub."), b("updates.notify", "Notify me when a new release is available", false)],
  },
  {
    id: "g.usage", scope: "global", label: "Usage Data",
    settings: [info("usage.note", "BIForge collects no usage data and sends nothing over the network.")],
  },
  {
    id: "g.diagnostics", scope: "global", label: "Diagnostics",
    settings: [b("diagnostics.tracing", "Enable tracing", false), t("diagnostics.folder", "Trace folder", ""), b("diagnostics.crashDumps", "Collect crash dump files", false)],
  },
  {
    id: "g.preview", scope: "global", label: "Preview features",
    settings: [
      b("preview.onObject", "On-object interaction", true, true, "Turns on the formatting handles on a selected visual in the Modern interface."),
      b("preview.newPq", "New Power Query experience", false, false, "One editor serves both interfaces."),
      b("preview.enhancedTime", "Enhanced DAX time intelligence", false),
    ],
  },
  {
    id: "g.autoRecovery", scope: "global", label: "Auto recovery",
    settings: [
      b("autosave.enabled", "Save a recovery copy of unsaved changes", true, true, "The copy is used only after a crash; saving or leaving on purpose removes it."),
      n("autosave.seconds", "Seconds of inactivity before the recovery copy is written", 2, 1, 600, true),
    ],
  },
  {
    id: "g.report", scope: "global", label: "Report settings",
    settings: [
      b("report.modernTooltip", "Use the modern visual tooltip", true),
      b("report.changeFilterTypes", "Allow users to change filter types", true, true, "When off, a reader of the report (viewing mode) cannot switch a filter between Basic, Advanced, Top N and Relative date."),
      b("report.filterSearch", "Enable the search box of the Filters pane", true, true),
      b("report.slicerSearch", "Show the search box in slicers that do not decide for themselves", false, true, "A slicer's own Search setting wins."),
      b("report.persistentFilters", "Persistent filters", false),
      b("report.hideFilterPane", "Hide the filter pane in new reports", false),
      b("report.visualHeader", "Show the visual header on hover", true, true, "A visual's own Visual header setting wins."),
      b("canvas.smartGuides", "Smart guides: snap to other visuals and the page while moving and resizing (hold Alt to skip)", true, true),
      b("canvas.gridlines", "Show gridlines on the canvas", false, true),
      b("canvas.snapToGrid", "Snap visuals to the grid", false, true),
      b("canvas.lockObjects", "Lock objects (visuals cannot be moved or resized)", false, true),
      n("canvas.gridSize", "Grid size (pixels)", 10, 2, 200, true),
      e("report.crossFilter", "What a selection in a chart does to the other visuals", "highlight", [["highlight", "Cross-highlighting where the visual can, else cross-filtering"], ["filter", "Cross-filtering everywhere"]], true, "Edit interactions on a page wins."),
    ],
  },
  {
    id: "g.cache", scope: "global", label: "Data Cache Management Options",
    settings: [info("cache.note", "The data store of a project lives in its .biforge folder and is removed when you delete the project.")],
  },
  // ---- Current file ----
  {
    id: "f.dataLoad", scope: "file", label: "Data Load",
    settings: [b("file.dataLoad.autoDateTime", "Auto date/time for this file", true), b("file.dataLoad.parallel", "Enable parallel loading of tables", true), b("file.dataLoad.background", "Allow data preview to download in the background", true)],
  },
  {
    id: "f.regional", scope: "file", label: "Regional Settings",
    settings: [e("model.culture", "Model language (culture of the model)", "en-US", CULTURES, true, "Stored as the culture of model.tmdl.")],
  },
  {
    id: "f.privacy", scope: "file", label: "Privacy",
    settings: [e("file.privacy", "Privacy levels", "global", [["global", "Use the global setting"], ["always", "Always combine"], ["ignore", "Ignore"]])],
  },
  {
    id: "f.autoRecovery", scope: "file", label: "Auto recovery",
    settings: [info("file.recovery.note", "Recovery copies are kept in this project's .biforge/recovery folder (see the global Auto recovery page).")],
  },
  {
    id: "f.queryReduction", scope: "file", label: "Query reduction",
    settings: [b("file.qr.disableCross", "Disable cross-highlighting and cross-filtering by default", false, true, "A selection then changes no other visual unless Edit interactions says so."), b("file.qr.slicerApply", "Add an Apply button to each slicer", false), b("file.qr.filterApply", "Add a single Apply button to the filter pane", false)],
  },
  {
    id: "f.report", scope: "file", label: "Report settings",
    settings: [
      b("file.report.modernTooltip", "Use the modern visual tooltip", true),
      b("file.report.changeFilterTypes", "Allow users to change filter types", true, true, "Off here wins over the global setting."),
      b("file.report.slicerSearch", "Show the search box in slicers that do not decide for themselves", false, true),
      b("file.report.persistentFilters", "Persistent filters", false),
      b("file.report.showTablesDefault", "Export data allowed", true),
      b("file.report.hiddenPages", "Show hidden pages to users", false, true, "In viewing mode the tabs of hidden pages are listed too."),
      b("file.report.personalize", "Let report readers personalize visuals (change the type and fields of a visual)", false, true, "Stored as the personalizeVisual setting of every page; the visual header then shows the Personalize button."),
    ],
  },
];

export const ALL_OPTIONS: OptionDef[] = OPTION_PAGES.flatMap((p) => p.settings);

export function optionDef(id: string): OptionDef | undefined {
  return ALL_OPTIONS.find((o) => o.id === id);
}

/** A stored value if it has the right type for the setting, otherwise the default. */
export function optionValue(stored: Record<string, OptionValue>, def: OptionDef): OptionValue {
  const v = stored[def.id];
  switch (def.type) {
    case "bool":
      return typeof v === "boolean" ? v : def.default;
    case "number":
      return typeof v === "number" && isFinite(v) ? Math.min(def.max ?? v, Math.max(def.min ?? v, v)) : def.default;
    case "enum":
      return typeof v === "string" && def.choices?.some((c) => c.value === v) ? v : def.default;
    case "text":
      return typeof v === "string" ? v : def.default;
    default:
      return def.default;
  }
}
