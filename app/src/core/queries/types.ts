// Types shared by the Power Query editor: they mirror the serde JSON of crates/m and app/src-tauri/src/pq.rs.
import type { RowPage, TableInfo } from "../data/types";

export interface StepColumn {
  name: string;
  duckdbType: string;
}

export interface StepResult {
  name: string;
  /** "table", another kind of value ("number", "list", ...), or "error". */
  kind: string;
  columns: StepColumn[];
  error: { reason: string; message: string } | null;
}

export interface ParsedStep {
  name: string;
  rawName: string;
  expr: string;
  function: string | null;
}

export interface ParsedQuery {
  steps: ParsedStep[];
  output: string;
}

export interface Applied {
  text: string;
  added: string[];
}

export interface MDiagnostic {
  /** UTF-16 offsets. */
  start: number;
  end: number;
  message: string;
}

export type StepEdit =
  | { op: "insert"; after: string | null; name: string; expr: string }
  | { op: "delete"; name: string }
  | { op: "deleteFrom"; name: string }
  | { op: "rename"; old: string; new: string }
  | { op: "setExpr"; name: string; expr: string }
  | { op: "move"; name: string; delta: number }
  | { op: "renameRef"; old: string; new: string };

export type DataTypeName = "text" | "int64" | "number" | "decimal" | "percentage" | "date" | "datetime" | "time" | "datetimezone" | "logical" | "any";

export type StatisticOp = "sum" | "min" | "max" | "median" | "average" | "standardDeviation" | "count" | "countDistinct";

export type FilterOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "contains" | "notContains" | "startsWith" | "endsWith" | "isNull" | "isNotNull";

export interface Condition {
  column: string;
  op: FilterOp;
  value?: string | number | boolean | null;
  valueType?: "text" | "number" | "date" | "logical";
}

export interface Aggregate {
  name: string;
  op: "sum" | "average" | "min" | "max" | "median" | "count" | "countDistinct" | "countRows";
  column?: string;
}

/** A ribbon transform as data (the Rust enum `Transform`, camelCase). */
export type Transform =
  | { kind: "promoteHeaders" }
  | { kind: "demoteHeaders" }
  | { kind: "changeType"; changes: { column: string; type: DataTypeName }[]; culture?: string }
  | { kind: "removeColumns"; columns: string[] }
  | { kind: "keepColumns"; columns: string[] }
  | { kind: "reorderColumns"; columns: string[] }
  | { kind: "renameColumns"; pairs: [string, string][] }
  | { kind: "duplicateColumn"; column: string; newName: string }
  | { kind: "filterRows"; conditions: Condition[]; combine?: "and" | "or" }
  | { kind: "removeBlankRows"; textColumns: string[]; otherColumns: string[] }
  | { kind: "removeDuplicates"; columns: string[] }
  | { kind: "sort"; keys: { column: string; descending?: boolean }[] }
  | { kind: "keepTopRows"; count: number }
  | { kind: "keepBottomRows"; count: number }
  | { kind: "keepRange"; offset: number; count: number }
  | { kind: "removeTopRows"; count: number }
  | { kind: "removeBottomRows"; count: number }
  | { kind: "replaceValues"; columns: string[]; find: string | number | null; replace: string | number | null; mode: "text" | "value"; valueType?: "text" | "number" }
  | {
      kind: "splitColumn";
      column: string;
      by: "delimiter" | "anyDelimiter" | "positions" | "lengths" | "repeatedLength";
      delimiter?: string;
      delimiters?: string[];
      positions?: number[];
      lengths?: number[];
      length?: number;
      count: number;
      names?: string[];
    }
  | { kind: "addCustomColumn"; name: string; formula: string; valueType?: DataTypeName }
  | {
      kind: "addConditionalColumn";
      name: string;
      clauses: { condition: Condition; result: string | number | boolean | null; resultType?: "text" | "number" | "logical" }[];
      elseValue: string | number | boolean | null;
      elseType?: "text" | "number" | "logical";
    }
  | { kind: "addIndexColumn"; name: string; start: number; step: number }
  | { kind: "fillDown"; columns: string[] }
  | { kind: "fillUp"; columns: string[] }
  | { kind: "groupBy"; keys: string[]; aggregates: Aggregate[] }
  | {
      kind: "merge";
      right: string;
      leftKeys: string[];
      rightKeys: string[];
      joinKind: "inner" | "leftOuter" | "rightOuter" | "fullOuter" | "leftAnti" | "rightAnti";
      newColumn: string;
      expand?: { name: string; newName: string }[];
    }
  | { kind: "append"; queries: string[] }
  | { kind: "pivot"; attribute: string; value: string; attributeIsText: boolean; aggregate: "sum" | "count" | "min" | "max" | "average" | "none" }
  | { kind: "unpivot"; columns: string[] }
  | { kind: "unpivotOther"; columns: string[] }
  | { kind: "transformText"; columns: string[]; op: "upper" | "lower" | "trim" | "clean" }
  | { kind: "round"; columns: string[]; digits: number }
  | { kind: "reverseRows" }
  | { kind: "transpose" }
  | { kind: "removeAlternateRows"; offset: number; remove: number; keep: number }
  | { kind: "mergeColumns"; columns: string[]; delimiter: string; newName: string }
  | { kind: "parseJson"; column: string; fields: string[] }
  | { kind: "countRows" }
  | { kind: "columnStatistic"; column: string; op: StatisticOp }
  | { kind: "rowStatistic"; columns: string[]; op: StatisticOp; newName: string }
  | { kind: "keepDuplicates"; columns: string[] }
  | { kind: "removeErrors"; columns: string[] }
  | { kind: "keepErrors"; columns: string[] }
  | { kind: "replaceErrors"; columns: string[]; value: string | number | boolean | null; valueType?: "text" | "number" | "logical" }
  | { kind: "transformColumn"; columns: string[]; function: string; args?: (string | number)[]; valueType?: DataTypeName; label: string }
  | { kind: "arithmetic"; columns: string[]; op: ArithOp; operand: number }
  | { kind: "textAffix"; columns: string[]; prefix?: string; suffix?: string }
  | { kind: "custom"; name: string; expr: string };

