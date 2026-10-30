// The forms of the Power Query editor as data: fields to show and a builder that turns the values into a transform
// or a command. No React here, so every dialog's output can be tested.
import type { ArithOp, StepColumn, Transform, DataTypeName, Condition, FilterOp } from "./types";
import { m_text } from "./mText";
import { PARAMETER_TYPES, parameterText, type ParameterDef, type ParameterType } from "./parameters";

export type Values = Record<string, unknown>;
export interface Option {
  value: string;
  label: string;
}

export type Field =
  | { kind: "text"; key: string; label: string; placeholder?: string; default?: string }
  | { kind: "number"; key: string; label: string; default?: number; min?: number }
  | { kind: "select"; key: string; label: string; options: Option[] | ((v: Values) => Option[]); default?: string }
  | { kind: "multi"; key: string; label: string; options: Option[]; default?: string[] }
  | { kind: "textarea"; key: string; label: string; rows?: number; default?: string; placeholder?: string }
  | { kind: "check"; key: string; label: string; default?: boolean }
  | { kind: "file"; key: string; label: string; extensions: string[]; name: string }
  | { kind: "folder"; key: string; label: string }
  | { kind: "rows"; key: string; label: string; addLabel: string; fields: Field[]; min?: number; defaultRows?: Values[] };

export type DialogAction = { transform: Transform } | { command: string; args: unknown };

export interface DialogDef {
  title: string;
  submitLabel: string;
  fields: Field[];
  build(values: Values): DialogAction;
}

export interface DialogContext {
  columns: StepColumn[];
  /** Names of the selected columns, in table order. */
  selected: string[];
  /** The query being edited. */
  query: string;
  /** Names of the other queries and their column names (for merge and append). */
  queries: string[];
  queryColumns: Record<string, string[]>;
  /** Sheet names of the workbook chosen in the new-Excel dialog. */
  sheets?: string[];
  /** The selected query when it is a parameter. */
  parameter?: { name: string; def: ParameterDef } | null;
  /** The query groups and the group of the selected query. */
  groups?: string[];
  group?: string | null;
}

export type DialogKind =
  | "filter" | "keepTop" | "keepBottom" | "keepRange" | "removeTop" | "removeBottom" | "replace" | "split" | "group" | "merge"
  | "append" | "conditional" | "custom" | "chooseColumns" | "pivot" | "round" | "rename" | "newCsv" | "newExcel" | "newFolder"
  | "enterData" | "customStep" | "indexCustom" | "removeAlt" | "mergeColumns" | "extractFirst" | "extractLast" | "extractRange"
  | "extractBefore" | "extractAfter" | "extractBetween" | "replaceErrors" | "newParameter" | "editParameter"
  | "parseJson" | "newGroup" | "moveToGroup" | "renameGroup" | "deleteGroup" | "addPrefix" | "addSuffix" | ArithDialog | ArithNewDialog;

/** The Standard operations of the Transform tab (in place) and of the Add Column tab (a new column). */
export type ArithDialog = `arith.${ArithOp}`;
export type ArithNewDialog = `arithNew.${ArithOp}`;

export const ARITH_LABELS: Record<ArithOp, { title: string; operand: string; symbol: string; column: string }> = {
  add: { title: "Add", operand: "Value to add", symbol: "+", column: "Addition" },
  subtract: { title: "Subtract", operand: "Value to subtract", symbol: "-", column: "Subtraction" },
  multiply: { title: "Multiply", operand: "Value to multiply by", symbol: "*", column: "Multiplication" },
  divide: { title: "Divide", operand: "Value to divide by", symbol: "/", column: "Division" },
  integerDivide: { title: "Integer-Divide", operand: "Value to divide by", symbol: "div", column: "Integer-division" },
  modulo: { title: "Modulo", operand: "Value to divide by", symbol: "mod", column: "Modulo" },
  power: { title: "Power", operand: "Exponent", symbol: "^", column: "Power" },
  percentage: { title: "Percentage", operand: "Percent", symbol: "%", column: "Percentage" },
  percentOf: { title: "Percent Of", operand: "Total", symbol: "%of", column: "Percent Of" },
};

/** The M formula of a Standard operation on a column, for a new column. */
export function arithFormula(op: ArithOp, column: string, n: number): string {
  const x = `[${column}]`;
  const v = n < 0 ? `(${n})` : String(n);
  switch (op) {
    case "add": return `${x} + ${v}`;
    case "subtract": return `${x} - ${v}`;
    case "multiply": return `${x} * ${v}`;
    case "divide": return `${x} / ${v}`;
    case "integerDivide": return `Number.IntegerDivide(${x}, ${v})`;
    case "modulo": return `Number.Mod(${x}, ${v})`;
    case "power": return `Number.Power(${x}, ${v})`;
    case "percentage": return `${x} * ${v} / 100`;
    case "percentOf": return `${x} / ${v} * 100`;
  }
}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL)/i;

export function valueTypeOf(duckdbType: string): "text" | "number" | "date" | "logical" {
  if (NUMERIC.test(duckdbType)) return "number";
  if (/^(DATE|TIMESTAMP)/i.test(duckdbType)) return "date";
  if (/^BOOLEAN$/i.test(duckdbType)) return "logical";
  return "text";
}

