// The ribbons as data: tabs, groups and controls that point at command ids. Nothing here runs anything; the Ribbon
// component asks the command registry whether a control is enabled and dispatches its command on a click.
// A control without a command is drawn disabled with its reason (not implemented / deferred).
import type { PaneId, ShellKind } from "./settings";
import type { ViewId, Zoom } from "./shellStore";
import { BUILTIN_THEMES } from "../report/theme";

export type IconName =
  | "save" | "undo" | "redo" | "paste" | "cut" | "copy" | "formatPainter" | "database" | "excel" | "sql" | "table" | "enterData"
  | "recent" | "transform" | "refresh" | "newVisual" | "textBox" | "moreVisuals" | "calc" | "measure" | "quickMeasure" | "column"
  | "newPage" | "duplicatePage" | "button" | "shapes" | "image" | "relationships" | "roles" | "viewAs"
  | "theme" | "pageView" | "gridlines" | "snap" | "lock" | "mobile" | "filters" | "visualizations" | "dataPane" | "bookmarks"
  | "selectionPane" | "syncSlicers" | "performance" | "about" | "keyboard" | "help" | "interactions" | "bringForward" | "sendBackward"
  | "align" | "group" | "drillUp" | "drillMode" | "nextLevel" | "expandAll" | "resetDrill" | "delete" | "run" | "format" | "code"
  | "tag" | "calendar" | "parameter" | "qna" | "language" | "text" | "fit" | "actual" | "options" | "folder" | "open" | "export" | "close"
  | "home" | "import" | "shield";

/** What a control may look at when deciding how to draw itself and which arguments to send. */
import type { CanvasOptions } from "../report/canvasOptions";

export interface RibbonCtx {
  view: ViewId;
  hasProject: boolean;
  pageName: string | null;
  pageCount: number;
  /** Visuals and groups selected on the canvas. */
  selectedCount: number;
  /** How many of them are groups, and which (for Ungroup). */
  selectedGroups: number;
  selectedGroupNames: string[];
  visual: {
    page: string;
    name: string;
    type: string;
    categories: number;
    drillLevel: number;
    drillMode: boolean;
    editingInteractions: boolean;
  } | null;
  table: string | null;
  daxTab: "query" | "measures";
  panes: Record<PaneId, boolean>;
  themeName: string;
  zoom: Zoom;
  /** Optimize > Pause visuals is on. */
  paused: boolean;
  /** Canvas view options (View > Page options). */
  canvas: CanvasOptions;
  /** The canvas shows the phone layout. */
  mobileLayout: boolean;
}

export type Args = Record<string, unknown> | ((c: RibbonCtx) => unknown);

export interface RibbonMenuItem {
  label: string;
  command?: string;
  args?: Args;
  /** Handled by the host window (file pickers, downloads), not by a command. */
  ui?: "theme.import" | "theme.export";
  checked?: (c: RibbonCtx) => boolean;
  status?: Unavailable;
  separatorBefore?: boolean;
}

export type Unavailable = "todo";

export interface RibbonControl {
  id: string;
  label: string;
  icon: IconName;
  command?: string;
  args?: Args;
  menu?: RibbonMenuItem[];
  /** Extra condition on top of the command's own enabled state. */
  when?: (c: RibbonCtx) => boolean;
  checked?: (c: RibbonCtx) => boolean;
  size?: "large" | "small";
  keytip?: string;
  /** Why the control does nothing (only for controls without a command). */
  status?: Unavailable;
  /** A read-only text box (table name) instead of a button. */
  readout?: (c: RibbonCtx) => string;
}

export interface RibbonGroup {
  id: string;
  label: string;
  controls: RibbonControl[];
}

export interface RibbonTab {
  id: string;
  label: string;
  keytip: string;
  /** The File tab opens the backstage instead of showing groups. */
  backstage?: boolean;
  /** A contextual tab, shown while `when` holds. */
  contextual?: boolean;
  when?: (c: RibbonCtx) => boolean;
  groups: RibbonGroup[];
}