/** Transform > Standard operations that take a number. */
export type ArithOp = "add" | "subtract" | "multiply" | "divide" | "integerDivide" | "modulo" | "power" | "percentage" | "percentOf";

/** The M engine and M text tools as the UI sees them. The real implementation calls Tauri commands. */
/** Statistics of one column of a step (View > Column quality / distribution / profile); mirrors the engine's ColumnProfile. */
export interface ColumnProfile {
  name: string;
  duckdbType: string;
  rows: number;
  valid: number;
  empty: number;
  /** Cells that are errors (a failed type conversion). */
  error: number;
  distinct: number;
  unique: number;
  min: string | null;
  max: string | null;
  average: number | null;
  stdDev: number | null;
  /** The most frequent values, most frequent first (null = a null value). */
  top: [string | null, number][];
  rowsLimited: boolean;
}

/** A step or query whose value is not a table (a parameter, a count, a statistic, a list). */
export interface ValueOut {
  kind: string;
  text: string;
  items: string[];
}

export interface MApi {
  parseQuery(text: string): Promise<ParsedQuery>;
  check(text: string): Promise<MDiagnostic[]>;
  applyTransform(text: string, after: string | null, transform: Transform): Promise<Applied>;
  editStep(text: string, edit: StepEdit): Promise<string>;
  dependencies(queries: Record<string, string>): Promise<Record<string, string[]>>;
  folderQuery(folder: string, extension: string, delimiter: string): Promise<string>;
  analyze(queries: Record<string, string>, query: string): Promise<StepResult[]>;
  preview(queries: Record<string, string>, query: string, step: string | null, limit: number): Promise<RowPage>;
  /** Column statistics of a step over its first `limit` rows (all rows when null). */
  profile(queries: Record<string, string>, query: string, step: string | null, limit: number | null): Promise<ColumnProfile[]>;
  /** The data type each of the text columns can be converted to without a conversion error (the others keep their type). */
  detectTypes(queries: Record<string, string>, query: string, step: string | null, columns: string[]): Promise<{ column: string; type: DataTypeName }[]>;
  /** The value of a step (or the whole query) that is not a table. */
  value(queries: Record<string, string>, query: string, step: string | null): Promise<ValueOut>;
  load(queries: Record<string, string>, query: string, table: string): Promise<TableInfo>;
  queryKinds(queries: Record<string, string>): Promise<Record<string, string>>;
}
