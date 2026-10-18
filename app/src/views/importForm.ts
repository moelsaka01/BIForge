import type { InlineType, OdbcFlavor, SourceSpec } from "../core/data/types";

export type SourceKind = SourceSpec["kind"];
/** What the user picks in Get data: a spec kind, or one of the ODBC flavors (which all produce an `odbc` spec). */
export type ConnectorId = Exclude<SourceKind, "odbc" | "script"> | OdbcFlavor | "python" | "r" | "blank";

export type ConnectorGroup = "File" | "Database" | "Online and other";

export interface Connector {
  id: ConnectorId;
  label: string;
  group: ConnectorGroup;
  /** Search words besides the label. */
  keywords?: string;
}

/** The Get data list (local connectors only). */
export const CONNECTORS: Connector[] = [
  { id: "csv", label: "Text/CSV", group: "File", keywords: "txt tsv comma" },
  { id: "excel", label: "Excel workbook", group: "File", keywords: "xlsx xls xlsb ods" },
  { id: "json", label: "JSON", group: "File" },
  { id: "xml", label: "XML", group: "File" },
  { id: "parquet", label: "Parquet", group: "File" },
  { id: "pdf", label: "PDF", group: "File", keywords: "tables" },
  { id: "fixedWidth", label: "Fixed-width text", group: "File", keywords: "columns positions" },
  { id: "access", label: "Access database", group: "File", keywords: "accdb mdb" },
  { id: "sqlite", label: "SQLite database", group: "Database" },
  { id: "sqlserver", label: "SQL Server database", group: "Database", keywords: "mssql azure sql" },
  { id: "postgres", label: "PostgreSQL database", group: "Database", keywords: "postgres" },
  { id: "mysql", label: "MySQL database", group: "Database", keywords: "mariadb" },
  { id: "oracle", label: "Oracle database", group: "Database" },
  { id: "db2", label: "IBM Db2 database", group: "Database" },
  { id: "teradata", label: "Teradata database", group: "Database" },
  { id: "saphana", label: "SAP HANA database", group: "Database" },
  { id: "redshift", label: "Amazon Redshift", group: "Database" },
  { id: "snowflake", label: "Snowflake (ODBC)", group: "Database" },
  { id: "odbc", label: "ODBC (any other database)", group: "Database", keywords: "bigquery databricks sybase generic dsn" },
  { id: "inline", label: "Enter data (type the table in)", group: "Online and other", keywords: "manual table grid" },
  { id: "web", label: "Web", group: "Online and other", keywords: "html url api rest" },
  { id: "odata", label: "OData feed", group: "Online and other" },
  { id: "oledb", label: "OLE DB", group: "Database", keywords: "ole db provider ace sqloledb" },
  { id: "analysisServices", label: "SQL Server Analysis Services (local or on-premises)", group: "Database", keywords: "ssas msolap tabular cube dax mdx power bi desktop local" },
  { id: "python", label: "Python script", group: "Online and other", keywords: "pandas dataframe" },
  { id: "r", label: "R script", group: "Online and other", keywords: "data.frame rscript" },
  { id: "blank", label: "Blank query", group: "Online and other", keywords: "empty power query m" },
];

export interface ImportForm {
  kind: ConnectorId;
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
  /** The table chosen for a database, workbook-like or web source (the first of `selected`). */
  pgTable: string;
  /** Custom SQL (native query); when set it replaces the table. */
  query: string;
  /** ODBC: the connection string (generic) and the installed driver chosen for the flavors. */
  connection: string;
  driver: string;
  /** Web and OData. */
  url: string;
  format: string;
  /** Web: extra request headers (the value of a secret one is kept in the credential store, not in the project). */
  headers: { name: string; value: string; secret: boolean }[];
  /** Fixed-width: "4, 10, 3". */
  widths: string;
  /** Python and R: the script, and the interpreter's home folder (from File > Options; blank = look for it). */
  code: string;
  home: string;
  /** Everything ticked in the navigator. */
  selected: string[];
  /** SQL Server: accept a certificate that does not validate (self-signed). */
  trustCert: boolean;
  /** Enter data: the columns and the cells of the grid. */
  inlineColumns: { name: string; type: InlineType }[];
  inlineRows: string[][];
}

export const DEFAULT_PORTS: Partial<Record<ConnectorId, string>> = { postgres: "5432", mysql: "3306", db2: "50000", redshift: "5439" };

