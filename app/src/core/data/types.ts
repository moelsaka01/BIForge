// Mirrors the serde JSON of biforge_engine::types (camelCase).

export type SourceSpec =
  | { kind: "csv"; path: string; delimiter?: string | null; header?: boolean | null }
  | { kind: "excel"; path: string; sheet?: string | null; header?: boolean }
  | { kind: "json"; path: string }
  | { kind: "parquet"; path: string }
  | { kind: "sqlite"; path: string; table: string }
  | { kind: "postgres"; host: string; port?: number; database: string; user: string; schema?: string; table: string }
  /** SQL Server; without `user` Windows integrated authentication. */
  | { kind: "sqlserver"; server: string; port?: number | null; database: string; user?: string | null; schema?: string; table: string };

export type BiType = "int64" | "double" | "decimal" | "boolean" | "dateTime" | "string" | "binary";

export interface ColumnInfo {
  name: string;
  duckdbType: string;
  biType: BiType;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount: number;
}

export interface SortSpec {
  column: string;
  descending?: boolean;
}

export interface RowPage {
  columns: ColumnInfo[];
  rows: (string | null)[][];
  total: number;
}

export type Cardinality = "oneToMany" | "manyToOne" | "oneToOne" | "manyToMany";

export interface RelationshipHint {
  fromUnique: boolean;
  toUnique: boolean;
  cardinality: Cardinality;
}

/** The engine as the UI sees it. The real implementation calls Tauri commands; tests use a fake. */
export interface EngineApi {
  /** Opens the project's data store (under `<root>/.biforge`). */
  openStore(root: string): Promise<string[]>;
  /** Save as: copies the data store of `srcRoot` into `dstRoot` and keeps the copy open. */
  copyStore(srcRoot: string, dstRoot: string): Promise<string[]>;
  importSource(table: string, spec: SourceSpec): Promise<TableInfo>;
  tableInfo(table: string): Promise<TableInfo | null>;
  dropTable(table: string): Promise<void>;
  fetchPage(table: string, offset: number, limit: number, sort?: SortSpec | null): Promise<RowPage>;
  suggestRelationship(from: [string, string], to: [string, string]): Promise<RelationshipHint>;
  excelSheets(path: string): Promise<string[]>;
  sqliteTables(path: string): Promise<string[]>;
  postgresTables(spec: SourceSpec): Promise<string[]>;
  sqlserverTables(spec: SourceSpec): Promise<string[]>;
  setCredential(spec: SourceSpec, secret: string): Promise<void>;
}
