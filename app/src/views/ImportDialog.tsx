import { useEffect, useState } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input, Select, Textarea } from "@fluentui/react-components";
import type { EngineApi, InlineType, RowPage, SourceSpec } from "../core/data/types";
import type { Dialogs } from "../core/session/session";
import { errText } from "../core/session/session";
import {
  CONNECTORS,
  DRIVER_PATTERNS,
  FILE_FILTERS,
  FILE_KINDS,
  NAVIGATOR_KINDS,
  ODBC_KINDS,
  SECRET_KINDS,
  SERVER_KINDS,
  buildSpec,
  defaultTableName,
  emptyForm,
  type ConnectorGroup,
  type ConnectorId,
  type ImportForm,
} from "./importForm";

export interface ImportDialogProps {
  open: boolean;
  /** The source type the form starts on. */
  initialKind?: ConnectorId;
  engine: EngineApi;
  dialogs: Dialogs;
  /** Runs the import command; resolves to an error message or null. */
  onSubmit(name: string, spec: SourceSpec, password: string): Promise<string | null>;
  /** Blank query: opens Power Query with a new empty query (no data source). */
  onBlank?(): Promise<string | null>;
  /** The interpreter folders from File > Options (Python home, R home). */
  scriptHomes?: { python: string; r: string };
  onClose(): void;
}

const GROUPS: ConnectorGroup[] = ["File", "Database", "Online and other"];
const SQL_KINDS: ConnectorId[] = ["sqlserver", "postgres", "mysql", "oledb", ...ODBC_KINDS.filter((k) => k !== "access")];
const NOTES: Partial<Record<ConnectorId, string>> = {
  postgres: "Connections are not encrypted yet (no TLS); use only on trusted networks.",
  mysql: "Connections are not encrypted yet (no TLS); use only on trusted networks.",
  sqlserver: "Connections are encrypted; the server certificate must validate.",
  pdf: "Finds text laid out in rows and columns. Scanned pages and PDFs with unusual text encodings give no table.",
  web: "BIForge reads the page or response once per refresh. A web page needs its tables in the HTML (not drawn by scripts).",
  odata: "OData v4 (JSON). Entity sets are listed from the service.",
  saphana: "Needs the SAP HANA ODBC driver on this computer.",
  oledb: "Needs the provider named in the connection string on this computer, in its 64-bit version (for example Microsoft.ACE.OLEDB.12.0 for Access and Excel files). Windows only.",
  analysisServices: "Needs the MSOLAP provider (installed with Power BI Desktop and SQL Server tools). For a Power BI Desktop instance that is running, the server is localhost:<port> and the database is the model's id.",
  python: "Runs your own Python 3 with pandas (BIForge ships none). Every pandas DataFrame the script leaves behind becomes a table.",
  r: "Runs your own R (BIForge ships none). Every data.frame the script leaves behind becomes a table.",
  blank: "A blank query has no data source. It opens in Power Query, where you write the M yourself.",
};

const HOST_LABEL: Partial<Record<ConnectorId, string>> = {
  oracle: "Server (host:port/service name, or a TNS alias)",
  teradata: "Server",
  saphana: "Server (host:port)",
  snowflake: "Server (account.snowflakecomputing.com)",
  redshift: "Server (cluster endpoint)",
  db2: "Server (host name)",
};

const INLINE_TYPES: { value: InlineType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "whole", label: "Whole number" },
  { value: "decimal", label: "Decimal number" },
  { value: "logical", label: "True/False" },
  { value: "date", label: "Date (yyyy-mm-dd)" },
  { value: "datetime", label: "Date and time" },
];

