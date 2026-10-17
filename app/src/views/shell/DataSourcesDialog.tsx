import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input } from "@fluentui/react-components";
import { listDataSources, locationOf, type DataSourceInfo, type SourceLocation } from "../../core/data/dataSources";
import { useEnv } from "./ShellContext";

const FIELDS: { key: keyof SourceLocation; label: string }[] = [
  { key: "path", label: "File path" },
  { key: "host", label: "Server" },
  { key: "port", label: "Port" },
  { key: "database", label: "Database" },
  { key: "url", label: "Web address" },
  { key: "connection", label: "Connection string" },
  { key: "user", label: "User" },
];

function SourceRow({ src, onNote }: { src: DataSourceInfo; onNote(text: string): void }) {
  const env = useEnv();
  const engine = env.session.engine;
  const [stored, setStored] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"none" | "secret" | "change">("none");
  const [secret, setSecret] = useState("");
  const [loc, setLoc] = useState<SourceLocation>(locationOf(src.spec));
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    if (engine && src.hasSecret) engine.credentialExists(src.spec).then((b) => live && setStored(b)).catch(() => live && setStored(null));
    return () => {
      live = false;
    };
  }, [engine, src.spec, src.hasSecret, note]);

  const run = async (id: string, args: Record<string, unknown>, done: string) => {
    setBusy(true);
    const r = await env.registry.execute(id, args);
    setBusy(false);
    setNote(r.ok ? done : r.message);
    onNote(r.ok ? done : r.message);
    return r.ok;
  };
  const shown = FIELDS.filter((f) => f.key in locationOf(src.spec));

  return (
    <section aria-label={`Data source ${src.label}`} style={{ border: "1px solid var(--colorNeutralStroke2)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{src.label}</div>
      <div>Used by: {src.tables.join(", ")}</div>
      {src.hasSecret && <div role="status">{src.user ? `User ${src.user}: ` : ""}{stored === null ? "checking the stored password…" : stored ? "a password is stored in Windows Credential Manager" : "no password is stored"}</div>}
      {!src.hasSecret && src.kind !== "inline" && <div style={{ opacity: 0.8 }}>This source needs no stored password.</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {src.hasSecret && (
          <Button size="small" onClick={() => setMode(mode === "secret" ? "none" : "secret")}>
            Edit permissions
          </Button>
        )}
        {src.kind !== "inline" && (
          <Button size="small" onClick={() => setMode(mode === "change" ? "none" : "change")}>
            Change source…
          </Button>
        )}
      </div>
      {mode === "secret" && (
        <div role="group" aria-label="Permissions" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Input aria-label="New password" type="password" placeholder="Password (kept in Windows Credential Manager, never in the project)" value={secret} onChange={(_, d) => setSecret(d.value)} />
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              size="small"
              appearance="primary"
              disabled={busy || !secret}
              onClick={async () => {
                if (await run("data.source.setSecret", { id: src.id, secret }, "The password was stored.")) setSecret("");
              }}
            >
              Save password
            </Button>
            <Button size="small" disabled={busy || stored === false} onClick={() => void run("data.source.clearSecret", { id: src.id }, "The stored password was removed.")}>
              Clear permissions
            </Button>
          </div>
        </div>
      )}
      {mode === "change" && (
        <div role="group" aria-label="Change source" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {shown.map((f) => (
            <Input key={f.key} aria-label={f.label} placeholder={f.label} value={loc[f.key] ?? ""} onChange={(_, d) => setLoc({ ...loc, [f.key]: d.value })} />
          ))}
          <div style={{ fontSize: 12, opacity: 0.8 }}>Every table that reads from this source is refreshed from the new location. A table whose refresh fails keeps its old data.</div>
          <div>
            <Button size="small" appearance="primary" disabled={busy} onClick={() => void run("data.source.change", { id: src.id, location: loc }, "The source was changed and its tables were refreshed.")}>
              {busy ? "Refreshing…" : "Change and refresh"}
            </Button>
          </div>
        </div>
      )}
      {note && <div role="status">{note}</div>}
    </section>
  );
}

export function DataSourcesDialog() {
  const env = useEnv();
  const close = () => env.session.shell.closeDialog();
  useSyncExternalStore(env.session.store.subscribe, env.session.store.getSnapshot);
  const project = env.session.store.project;
  const sources = project ? listDataSources(project) : [];
  const [last, setLast] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface aria-label="Data source settings" style={{ maxWidth: 760, width: "92vw" }}>
        <DialogBody>
          <DialogTitle>Data source settings</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "68vh", overflowY: "auto" }}>
            {sources.length === 0 && <div>No table of this project reads from a data source yet.</div>}
            {sources.map((s) => (
              <SourceRow key={s.id} src={s} onNote={setLast} />
            ))}
            {last && <div role="status" aria-label="Result">{last}</div>}
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Passwords are kept in Windows Credential Manager and never written into the project. Privacy levels are not stored in a Power BI project file and BIForge never sends data from one source to another, so there is nothing to set here.
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={close}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
