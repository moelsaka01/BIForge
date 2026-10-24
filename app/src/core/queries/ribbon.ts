// The Power Query editor ribbon as data: tabs, groups and buttons (labels follow the editor's command inventory in
// research/ui-ribbon-commands.md). A button either opens a dialog, runs a transform on the selected columns, runs a
// command, or is listed as not implemented (shown disabled with a tooltip so the gap is visible).
import type { DataTypeName, StatisticOp, StepColumn, Transform } from "./types";
import { DATA_TYPES, isTextType, valueTypeOf, type DialogKind } from "./dialogs";

export interface RibbonContext {
  /** Columns of the selected step (empty when the step is not a table). */
  columns: StepColumn[];
  selected: string[];
  hasTable: boolean;
  /** A query is selected and the editor can change it. */
  hasQuery: boolean;
  dirty: boolean;
  /** The selected query is a parameter. */
  parameter?: boolean;
}

export type RibbonAction =
  | { type: "transform"; build: (c: RibbonContext) => Transform }
  | { type: "dialog"; dialog: DialogKind }
  | { type: "command"; id: string; args?: unknown; argsFor?: (c: RibbonContext) => unknown }
  | { type: "ui"; what: "advanced" | "dependencies" | "settings" | "formulaBar" | "refresh" | "close" | "quality" | "distribution" | "profile" | "examples" }
  | { type: "none" };

export type Need = "none" | "table" | "column" | "columns" | "textColumn" | "numberColumn" | "parameter";

export interface RibbonItem {
  id: string;
  label: string;
  tip?: string;
  need?: Need;
  action: RibbonAction;
  notImplemented?: boolean;
  menu?: RibbonItem[];
}

export interface RibbonGroup {
  id: string;
  label: string;
  items: RibbonItem[];
}

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
}

const tf = (build: (c: RibbonContext) => Transform): RibbonAction => ({ type: "transform", build });
const dlg = (dialog: DialogKind): RibbonAction => ({ type: "dialog", dialog });
/** A button that applies a library function to each value of the selected columns, in place. */
const colFn = (id: string, label: string, fn: string, step: string, valueType: DataTypeName): RibbonItem => ({
  id,
  label,
  need: "columns",
  action: tf((c) => ({ kind: "transformColumn", columns: c.selected, function: fn, valueType, label: step })),
});
const todo = (id: string, label: string, need: Need = "table"): RibbonItem => ({ id, label, need, action: { type: "none" }, notImplemented: true });

const STATISTICS: [StatisticOp, string][] = [
  ["sum", "Sum"],
  ["min", "Minimum"],
  ["max", "Maximum"],
  ["median", "Median"],
  ["average", "Average"],
  ["standardDeviation", "Standard Deviation"],
  ["count", "Count Values"],
  ["countDistinct", "Count Distinct Values"],
];

/** Transform > Statistics: one value computed from the selected column. */
const columnStatistics: RibbonItem[] = STATISTICS.map(([op, label]) => ({
  id: `t.stats.${op}`,
  label,
  need: "column" as const,
  action: tf((c) => ({ kind: "columnStatistic", column: c.selected[0], op })),
}));

/** Add Column > Statistics: a new column with the statistic across the selected columns of each row. */
const rowStatistics: RibbonItem[] = STATISTICS.filter(([op]) => op !== "countDistinct").map(([op, label]) => ({
  id: `a.stats.${op}`,
  label,
  need: "columns" as const,
  action: tf((c) => ({ kind: "rowStatistic", columns: c.selected, op, newName: label })),
}));

const typeMenu: RibbonItem[] = DATA_TYPES.map((t) => ({
  id: `type.${t.type}`,
  label: t.label,
  need: "columns",
  action: tf((c) => ({ kind: "changeType", changes: c.selected.map((column) => ({ column, type: t.type })) })),
}));

const sortItems: RibbonItem[] = [
  { id: "sort.asc", label: "Sort Ascending", need: "columns", action: tf((c) => ({ kind: "sort", keys: c.selected.map((column) => ({ column })) })) },
  { id: "sort.desc", label: "Sort Descending", need: "columns", action: tf((c) => ({ kind: "sort", keys: c.selected.map((column) => ({ column, descending: true })) })) },
];