export const emptyForm = (kind: ConnectorId = "csv"): ImportForm => ({
  kind,
  path: "",
  delimiter: "",
  header: true,
  sheet: "",
  sqliteTable: "",
  host: "localhost",
  port: kind === "sqlserver" ? "" : DEFAULT_PORTS[kind] ?? "5432",
  database: "",
  user: "",
  schema: kind === "sqlserver" ? "dbo" : "public",
  pgTable: "",
  query: "",
  connection: "",
  driver: "",
  url: "",
  format: "auto",
  headers: [],
  widths: "",
  code: "",
  home: "",
  selected: [],
  trustCert: false,
  inlineColumns: [
    { name: "Column1", type: "text" },
    { name: "Column2", type: "text" },
  ],
  inlineRows: [["", ""], ["", ""], ["", ""]],
});

export const FILE_FILTERS: Record<string, { label: string; extensions: string[] }> = {
  csv: { label: "CSV / text", extensions: ["csv", "txt", "tsv"] },
  excel: { label: "Excel workbook", extensions: ["xlsx", "xlsm", "xlsb", "xls", "ods"] },
  json: { label: "JSON", extensions: ["json", "jsonl", "ndjson"] },
  parquet: { label: "Parquet", extensions: ["parquet"] },
  sqlite: { label: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] },
  xml: { label: "XML", extensions: ["xml"] },
  pdf: { label: "PDF", extensions: ["pdf"] },
  fixedWidth: { label: "Text file", extensions: ["txt", "dat", "prn"] },
  access: { label: "Access database", extensions: ["accdb", "mdb"] },
};

/** Kinds whose source is a file picked from the disk. */
export const FILE_KINDS: ConnectorId[] = ["csv", "excel", "json", "parquet", "sqlite", "xml", "pdf", "fixedWidth", "access"];
/** Kinds with a server (host, port, database, user, password). */
export const SERVER_KINDS: ConnectorId[] = ["postgres", "sqlserver", "mysql", "oracle", "db2", "teradata", "saphana", "redshift", "snowflake"];
/** Kinds that go through an ODBC driver. */
export const ODBC_KINDS: ConnectorId[] = ["odbc", "access", "oracle", "db2", "teradata", "saphana", "redshift", "snowflake"];
/** Kinds that list their tables in the navigator. */
export const NAVIGATOR_KINDS: ConnectorId[] = ["oledb", "analysisServices", "python", "r", "postgres", "sqlserver", "mysql", "xml", "pdf", "web", "odata", "odbc", "access", "oracle", "db2", "teradata", "saphana", "redshift", "snowflake"];
/** Kinds whose password (or Basic-authentication secret) goes to Windows Credential Manager. */
export const SECRET_KINDS: ConnectorId[] = ["postgres", "sqlserver", "mysql", "oledb", "analysisServices", "web", "odata", ...ODBC_KINDS];
/** Words that identify the installed ODBC driver of a flavor. */
export const DRIVER_PATTERNS: Partial<Record<ConnectorId, RegExp>> = {
  access: /access.*(accdb|mdb)|(accdb|mdb).*access/i,
  oracle: /oracle/i,
  db2: /db2|ibm/i,
  teradata: /teradata/i,
  saphana: /hdbodbc|hana|sap/i,
  redshift: /redshift/i,
  snowflake: /snowflake/i,
};

const brace = (v: string) => `{${v}}`;

/** The ODBC connection string (without user and password) for the form. */
export function odbcConnection(f: ImportForm): string {
  const drv = f.driver ? `Driver=${brace(f.driver)};` : "";
  const host = f.host.trim();
  const db = f.database.trim();
  const port = f.port.trim();
  switch (f.kind) {
    case "access":
      return `${drv}Dbq=${f.path.trim()};`;
    case "oracle":
      return `${drv}Dbq=${host};`;
    case "db2":
      return `${drv}Hostname=${host};Port=${port || "50000"};Database=${db};Protocol=TCPIP;`;
    case "teradata":
      return `${drv}DBCName=${host};`;
    case "saphana":
      return `${drv}ServerNode=${host};`;
    case "redshift":
      return `${drv}Server=${host};Port=${port || "5439"};Database=${db};`;
    case "snowflake":
      return `${drv}Server=${host};${db ? `Database=${db};` : ""}`;
    default:
      return f.connection.trim() || (drv ? drv : "");
  }
}

