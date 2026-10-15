// Mirrors the serde JSON of biforge_dax::editor and app/src-tauri/src/dax.rs (camelCase).

import type { TmdlDocument } from "../model/types";

export interface FunctionInfo {
  name: string;
  category: string;
  signature: string;
  returnsTable: boolean;
  description: string;
  /** False: the function exists in DAX but BIForge cannot evaluate it yet. */
  implemented: boolean;
  minArgs: number;
  maxArgs: number | null;
}

export interface EditorDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  /** UTF-16 offsets into the checked text. */
  start: number;
  end: number;
}

export interface Cell {
  t: "blank" | "int" | "real" | "currency" | "text" | "bool" | "datetime";
  v: string;
}

export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  totalRows: number;
  truncated: boolean;
}

export interface QueryOutcome {
  results: QueryResult[];
  elapsedMs: number;
}

/** The DAX engine as the UI sees it. The real implementation calls Tauri commands; tests use a fake. */
export interface DaxApi {
  catalog(): Promise<FunctionInfo[]>;
  check(documents: TmdlDocument[], expression: string): Promise<EditorDiagnostic[]>;
  query(documents: TmdlDocument[], query: string): Promise<QueryOutcome>;
}