const formatItems: RibbonItem[] = (
  [
    ["lower", "lowercase"],
    ["upper", "UPPERCASE"],
    ["trim", "Trim"],
    ["clean", "Clean"],
  ] as const
).map(([op, label]) => ({ id: `format.${op}`, label, need: "textColumn" as const, action: tf((c) => ({ kind: "transformText", columns: c.selected, op })) }));

const datePart = (id: string, label: string, fn: string): RibbonItem => ({
  id,
  label,
  need: "column",
  action: tf((c) => ({ kind: "addCustomColumn", name: label, formula: `${fn}([${c.selected[0]}])` })),
});

export const RIBBON: RibbonTab[] = [
  {
    id: "home",
    label: "Home",
    groups: [
      {
        id: "close",
        label: "Close",
        items: [
          { id: "closeApply", label: "Close & Apply", tip: "Run the changed queries, load their tables into the model and close the editor", need: "none", action: { type: "command", id: "query.applyAndClose" } },
          { id: "apply", label: "Apply", need: "none", action: { type: "command", id: "query.apply" } },
          { id: "discard", label: "Close", tip: "Close the editor and discard changes that were not applied", need: "none", action: { type: "ui", what: "close" } },
        ],
      },
      {
        id: "newQuery",
        label: "New Query",
        items: [
          {
            id: "newSource",
            label: "New Source",
            need: "none",
            action: { type: "none" },
            menu: [
              { id: "src.csv", label: "Text/CSV", need: "none", action: dlg("newCsv") },
              { id: "src.excel", label: "Excel workbook", need: "none", action: dlg("newExcel") },
              { id: "src.folder", label: "Folder", need: "none", action: dlg("newFolder") },
              { id: "src.blank", label: "Blank query", need: "none", action: { type: "command", id: "query.add" } },
              { id: "src.web", label: "Web", need: "none", action: { type: "none" }, notImplemented: true },
              { id: "src.sql", label: "SQL Server", need: "none", action: { type: "none" }, notImplemented: true },
            ],
          },
          { id: "enterData", label: "Enter Data", need: "none", action: dlg("enterData") },
        ],
      },
      {
        id: "parameters",
        label: "Parameters",
        items: [
          {
            id: "manageParameters",
            label: "Manage Parameters",
            need: "none",
            action: { type: "none" },
            menu: [
              { id: "param.new", label: "New Parameter...", need: "none", action: dlg("newParameter") },
              { id: "param.edit", label: "Edit Parameter...", need: "parameter", action: dlg("editParameter") },
            ],
          },
        ],
      },
      {
        id: "query",
        label: "Query",
        items: [
          { id: "refresh", label: "Refresh Preview", need: "none", action: { type: "ui", what: "refresh" } },
          { id: "advanced", label: "Advanced Editor", need: "none", action: { type: "ui", what: "advanced" } },
        ],
      },
      {
        id: "columns",
        label: "Manage Columns",
        items: [
          { id: "chooseColumns", label: "Choose Columns", need: "table", action: dlg("chooseColumns") },
          {
            id: "removeColumns",
            label: "Remove Columns",
            need: "columns",
            action: tf((c) => ({ kind: "removeColumns", columns: c.selected })),
            menu: [
              { id: "removeColumns.sel", label: "Remove Columns", need: "columns", action: tf((c) => ({ kind: "removeColumns", columns: c.selected })) },
              {
                id: "removeColumns.other",
                label: "Remove Other Columns",
                need: "columns",
                action: tf((c) => ({ kind: "keepColumns", columns: c.columns.map((x) => x.name).filter((n) => c.selected.includes(n)) })),
              },
            ],
          },
        ],
      },
      {
        id: "rows",
        label: "Reduce Rows",
        items: [
          {
            id: "keepRows",
            label: "Keep Rows",
            need: "table",
            action: { type: "none" },
            menu: [
              { id: "keep.top", label: "Keep Top Rows", need: "table", action: dlg("keepTop") },
              { id: "keep.bottom", label: "Keep Bottom Rows", need: "table", action: dlg("keepBottom") },
              { id: "keep.range", label: "Keep Range of Rows", need: "table", action: dlg("keepRange") },
              { id: "keep.dups", label: "Keep Duplicates", need: "columns", action: tf((c) => ({ kind: "keepDuplicates", columns: c.selected })) },
              { id: "keep.errors", label: "Keep Errors", need: "table", action: tf((c) => ({ kind: "keepErrors", columns: c.selected })) },
            ],
          },
          {
            id: "removeRows",
            label: "Remove Rows",
            need: "table",
            action: { type: "none" },
            menu: [
              { id: "remove.top", label: "Remove Top Rows", need: "table", action: dlg("removeTop") },
              { id: "remove.bottom", label: "Remove Bottom Rows", need: "table", action: dlg("removeBottom") },
              { id: "remove.alt", label: "Remove Alternate Rows", need: "table", action: dlg("removeAlt") },
              { id: "remove.dups", label: "Remove Duplicates", need: "columns", action: tf((c) => ({ kind: "removeDuplicates", columns: c.selected })) },
              {
                id: "remove.blank",
                label: "Remove Blank Rows",
                need: "table",
                action: tf((c) => ({ kind: "removeBlankRows", textColumns: c.columns.filter((x) => isTextType(x.duckdbType)).map((x) => x.name), otherColumns: c.columns.filter((x) => !isTextType(x.duckdbType)).map((x) => x.name) })),
              },
              { id: "remove.errors", label: "Remove Errors", need: "table", action: tf((c) => ({ kind: "removeErrors", columns: c.selected })) },
            ],
          },
          { id: "filterRows", label: "Filter Rows", need: "table", action: dlg("filter") },
        ],
      },
      { id: "sort", label: "Sort", items: sortItems },
      {
        id: "transform",
        label: "Transform",
        items: [
          { id: "splitColumn", label: "Split Column", need: "column", action: dlg("split") },
          { id: "groupBy", label: "Group By", need: "table", action: dlg("group") },
          { id: "dataType", label: "Data Type", need: "columns", action: { type: "none" }, menu: typeMenu },
          { id: "promote", label: "Use First Row as Headers", need: "table", action: tf(() => ({ kind: "promoteHeaders" })) },
          { id: "replace", label: "Replace Values", need: "columns", action: dlg("replace") },
        ],
      },
      {
        id: "combine",
        label: "Combine",
        items: [
          { id: "merge", label: "Merge Queries", need: "table", action: dlg("merge") },
          { id: "append", label: "Append Queries", need: "table", action: dlg("append") },
          { id: "combineFiles", label: "Combine Files", need: "none", action: dlg("newFolder") },
        ],
      },
    ],
  },
  {
    id: "transform",
    label: "Transform",
    groups: [
      {
        id: "table",
        label: "Table",
        items: [
          { id: "t.group", label: "Group By", need: "table", action: dlg("group") },
          { id: "t.promote", label: "Use First Row as Headers", need: "table", action: tf(() => ({ kind: "promoteHeaders" })) },
          { id: "t.demote", label: "Use Headers as First Row", need: "table", action: tf(() => ({ kind: "demoteHeaders" })) },
          { id: "t.transpose", label: "Transpose", need: "table", action: tf(() => ({ kind: "transpose" })) },
          { id: "t.reverse", label: "Reverse Rows", need: "table", action: tf(() => ({ kind: "reverseRows" })) },
          { id: "t.count", label: "Count Rows", need: "table", action: tf(() => ({ kind: "countRows" })) },
        ],
      },
      {
        id: "anyColumn",
        label: "Any Column",
        items: [
          { id: "t.type", label: "Data Type", need: "columns", action: { type: "none" }, menu: typeMenu },
          { id: "t.detect", label: "Detect Data Type", need: "columns", action: { type: "command", id: "query.detectTypes", argsFor: (c) => ({ columns: c.selected }) } },
          { id: "t.replace", label: "Replace Values", need: "columns", action: dlg("replace") },
          { id: "t.errors", label: "Replace Errors", need: "table", action: dlg("replaceErrors") },
          {
            id: "t.fill",
            label: "Fill",
            need: "columns",
            action: { type: "none" },
            menu: [
              { id: "t.fill.down", label: "Down", need: "columns", action: tf((c) => ({ kind: "fillDown", columns: c.selected })) },
              { id: "t.fill.up", label: "Up", need: "columns", action: tf((c) => ({ kind: "fillUp", columns: c.selected })) },
            ],
          },
          { id: "t.pivot", label: "Pivot Column", need: "column", action: dlg("pivot") },
          {
            id: "t.unpivot",
            label: "Unpivot Columns",
            need: "columns",
            action: { type: "none" },
            menu: [
              { id: "t.unpivot.sel", label: "Unpivot Columns", need: "columns", action: tf((c) => ({ kind: "unpivot", columns: c.selected })) },
              { id: "t.unpivot.other", label: "Unpivot Other Columns", need: "columns", action: tf((c) => ({ kind: "unpivotOther", columns: c.selected })) },
              { id: "t.unpivot.only", label: "Unpivot Only Selected Columns", need: "columns", action: tf((c) => ({ kind: "unpivot", columns: c.selected })) },
            ],
          },
          { id: "t.rename", label: "Rename", need: "column", action: dlg("rename") },
        ],
      },
      {
        id: "textColumn",
        label: "Text Column",
        items: [
          { id: "t.split", label: "Split Column", need: "column", action: dlg("split") },
          { id: "t.format", label: "Format", need: "textColumn", action: { type: "none" }, menu: formatItems },
          { id: "t.merge", label: "Merge Columns", need: "columns", action: dlg("mergeColumns") },
          {
            id: "t.extract",
            label: "Extract",
            need: "textColumn",
            action: { type: "none" },
            menu: [
              colFn("t.ext.length", "Length", "Text.Length", "Extracted Text Length", "int64"),
              { id: "t.ext.first", label: "First Characters", need: "textColumn", action: dlg("extractFirst") },
              { id: "t.ext.last", label: "Last Characters", need: "textColumn", action: dlg("extractLast") },
              { id: "t.ext.range", label: "Range", need: "textColumn", action: dlg("extractRange") },
              { id: "t.ext.before", label: "Text Before Delimiter", need: "textColumn", action: dlg("extractBefore") },
              { id: "t.ext.after", label: "Text After Delimiter", need: "textColumn", action: dlg("extractAfter") },
              { id: "t.ext.between", label: "Text Between Delimiters", need: "textColumn", action: dlg("extractBetween") },
            ],
          },
          {
            id: "t.parse",
            label: "Parse",
            need: "textColumn",
            action: { type: "none" },
            menu: [
              { id: "t.parse.json", label: "JSON", need: "textColumn", action: dlg("parseJson") },
              { id: "t.parse.xml", label: "XML", need: "textColumn", action: { type: "none" }, notImplemented: true },
            ],
          },
        ],
      },
      {
        id: "numberColumn",
        label: "Number Column",
        items: [
          {
            id: "t.round",
            label: "Rounding",
            need: "numberColumn",
            action: { type: "none" },
            menu: [
              { id: "t.round.round", label: "Round...", need: "numberColumn", action: dlg("round") },
              colFn("t.round.up", "Round Up", "Number.RoundUp", "Rounded Up", "int64"),
              colFn("t.round.down", "Round Down", "Number.RoundDown", "Rounded Down", "int64"),
            ],
          },
          { id: "t.stats", label: "Statistics", need: "numberColumn", action: { type: "none" }, menu: columnStatistics },
          {
            id: "t.standard",
            label: "Standard",
            need: "numberColumn",
            action: { type: "none" },
            menu: [colFn("t.std.abs", "Absolute Value", "Number.Abs", "Calculated Absolute Value", "number")],
          },
          {
            id: "t.info",
            label: "Information",
            need: "numberColumn",
            action: { type: "none" },
            menu: [
              colFn("t.std.even", "Is Even", "Number.IsEven", "Calculated Is Even", "logical"),
              colFn("t.std.odd", "Is Odd", "Number.IsOdd", "Calculated Is Odd", "logical"),
              colFn("t.info.sign", "Sign", "Number.Sign", "Calculated Sign", "int64"),
            ],
          },
          {
            id: "t.scientific",
            label: "Scientific",
            need: "numberColumn",
            action: { type: "none" },
            menu: [
              colFn("t.sci.sqrt", "Square Root", "Number.Sqrt", "Calculated Square Root", "number"),
              colFn("t.sci.exp", "Exponent", "Number.Exp", "Calculated Exponent", "number"),
              colFn("t.sci.ln", "Natural Logarithm", "Number.Ln", "Calculated Natural Logarithm", "number"),
              colFn("t.sci.log10", "Logarithm", "Number.Log10", "Calculated Logarithm", "number"),
              colFn("t.sci.sin", "Sine", "Number.Sin", "Calculated Sine", "number"),
              colFn("t.sci.cos", "Cosine", "Number.Cos", "Calculated Cosine", "number"),
              colFn("t.sci.tan", "Tangent", "Number.Tan", "Calculated Tangent", "number"),
            ],
          },
        ],
      },
      {
        id: "dateColumn",
        label: "Date & Time Column",
        items: [
          {
            id: "t.date",
            label: "Date",
            need: "column",
            action: { type: "none" },
            menu: [
              colFn("t.date.year", "Year", "Date.Year", "Extracted Year", "int64"),
              colFn("t.date.month", "Month", "Date.Month", "Extracted Month", "int64"),
              colFn("t.date.monthname", "Name of Month", "Date.MonthName", "Extracted Month Name", "text"),
              colFn("t.date.quarter", "Quarter of Year", "Date.Quarter", "Extracted Quarter", "int64"),
              colFn("t.date.day", "Day", "Date.Day", "Extracted Day", "int64"),
              colFn("t.date.dayofweek", "Day of Week", "Date.DayOfWeek", "Extracted Day of Week", "int64"),
              colFn("t.date.dayname", "Name of Day", "Date.DayOfWeekName", "Extracted Day Name", "text"),
              colFn("t.date.dayofyear", "Day of Year", "Date.DayOfYear", "Extracted Day of Year", "int64"),
              colFn("t.date.somonth", "Start of Month", "Date.StartOfMonth", "Calculated Start of Month", "date"),
              colFn("t.date.eomonth", "End of Month", "Date.EndOfMonth", "Calculated End of Month", "date"),
              colFn("t.date.soquarter", "Start of Quarter", "Date.StartOfQuarter", "Calculated Start of Quarter", "date"),
              colFn("t.date.eoquarter", "End of Quarter", "Date.EndOfQuarter", "Calculated End of Quarter", "date"),
              colFn("t.date.soyear", "Start of Year", "Date.StartOfYear", "Calculated Start of Year", "date"),
              colFn("t.date.eoyear", "End of Year", "Date.EndOfYear", "Calculated End of Year", "date"),
              colFn("t.date.days", "Days in Month", "Date.DaysInMonth", "Calculated Days in Month", "int64"),
            ],
          },
          {
            id: "t.time",
            label: "Time",
            need: "column",
            action: { type: "none" },
            menu: [
              colFn("t.time.hour", "Hour", "DateTime.Hour", "Extracted Hour", "int64"),
              colFn("t.time.minute", "Minute", "DateTime.Minute", "Extracted Minute", "int64"),
              colFn("t.time.second", "Second", "DateTime.Second", "Extracted Second", "int64"),
            ],
          },
          todo("t.duration", "Duration", "column"),
        ],
      },
    ],
  },
  {
    id: "addColumn",
    label: "Add Column",
    groups: [
      {
        id: "general",
        label: "General",
        items: [
          { id: "a.examples", label: "Column From Examples", need: "table", action: { type: "ui", what: "examples" } },
          { id: "a.custom", label: "Custom Column", need: "table", action: dlg("custom") },
          todo("a.function", "Invoke Custom Function", "table"),
          { id: "a.conditional", label: "Conditional Column", need: "table", action: dlg("conditional") },
          {
            id: "a.index",
            label: "Index Column",
            need: "table",
            action: { type: "none" },
            menu: [
              { id: "a.index0", label: "From 0", need: "table", action: tf(() => ({ kind: "addIndexColumn", name: "Index", start: 0, step: 1 })) },
              { id: "a.index1", label: "From 1", need: "table", action: tf(() => ({ kind: "addIndexColumn", name: "Index", start: 1, step: 1 })) },
              { id: "a.indexN", label: "Custom...", need: "table", action: dlg("indexCustom") },
            ],
          },
          {
            id: "a.dup",
            label: "Duplicate Column",
            need: "column",
            action: tf((c) => ({ kind: "duplicateColumn", column: c.selected[0], newName: `${c.selected[0]} - Copy` })),
          },
        ],
      },
      {
        id: "fromText",
        label: "From Text",
        items: [
          { id: "a.length", label: "Length", need: "textColumn", action: tf((c) => ({ kind: "addCustomColumn", name: "Length", formula: `Text.Length([${c.selected[0]}])`, valueType: "int64" })) },
          todo("a.textformat", "Format", "textColumn"),
          todo("a.textextract", "Extract", "textColumn"),
        ],
      },
      {
        id: "fromNumber",
        label: "From Number",
        items: [{ id: "a.numstats", label: "Statistics", need: "columns", action: { type: "none" }, menu: rowStatistics }, todo("a.numstandard", "Standard", "numberColumn")],
      },
      {
        id: "fromDate",
        label: "From Date & Time",
        items: [
          { id: "a.year", label: "Year", need: "column", action: tf((c) => ({ kind: "addCustomColumn", name: "Year", formula: `Date.Year([${c.selected[0]}])`, valueType: "int64" })) },
          { id: "a.month", label: "Month", need: "column", action: tf((c) => ({ kind: "addCustomColumn", name: "Month", formula: `Date.Month([${c.selected[0]}])`, valueType: "int64" })) },
          { id: "a.day", label: "Day", need: "column", action: tf((c) => ({ kind: "addCustomColumn", name: "Day", formula: `Date.Day([${c.selected[0]}])`, valueType: "int64" })) },
          { id: "a.quarter", label: "Quarter", need: "column", action: tf((c) => ({ kind: "addCustomColumn", name: "Quarter", formula: `Date.Quarter([${c.selected[0]}])`, valueType: "int64" })) },
          { id: "a.somd", label: "Start of Month", need: "column", action: tf((c) => ({ kind: "addCustomColumn", name: "Start of Month", formula: `Date.StartOfMonth([${c.selected[0]}])`, valueType: "date" })) },
        ],
      },
    ],
  },
  {
    id: "view",
    label: "View",
    groups: [
      {
        id: "layout",
        label: "Layout",
        items: [
          { id: "v.settings", label: "Query Settings", need: "none", action: { type: "ui", what: "settings" } },
          { id: "v.formula", label: "Formula Bar", need: "none", action: { type: "ui", what: "formulaBar" } },
        ],
      },
      {
        id: "dataPreview",
        label: "Data Preview",
        items: [
          { id: "v.quality", label: "Column quality", need: "none", action: { type: "ui", what: "quality" } },
          { id: "v.distribution", label: "Column distribution", need: "none", action: { type: "ui", what: "distribution" } },
          { id: "v.profile", label: "Column profile", need: "none", action: { type: "ui", what: "profile" } },
        ],
      },
      {
        id: "advanced",
        label: "Advanced",
        items: [
          { id: "v.advanced", label: "Advanced Editor", need: "none", action: { type: "ui", what: "advanced" } },
          { id: "v.deps", label: "Query Dependencies", need: "none", action: { type: "ui", what: "dependencies" } },
        ],
      },
    ],
  },
];