export const STATUS_TEXT: Record<Unavailable, string> = {
  todo: "Not yet implemented",
};

// ---- builders ----
const todo = (id: string, label: string, icon: IconName, extra: Partial<RibbonControl> = {}): RibbonControl => ({ id, label, icon, status: "todo", ...extra });
const cmd = (id: string, label: string, icon: IconName, command: string, extra: Partial<RibbonControl> = {}): RibbonControl => ({ id, label, icon, command, ...extra });

const hasVisual = (c: RibbonCtx) => c.visual !== null;
const vArgs = (c: RibbonCtx) => ({ page: c.visual!.page, visual: c.visual!.name });
const drillable = (c: RibbonCtx) => !!c.visual && c.visual.categories > 1;

const getDataMenu: RibbonMenuItem[] = [
  { label: "Text/CSV", command: "data.getData", args: { source: "csv" } },
  { label: "Excel workbook", command: "data.getData", args: { source: "excel" } },
  { label: "JSON", command: "data.getData", args: { source: "json" } },
  { label: "Parquet", command: "data.getData", args: { source: "parquet" } },
  { label: "XML", command: "data.getData", args: { source: "xml" } },
  { label: "PDF", command: "data.getData", args: { source: "pdf" } },
  { label: "Access database", command: "data.getData", args: { source: "access" } },
  { label: "SQLite database", command: "data.getData", args: { source: "sqlite" }, separatorBefore: true },
  { label: "SQL Server database", command: "data.getData", args: { source: "sqlserver" } },
  { label: "PostgreSQL database", command: "data.getData", args: { source: "postgres" } },
  { label: "MySQL database", command: "data.getData", args: { source: "mysql" } },
  { label: "Oracle database", command: "data.getData", args: { source: "oracle" } },
  { label: "ODBC", command: "data.getData", args: { source: "odbc" } },
  { label: "Web", command: "data.getData", args: { source: "web" }, separatorBefore: true },
  { label: "OData feed", command: "data.getData", args: { source: "odata" } },
  { label: "More…", command: "data.getData" },
];

const themeMenu: RibbonMenuItem[] = [
  ...BUILTIN_THEMES.map((t) => ({ label: t.name, command: "report.theme.apply", args: { builtin: t.name }, checked: (c: RibbonCtx) => c.themeName === t.name })),
  { label: "Browse for themes…", ui: "theme.import", separatorBefore: true },
  { label: "Save current theme…", ui: "theme.export" },
  { label: "Reset to the default theme", command: "report.theme.reset" },
];

const clipboard = (): RibbonGroup => ({
  id: "clipboard",
  label: "Clipboard",
  controls: [
    cmd("paste", "Paste", "paste", "report.visuals.paste", { size: "large", when: (c) => c.view === "report" }),
    cmd("cut", "Cut", "cut", "report.visuals.cut", { size: "small", when: (c) => c.view === "report" && c.selectedCount > 0 }),
    cmd("copy", "Copy", "copy", "report.visuals.copy", { size: "small", when: (c) => c.view === "report" && c.selectedCount > 0 }),
    todo("formatPainter", "Format painter", "formatPainter", { size: "small" }),
  ],
});

const dataGroup = (): RibbonGroup => ({
  id: "data",
  label: "Data",
  controls: [
    cmd("getData", "Get data", "database", "data.getData", { size: "large", menu: getDataMenu, keytip: "G" }),
    cmd("excel", "Excel workbook", "excel", "data.getData", { size: "large", args: { source: "excel" }, keytip: "X" }),
    cmd("sqlServer", "SQL Server", "sql", "data.getData", { size: "large", args: { source: "sqlserver" } }),
    cmd("enterData", "Enter data", "enterData", "data.getData", { size: "large", args: { source: "inline" } }),
    todo("recentSources", "Recent sources", "recent", { size: "large" }),
  ],
});