const portError = "Port must be a number between 1 and 65535.";

/** Validates the form and builds the source for `table` (the chosen one by default). Returns an error message when something required is missing. */
export function buildSpec(f: ImportForm, table: string = f.pgTable): { spec: SourceSpec } | { error: string } {
  const q = f.query.trim();
  const hasQuery = q !== "";
  const needTable = (): string | null => (hasQuery || table.trim() ? null : "Choose a table.");
  const withQuery = hasQuery ? { query: q } : {};
  if (FILE_KINDS.includes(f.kind) && f.kind !== "access" && !f.path.trim()) return { error: "Choose a file." };
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
    case "xml":
      return { spec: { kind: "xml", path: f.path.trim(), ...(table ? { table } : {}) } };
    case "pdf":
      return { spec: { kind: "pdf", path: f.path.trim(), ...(table ? { table } : {}) } };
    case "fixedWidth": {
      const widths = f.widths.split(/[,\s]+/).filter(Boolean).map(Number);
      if (widths.length === 0 || widths.some((w) => !Number.isInteger(w) || w < 1)) return { error: "Enter the column widths as whole numbers, for example 4, 10, 3." };
      return { spec: { kind: "fixedWidth", path: f.path.trim(), widths, header: f.header } };
    }
    case "sqlserver": {
      const port = f.port.trim() === "" ? null : Number(f.port);
      if (!f.host.trim() || !f.database.trim()) return { error: "Server and database are required." };
      if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return { error: portError };
      const e = needTable();
      if (e) return { error: e };
      return { spec: { kind: "sqlserver", server: f.host.trim(), port, database: f.database.trim(), user: f.user.trim() || null, schema: f.schema.trim() || "dbo", table: table.trim(), ...withQuery, ...(f.trustCert ? { trustCertificate: true } : {}) } };
    }
    case "postgres": {
      const port = Number(f.port);
      if (!f.host.trim() || !f.database.trim() || !f.user.trim()) return { error: "Server, database and user are required." };
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: portError };
      const e = needTable();
      if (e) return { error: e };
      return { spec: { kind: "postgres", host: f.host.trim(), port, database: f.database.trim(), user: f.user.trim(), schema: f.schema.trim() || "public", table: table.trim(), ...withQuery } };
    }
    case "mysql": {
      const port = Number(f.port);
      if (!f.host.trim() || !f.database.trim() || !f.user.trim()) return { error: "Server, database and user are required." };
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: portError };
      const e = needTable();
      if (e) return { error: e };
      return { spec: { kind: "mysql", host: f.host.trim(), port, database: f.database.trim(), user: f.user.trim(), table: table.trim(), ...withQuery } };
    }
    case "inline": {
      const names = f.inlineColumns.map((c) => c.name.trim());
      if (names.length === 0 || names.some((n) => n === "")) return { error: "Every column needs a name." };
      if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return { error: "Column names must be different." };
      const rows = f.inlineRows.filter((r) => r.some((c) => c.trim() !== ""));
      if (rows.length === 0) return { error: "Type at least one row." };
      return { spec: { kind: "inline", columns: f.inlineColumns.map((c, i) => ({ name: names[i], type: c.type })), rows: rows.map((r) => f.inlineColumns.map((_, i) => (r[i] ?? "").trim() === "" ? null : r[i])) } };
    }
    case "oledb": {
      if (!f.connection.trim()) return { error: "Enter the OLE DB connection string, for example Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\\data\\shop.accdb" };
      if (/(^|;)\s*(password|pwd)\s*=/i.test(f.connection)) return { error: "Do not put the password in the connection string: enter it in the Password field, it is kept in Windows Credential Manager." };
      const e = needTable();
      if (e) return { error: e };
      return { spec: { kind: "oledb", connection: f.connection.trim(), user: f.user.trim() || null, table: table.trim() || null, ...withQuery } };
    }
    case "analysisServices": {
      if (!f.host.trim()) return { error: "Enter the server (a name, or host:port of a local instance)." };
      if (!f.database.trim()) return { error: "Enter the database (the model's name)." };
      if (/;/.test(f.host + f.database)) return { error: "The server and database names cannot contain a semicolon." };
      if (!hasQuery && !table.trim()) return { error: "Choose a table, or write a DAX (EVALUATE ...) or MDX query." };
      return { spec: { kind: "analysisServices", server: f.host.trim(), database: f.database.trim(), user: f.user.trim() || null, table: table.trim() || null, ...withQuery } };
    }
    case "python":
    case "r": {
      if (!f.code.trim()) return { error: f.kind === "r" ? "Write the R script. Every data.frame it leaves behind becomes a table." : "Write the Python script. Every pandas DataFrame it leaves behind becomes a table." };
      return { spec: { kind: "script", language: f.kind, code: f.code, table: table.trim() || null, home: f.home.trim() || null } };
    }
    case "blank":
      return { error: "A blank query has no data source: it opens in Power Query." };
    case "web": {
      if (!/^https?:\/\/\S+$/i.test(f.url.trim())) return { error: "Enter an http:// or https:// web address." };
      const rows = f.headers.filter((h) => h.name.trim() !== "" || h.value.trim() !== "");
      if (rows.some((h) => h.name.trim() === "")) return { error: "Every request header needs a name." };
      if (rows.some((h) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.name.trim()))) return { error: "A header name may only use letters, digits and - _ . ~ ! # $ % & ' * + ^ ` |." };
      if (rows.some((h) => /^(host|content-length|connection|transfer-encoding|upgrade|te|trailer|proxy-authorization)$/i.test(h.name.trim()))) return { error: "BIForge sets Host, Content-Length, Connection and similar headers itself." };
      if (rows.some((h) => /[\r\n]/.test(h.value))) return { error: "A header value must be on one line." };
      const headers = rows.map((h) => ({ name: h.name.trim(), value: h.secret ? null : h.value, secret: h.secret }));
      return { spec: { kind: "web", url: f.url.trim(), format: f.format === "auto" ? null : f.format, table: table || null, user: f.user.trim() || null, ...(headers.length ? { headers } : {}) } };
    }
    case "odata": {
      if (!/^https?:\/\/\S+$/i.test(f.url.trim())) return { error: "Enter the http:// or https:// address of the OData service." };
      if (!table.trim()) return { error: "Choose an entity set." };
      return { spec: { kind: "odata", url: f.url.trim(), entity: table.trim(), user: f.user.trim() || null } };
    }
    default: {
      // ODBC and its flavors
      const flavor = f.kind as OdbcFlavor;
      if (flavor === "access" && !f.path.trim()) return { error: "Choose an Access database file." };
      if (flavor !== "odbc" && flavor !== "access" && !f.host.trim()) return { error: "Server is required." };
      const connection = odbcConnection(f);
      if (!connection) return { error: "Enter a connection string or choose a driver." };
      if (/(^|;)\s*(pwd|password)\s*=/i.test(connection)) return { error: "Do not put the password in the connection string: use the Password field." };
      const e = needTable();
      if (e) return { error: e };
      return {
        spec: {
          kind: "odbc",
          flavor,
          connection,
          user: f.user.trim() || null,
          table: table.trim() || null,
          ...withQuery,
          ...(["odbc", "access"].includes(flavor) ? {} : { server: f.host.trim(), database: f.database.trim() || null }),
        },
      };
    }
  }
}

