// Mirrors the serde JSON of biforge_engine::types (camelCase).

export type SourceSpec =
  | { kind: "csv"; path: string; delimiter?: string | null; header?: boolean | null }
  | { kind: "excel"; path: string; sheet?: string | null; header?: boolean }
  | { kind: "json"; path: string }
  | { kind: "parquet"; path: string }
  | { kind: "sqlite"; path: string; table: string }
  | { kind: "postgres"; host: string; port?: number; database: string; user: string; schema?: string; table: string; query?: string | null }
  /** SQL Server; without `user` Windows integrated authentication. */
  | { kind: "sqlserver"; server: string; port?: number | null; database: string; user?: string | null; schema?: string; table: string; query?: string | null; trustCertificate?: boolean }
  | { kind: "mysql"; host: string; port?: number; database: string; user: string; table: string; query?: string | null }
  /** Any database with an ODBC driver. `connection` never holds the password. `flavor` picks the M connector written for Power BI Desktop. */
  | { kind: "odbc"; flavor: OdbcFlavor; connection: string; user?: string | null; table?: string | null; query?: string | null; server?: string | null; database?: string | null }
  | { kind: "xml"; path: string; table?: string | null }
  /** `format`: auto, html, json, csv or xml. With `user` the request uses Basic authentication (secret in Windows Credential Manager). */
  | { kind: "web"; url: string; format?: string | null; table?: string | null; user?: string | null }
  | { kind: "odata"; url: string; entity: string; user?: string | null }
  | { kind: "pdf"; path: string; table?: string | null }
  | { kind: "fixedWidth"; path: string; widths: number[]; header?: boolean }
  /** Data typed into the Enter data grid. Cells are text (null = empty). */
  | { kind: "inline"; columns: { name: string; type: InlineType }[]; rows: (string | null)[][] };

export type InlineType = "text" | "whole" | "decimal" | "logical" | "date" | "datetime";

export type OdbcFlavor = "odbc" | "access" | "oracle" | "db2" | "teradata" | "saphana" | "redshift" | "snowflake";

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
  /** Tables, sheets or entities a source offers (the navigator list). */
  sourceChoices(spec: SourceSpec): Promise<string[]>;
  /** The first rows of a source, as text, without importing it. */
  sourcePreview(spec: SourceSpec, limit: number): Promise<RowPage>;
  /** True when a password or token is stored for the source (Windows Credential Manager). */
  credentialExists(spec: SourceSpec): Promise<boolean>;
  /** Removes the stored password or token of the source. */
  clearCredential(spec: SourceSpec): Promise<void>;
  /** Names of the ODBC drivers installed on this computer. */
  odbcDrivers(): Promise<string[]>;
  setCredential(spec: SourceSpec, secret: string): Promise<void>;
}