const queriesGroup = (): RibbonGroup => ({
  id: "queries",
  label: "Queries",
  controls: [
    cmd("transform", "Transform data", "transform", "query.editor.open", { size: "large", keytip: "TD" }),
    cmd("refresh", "Refresh", "refresh", "data.refreshAll", { size: "large", keytip: "R" }),
    cmd("dataSourceSettings", "Data source settings", "database", "data.sourceSettings", { size: "small" }),
  ],
});

const shapeItem = (label: string, shape: string): RibbonMenuItem => ({ label, command: "report.visual.add", args: { type: "shape", format: [{ object: "shape", prop: "tileShape", value: { t: "string", v: shape } }] } });
const buttonItem = (label: string, type: string, extra: object[] = []): RibbonMenuItem => ({
  label,
  command: "report.visual.add",
  args: { type: "actionButton", format: [{ object: "visualLink", prop: "type", value: { t: "string", v: type } }, { object: "text", prop: "text", value: { t: "string", v: label } }, ...extra] },
});
/** Text box, Buttons, Shapes, Image, Page navigator: the objects that show no data. */
const elementControls = (): RibbonControl[] => [
  cmd("textBox", "Text box", "textBox", "report.visual.add", { size: "large", args: { type: "textbox" }, keytip: "TB" }),
  cmd("button", "Buttons", "button", "report.visual.add", {
    size: "large",
    args: { type: "actionButton" },
    menu: [buttonItem("Blank", "None"), buttonItem("Back", "Back"), buttonItem("Bookmark", "Bookmark"), buttonItem("Page navigation", "PageNavigation"), buttonItem("Web URL", "WebUrl")],
  }),
  cmd("shapes", "Shapes", "shapes", "report.visual.add", {
    size: "large",
    args: { type: "shape" },
    menu: [shapeItem("Rectangle", "rectangle"), shapeItem("Rounded rectangle", "rectangleRounded"), shapeItem("Oval", "oval"), shapeItem("Triangle", "triangleIsoc"), shapeItem("Line", "line")],
  }),
  cmd("image", "Image", "image", "report.image.insert", { size: "large" }),
  cmd("pageNavigator", "Page navigator", "bookmarks", "report.visual.add", { size: "large", args: { type: "pageNavigator" } }),
];

const insertGroup = (): RibbonGroup => ({
  id: "insert",
  label: "Insert",
  controls: [
    cmd("newVisual", "New visual", "newVisual", "report.visual.add", { size: "large", args: { type: "clusteredColumnChart" }, keytip: "V" }),
    cmd("textBox", "Text box", "textBox", "report.visual.add", { size: "large", args: { type: "textbox" }, keytip: "TB" }),
    todo("moreVisuals", "More visuals", "moreVisuals", { size: "large" }),
  ],
});

const calculationsGroup = (): RibbonGroup => ({
  id: "calculations",
  label: "Calculations",
  controls: [
    todo("visualCalc", "New visual calculation", "calc", { size: "large" }),
    cmd("newMeasure", "New measure", "measure", "model.newMeasure", { size: "large", keytip: "NM" }),
    todo("quickMeasure", "Quick measure", "quickMeasure", { size: "large" }),
  ],
});


const modelingCalculations = (): RibbonGroup => ({
  id: "calculations",
  label: "Calculations",
  controls: [
    cmd("newMeasure", "New measure", "measure", "model.newMeasure", { size: "large", keytip: "NM" }),
    todo("quickMeasure", "Quick measure", "quickMeasure", { size: "large" }),
    todo("newColumn", "New column", "column", { size: "large" }),
    cmd("newTable", "New table", "table", "model.newTableDialog", { size: "large", keytip: "NT" }),
    todo("calcGroup", "Calculation group", "calc", { size: "large" }),
  ],
});

const relationshipsGroup = (): RibbonGroup => ({
  id: "relationships",
  label: "Relationships",
  controls: [cmd("manageRelationships", "Manage relationships", "relationships", "model.manageRelationships", { size: "large", keytip: "MR" })],
});

