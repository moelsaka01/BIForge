import type { SourceSpec } from "../core/data/types";

export type SourceKind = SourceSpec["kind"];

export interface ImportForm {
  kind: SourceKind;
  path: string;
  delimiter: string;
  header: boolean;
  sheet: string;
  sqliteTable: string;
  host: string;
  port: string;
  database: string;
  user: string;
  schema: string;
  pgTable: string;
}

export const emptyForm = (kind: SourceKind = "csv"): ImportForm => ({
  kind,
  path: "",
  delimiter: "",
  header: true,
  sheet: "",
  sqliteTable: "",
  host: "localhost",
  port: "5432",
  database: "",
  user: "",
  schema: "public",
  pgTable: "",
});

export const FILE_FILTERS: Record<string, { label: string; extensions: string[] }> = {
  csv: { label: "CSV / text", extensions: ["csv", "txt", "tsv"] },
  excel: { label: "Excel workbook", extensions: ["xlsx", "xlsm", "xlsb", "xls", "ods"] },
  json: { label: "JSON", extensions: ["json", "jsonl", "ndjson"] },
  parquet: { label: "Parquet", extensions: ["parquet"] },
  sqlite: { label: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] },
};

/** Validates the form and builds the source. Returns an error message when something required is missing. */
export function buildSpec(f: ImportForm): { spec: SourceSpec } | { error: string } {
  const needPath = f.kind !== "postgres";
  if (needPath && !f.path.trim()) return { error: "Choose a file." };
  switch (f.kind) {
    case "csv":
      return { spec: { kind: "csv", path: f.path.trim(), delimiter: f.delimiter === "" ? null : f.delimiter, header: f.header } };
    case "excel":
      return { spec: { kind: "excel", path: f.path.trim(), sheet: f.sheet || null, header: f.header } };
    case "json":
      return { spec: { kind: "json", path: f.path.trim() } };
    case "parquet":
      return { spec: { kind: "parquet", path: f.path.trim() } };
    case "sqlite":
      if (!f.sqliteTable) return { error: "Choose a table." };
      return { spec: { kind: "sqlite", path: f.path.trim(), table: f.sqliteTable } };
    case "postgres": {
      const port = Number(f.port);
      if (!f.host.trim() || !f.database.trim() || !f.user.trim()) return { error: "Server, database and user are required." };
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "Port must be a number between 1 and 65535." };
      if (!f.pgTable.trim()) return { error: "Choose a table." };
      return {
        spec: {
          kind: "postgres",
          host: f.host.trim(),
          port,
          database: f.database.trim(),
          user: f.user.trim(),
          schema: f.schema.trim() || "public",
          table: f.pgTable.trim(),
        },
      };
    }
  }
}

/** A sensible default table name from the source (file name without extension, or the database table). */
export function defaultTableName(spec: SourceSpec): string {
  if (spec.kind === "sqlite") return spec.table;
  if (spec.kind === "postgres") return spec.table;
  const file = spec.path.split(/[\\/]/).pop() ?? "Table";
  const stem = file.replace(/\.[^.]+$/, "");
  const base = stem.trim() === "" ? "Table" : stem;
  return spec.kind === "excel" && spec.sheet ? spec.sheet : base;
}
