import { invoke } from "@tauri-apps/api/core";
import type { EngineApi, RelationshipHint, RowPage, SortSpec, SourceSpec, TableInfo } from "./types";

/** EngineApi backed by the Rust engine through Tauri commands. */
export const tauriEngine: EngineApi = {
  openStore: (root) => invoke<string[]>("engine_open_store", { root }),
  copyStore: (srcRoot, dstRoot) => invoke<string[]>("engine_copy_store", { srcRoot, dstRoot }),
  importSource: (table, spec) => invoke<TableInfo>("engine_import", { table, spec }),
  tableInfo: (table) => invoke<TableInfo | null>("engine_table_info", { table }),
  dropTable: (table) => invoke<void>("engine_drop_table", { table }),
  fetchPage: (table, offset, limit, sort?: SortSpec | null) => invoke<RowPage>("engine_fetch_page", { table, offset, limit, sort: sort ?? null }),
  suggestRelationship: (from, to) => invoke<RelationshipHint>("engine_suggest_relationship", { from, to }),
  excelSheets: (path) => invoke<string[]>("engine_excel_sheets", { path }),
  sqliteTables: (path) => invoke<string[]>("engine_sqlite_tables", { path }),
  postgresTables: (spec: SourceSpec) => invoke<string[]>("engine_postgres_tables", { spec }),
  sqlserverTables: (spec: SourceSpec) => invoke<string[]>("engine_sqlserver_tables", { spec }),
  sourceChoices: (spec: SourceSpec) => invoke<string[]>("engine_source_choices", { spec }),
  sourcePreview: (spec: SourceSpec, limit: number) => invoke<RowPage>("engine_source_preview", { spec, limit }),
  odbcDrivers: () => invoke<string[]>("engine_odbc_drivers"),
  setCredential: (spec, secret) => invoke<void>("engine_set_credential", { spec, secret }),
};