const securityGroup = (): RibbonGroup => ({
  id: "security",
  label: "Security",
  controls: [todo("manageRoles", "Manage roles", "roles", { size: "large" }), todo("viewAs", "View as", "viewAs", { size: "large" })],
});

const shareGroup = (): RibbonGroup => ({
  id: "share",
  label: "Share",
  controls: [
    cmd("publishShare", "Publish & Share", "export", "publish.open", { size: "large", keytip: "PS" }),
    cmd("openShared", "Open shared report", "open", "package.open", { size: "large", keytip: "OS" }),
    cmd("hostShare", "Host and collaborate", "export", "host.open", { size: "large", keytip: "HC" }),
    cmd("joinServer", "Join a server", "open", "server.join", { size: "large", keytip: "JS" }),
    cmd("comments", "Comments", "help", "comments.open", { size: "large", keytip: "CM" }),
    cmd("stopCoEdit", "Stop editing together", "delete", "collab.stop", { size: "large", keytip: "SC" }),
  ],
});

const homeCommon = (): RibbonGroup[] => [clipboard(), dataGroup(), queriesGroup()];

const helpTab = (): RibbonTab => ({
  id: "help",
  label: "Help",
  keytip: "Y",
  groups: [
    {
      id: "help",
      label: "Help",
      controls: [cmd("about", "About", "about", "app.about", { size: "large", keytip: "AB" }), cmd("shortcuts", "Keyboard shortcuts", "keyboard", "app.shortcuts", { size: "large", keytip: "KS" })],
    },
  ],
});

const fileTab = (): RibbonTab => ({ id: "file", label: "File", keytip: "F", backstage: true, groups: [] });

const themesGroup = (): RibbonGroup => ({
  id: "themes",
  label: "Themes",
  controls: [cmd("themes", "Themes", "theme", "report.theme.apply", { size: "large", menu: themeMenu, keytip: "TH" })],
});

const pageViewGroup = (): RibbonGroup => ({
  id: "pageView",
  label: "Page view",
  controls: [
    cmd("fit", "Fit to page", "fit", "view.zoom", { size: "large", args: { zoom: "fit" }, checked: (c) => c.zoom === "fit", keytip: "FP" }),
    cmd("actual", "Actual size", "actual", "view.zoom", { size: "large", args: { zoom: 1 }, checked: (c) => c.zoom === 1 }),
  ],
});

const panesGroup = (): RibbonGroup => ({
  id: "panes",
  label: "Show panes",
  controls: (
    [
      ["filters", "Filters", "filters"],
      ["visualizations", "Visualizations", "visualizations"],
      ["data", "Data", "dataPane"],
      ["bookmarks", "Bookmarks", "bookmarks"],
      ["selection", "Selection", "selectionPane"],
      ["sync", "Sync slicers", "syncSlicers"],
    ] as const
  ).map(([pane, label, icon]) => cmd(`pane.${pane}`, label, icon, "pane.toggle", { size: "small", args: { pane }, checked: (c) => c.panes[pane] })).concat([
    todo("pane.performance", "Performance analyzer", "performance", { size: "small" }),
  ]),
});

const pageOptionsGroup = (): RibbonGroup => ({
  id: "pageOptions",
  label: "Page options",
  controls: [
    cmd("guides", "Smart guides", "align", "view.canvas", { size: "small", args: { option: "smartGuides" }, checked: (c) => c.canvas.smartGuides, when: (c) => c.view === "report" }),
    cmd("gridlines", "Gridlines", "gridlines", "view.canvas", { size: "small", args: { option: "gridlines" }, checked: (c) => c.canvas.gridlines, when: (c) => c.view === "report" }),
    cmd("snap", "Snap to grid", "snap", "view.canvas", { size: "small", args: { option: "snapToGrid" }, checked: (c) => c.canvas.snapToGrid, when: (c) => c.view === "report" }),
    cmd("lock", "Lock objects", "lock", "view.canvas", { size: "small", args: { option: "lockObjects" }, checked: (c) => c.canvas.lockObjects, when: (c) => c.view === "report" }),
    cmd("mobile", "Mobile layout", "mobile", "view.mobileLayout", { size: "small", checked: (c) => c.mobileLayout, when: (c) => c.view === "report" }),
  ],
});

