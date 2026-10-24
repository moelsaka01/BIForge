// Mirrors the serde JSON of biforge_engine::types (camelCase).
import type { TmdlDocument } from "../model/types";

/** An extra request header of a Web source. A secret header keeps its value in the Windows Credential Manager, not here. */
export interface WebHeader {
  name: string;
  value: string | null;
  secret: boolean;
}

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
  /** An OLE DB data source: any provider installed on this PC (64 bit). The password of `user` is kept in Windows Credential Manager. */
  | { kind: "oledb"; connection: string; user?: string | null; table?: string | null; query?: string | null }
  /** SQL Server Analysis Services (local or on premises) through MSOLAP: a table of a tabular model, or a DAX or MDX query. */
  | { kind: "analysisServices"; server: string; database: string; user?: string | null; table?: string | null; query?: string | null }
  /** A Python or R script run by the user's own interpreter; each pandas DataFrame / data.frame it leaves behind is a table. */
  | { kind: "script"; language: "python" | "r"; code: string; table?: string | null; home?: string | null }
  | { kind: "web"; url: string; format?: string | null; table?: string | null; user?: string | null; headers?: WebHeader[] }
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
  /** A CSV whose header row has names with leading or trailing spaces; the generated M then trims them in an explicit step. */
  headerPadded?: boolean;
}

export interface SortSpec {
  column: string;
  descending?: boolean;
}

export interface RowPage {
  columns: ColumnInfo[];
  rows: (string | null)[][];
  total: number;
  /** (row, column) of the cells that are errors (a failed type conversion); Power Query previews only. */
  errorCells?: [number, number][];
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
  /** Renames the stored data of a table (the model table was renamed). */
  renameTable(old: string, to: string): Promise<void>;
  /** Renames a stored column (a model column was renamed, or a source column is mapped to the name it has in the model). */
  renameColumn(table: string, old: string, to: string): Promise<void>;
  /** `sort` is one column, or several (the first is the main key). */
  fetchPage(table: string, offset: number, limit: number, sort?: SortSpec | SortSpec[] | null): Promise<RowPage>;
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
  /** Keeps the value of a secret request header of a Web source in the credential store. */
  setHeaderSecret(spec: SourceSpec, name: string, value: string): Promise<void>;
  /** Evaluates a DAX table expression over the model and stores its rows as table `name` (a calculated table). */
  calcTable(documents: TmdlDocument[], name: string, expression: string): Promise<TableInfo>;
  /** Computes the calculated columns of a table and stores their values in it; returns their names. Throws the engine's message when one fails. */
  calcColumns(documents: TmdlDocument[], table: string): Promise<string[]>;
}