/** The Enter data grid: named, typed columns and rows of cells. */
function EnterDataGrid({ f, set }: { f: ImportForm; set(patch: Partial<ImportForm>): void }) {
  const cols = f.inlineColumns;
  const setCol = (i: number, patch: Partial<(typeof cols)[number]>) => set({ inlineColumns: cols.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setCell = (r: number, c: number, v: string) => set({ inlineRows: f.inlineRows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)) });
  return (
    <div role="group" aria-label="Enter data" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ overflow: "auto", maxHeight: 260 }}>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={i} style={{ padding: 2, verticalAlign: "top" }}>
                  <Input size="small" aria-label={`Name of column ${i + 1}`} value={c.name} onChange={(_, d) => setCol(i, { name: d.value })} />
                  <Select size="small" aria-label={`Type of column ${i + 1}`} value={c.type} onChange={(_, d) => setCol(i, { type: d.value as InlineType })}>
                    {INLINE_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                  <Button size="small" appearance="subtle" aria-label={`Remove column ${i + 1}`} disabled={cols.length < 2} onClick={() => set({ inlineColumns: cols.filter((_, j) => j !== i), inlineRows: f.inlineRows.map((r) => r.filter((_, j) => j !== i)) })}>
                    ✕
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {f.inlineRows.map((row, r) => (
              <tr key={r}>
                {cols.map((_, c) => (
                  <td key={c} style={{ padding: 2 }}>
                    <Input size="small" aria-label={`Row ${r + 1}, column ${c + 1}`} value={row[c] ?? ""} onChange={(_, d) => setCell(r, c, d.value)} />
                  </td>
                ))}
                <td>
                  <Button size="small" appearance="subtle" aria-label={`Remove row ${r + 1}`} onClick={() => set({ inlineRows: f.inlineRows.filter((_, i) => i !== r) })}>
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button size="small" onClick={() => set({ inlineRows: [...f.inlineRows, cols.map(() => "")] })}>
          Add row
        </Button>
        <Button
          size="small"
          onClick={() => set({ inlineColumns: [...cols, { name: `Column${cols.length + 1}`, type: "text" }], inlineRows: f.inlineRows.map((r) => [...r, ""]) })}
        >
          Add column
        </Button>
      </div>
    </div>
  );
}

export function ImportDialog({ open, initialKind, engine, dialogs, onSubmit, onBlank, scriptHomes, onClose }: ImportDialogProps) {
  const homeOf = (kind: ConnectorId) => (kind === "python" ? (scriptHomes?.python ?? "") : kind === "r" ? (scriptHomes?.r ?? "") : "");
  const [f, setF] = useState<ImportForm>(() => ({ ...emptyForm(initialKind), home: homeOf(initialKind ?? "csv") }));
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [preview, setPreview] = useState<RowPage | null>(null);
  const [drivers, setDrivers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A script runs with the user's rights: the box must be ticked before BIForge runs it. */
  const [scriptOk, setScriptOk] = useState(false);
  const set = (patch: Partial<ImportForm>) => setF((x) => ({ ...x, ...patch }));
  const navigator = NAVIGATOR_KINDS.includes(f.kind);
  const isOdbc = ODBC_KINDS.includes(f.kind);
  const isServer = SERVER_KINDS.includes(f.kind);

  useEffect(() => {
    if (!isOdbc) return;
    let live = true;
    engine
      .odbcDrivers()
      .then((all) => {
        if (!live) return;
        const re = DRIVER_PATTERNS[f.kind];
        const list = re ? all.filter((d) => re.test(d)) : all;
        setDrivers(list);
        if (re && list.length > 0 && !list.includes(f.driver)) setF((x) => ({ ...x, driver: list[0] }));
      })
      .catch(() => live && setDrivers([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.kind, isOdbc]);

  const reset = (kind: ConnectorId) => {
    setF({ ...emptyForm(kind), home: homeOf(kind) });
    setScriptOk(false);
    setChoices([]);
    setShown(null);
    setPreview(null);
    setError(null);
  };

  const loadChoices = async (next: ImportForm) => {
    setChoices([]);
    try {
      if (next.kind === "excel" && next.path) {
        const sheets = await engine.excelSheets(next.path);
        setChoices(sheets);
        set({ sheet: sheets[0] ?? "" });
        if (!name && sheets[0]) setName(defaultTableName({ kind: "excel", path: next.path, sheet: sheets[0] }));
      } else if (next.kind === "sqlite" && next.path) {
        const tables = await engine.sqliteTables(next.path);
        setChoices(tables);
        set({ sqliteTable: tables[0] ?? "" });
        if (!name && tables[0]) setName(tables[0]);
      } else if ((next.kind === "xml" || next.kind === "pdf" || next.kind === "access") && next.path) {
        await listTables(next);
      }
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  };

  const pick = async () => {
    const flt = FILE_FILTERS[f.kind];
    const path = await dialogs.pickFile(flt.label, flt.extensions);
    if (!path) return;
    const next = { ...f, path };
    set({ path });
    if (f.kind === "csv" || f.kind === "json" || f.kind === "parquet" || f.kind === "fixedWidth") {
      if (!name) setName(defaultTableName({ kind: f.kind, path } as never));
    }
    await loadChoices(next);
  };

  /** The values of secret request headers go to the credential store; the source description keeps none. */
  async function storeHeaderSecrets(spec: SourceSpec, form: ImportForm) {
    if (spec.kind !== "web") return;
    for (const h of spec.headers ?? []) {
      const row = form.headers.find((x) => x.name.trim() === h.name);
      if (h.secret && row && row.value !== "") await engine.setHeaderSecret(spec, h.name, row.value);
    }
  }

  /** Asks the source what it offers: the navigator list. */
  async function listTables(form: ImportForm = f) {
    const r = buildSpec({ ...form, query: "" }, "x");
    if ("error" in r) return setError(r.error);
    try {
      if (password && SECRET_KINDS.includes(form.kind)) await engine.setCredential(r.spec, password);
      await storeHeaderSecrets(r.spec, form);
      const tables = await engine.sourceChoices(r.spec);
      setChoices(tables);
      setShown(tables[0] ?? null);
      set({ pgTable: tables[0] ?? "", selected: tables.length === 1 ? [tables[0]] : [] });
      if (tables[0]) void showPreview(form, tables[0]);
      setError(tables.length === 0 ? "The source has no tables to show." : null);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function showPreview(form: ImportForm, table: string) {
    setShown(table);
    const r = buildSpec({ ...form, query: "" }, table);
    if ("error" in r) return;
    try {
      setPreview(await engine.sourcePreview(r.spec, 20));
    } catch (e) {
      setPreview(null);
      setError(errText(e));
    }
  }

  const toggle = (t: string, on: boolean) => set({ selected: on ? [...f.selected, t] : f.selected.filter((x) => x !== t), pgTable: on ? t : f.pgTable });

  const submit = async () => {
    if (f.kind === "blank") {
      setBusy(true);
      try {
        const err = onBlank ? await onBlank() : "Blank queries are not available here.";
        if (err) setError(err);
        else onClose();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    if ((f.kind === "python" || f.kind === "r") && !scriptOk) return setError("Tick the box to confirm that this script may run on your computer.");
    // one source per ticked table; a custom SQL statement (or a source without a list) is a single source
    const hasQuery = f.query.trim() !== "";
    const tables = !navigator || hasQuery ? [f.pgTable] : f.selected.length > 0 ? f.selected : choices.length === 0 && f.pgTable ? [f.pgTable] : [];
    if (navigator && !hasQuery && tables.length === 0 && f.kind !== "web" && f.kind !== "xml" && f.kind !== "pdf" && f.kind !== "python" && f.kind !== "r") return setError("Tick at least one table.");
    const builds = (tables.length === 0 ? [""] : tables).map((t) => buildSpec(f, t));
    const bad = builds.find((b) => "error" in b);
    if (bad && "error" in bad) return setError(bad.error);
    setBusy(true);
    try {
      let n = 0;
      for (const b of builds) {
        if (!("spec" in b)) continue;
        const spec = b.spec;
        const tableName = (builds.length === 1 && name ? name : defaultTableName(spec)).trim();
        if (password && SECRET_KINDS.includes(f.kind)) await engine.setCredential(spec, password);
        await storeHeaderSecrets(spec, f);
        const err = await onSubmit(tableName, spec, password);
        if (err) {
          setError(builds.length > 1 ? `${tableName}: ${err}` : err);
          return;
        }
        n++;
      }
      if (n > 0) {
        setPassword("");
        setName("");
        reset(f.kind);
        onClose();
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const userLabel = f.kind === "sqlserver" ? "User (blank = Windows authentication)" : f.kind === "web" || f.kind === "odata" ? "User for Basic authentication (blank = none)" : "User";
  const showPassword = isServer || f.kind === "odbc" || f.kind === "access" || ((f.kind === "web" || f.kind === "odata" || f.kind === "oledb" || f.kind === "analysisServices") && f.user.trim() !== "");

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface aria-label="Import data" style={{ maxWidth: 820, width: "92vw" }}>
        <DialogBody>
          <DialogTitle>Import data</DialogTitle>
          <DialogContent style={{ display: "grid", gap: 8, maxHeight: "70vh", overflowY: "auto" }}>
            <label>
              Source{" "}
              <Select aria-label="Source type" value={f.kind} onChange={(_, d) => reset(d.value as ConnectorId)}>
                {GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {CONNECTORS.filter((c) => c.group === g).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </label>

            {FILE_KINDS.includes(f.kind) && (
              <div style={{ display: "flex", gap: 6 }}>
                <Input aria-label="File path" style={{ flex: 1 }} value={f.path} onChange={(_, d) => set({ path: d.value })} onBlur={() => void loadChoices(f)} />
                <Button onClick={() => void pick()}>Browse…</Button>
              </div>
            )}
            {(f.kind === "csv" || f.kind === "fixedWidth") && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {f.kind === "csv" && <Input aria-label="Delimiter" placeholder="Delimiter (auto)" size="small" value={f.delimiter} onChange={(_, d) => set({ delimiter: d.value })} />}
                {f.kind === "fixedWidth" && <Input aria-label="Column widths" placeholder="Column widths, e.g. 4, 10, 3" value={f.widths} onChange={(_, d) => set({ widths: d.value })} />}
                <Checkbox label="First row is header" checked={f.header} onChange={(_, d) => set({ header: !!d.checked })} />
              </div>
            )}
            {f.kind === "excel" && (
              <>
                <Select aria-label="Sheet" value={f.sheet} onChange={(_, d) => set({ sheet: d.value })}>
                  {choices.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
                <Checkbox label="First row is header" checked={f.header} onChange={(_, d) => set({ header: !!d.checked })} />
              </>
            )}
            {f.kind === "sqlite" && (
              <Select aria-label="Database table" value={f.sqliteTable} onChange={(_, d) => set({ sqliteTable: d.value })}>
                {choices.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            )}

            {(f.kind === "web" || f.kind === "odata") && (
              <>
                <Input aria-label="Web address" placeholder={f.kind === "odata" ? "https://services.odata.org/V4/Northwind/Northwind.svc" : "https://example.com/page-or-api"} value={f.url} onChange={(_, d) => set({ url: d.value })} />
                {f.kind === "web" && (
                  <fieldset aria-label="Request headers" style={{ border: "1px solid var(--colorNeutralStroke2)", padding: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                    <legend>Request headers (optional)</legend>
                    {f.headers.map((h, i) => (
                      <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <Input aria-label={`Header name ${i + 1}`} placeholder="Name, for example X-Api-Key" value={h.name} onChange={(_, d) => set({ headers: f.headers.map((x, j) => (j === i ? { ...x, name: d.value } : x)) })} />
                        <Input aria-label={`Header value ${i + 1}`} type={h.secret ? "password" : "text"} placeholder="Value" value={h.value} onChange={(_, d) => set({ headers: f.headers.map((x, j) => (j === i ? { ...x, value: d.value } : x)) })} />
                        <Checkbox label="Secret" checked={h.secret} onChange={(_, d) => set({ headers: f.headers.map((x, j) => (j === i ? { ...x, secret: d.checked === true } : x)) })} />
                        <Button size="small" aria-label={`Remove header ${i + 1}`} onClick={() => set({ headers: f.headers.filter((_, j) => j !== i) })}>
                          Remove
                        </Button>
                      </div>
                    ))}
                    <div style={{ fontSize: 12 }}>A secret header's value is kept in Windows Credential Manager and is not written into the project or the query. Plain headers are written into the query.</div>
                    <div>
                      <Button size="small" onClick={() => set({ headers: [...f.headers, { name: "", value: "", secret: false }] })}>
                        Add a header
                      </Button>
                    </div>
                  </fieldset>
                )}
                {f.kind === "web" && (
                  <Select aria-label="Response format" value={f.format} onChange={(_, d) => set({ format: d.value })}>
                    <option value="auto">Detect the format</option>
                    <option value="html">HTML page (tables)</option>
                    <option value="json">JSON</option>
                    <option value="csv">CSV</option>
                    <option value="xml">XML</option>
                  </Select>
                )}
              </>
            )}

            {f.kind === "oledb" && <Input aria-label="OLE DB connection string" placeholder="Provider=…;Data Source=…  (no password here)" value={f.connection} onChange={(_, d) => set({ connection: d.value })} />}
            {f.kind === "analysisServices" && (
              <>
                <Input aria-label="Server" placeholder="Server (name, or localhost:port of a local instance)" value={f.host} onChange={(_, d) => set({ host: d.value })} />
                <Input aria-label="Database" placeholder="Database (the model's name)" value={f.database} onChange={(_, d) => set({ database: d.value })} />
                <Textarea aria-label="DAX or MDX query" resize="vertical" placeholder="EVALUATE 'Sales'   (or a DAX or MDX query; blank = choose a table below)" value={f.query} onChange={(_, d) => set({ query: d.value })} />
              </>
            )}
            {(f.kind === "python" || f.kind === "r") && (
              <>
                <Textarea aria-label="Script" resize="vertical" rows={8} style={{ fontFamily: "Consolas, monospace" }} placeholder={f.kind === "r" ? "df <- data.frame(a = 1:3, b = c('x', 'y', 'z'))" : "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2, 3]})"} value={f.code} onChange={(_, d) => set({ code: d.value })} />
                <Input aria-label="Interpreter folder" placeholder={`Folder of ${f.kind === "r" ? "R" : "Python"} (blank = look for it; set once in File > Options and settings)`} value={f.home} onChange={(_, d) => set({ home: d.value })} />
                <Checkbox label="I understand that this script runs on my computer with my user rights" checked={scriptOk} onChange={(_, d) => setScriptOk(d.checked === true)} />
              </>
            )}
            {isServer && (
              <>
                <Input aria-label="Server" placeholder={HOST_LABEL[f.kind] ?? "Server"} value={f.host} onChange={(_, d) => set({ host: d.value })} />
                {["sqlserver", "postgres", "mysql", "db2", "redshift"].includes(f.kind) && <Input aria-label="Port" placeholder={f.kind === "sqlserver" ? "Port (blank = 1433)" : "Port"} value={f.port} onChange={(_, d) => set({ port: d.value })} />}
                <Input aria-label="Database" placeholder={f.kind === "oracle" || f.kind === "teradata" || f.kind === "saphana" ? "Database (optional)" : "Database"} value={f.database} onChange={(_, d) => set({ database: d.value })} />
              </>
            )}
            {isOdbc && (
              <>
                {drivers.length > 0 || f.kind !== "odbc" ? (
                  <Select aria-label="ODBC driver" value={f.driver} onChange={(_, d) => set({ driver: d.value })}>
                    {f.kind === "odbc" && <option value="">(use the connection string)</option>}
                    {drivers.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </Select>
                ) : null}
                {drivers.length === 0 && f.kind !== "odbc" && (
                  <div role="note" style={{ fontSize: 12 }}>
                    No matching ODBC driver is installed on this computer. Install the vendor's 64-bit ODBC driver, then open this dialog again.
                  </div>
                )}
                {f.kind === "odbc" && <Input aria-label="Connection string" placeholder="Driver={…};Server=…;Database=…  or  DSN=name  (no password here)" value={f.connection} onChange={(_, d) => set({ connection: d.value })} />}
              </>
            )}
            {(isServer || isOdbc || f.kind === "web" || f.kind === "odata" || f.kind === "oledb" || f.kind === "analysisServices") && <Input aria-label="User" placeholder={userLabel} value={f.user} onChange={(_, d) => set({ user: d.value })} />}
            {showPassword && (
              <Input aria-label="Password" type="password" placeholder="Password (kept in Windows Credential Manager, never in the project)" value={password} onChange={(_, d) => setPassword(d.value)} />
            )}
            {f.kind === "sqlserver" && <Checkbox label="Trust the server certificate (for a self-signed certificate; the connection stays encrypted)" checked={f.trustCert} onChange={(_, d) => set({ trustCert: !!d.checked })} />}
            {(f.kind === "sqlserver" || f.kind === "postgres") && <Input aria-label="Schema" placeholder="Schema" value={f.schema} onChange={(_, d) => set({ schema: d.value })} />}

            {f.kind === "inline" && <EnterDataGrid f={f} set={set} />}

            {SQL_KINDS.includes(f.kind) && (
              <details>
                <summary>Advanced options: SQL statement</summary>
                <Textarea aria-label="SQL statement" resize="vertical" placeholder="SELECT … (optional; replaces the table). BIForge runs exactly this text." value={f.query} onChange={(_, d) => set({ query: d.value })} />
              </details>
            )}

            {navigator && (
              <div>
                <Button disabled={(f.kind === "python" || f.kind === "r") && !scriptOk} onClick={() => void listTables()}>{f.kind === "web" || f.kind === "xml" || f.kind === "pdf" ? "Show tables" : f.kind === "python" || f.kind === "r" ? "Run the script and list its tables" : "List tables"}</Button>
              </div>
            )}
            {navigator && choices.length > 0 && (
              <div role="group" aria-label="Navigator" style={{ display: "flex", gap: 10, border: "1px solid var(--colorNeutralStroke2)", padding: 6, minHeight: 120 }}>
                <ul aria-label="Tables" style={{ listStyle: "none", margin: 0, padding: 0, minWidth: 190, maxHeight: 220, overflowY: "auto" }}>
                  {choices.map((t) => (
                    <li key={t} style={{ display: "flex", alignItems: "center", gap: 4, background: shown === t ? "var(--colorNeutralBackground1Selected)" : undefined }}>
                      <Checkbox aria-label={`Select ${t}`} checked={f.selected.includes(t)} onChange={(_, d) => toggle(t, !!d.checked)} />
                      <button type="button" onClick={() => void showPreview(f, t)} style={{ all: "unset", cursor: "pointer", flex: 1 }}>
                        {t}
                      </button>
                    </li>
                  ))}
                </ul>
                <div style={{ flex: 1, overflow: "auto", maxHeight: 220, fontSize: 12 }} aria-label="Preview">
                  {preview && preview.columns.length > 0 ? (
                    <table style={{ borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          {preview.columns.map((c) => (
                            <th key={c.name} style={{ textAlign: "left", padding: "2px 6px", borderBottom: "1px solid var(--colorNeutralStroke2)" }}>
                              {c.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((r, i) => (
                          <tr key={i}>
                            {r.map((v, j) => (
                              <td key={j} style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>
                                {v ?? ""}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <span style={{ opacity: 0.7 }}>Click a name to preview its first rows.</span>
                  )}
                </div>
              </div>
            )}

            {NOTES[f.kind] && <div style={{ fontSize: 11, opacity: 0.7 }}>{NOTES[f.kind]}</div>}
            <Input aria-label="Table name" placeholder={navigator && f.selected.length > 1 ? "Each table keeps its own name" : "Table name"} disabled={navigator && f.selected.length > 1} value={name} onChange={(_, d) => setName(d.value)} />
            {error && (
              <div role="alert" style={{ color: "#a4262c" }}>
                {error}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? "Importing…" : f.selected.length > 1 ? `Import ${f.selected.length} tables` : "Import"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