const formatTab = (): RibbonTab => ({
  id: "format",
  label: "Format",
  keytip: "JB",
  contextual: true,
  when: hasVisual,
  groups: [
    {
      id: "interactions",
      label: "Interactions",
      controls: [cmd("editInteractions", "Edit interactions", "interactions", "report.interaction.edit", { size: "large", args: (c) => ({ source: c.visual?.editingInteractions ? null : c.visual?.name }), when: hasVisual, checked: (c) => !!c.visual?.editingInteractions, keytip: "EI" })],
    },
    {
      id: "arrange",
      label: "Arrange",
      controls: [
        cmd("bringForward", "Bring forward", "bringForward", "report.visual.arrange", { size: "large", args: (c) => ({ ...vArgs(c), where: "front" }), when: hasVisual }),
        cmd("sendBackward", "Send backward", "sendBackward", "report.visual.arrange", { size: "large", args: (c) => ({ ...vArgs(c), where: "back" }), when: hasVisual }),
        cmd("selection", "Selection", "selectionPane", "pane.toggle", { size: "large", args: { pane: "selection" } }),
        cmd("align", "Align", "align", "report.visuals.align", {
          size: "large",
          when: (c) => c.selectedCount >= 2,
          args: { mode: "left" },
          menu: [
            { label: "Align left", command: "report.visuals.align", args: { mode: "left" } },
            { label: "Align center", command: "report.visuals.align", args: { mode: "center" } },
            { label: "Align right", command: "report.visuals.align", args: { mode: "right" } },
            { label: "Align top", command: "report.visuals.align", args: { mode: "top" }, separatorBefore: true },
            { label: "Align middle", command: "report.visuals.align", args: { mode: "middle" } },
            { label: "Align bottom", command: "report.visuals.align", args: { mode: "bottom" } },
            { label: "Distribute horizontally", command: "report.visuals.distribute", args: { axis: "horizontal" }, separatorBefore: true },
            { label: "Distribute vertically", command: "report.visuals.distribute", args: { axis: "vertical" } },
          ],
        }),
        cmd("group", "Group", "group", "report.visuals.group", {
          size: "large",
          when: (c) => c.selectedCount >= 2 || c.selectedGroups > 0,
          keytip: "GR",
          menu: [
            { label: "Group (Ctrl+G)", command: "report.visuals.group" },
            { label: "Ungroup (Ctrl+Shift+G)", command: "report.group.ungroup", args: (c) => ({ visuals: c.selectedGroupNames }) },
          ],
        }),
      ],
    },
    {
      id: "visual",
      label: "Visual",
      controls: [
        cmd("duplicateVisual", "Duplicate", "duplicatePage", "report.visual.duplicate", { size: "large", args: vArgs, when: hasVisual }),
        cmd("deleteVisual", "Delete", "delete", "report.visual.delete", { size: "large", args: vArgs, when: hasVisual }),
      ],
    },
  ],
});

const drillTab = (): RibbonTab => ({
  id: "drill",
  label: "Data / Drill",
  keytip: "JD",
  contextual: true,
  when: hasVisual,
  groups: [
    {
      id: "drill",
      label: "Drill",
      controls: [
        cmd("drillMode", "Drill mode", "drillMode", "report.view.drillMode", { size: "large", args: (c) => ({ visual: c.visual?.name ?? null }), when: drillable, checked: (c) => !!c.visual?.drillMode }),
        cmd("drillUp", "Drill up", "drillUp", "report.view.drillUp", { size: "large", args: (c) => ({ visual: c.visual?.name }), when: (c) => drillable(c) && c.visual!.drillLevel > 0 }),
        cmd("nextLevel", "Go to the next level", "nextLevel", "report.view.nextLevel", { size: "large", args: (c) => ({ visual: c.visual?.name, levels: c.visual?.categories }), when: (c) => drillable(c) && c.visual!.drillLevel < c.visual!.categories - 1 }),
        cmd("expandAll", "Expand all down one level", "expandAll", "report.view.expandAll", { size: "large", args: (c) => ({ visual: c.visual?.name, levels: c.visual?.categories }), when: (c) => drillable(c) && c.visual!.drillLevel < c.visual!.categories - 1 }),
        cmd("resetDrill", "Reset drill", "resetDrill", "report.view.resetDrill", { size: "large", args: (c) => ({ visual: c.visual?.name }), when: (c) => drillable(c) && c.visual!.drillLevel > 0 }),
      ],
    },
  ],
});