export function isTextType(duckdbType: string): boolean {
  return /^VARCHAR$/i.test(duckdbType);
}

/** The M data type menu entries of the ribbon. */
export const DATA_TYPES: { type: DataTypeName; label: string }[] = [
  { type: "decimal", label: "Fixed decimal number" },
  { type: "number", label: "Decimal number" },
  { type: "int64", label: "Whole number" },
  { type: "percentage", label: "Percentage" },
  { type: "datetime", label: "Date/Time" },
  { type: "date", label: "Date" },
  { type: "time", label: "Time" },
  { type: "text", label: "Text" },
  { type: "logical", label: "True/False" },
];

export function typeLabelOf(duckdbType: string): string {
  const u = duckdbType.toUpperCase();
  if (u === "VARCHAR") return "Text";
  if (u === "DATE") return "Date";
  if (u.startsWith("TIMESTAMP")) return "Date/Time";
  if (u === "TIME") return "Time";
  if (u === "BOOLEAN") return "True/False";
  if (u.startsWith("DECIMAL")) return "Fixed decimal number";
  if (u === "DOUBLE" || u === "FLOAT") return "Decimal number";
  if (NUMERIC.test(u)) return "Whole number";
  return "Any";
}

const OPS: { value: FilterOp; label: string; text?: boolean; noValue?: boolean }[] = [
  { value: "eq", label: "equals" },
  { value: "ne", label: "does not equal" },
  { value: "gt", label: "is greater than" },
  { value: "ge", label: "is greater than or equal to" },
  { value: "lt", label: "is less than" },
  { value: "le", label: "is less than or equal to" },
  { value: "contains", label: "contains", text: true },
  { value: "notContains", label: "does not contain", text: true },
  { value: "startsWith", label: "begins with", text: true },
  { value: "endsWith", label: "ends with", text: true },
  { value: "isNull", label: "is null", noValue: true },
  { value: "isNotNull", label: "is not null", noValue: true },
];
const opOptions: Option[] = OPS.map((o) => ({ value: o.value, label: o.label }));

function colOptions(c: DialogContext): Option[] {
  return c.columns.map((x) => ({ value: x.name, label: x.name }));
}

function typeOfColumn(c: DialogContext, name: string): string {
  return c.columns.find((x) => x.name === name)?.duckdbType ?? "VARCHAR";
}

function need(v: unknown, what: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new Error(`${what} is required.`);
  return s;
}

function count(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a whole number of at least 0.`);
  return n;
}

function condition(c: DialogContext, v: Values, what = "condition"): Condition {
  const column = need(v.column, "The column");
  const op = (v.op as FilterOp) ?? "eq";
  const info = OPS.find((o) => o.value === op);
  if (!info) throw new Error(`Unknown operator for the ${what}.`);
  if (info.noValue) return { column, op };
  const raw = typeof v.value === "string" ? v.value : String(v.value ?? "");
  const vt = info.text ? "text" : valueTypeOf(typeOfColumn(c, column));
  if (raw.trim() === "" && vt !== "text") throw new Error(`The ${what} on "${column}" needs a value.`);
  if (vt === "number" && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw.trim())) throw new Error(`"${raw}" is not a number (column "${column}").`);
  if (vt === "date" && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw.trim())) throw new Error(`"${raw}" is not a date; write it as yyyy-mm-dd (column "${column}").`);
  if (vt === "logical" && !/^(true|false)$/i.test(raw.trim())) throw new Error(`"${raw}" is not true or false (column "${column}").`);
  return { column, op, value: vt === "text" ? raw : raw.trim(), valueType: vt };
}

const looksNumeric = (s: string) => /^-?\d+(\.\d+)?$/.test(s.trim());

const csvName = (path: string) => path.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]*$/, "") || "Query";

/** The M of a query that reads a CSV/text file (steps as Power Query writes them). */
export function csvQueryText(path: string, delimiter: string): string {
  return `let\n    Source = Csv.Document(File.Contents(${m_text(path)}), [Delimiter=${m_text(delimiter)}, Encoding=65001, QuoteStyle=QuoteStyle.Csv]),\n    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true])\nin\n    #"Promoted Headers"`;
}

export function excelQueryText(path: string, sheet: string): string {
  return `let\n    Source = Excel.Workbook(File.Contents(${m_text(path)}), true, true),\n    ${quoteName(sheet + "_Sheet")} = Source{[Item=${m_text(sheet)},Kind="Sheet"]}[Data]\nin\n    ${quoteName(sheet + "_Sheet")}`;
}

function quoteName(n: string): string {
  return `#"${n.replace(/"/g, '""')}"`;
}

/** `#table` M for rows typed or pasted into Enter Data: the first line holds the column names. */
export function enterDataText(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("Type or paste at least a row of column names.");
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const cells = lines.map((l) => l.split(sep).map((c) => c.trim()));
  const names = cells[0];
  if (names.some((n) => n === "")) throw new Error("Every column needs a name in the first line.");
  if (new Set(names).size !== names.length) throw new Error("Column names must be different.");
  const rows = cells.slice(1).map((r) => {
    if (r.length > names.length) throw new Error("A row has more values than there are column names.");
    return `{${names.map((_, i) => (r[i] === undefined || r[i] === "" ? "null" : m_text(r[i]))).join(", ")}}`;
  });
  return `let\n    Source = #table({${names.map(m_text).join(", ")}}, {${rows.join(", ")}})\nin\n    Source`;
}

