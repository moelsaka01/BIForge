import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, Input, MessageBar, MessageBarBody, Tab, TabList, Text } from "@fluentui/react-components";
import { createAppRuntime } from "./core/appRuntime";
import { eventToShortcut } from "./core/commands/registry";
import { APP_NAME, STATUS_NOTICE } from "./core/info";
import { DataPane } from "./views/DataPane";
import { DataView } from "./views/DataView";
import { ModelView } from "./views/ModelView";
import { ImportDialog } from "./views/ImportDialog";
import { MeasureEditor } from "./views/MeasureEditor";
import { createMonacoEditor } from "./core/dax/monaco";
import { ReportView } from "./views/report/ReportView";
import { PowerQueryEditor } from "./views/pq/PowerQueryEditor";
import { modelInfo } from "./core/report/modelInfo";
import { asValueField, routeField, usedIn } from "./core/report/fieldRouting";
import { parseVisual, visualKey } from "./core/report/visualDoc";
import type { FieldRef } from "./core/report/fields";
import type { DataPaneProps } from "./views/DataPane";

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
  const [view, setView] = useState<"report" | "data" | "model" | "measures">("report");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selVisual, setSelVisual] = useState<{ page: string; visual: string } | null>(null);

  const fieldUse: DataPaneProps["fieldUse"] = view === "report" && doc.project ? (() => {
    const project = doc.project;
    const visual = selVisual ? parseVisual(selVisual.page, project.report.files[visualKey(selVisual.page, selVisual.visual)]) : null;
    return {
      isUsed: (f: FieldRef) => !!visual && usedIn(visual, f) !== null,
      onToggle: (f: FieldRef) => {
        const m = modelInfo(project);
        if (visual) {
          const used = usedIn(visual, f);
          if (used) return void run("report.field.remove", { page: visual.pageName, visual: visual.name, role: used.role, index: used.index });
          const route = routeField(project, m, visual, f);
          if (!route) return setError("This visual has no field well for that field.");
          return void run("report.field.add", { page: visual.pageName, visual: visual.name, role: route.role, field: route.field });
        }
        // nothing selected: start a table with the field
        void run("report.visual.add", { type: "tableEx", fields: [{ role: "Values", field: f.kind === "measure" ? f : f.kind === "column" ? f : asValueField(m, f) }] });
      },
    };
  })() : undefined;

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
        {btn("query.editor.open")}
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
            <Tab value="measures">Measures</Tab>
          </TabList>
          <div style={{ display: "flex", height: view === "report" ? "76vh" : "62vh", minHeight: 480, border: "1px solid #ddd" }}>
            <div style={{ width: 260, borderRight: "1px solid #ddd", flex: "none" }}>
              <DataPane
                project={doc.project}
                fieldUse={fieldUse}
                dataTables={sess.dataTables}
                selected={selectedTable}
                canImport={registry.isEnabled("data.import")}
                onSelect={(t) => {
                  setSelectedTable(t);
                }}
                onRefresh={(t) => void run("data.refreshTable", { name: t }).then(() => setReloadKey((k) => k + 1))}
                onRefreshAll={() => void run("data.refreshAll").then(() => setReloadKey((k) => k + 1))}
                onImport={() => setImportOpen(true)}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {view === "report" && <ReportView project={doc.project} runtime={session.report} dax={rt.dax} dispatch={(id, args) => void run(id, args)} dataEpoch={reloadKey} onSelectVisual={(page, visual) => setSelVisual(page && visual ? { page, visual } : null)} />}
              {view === "data" && session.engine && <DataView engine={session.engine} table={selectedTable} reloadKey={reloadKey + sess.dataTables.length} />}
              {view === "measures" && <MeasureEditor project={doc.project} dax={rt.dax} registry={registry} factory={createMonacoEditor} onError={setError} />}
              {view === "model" && <ModelView project={doc.project} session={session} registry={registry} engine={session.engine} onError={setError} />}
            </div>
          </div>
        </div>
      )}
      <PowerQueryEditor session={session} registry={registry} />
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