// ---- the report view ----
function reportTabs(shell: ShellKind): RibbonTab[] {
  const home: RibbonTab = {
    id: "home",
    label: "Home",
    keytip: "H",
    groups: [...homeCommon(), insertGroup(), calculationsGroup(), shareGroup()],
  };
  const insert: RibbonTab = {
    id: "insert",
    label: "Insert",
    keytip: "N",
    groups: [
      {
        id: "pages",
        label: "Pages",
        controls: [
          cmd("newPage", "New page", "newPage", "report.page.add", { size: "large", keytip: "NP" }),
          cmd("duplicatePage", "Duplicate page", "duplicatePage", "report.page.duplicate", { size: "large", args: (c) => ({ page: c.pageName }), when: (c) => c.pageName !== null }),
        ],
      },
      {
        id: "visuals",
        label: "Visuals",
        controls: [
          cmd("newVisual", "New visual", "newVisual", "report.visual.add", { size: "large", args: { type: "clusteredColumnChart" } }),
          todo("moreVisuals", "More visuals", "moreVisuals", { size: "large" }),
        ],
      },
      {
        id: "elements",
        label: "Elements",
        controls: elementControls(),
      },
    ],
  };
  const modeling: RibbonTab = {
    id: "modeling",
    label: "Modeling",
    keytip: "M",
    groups: [relationshipsGroup(), modelingCalculations(), securityGroup(), { id: "parameters", label: "Parameters", controls: [todo("whatIf", "New parameter", "parameter", { size: "large" })] }, { id: "qna", label: "Q&A", controls: [todo("qnaSetup", "Q&A setup", "qna", { size: "large" }), todo("language", "Language", "language", { size: "large" })] }],
  };
  const viewTab: RibbonTab = {
    id: "view",
    label: "View",
    keytip: "W",
    groups: shell === "classic" ? [themesGroup(), pageViewGroup(), pageOptionsGroup(), panesGroup()] : [pageViewGroup(), pageOptionsGroup(), panesGroup()],
  };
  const optimize: RibbonTab = {
    id: "optimize",
    label: "Optimize",
    keytip: "Z",
    groups: [
      {
        id: "optimize",
        label: "Optimize",
        controls: [
          cmd("pauseVisuals", "Pause visuals", "performance", "report.visuals.pause", { size: "large", checked: (c) => c.paused, keytip: "PV" }),
          cmd("refreshVisuals", "Refresh visuals", "refresh", "report.visuals.refresh", { size: "large", keytip: "RV" }),
        ],
      },
      { id: "analyze", label: "Performance", controls: [todo("performanceAnalyzer", "Performance analyzer", "performance", { size: "large" })] },
    ],
  };
  const design: RibbonTab = { id: "design", label: "Design", keytip: "G", groups: [themesGroup(), { id: "page", label: "Page", controls: pageViewGroup().controls }] };
  const base = shell === "classic" ? [fileTab(), home, insert, modeling, viewTab, optimize, helpTab()] : [fileTab(), home, insert, modeling, design, viewTab, optimize, helpTab()];
  return [...base, formatTab(), drillTab()];
}