export function dialogFor(kind: DialogKind, c: DialogContext): DialogDef {
  const cols = colOptions(c);
  const first = c.selected[0] ?? c.columns[0]?.name ?? "";
  if (kind.startsWith("arith.") || kind.startsWith("arithNew.")) {
    const inPlace = kind.startsWith("arith.");
    const op = kind.slice(kind.indexOf(".") + 1) as ArithOp;
    const lab = ARITH_LABELS[op];
    return {
      title: inPlace ? lab.title : `Add Column: ${lab.title}`,
      submitLabel: "OK",
      fields: [{ kind: "number", key: "operand", label: lab.operand, default: op === "percentage" || op === "percentOf" ? 100 : op === "power" ? 2 : 1 }],
      build: (v) => {
        const operand = Number(v.operand);
        if (v.operand === "" || v.operand === undefined || !Number.isFinite(operand)) throw new Error(`${lab.operand} must be a number.`);
        if ((op === "divide" || op === "integerDivide" || op === "modulo" || op === "percentOf") && operand === 0) throw new Error("Cannot divide by zero.");
        if (inPlace) return { transform: { kind: "arithmetic", columns: c.selected, op, operand } };
        let name = lab.column;
        for (let i = 2; c.columns.some((x) => x.name === name); i++) name = `${lab.column} ${i}`;
        return { transform: { kind: "addCustomColumn", name, formula: arithFormula(op, first, operand), valueType: "number" } };
      },
    };
  }
  switch (kind) {
    case "addPrefix":
    case "addSuffix":
      return {
        title: kind === "addPrefix" ? "Add Prefix" : "Add Suffix",
        submitLabel: "OK",
        fields: [{ kind: "text", key: "text", label: kind === "addPrefix" ? "Prefix" : "Suffix", default: "" }],
        build: (v) => {
          const text = typeof v.text === "string" ? v.text : "";
          if (!text) throw new Error(`The ${kind === "addPrefix" ? "prefix" : "suffix"} is required.`);
          return { transform: { kind: "textAffix", columns: c.selected, ...(kind === "addPrefix" ? { prefix: text } : { suffix: text }) } };
        },
      };
    case "filter":
      return {
        title: "Filter Rows",
        submitLabel: "OK",
        fields: [
          { kind: "select", key: "combine", label: "Keep rows where", options: [{ value: "and", label: "all conditions are true" }, { value: "or", label: "any condition is true" }], default: "and" },
          {
            kind: "rows",
            key: "conditions",
            label: "Conditions",
            addLabel: "Add condition",
            min: 1,
            defaultRows: [{ column: first, op: "eq", value: "" }],
            fields: [
              { kind: "select", key: "column", label: "Column", options: cols, default: first },
              { kind: "select", key: "op", label: "Operator", options: opOptions, default: "eq" },
              { kind: "text", key: "value", label: "Value" },
            ],
          },
        ],
        build: (v) => ({
          transform: { kind: "filterRows", combine: v.combine === "or" ? "or" : "and", conditions: (v.conditions as Values[]).map((r) => condition(c, r)) },
        }),
      };
    case "keepTop":
    case "keepBottom":
    case "removeTop":
    case "removeBottom": {
      const titles = { keepTop: "Keep Top Rows", keepBottom: "Keep Bottom Rows", removeTop: "Remove Top Rows", removeBottom: "Remove Bottom Rows" } as const;
      const kinds = { keepTop: "keepTopRows", keepBottom: "keepBottomRows", removeTop: "removeTopRows", removeBottom: "removeBottomRows" } as const;
      return {
        title: titles[kind],
        submitLabel: "OK",
        fields: [{ kind: "number", key: "count", label: "Number of rows", default: 10, min: 0 }],
        build: (v) => ({ transform: { kind: kinds[kind], count: count(v.count, "The number of rows") } }),
      };
    }
    case "keepRange":
      return {
        title: "Keep Range of Rows",
        submitLabel: "OK",
        fields: [
          { kind: "number", key: "first", label: "First row", default: 1, min: 1 },
          { kind: "number", key: "count", label: "Number of rows", default: 10, min: 0 },
        ],
        build: (v) => {
          const f = count(v.first, "The first row");
          if (f < 1) throw new Error("The first row must be at least 1.");
          return { transform: { kind: "keepRange", offset: f - 1, count: count(v.count, "The number of rows") } };
        },
      };
    case "replace":
      return {
        title: "Replace Values",
        submitLabel: "OK",
        fields: [
          { kind: "multi", key: "columns", label: "In columns", options: cols, default: c.selected.length ? c.selected : first ? [first] : [] },
          { kind: "check", key: "findNull", label: "Value to find is null" },
          { kind: "text", key: "find", label: "Value to find" },
          { kind: "text", key: "replace", label: "Replace with" },
          { kind: "check", key: "entire", label: "Match entire cell contents", default: true },
        ],
        build: (v) => {
          const columns = (v.columns as string[]) ?? [];
          if (!columns.length) throw new Error("Choose at least one column.");
          const numeric = columns.every((n) => valueTypeOf(typeOfColumn(c, n)) === "number");
          const find = v.findNull ? null : String(v.find ?? "");
          if (find === "" && !v.findNull) throw new Error("Enter the value to find (or tick \"Value to find is null\").");
          const rep = String(v.replace ?? "");
          if (numeric) {
            if ((find !== null && !looksNumeric(find)) || !(rep === "" ? false : looksNumeric(rep))) throw new Error("These columns hold numbers: the value to find and the replacement must be numbers.");
            return { transform: { kind: "replaceValues", columns, find: find === null ? null : Number(find), replace: Number(rep), mode: "value", valueType: "number" } };
          }
          return { transform: { kind: "replaceValues", columns, find, replace: rep, mode: v.entire || find === null ? "value" : "text" } };
        },
      };
    case "newParameter":
    case "editParameter": {
      const editing = kind === "editParameter";
      if (editing && !c.parameter) throw new Error("Select a parameter in the Queries pane first.");
      const p = editing ? c.parameter!.def : null;
      return {
        title: editing ? "Edit Parameter" : "New Parameter",
        submitLabel: "OK",
        fields: [
          { kind: "text", key: "name", label: "Name", default: editing ? c.parameter!.name : "Parameter1" },
          { kind: "text", key: "description", label: "Description", default: p?.description ?? "" },
          { kind: "check", key: "required", label: "Required", default: p?.required ?? true },
          { kind: "select", key: "type", label: "Type", options: PARAMETER_TYPES.map((t) => ({ value: t.type, label: t.label })), default: p?.type ?? "Text" },
          {
            kind: "select",
            key: "suggested",
            label: "Suggested Values",
            options: [
              { value: "any", label: "Any value" },
              { value: "list", label: "List of values" },
            ],
            default: p && p.list.length ? "list" : "any",
          },
          { kind: "textarea", key: "list", label: "List of values (one per line)", rows: 4, default: p?.list.join("\n") ?? "" },
          { kind: "text", key: "defaultValue", label: "Default Value", default: p?.defaultValue ?? "" },
          { kind: "text", key: "current", label: "Current Value", default: p?.current ?? "" },
        ],
        build: (v) => {
          const name = String(v.name ?? "").trim();
          if (!name) throw new Error("Enter a name for the parameter.");
          if (editing && name !== c.parameter!.name) throw new Error("Rename the parameter in the Queries pane.");
          if (!editing && c.queries.concat(c.query).some((q) => q.toLowerCase() === name.toLowerCase())) throw new Error(`A query named "${name}" already exists.`);
          const list = v.suggested === "list" ? String(v.list ?? "").split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== "") : [];
          if (v.suggested === "list" && list.length === 0) throw new Error("Enter at least one suggested value.");
          const def: ParameterDef = {
            description: String(v.description ?? ""),
            required: !!v.required,
            type: String(v.type ?? "Text") as ParameterType,
            list,
            defaultValue: String(v.defaultValue ?? ""),
            current: String(v.current ?? ""),
          };
          parameterText(def); // validates the values against the type
          if (list.length && !list.includes(def.current)) throw new Error("The current value must be one of the suggested values.");
          if (list.length && def.defaultValue && !list.includes(def.defaultValue)) throw new Error("The default value must be one of the suggested values.");
          return { command: "query.setParameter", args: { name, def } };
        },
      };
    }
    case "parseJson": {
      const textCols = c.columns.filter((x) => valueTypeOf(x.duckdbType) === "text").map((x) => ({ value: x.name, label: x.name }));
      if (!textCols.length) throw new Error("The table has no text column to parse.");
      return {
        title: "Parse JSON",
        submitLabel: "OK",
        fields: [
          { kind: "select", key: "column", label: "Column with JSON text", options: textCols, default: c.selected.find((s) => textCols.some((t) => t.value === s)) ?? textCols[0].value },
          { kind: "textarea", key: "fields", label: "Fields to read (one per line; address.city reaches a nested field)", rows: 5 },
        ],
        build: (v) => {
          const fields = String(v.fields ?? "").split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== "");
          if (!fields.length) throw new Error("Name at least one field to read from the JSON.");
          return { transform: { kind: "parseJson", column: String(v.column ?? ""), fields } };
        },
      };
    }
    case "newGroup":
      return {
        title: "New Group",
        submitLabel: "OK",
        fields: [{ kind: "text", key: "name", label: "Name" }],
        build: (v) => ({ command: "query.group.add", args: { name: String(v.name ?? ""), query: c.query || undefined } }),
      };
    case "moveToGroup": {
      const groups = c.groups ?? [];
      if (!groups.length) throw new Error("There are no groups yet. Create a group first.");
      return {
        title: "Move to Group",
        submitLabel: "OK",
        fields: [{ kind: "select", key: "group", label: "Group", options: groups.map((g) => ({ value: g, label: g })), default: c.group && groups.includes(c.group) ? c.group : groups[0] }],
        build: (v) => ({ command: "query.setGroup", args: { query: c.query, group: String(v.group ?? "") } }),
      };
    }
    case "renameGroup": {
      const groups = c.groups ?? [];
      if (!groups.length) throw new Error("There are no groups to rename.");
      return {
        title: "Rename Group",
        submitLabel: "OK",
        fields: [
          { kind: "select", key: "group", label: "Group", options: groups.map((g) => ({ value: g, label: g })), default: c.group && groups.includes(c.group) ? c.group : groups[0] },
          { kind: "text", key: "name", label: "New name" },
        ],
        build: (v) => ({ command: "query.group.rename", args: { old: String(v.group ?? ""), to: String(v.name ?? "") } }),
      };
    }
    case "deleteGroup": {
      const groups = c.groups ?? [];
      if (!groups.length) throw new Error("There are no groups to delete.");
      return {
        title: "Delete Group",
        submitLabel: "Delete",
        fields: [{ kind: "select", key: "group", label: "Group (its queries are kept, ungrouped)", options: groups.map((g) => ({ value: g, label: g })), default: c.group && groups.includes(c.group) ? c.group : groups[0] }],
        build: (v) => ({ command: "query.group.remove", args: { name: String(v.group ?? "") } }),
      };
    }
    case "replaceErrors":
      return {
        title: "Replace Errors",
        submitLabel: "OK",
        fields: [
          { kind: "multi", key: "columns", label: "In columns", options: cols, default: c.selected.length ? c.selected : first ? [first] : [] },
          { kind: "check", key: "asNull", label: "Replace errors with null" },
          { kind: "text", key: "value", label: "Value" },
        ],
        build: (v) => {
          const columns = (v.columns as string[]) ?? [];
          if (!columns.length) throw new Error("Choose at least one column.");
          if (v.asNull) return { transform: { kind: "replaceErrors", columns, value: null } };
          const text = String(v.value ?? "");
          if (columns.every((n) => valueTypeOf(typeOfColumn(c, n)) === "number")) {
            if (!looksNumeric(text)) throw new Error("These columns hold numbers: the replacement must be a number.");
            return { transform: { kind: "replaceErrors", columns, value: Number(text), valueType: "number" } };
          }
          return { transform: { kind: "replaceErrors", columns, value: text, valueType: "text" } };
        },
      };
    case "split":
      return {
        title: "Split Column",
        submitLabel: "OK",
        fields: [
          { kind: "select", key: "column", label: "Column", options: cols, default: first },
          {
            kind: "select",
            key: "by",
            label: "Split by",
            options: [
              { value: "delimiter", label: "Delimiter" },
              { value: "positions", label: "Positions" },
              { value: "lengths", label: "Lengths" },
              { value: "repeatedLength", label: "Number of characters (repeatedly)" },
            ],
            default: "delimiter",
          },
          { kind: "text", key: "delimiter", label: "Delimiter", default: "," },
          { kind: "text", key: "list", label: "Positions or lengths (comma separated)", placeholder: "0, 3, 6" },
          { kind: "number", key: "length", label: "Number of characters", default: 3, min: 1 },
          { kind: "number", key: "count", label: "Number of new columns", default: 2, min: 1 },
        ],
        build: (v) => {
          const column = need(v.column, "The column");
          const by = (v.by as "delimiter" | "positions" | "lengths" | "repeatedLength") ?? "delimiter";
          const n = count(v.count, "The number of new columns");
          if (n < 1) throw new Error("A column must be split into at least one column.");
          const list = String(v.list ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
          if (by === "delimiter") return { transform: { kind: "splitColumn", column, by, delimiter: String(v.delimiter ?? ""), count: n } };
          if (by === "repeatedLength") return { transform: { kind: "splitColumn", column, by, length: count(v.length, "The number of characters"), count: n } };
          if (list.length === 0 || list.some((x) => !Number.isInteger(x) || x < 0)) throw new Error("Enter whole numbers separated by commas.");
          return { transform: { kind: "splitColumn", column, by, ...(by === "positions" ? { positions: list } : { lengths: list }), count: Math.max(n, by === "positions" ? list.length : list.length) } };
        },
      };
    case "group": {
      const aggOps: Option[] = [
        { value: "sum", label: "Sum" },
        { value: "average", label: "Average" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
        { value: "median", label: "Median" },
        { value: "count", label: "Count" },
        { value: "countDistinct", label: "Count Distinct" },
        { value: "countRows", label: "Count Rows" },
      ];
      return {
        title: "Group By",
        submitLabel: "OK",
        fields: [
          { kind: "multi", key: "keys", label: "Group by", options: cols, default: c.selected },
          {
            kind: "rows",
            key: "aggregates",
            label: "Aggregations",
            addLabel: "Add aggregation",
            min: 1,
            defaultRows: [{ name: "Count", op: "countRows", column: "" }],
            fields: [
              { kind: "text", key: "name", label: "New column name" },
              { kind: "select", key: "op", label: "Operation", options: aggOps, default: "countRows" },
              { kind: "select", key: "column", label: "Column", options: [{ value: "", label: "(none)" }, ...cols], default: "" },
            ],
          },
        ],
        build: (v) => {
          const keys = (v.keys as string[]) ?? [];
          const aggregates = (v.aggregates as Values[]).map((r) => {
            const name = need(r.name, "Each aggregation needs a new column name; it");
            const op = r.op as "sum";
            const column = String(r.column ?? "");
            if (op !== ("countRows" as string) && !column) throw new Error(`The aggregation "${name}" needs a column.`);
            return op === ("countRows" as string) ? { name, op } : { name, op, column };
          });
          const names = [...keys, ...aggregates.map((a) => a.name)];
          if (new Set(names).size !== names.length) throw new Error("The new column names must differ from each other and from the grouping columns.");
          return { transform: { kind: "groupBy", keys, aggregates } };
        },
      };
    }
    case "merge": {
      const joinKinds: Option[] = [
        { value: "leftOuter", label: "Left outer (all from first, matching from second)" },
        { value: "rightOuter", label: "Right outer (all from second, matching from first)" },
        { value: "fullOuter", label: "Full outer (all rows from both)" },
        { value: "inner", label: "Inner (only matching rows)" },
        { value: "leftAnti", label: "Left anti (rows only in first)" },
      ];
      return {
        title: "Merge Queries",
        submitLabel: "OK",
        fields: [
          { kind: "select", key: "right", label: "Second query", options: c.queries.map((q) => ({ value: q, label: q })), default: c.queries[0] ?? "" },
          { kind: "select", key: "leftKey", label: `Matching column in ${c.query}`, options: cols, default: first },
          {
            kind: "select",
            key: "rightKey",
            label: "Matching column in the second query",
            options: (v) => (c.queryColumns[String(v.right ?? c.queries[0] ?? "")] ?? []).map((n) => ({ value: n, label: n })),
          },
          { kind: "select", key: "joinKind", label: "Join kind", options: joinKinds, default: "leftOuter" },
          { kind: "check", key: "expand", label: "Expand the columns of the second query", default: true },
        ],
        build: (v) => {
          const right = need(v.right, "The second query");
          const leftKey = need(v.leftKey, "The matching column of the first query");
          const rightKey = need(v.rightKey, "The matching column of the second query");
          const rightCols = c.queryColumns[right] ?? [];
          const expand = v.expand
            ? rightCols.filter((n) => n !== rightKey || true).map((n) => ({ name: n, newName: c.columns.some((x) => x.name === n) ? `${right}.${n}` : n }))
            : [];
          return { transform: { kind: "merge", right, leftKeys: [leftKey], rightKeys: [rightKey], joinKind: (v.joinKind as "inner") ?? "leftOuter", newColumn: right, expand } };
        },
      };
    }
    case "append":
      return {
        title: "Append Queries",
        submitLabel: "OK",
        fields: [{ kind: "multi", key: "queries", label: "Queries to add to the end of this one", options: c.queries.map((q) => ({ value: q, label: q })) }],
        build: (v) => {
          const queries = (v.queries as string[]) ?? [];
          if (!queries.length) throw new Error("Choose at least one query.");
          return { transform: { kind: "append", queries } };
        },
      };
    case "conditional":
      return {
        title: "Add Conditional Column",
        submitLabel: "OK",
        fields: [
          { kind: "text", key: "name", label: "New column name", default: "Custom" },
          {
            kind: "rows",
            key: "clauses",
            label: "If / else if",
            addLabel: "Add clause",
            min: 1,
            defaultRows: [{ column: first, op: "eq", value: "", result: "" }],
            fields: [
              { kind: "select", key: "column", label: "Column", options: cols, default: first },
              { kind: "select", key: "op", label: "Operator", options: opOptions, default: "eq" },
              { kind: "text", key: "value", label: "Value" },
              { kind: "text", key: "result", label: "Then" },
            ],
          },
          { kind: "text", key: "otherwise", label: "Otherwise", default: "" },
        ],
        build: (v) => {
          const lit = (s: unknown) => {
            const t = String(s ?? "");
            return looksNumeric(t) ? { value: Number(t), type: "number" as const } : { value: t, type: "text" as const };
          };
          const name = need(v.name, "The column name");
          if (c.columns.some((x) => x.name === name)) throw new Error(`The column "${name}" already exists.`);
          const clauses = (v.clauses as Values[]).map((r) => {
            const res = lit(r.result);
            return { condition: condition(c, r, "clause"), result: res.value, resultType: res.type };
          });
          const other = String(v.otherwise ?? "") === "" ? { value: null, type: undefined } : lit(v.otherwise);
          return { transform: { kind: "addConditionalColumn", name, clauses, elseValue: other.value, ...(other.type ? { elseType: other.type } : {}) } };
        },
      };
    case "custom":
      return {
        title: "Custom Column",
        submitLabel: "OK",
        fields: [
          { kind: "text", key: "name", label: "New column name", default: "Custom" },
          { kind: "textarea", key: "formula", label: "Custom column formula  (use [Column] to refer to a column)", rows: 4, default: "" },
        ],
        build: (v) => {
          const name = need(v.name, "The column name");
          if (c.columns.some((x) => x.name === name)) throw new Error(`The column "${name}" already exists.`);
          return { transform: { kind: "addCustomColumn", name, formula: need(v.formula, "The formula") } };
        },
      };
    case "chooseColumns":
      return {
        title: "Choose Columns",
        submitLabel: "OK",
        fields: [{ kind: "multi", key: "columns", label: "Columns to keep", options: cols, default: c.columns.map((x) => x.name) }],
        build: (v) => {
          const keep = new Set((v.columns as string[]) ?? []);
          if (keep.size === 0) throw new Error("Choose at least one column.");
          return { transform: { kind: "keepColumns", columns: c.columns.map((x) => x.name).filter((n) => keep.has(n)) } };
        },
      };
    case "pivot":
      return {
        title: "Pivot Column",
        submitLabel: "OK",
        fields: [
          { kind: "select", key: "attribute", label: "Column whose values become the new columns", options: cols, default: first },
          { kind: "select", key: "value", label: "Values column", options: cols, default: c.columns.find((x) => x.name !== first && valueTypeOf(x.duckdbType) === "number")?.name ?? c.columns.find((x) => x.name !== first)?.name ?? "" },
          { kind: "select", key: "aggregate", label: "Aggregate value function", options: [{ value: "sum", label: "Sum" }, { value: "count", label: "Count (all)" }, { value: "min", label: "Minimum" }, { value: "max", label: "Maximum" }, { value: "average", label: "Average" }, { value: "none", label: "Don't aggregate" }], default: "sum" },
        ],
        build: (v) => {
          const attribute = need(v.attribute, "The column to pivot");
          const value = need(v.value, "The values column");
          if (attribute === value) throw new Error("The pivoted column and the values column must be different.");
          return { transform: { kind: "pivot", attribute, value, attributeIsText: isTextType(typeOfColumn(c, attribute)), aggregate: (v.aggregate as "sum") ?? "sum" } };
        },
      };
    case "round":
      return {
        title: "Round",
        submitLabel: "OK",
        fields: [
          { kind: "multi", key: "columns", label: "Columns", options: cols, default: c.selected },
          { kind: "number", key: "digits", label: "Decimal places", default: 0 },
        ],
        build: (v) => {
          const columns = (v.columns as string[]) ?? [];
          if (!columns.length) throw new Error("Choose at least one column.");
          return { transform: { kind: "round", columns, digits: Number(v.digits ?? 0) } };
        },
      };
    case "removeAlt":
      return {
        title: "Remove Alternate Rows",
        submitLabel: "OK",
        fields: [
          { kind: "number", key: "first", label: "First row to remove", default: 1, min: 1 },
          { kind: "number", key: "remove", label: "Number of rows to remove", default: 1, min: 1 },
          { kind: "number", key: "keep", label: "Number of rows to keep", default: 1, min: 1 },
        ],
        build: (v) => {
          const first = count(v.first, "The first row to remove");
          if (first < 1) throw new Error("The first row to remove must be at least 1.");
          return { transform: { kind: "removeAlternateRows", offset: first - 1, remove: count(v.remove, "The number of rows to remove"), keep: count(v.keep, "The number of rows to keep") } };
        },
      };
    case "mergeColumns":
      return {
        title: "Merge Columns",
        submitLabel: "OK",
        fields: [
          { kind: "multi", key: "columns", label: "Columns to merge", options: cols, default: c.selected },
          { kind: "select", key: "separator", label: "Separator", options: [{ value: ",", label: "Comma" }, { value: ";", label: "Semicolon" }, { value: " ", label: "Space" }, { value: "\t", label: "Tab" }, { value: "", label: "None" }, { value: "custom", label: "Custom" }], default: "," },
          { kind: "text", key: "custom", label: "Custom separator (when Custom is chosen)" },
          { kind: "text", key: "name", label: "New column name", default: "Merged" },
        ],
        build: (v) => {
          const columns = (v.columns as string[]) ?? [];
          if (columns.length < 2) throw new Error("Choose at least two columns to merge.");
          const sep = v.separator === "custom" ? String(v.custom ?? "") : String(v.separator ?? ",");
          const name = String(v.name ?? "").trim();
          if (!name) throw new Error("Enter a name for the merged column.");
          return { transform: { kind: "mergeColumns", columns, delimiter: sep, newName: name } };
        },
      };
    case "extractFirst":
    case "extractLast":
      return {
        title: kind === "extractFirst" ? "Extract First Characters" : "Extract Last Characters",
        submitLabel: "OK",
        fields: [{ kind: "number", key: "count", label: "Count", default: 1, min: 0 }],
        build: (v) => ({ transform: { kind: "transformColumn", columns: c.selected, function: kind === "extractFirst" ? "Text.Start" : "Text.End", args: [count(v.count, "The count")], valueType: "text", label: kind === "extractFirst" ? "Extracted First Characters" : "Extracted Last Characters" } }),
      };
    case "extractRange":
      return {
        title: "Extract Text Range",
        submitLabel: "OK",
        fields: [
          { kind: "number", key: "start", label: "Starting index (0 is the first character)", default: 0, min: 0 },
          { kind: "number", key: "count", label: "Number of characters", default: 1, min: 0 },
        ],
        build: (v) => ({ transform: { kind: "transformColumn", columns: c.selected, function: "Text.Middle", args: [count(v.start, "The starting index"), count(v.count, "The number of characters")], valueType: "text", label: "Extracted Text Range" } }),
      };
    case "extractBefore":
    case "extractAfter":
      return {
        title: kind === "extractBefore" ? "Text Before Delimiter" : "Text After Delimiter",
        submitLabel: "OK",
        fields: [{ kind: "text", key: "delimiter", label: "Delimiter" }],
        build: (v) => {
          const d = String(v.delimiter ?? "");
          if (!d) throw new Error("Enter the delimiter.");
          return { transform: { kind: "transformColumn", columns: c.selected, function: kind === "extractBefore" ? "Text.BeforeDelimiter" : "Text.AfterDelimiter", args: [d], valueType: "text", label: kind === "extractBefore" ? "Extracted Text Before Delimiter" : "Extracted Text After Delimiter" } };
        },
      };
    case "extractBetween":
      return {
        title: "Text Between Delimiters",
        submitLabel: "OK",
        fields: [
          { kind: "text", key: "start", label: "Start delimiter" },
          { kind: "text", key: "end", label: "End delimiter" },
        ],
        build: (v) => {
          const s = String(v.start ?? "");
          const e = String(v.end ?? "");
          if (!s || !e) throw new Error("Enter both delimiters.");
          return { transform: { kind: "transformColumn", columns: c.selected, function: "Text.BetweenDelimiters", args: [s, e], valueType: "text", label: "Extracted Text Between Delimiters" } };
        },
      };
    case "rename":
      return {
        title: "Rename Column",
        submitLabel: "OK",
        fields: [
          { kind: "select", key: "column", label: "Column", options: cols, default: first },
          { kind: "text", key: "to", label: "New name" },
        ],
        build: (v) => {
          const column = need(v.column, "The column");
          const to = need(v.to, "The new name");
          if (to !== column && c.columns.some((x) => x.name === to)) throw new Error(`A column named "${to}" already exists.`);
          return { transform: { kind: "renameColumns", pairs: [[column, to]] } };
        },
      };
    case "indexCustom":
      return {
        title: "Add Index Column",
        submitLabel: "OK",
        fields: [
          { kind: "text", key: "name", label: "Column name", default: "Index" },
          { kind: "number", key: "start", label: "Starting index", default: 0 },
          { kind: "number", key: "step", label: "Increment", default: 1 },
        ],
        build: (v) => {
          const name = need(v.name, "The column name");
          if (c.columns.some((x) => x.name === name)) throw new Error(`The column "${name}" already exists.`);
          return { transform: { kind: "addIndexColumn", name, start: Number(v.start ?? 0), step: Number(v.step ?? 1) } };
        },
      };
    case "customStep":
      return {
        title: "Insert Step",
        submitLabel: "OK",
        fields: [
          { kind: "text", key: "name", label: "Step name", default: "Custom Step" },
          { kind: "textarea", key: "expr", label: "Formula  (the previous step is available by its name)", rows: 4 },
        ],
        build: (v) => ({ transform: { kind: "custom", name: need(v.name, "The step name"), expr: need(v.expr, "The formula") } }),
      };
    case "newCsv":
      return {
        title: "Text/CSV",
        submitLabel: "OK",
        fields: [
          { kind: "file", key: "path", label: "File path", extensions: ["csv", "txt", "tsv"], name: "Text or CSV files" },
          { kind: "text", key: "delimiter", label: "Delimiter", default: "," },
        ],
        build: (v) => {
          const path = need(v.path, "The file path");
          return { command: "query.add", args: { name: csvName(path), text: csvQueryText(path, String(v.delimiter ?? ",") || ","), loaded: true } };
        },
      };
    case "newExcel":
      return {
        title: "Excel workbook",
        submitLabel: "OK",
        fields: [
          { kind: "file", key: "path", label: "File path", extensions: ["xlsx", "xlsm", "xls"], name: "Excel workbooks" },
          { kind: "select", key: "sheet", label: "Sheet", options: (c.sheets ?? []).map((s) => ({ value: s, label: s })), default: c.sheets?.[0] },
        ],
        build: (v) => {
          const path = need(v.path, "The file path");
          const sheet = need(v.sheet, "The sheet");
          return { command: "query.add", args: { name: sheet, text: excelQueryText(path, sheet), loaded: true } };
        },
      };
    case "newFolder":
      return {
        title: "Folder",
        submitLabel: "OK",
        fields: [
          { kind: "folder", key: "folder", label: "Folder path" },
          { kind: "text", key: "extension", label: "Combine files with this extension", default: "csv" },
          { kind: "text", key: "delimiter", label: "Delimiter", default: "," },
        ],
        build: (v) => ({
          command: "query.addFromFolder",
          args: { folder: need(v.folder, "The folder path"), extension: need(v.extension, "The extension"), delimiter: String(v.delimiter ?? ",") || "," },
        }),
      };
    case "enterData":
      return {
        title: "Create Table",
        submitLabel: "OK",
        fields: [
          { kind: "text", key: "name", label: "Query name", default: "Table" },
          { kind: "textarea", key: "data", label: "Column names in the first line, then one row per line (comma or tab separated)", rows: 8, placeholder: "Name,Qty\nPen,3\nInk,4" },
        ],
        build: (v) => ({ command: "query.add", args: { name: need(v.name, "The query name"), text: enterDataText(String(v.data ?? "")), loaded: true } }),
      };
  }
  throw new Error(`Unknown dialog "${String(kind)}".`);
}