/** Whether a button can be used now, and why not. */
export function itemState(item: RibbonItem, c: RibbonContext): { enabled: boolean; reason?: string } {
  if (item.notImplemented) return { enabled: false, reason: "Not implemented in BIForge yet." };
  if (item.menu && item.action.type === "none") {
    return item.menu.some((m) => itemState(m, c).enabled) ? { enabled: true } : { enabled: false, reason: reasonFor(item.need ?? "table", c) ?? "Not available now." };
  }
  const need = item.need ?? "table";
  const reason = reasonFor(need, c);
  if (reason) return { enabled: false, reason };
  if (item.action.type === "command" || item.action.type === "ui") return { enabled: true };
  if (!c.hasQuery) return { enabled: false, reason: "Select a query first." };
  return { enabled: true };
}

function reasonFor(need: Need, c: RibbonContext): string | undefined {
  if (need === "none") return undefined;
  if (need === "parameter") return c.parameter ? undefined : "Select a parameter in the Queries pane.";
  if (!c.hasQuery) return "Select a query first.";
  if (!c.hasTable) return "The selected step is not a table (or has an error).";
  if (need === "table") return undefined;
  const sel = c.columns.filter((x) => c.selected.includes(x.name));
  if (sel.length === 0) return "Select a column first.";
  if (need === "column" && sel.length > 1) return "Select a single column.";
  if (need === "textColumn" && !sel.every((x) => isTextType(x.duckdbType))) return "Select a text column.";
  if (need === "numberColumn" && !sel.every((x) => valueTypeOf(x.duckdbType) === "number")) return "Select a number column.";
  return undefined;
}