/** A sensible default table name from the source (file name without extension, or the database table). */
export function defaultTableName(spec: SourceSpec): string {
  const last = (t: string) => t.slice(t.lastIndexOf(".") + 1).replace(/\s*\(.*\)$/, "");
  switch (spec.kind) {
    case "sqlite":
    case "postgres":
    case "sqlserver":
    case "mysql":
      return spec.table || "Query";
    case "odbc":
      return spec.table ? last(spec.table) : "Query";
    case "odata":
      return spec.entity;
    case "oledb":
    case "analysisServices":
      return spec.table ? last(spec.table).replace(/^['"\[]|['"\]]$/g, "") : "Query";
    case "script":
      return spec.table || "Script";
    case "inline":
      return "Table";
    case "web":
      return spec.table ? spec.table : (() => {
        try {
          return new URL(spec.url).hostname.replace(/^www\./, "") || "Web";
        } catch {
          return "Web";
        }
      })();
    case "xml":
    case "pdf":
      if (spec.table) return last(spec.table).replace(/\s*\(.*\)$/, "");
  }
  const file = spec.path.split(/[\\/]/).pop() ?? "Table";
  const stem = file.replace(/\.[^.]+$/, "");
  const base = stem.trim() === "" ? "Table" : stem;
  return spec.kind === "excel" && spec.sheet ? spec.sheet : base;
}
