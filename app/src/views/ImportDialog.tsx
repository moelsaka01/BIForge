import { useState } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input, Select } from "@fluentui/react-components";
import type { EngineApi, SourceSpec } from "../core/data/types";
import type { Dialogs } from "../core/session/session";
import { errText } from "../core/session/session";
import { FILE_FILTERS, buildSpec, defaultTableName, emptyForm, type ImportForm, type SourceKind } from "./importForm";

export interface ImportDialogProps {
  open: boolean;
  /** The source type the form starts on. */
  initialKind?: SourceKind;
  engine: EngineApi;
  dialogs: Dialogs;
  /** Runs the import command; resolves to an error message or null. */
  onSubmit(name: string, spec: SourceSpec, password: string): Promise<string | null>;
  onClose(): void;
}

const KINDS: { kind: SourceKind; label: string }[] = [
  { kind: "csv", label: "Text/CSV" },
  { kind: "excel", label: "Excel workbook" },
  { kind: "json", label: "JSON" },
  { kind: "parquet", label: "Parquet" },
  { kind: "sqlite", label: "SQLite database" },
  { kind: "postgres", label: "PostgreSQL database" },
  { kind: "sqlserver", label: "SQL Server database" },
];

export function ImportDialog({ open, initialKind, engine, dialogs, onSubmit, onClose }: ImportDialogProps) {
  const [f, setF] = useState<ImportForm>(emptyForm(initialKind));
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ImportForm>) => setF((x) => ({ ...x, ...patch }));

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
    if (f.kind === "csv" || f.kind === "json" || f.kind === "parquet") {
      if (!name) setName(defaultTableName({ kind: f.kind, path } as never));
    }
    await loadChoices(next);
  };

  const listPg = async () => {
    const r = buildSpec({ ...f, pgTable: f.pgTable || "x" });
    if ("error" in r || (r.spec.kind !== "postgres" && r.spec.kind !== "sqlserver")) return setError("error" in r ? r.error : "Invalid server settings.");
    try {
      if (password) await engine.setCredential(r.spec, password);
      const tables = r.spec.kind === "sqlserver" ? await engine.sqlserverTables(r.spec) : await engine.postgresTables(r.spec);
      setChoices(tables);
      set({ pgTable: tables[0] ?? "" });
      if (!name && tables[0]) setName(tables[0]);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  };

  const submit = async () => {
    const r = buildSpec(f);
    if ("error" in r) return setError(r.error);
    const tableName = (name || defaultTableName(r.spec)).trim();
    setBusy(true);
    try {
      if ((r.spec.kind === "postgres" || r.spec.kind === "sqlserver") && password) await engine.setCredential(r.spec, password);
      const err = await onSubmit(tableName, r.spec, password);
      if (err) setError(err);
      else {
        setPassword("");
        setName("");
        setF(emptyForm(f.kind));
        setChoices([]);
        setError(null);
        onClose();
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface aria-label="Import data">
        <DialogBody>
          <DialogTitle>Import data</DialogTitle>
          <DialogContent style={{ display: "grid", gap: 8 }}>
            <label>
              Source{" "}
              <Select
                aria-label="Source type"
                value={f.kind}
                onChange={(_, d) => {
                  setF(emptyForm(d.value as SourceKind));
                  setChoices([]);
                  setError(null);
                }}
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </label>

            {f.kind !== "postgres" && f.kind !== "sqlserver" && (
              <div style={{ display: "flex", gap: 6 }}>
                <Input aria-label="File path" style={{ flex: 1 }} value={f.path} onChange={(_, d) => set({ path: d.value })} onBlur={() => void loadChoices(f)} />
                <Button onClick={() => void pick()}>Browse…</Button>
              </div>
            )}
            {f.kind === "csv" && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Input aria-label="Delimiter" placeholder="Delimiter (auto)" size="small" value={f.delimiter} onChange={(_, d) => set({ delimiter: d.value })} />
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
            {(f.kind === "postgres" || f.kind === "sqlserver") && (
              <>
                <Input aria-label="Server" placeholder="Server" value={f.host} onChange={(_, d) => set({ host: d.value })} />
                <Input aria-label="Port" placeholder={f.kind === "sqlserver" ? "Port (blank = 1433)" : "Port"} value={f.port} onChange={(_, d) => set({ port: d.value })} />
                <Input aria-label="Database" placeholder="Database" value={f.database} onChange={(_, d) => set({ database: d.value })} />
                <Input aria-label="User" placeholder={f.kind === "sqlserver" ? "User (blank = Windows authentication)" : "User"} value={f.user} onChange={(_, d) => set({ user: d.value })} />
                <Input
                  aria-label="Password"
                  type="password"
                  placeholder="Password (kept in Windows Credential Manager, never in the project)"
                  value={password}
                  onChange={(_, d) => setPassword(d.value)}
                />
                <Input aria-label="Schema" placeholder="Schema" value={f.schema} onChange={(_, d) => set({ schema: d.value })} />
                <div style={{ display: "flex", gap: 6 }}>
                  <Select aria-label="Database table" style={{ flex: 1 }} value={f.pgTable} onChange={(_, d) => set({ pgTable: d.value })}>
                    {choices.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                  <Button onClick={() => void listPg()}>List tables</Button>
                </div>
                {f.kind === "postgres" && <div style={{ fontSize: 11, opacity: 0.7 }}>Connections are not encrypted yet (no TLS); use only on trusted networks.</div>}
                {f.kind === "sqlserver" && <div style={{ fontSize: 11, opacity: 0.7 }}>Connections are encrypted; the server certificate must validate.</div>}
              </>
            )}
            <Input aria-label="Table name" placeholder="Table name" value={name} onChange={(_, d) => setName(d.value)} />
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
              {busy ? "Importing…" : "Import"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
