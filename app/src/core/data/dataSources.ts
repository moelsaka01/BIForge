// The data sources of a project, as the Data source settings dialog shows them: one row per place data comes from (a file,
// a server and database, a web address), with the tables that use it. Pure; the dialog and the commands call these.
import type { Project } from "../model/types";
import { getTableSource, importedTables } from "../model/tables";
import type { SourceSpec } from "./types";

export interface DataSourceInfo {
  /** Identity of the place: the same for every table that reads from it (sheet, table and query are not part of it). */
  id: string;
  kind: SourceSpec["kind"];
  label: string;
  /** The user name, when the source uses one (a password for it lives in Windows Credential Manager). */
  user: string | null;
  /** True when a password or token can be stored for this source. */
  hasSecret: boolean;
  tables: string[];
  /** A spec of one of the tables, used to reach the credential. */
  spec: SourceSpec;
}

const KIND_LABEL: Record<SourceSpec["kind"], string> = {
  csv: "Text/CSV file",
  excel: "Excel workbook",
  json: "JSON file",
  parquet: "Parquet file",
  sqlite: "SQLite database",
  postgres: "PostgreSQL database",
  sqlserver: "SQL Server database",
  mysql: "MySQL database",
  odbc: "ODBC",
  xml: "XML file",
  web: "Web",
  odata: "OData feed",
  pdf: "PDF file",
  fixedWidth: "Fixed-width text file",
  inline: "Entered data",
};

/** The place a spec reads from. */
export function sourceIdentity(s: SourceSpec): string {
  switch (s.kind) {
    case "csv":
    case "excel":
    case "json":
    case "parquet":
    case "sqlite":
    case "xml":
    case "pdf":
    case "fixedWidth":
      return `${s.kind}|${s.path.toLowerCase()}`;
    case "postgres":
      return `postgres|${s.host.toLowerCase()}:${s.port ?? 5432}/${s.database.toLowerCase()}|${s.user}`;
    case "mysql":
      return `mysql|${s.host.toLowerCase()}:${s.port ?? 3306}/${s.database.toLowerCase()}|${s.user}`;
    case "sqlserver":
      return `sqlserver|${s.server.toLowerCase()}:${s.port ?? ""}/${s.database.toLowerCase()}|${s.user ?? ""}`;
    case "odbc":
      return `odbc|${s.connection.toLowerCase()}|${s.user ?? ""}`;
    case "web":
    case "odata":
      return `${s.kind}|${s.url.toLowerCase()}|${s.user ?? ""}`;
    case "inline":
      return "inline";
  }
}

export function describeSource(s: SourceSpec): string {
  switch (s.kind) {
    case "csv":
    case "excel":
    case "json":
    case "parquet":
    case "sqlite":
    case "xml":
    case "pdf":
    case "fixedWidth":
      return s.path;
    case "postgres":
    case "mysql":
      return `${s.host}:${s.port ?? (s.kind === "mysql" ? 3306 : 5432)} / ${s.database}`;
    case "sqlserver":
      return `${s.server}${s.port ? `,${s.port}` : ""} / ${s.database}`;
    case "odbc":
      return s.connection;
    case "web":
    case "odata":
      return s.url;
    case "inline":
      return "Typed into BIForge";
  }
}

const userOf = (s: SourceSpec): string | null => ("user" in s && typeof s.user === "string" && s.user.trim() !== "" ? s.user : null);

export function listDataSources(p: Project): DataSourceInfo[] {
  const out = new Map<string, DataSourceInfo>();
  for (const t of importedTables(p)) {
    const spec = getTableSource(p, t);
    if (!spec) continue;
    const id = sourceIdentity(spec);
    const cur = out.get(id);
    if (cur) cur.tables.push(t);
    else
      out.set(id, {
        id,
        kind: spec.kind,
        label: `${KIND_LABEL[spec.kind]}: ${describeSource(spec)}`,
        user: userOf(spec),
        hasSecret: ["postgres", "mysql", "sqlserver", "odbc", "web", "odata"].includes(spec.kind) && userOf(spec) !== null,
        tables: [t],
        spec,
      });
  }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** What the "Change source" form edits for each kind. */
export interface SourceLocation {
  path?: string;
  host?: string;
  port?: string;
  database?: string;
  user?: string;
  url?: string;
  connection?: string;
}

export function locationOf(s: SourceSpec): SourceLocation {
  switch (s.kind) {
    case "csv":
    case "excel":
    case "json":
    case "parquet":
    case "sqlite":
    case "xml":
    case "pdf":
    case "fixedWidth":
      return { path: s.path };
    case "postgres":
    case "mysql":
      return { host: s.host, port: String(s.port ?? ""), database: s.database, user: s.user };
    case "sqlserver":
      return { host: s.server, port: s.port ? String(s.port) : "", database: s.database, user: s.user ?? "" };
    case "odbc":
      return { connection: s.connection, user: s.user ?? "" };
    case "web":
    case "odata":
      return { url: s.url, user: s.user ?? "" };
    case "inline":
      return {};
  }
}

/** The spec with a new location; table, sheet, query and options stay. Returns an error text for an invalid value. */
export function withLocation(s: SourceSpec, loc: SourceLocation): SourceSpec | { error: string } {
  const need = (v: string | undefined, what: string) => (v && v.trim() !== "" ? null : `${what} is required.`);
  const port = (v: string | undefined, dflt: number | null): number | null | { error: string } => {
    if (v === undefined || v.trim() === "") return dflt;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : { error: "Port must be a number between 1 and 65535." };
  };
  switch (s.kind) {
    case "csv":
    case "excel":
    case "json":
    case "parquet":
    case "sqlite":
    case "xml":
    case "pdf":
    case "fixedWidth": {
      const e = need(loc.path, "The file path");
      return e ? { error: e } : { ...s, path: loc.path!.trim() };
    }
    case "postgres":
    case "mysql": {
      const e = need(loc.host, "Server") ?? need(loc.database, "Database") ?? need(loc.user, "User");
      const pt = port(loc.port, s.kind === "mysql" ? 3306 : 5432);
      if (e) return { error: e };
      if (pt !== null && typeof pt === "object") return pt;
      return { ...s, host: loc.host!.trim(), port: pt ?? undefined, database: loc.database!.trim(), user: loc.user!.trim() };
    }
    case "sqlserver": {
      const e = need(loc.host, "Server") ?? need(loc.database, "Database");
      const pt = port(loc.port, null);
      if (e) return { error: e };
      if (pt !== null && typeof pt === "object") return pt;
      return { ...s, server: loc.host!.trim(), port: pt, database: loc.database!.trim(), user: loc.user?.trim() ? loc.user.trim() : null };
    }
    case "odbc": {
      const e = need(loc.connection, "The connection string");
      if (e) return { error: e };
      if (/(^|;)\s*(pwd|password)\s*=/i.test(loc.connection!)) return { error: "Do not put the password in the connection string." };
      return { ...s, connection: loc.connection!.trim(), user: loc.user?.trim() ? loc.user.trim() : null };
    }
    case "web":
    case "odata": {
      if (!/^https?:\/\/\S+$/i.test(loc.url?.trim() ?? "")) return { error: "Enter an http:// or https:// web address." };
      return { ...s, url: loc.url!.trim(), user: loc.user?.trim() ? loc.user.trim() : null };
    }
    case "inline":
      return { error: "Typed-in data has no location to change." };
  }
}
