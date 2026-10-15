import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, Input, MessageBar, MessageBarBody, Tab, TabList, Text } from "@fluentui/react-components";
import { createAppRuntime } from "./core/appRuntime";
import { eventToShortcut } from "./core/commands/registry";
import { APP_NAME, STATUS_NOTICE } from "./core/info";
import { DataPane } from "./views/DataPane";
import { DataView } from "./views/DataView";
import { ModelView } from "./views/ModelView";
import { ImportDialog } from "./views/ImportDialog";

/**
 * Temporary host UI (Phases 1–2). It only dispatches registered commands and renders state; the real
 * Classic and Modern shells arrive in a later phase.
 */
export function App() {
  const rt = useMemo(createAppRuntime, []);
  const { session, registry } = rt;
  const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
  const sess = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [tableName, setTableName] = useState("");
  const [view, setView] = useState<"report" | "data" | "model">("model");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    setError(r.ok ? null : r.message);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sc = eventToShortcut(e);
      const cmd = sc ? registry.byShortcut(sc) : undefined;
      if (cmd && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        void run(cmd.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry]);

  const btn = (id: string, args?: unknown) => (
    <Button size="small" disabled={!registry.isEnabled(id)} onClick={() => void run(id, args)} title={registry.get(id)?.shortcut}>
      {registry.get(id)?.label}
    </Button>
  );

  return (
    <main style={{ padding: 16, display: "grid", gap: 12 }}>
      <Text as="h1" size={700} weight="semibold">
        {APP_NAME} {doc.project ? `— ${doc.project.name}${doc.isDirty ? " *" : ""}` : ""}
      </Text>
      <MessageBar intent="warning">
        <MessageBarBody data-testid="status-notice">{STATUS_NOTICE}</MessageBarBody>
      </MessageBar>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {sess.pendingRecovery && (
        <MessageBar intent="info">
          <MessageBarBody>
            Unsaved changes from an earlier session were found. {btn("file.restoreRecovery")} {btn("file.discardRecovery")}
          </MessageBarBody>
        </MessageBar>
      )}
      {sess.lastMessage && <Text size={200}>{sess.lastMessage}</Text>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Input size="small" placeholder="New project name" value={name} onChange={(_, d) => setName(d.value)} />
        <Button size="small" disabled={!name.trim()} onClick={() => void run("file.new", { name: name.trim() })}>
          {registry.get("file.new")?.label}…
        </Button>
        {btn("file.open")}
        {btn("file.save")}
        {btn("edit.undo")}
        {btn("edit.redo")}
        <Text size={200}>{doc.undoLabel ? `Undo: ${doc.undoLabel}` : ""}</Text>
      </div>

      {doc.project && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Input size="small" placeholder="Table name" value={tableName} onChange={(_, d) => setTableName(d.value)} />
          <Button size="small" disabled={!tableName.trim()} onClick={() => void run("model.addTable", { name: tableName })}>
            {registry.get("model.addTable")?.label}
          </Button>
        </div>
      )}

      {doc.project && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as typeof view)}>
            <Tab value="report">Report</Tab>
            <Tab value="data">Data</Tab>
            <Tab value="model">Model</Tab>
          </TabList>
          <div style={{ display: "flex", height: "62vh", border: "1px solid #ddd" }}>
            <div style={{ width: 260, borderRight: "1px solid #ddd", flex: "none" }}>
              <DataPane
                project={doc.project}
                dataTables={sess.dataTables}
                selected={selectedTable}
                canImport={registry.isEnabled("data.import")}
                onSelect={(t) => {
                  setSelectedTable(t);
                  setView((v) => (v === "report" ? "data" : v));
                }}
                onRefresh={(t) => void run("data.refreshTable", { name: t }).then(() => setReloadKey((k) => k + 1))}
                onRefreshAll={() => void run("data.refreshAll").then(() => setReloadKey((k) => k + 1))}
                onImport={() => setImportOpen(true)}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {view === "report" && (
                <div style={{ padding: 16 }}>
                  <MessageBar intent="warning">
                    <MessageBarBody>Not yet implemented: the report canvas arrives in a later phase.</MessageBarBody>
                  </MessageBar>
                </div>
              )}
              {view === "data" && session.engine && <DataView engine={session.engine} table={selectedTable} reloadKey={reloadKey + sess.dataTables.length} />}
              {view === "model" && <ModelView project={doc.project} session={session} registry={registry} engine={session.engine} onError={setError} />}
            </div>
          </div>
        </div>
      )}
      {session.engine && (
        <ImportDialog
          open={importOpen}
          engine={session.engine}
          dialogs={session.dialogs}
          onClose={() => setImportOpen(false)}
          onSubmit={async (name, spec) => {
            const r = await registry.execute("data.import", { name, spec });
            if (r.ok) setSelectedTable(name);
            setReloadKey((k) => k + 1);
            return r.ok ? null : r.message;
          }}
        />
      )}
    </main>
  );
}