// ---- the other views ----
function tableTabs(): RibbonTab[] {
  return [
    fileTab(),
    { id: "home", label: "Home", keytip: "H", groups: [...homeCommon(), relationshipsGroup(), modelingCalculations()] },
    helpTab(),
    {
      id: "tableTools",
      label: "Table tools",
      keytip: "JT",
      contextual: true,
      when: (c) => c.table !== null,
      groups: [
        { id: "structure", label: "Structure", controls: [{ id: "tableName", label: "Name", icon: "tag", readout: (c) => c.table ?? "", status: "todo" }] },
        relationshipsGroup(),
        modelingCalculations(),
        { id: "calendars", label: "Calendars", controls: [todo("markDate", "Mark as date table", "calendar", { size: "large" })] },
      ],
    },
  ];
}

function modelTabs(): RibbonTab[] {
  return [
    fileTab(),
    {
      id: "home",
      label: "Home",
      keytip: "H",
      groups: [...homeCommon(), relationshipsGroup(), modelingCalculations(), { id: "parameters", label: "Parameters", controls: [todo("whatIf", "New parameter", "parameter", { size: "large" })] }, securityGroup(), { id: "qna", label: "Q&A", controls: [todo("qnaSetup", "Q&A setup", "qna", { size: "large" }), todo("language", "Language", "language", { size: "large" })] }],
    },
    {
      id: "view",
      label: "View",
      keytip: "W",
      groups: [
        {
          id: "panes",
          label: "Show panes",
          controls: [
            cmd("pane.properties", "Properties", "dataPane", "pane.toggle", { size: "large", args: { pane: "properties" }, checked: (c) => c.panes.properties, keytip: "PR" }),
            cmd("pane.data", "Data", "dataPane", "pane.toggle", { size: "large", args: { pane: "data" }, checked: (c) => c.panes.data }),
          ],
        },
      ],
    },
    helpTab(),
  ];
}

function daxTabs(): RibbonTab[] {
  return [
    fileTab(),
    {
      id: "home",
      label: "Home",
      keytip: "H",
      groups: [
        {
          id: "query",
          label: "Query",
          controls: [
            cmd("run", "Run", "run", "dax.query.run", { size: "large", keytip: "RN" }),
            cmd("queryTab", "Query", "code", "dax.tab", { size: "large", args: { tab: "query" }, checked: (c) => c.daxTab === "query" }),
            cmd("measuresTab", "Measures", "measure", "dax.tab", { size: "large", args: { tab: "measures" }, checked: (c) => c.daxTab === "measures" }),
            todo("format", "Format query", "format", { size: "large" }),
          ],
        },
        modelingCalculations(),
        queriesGroup(),
      ],
    },
    helpTab(),
  ];
}

function tmdlTabs(): RibbonTab[] {
  return [
    fileTab(),
    { id: "home", label: "Home", keytip: "H", groups: [{ id: "tmdl", label: "TMDL", controls: [cmd("apply", "Apply changes", "code", "tmdl.apply", { size: "large", keytip: "AP" }), cmd("refresh", "Refresh", "refresh", "data.refreshAll", { size: "large" })] }] },
    helpTab(),
  ];
}

/** The tabs of one shell for one view (contextual tabs included; the host decides which to show). */
export function ribbonFor(shell: ShellKind, view: ViewId): RibbonTab[] {
  switch (view) {
    case "report":
      return reportTabs(shell);
    case "data":
      return tableTabs();
    case "model":
      return modelTabs();
    case "dax":
      return daxTabs();
    case "tmdl":
      return tmdlTabs();
  }
}

export function resolveArgs(a: Args | undefined, c: RibbonCtx): unknown {
  return typeof a === "function" ? (a as (c: RibbonCtx) => unknown)(c) : a;
}

/** Every control and menu item of a ribbon, flattened (for tests and coverage counts). */
export function allControls(tabs: RibbonTab[]): { tab: string; control: RibbonControl }[] {
  return tabs.flatMap((t) => t.groups.flatMap((g) => g.controls.map((control) => ({ tab: t.id, control }))));
}

export function visibleTabs(tabs: RibbonTab[], c: RibbonCtx): RibbonTab[] {
  return tabs.filter((t) => !t.contextual || (t.when?.(c) ?? true));
}
