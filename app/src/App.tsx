import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, Input, MessageBar, MessageBarBody, Text, Tree, TreeItem, TreeItemLayout } from "@fluentui/react-components";
import { createAppRuntime } from "./core/appRuntime";
import { eventToShortcut } from "./core/commands/registry";
import { listTables } from "./core/model/ops";
import { APP_NAME, STATUS_NOTICE } from "./core/info";

/**
 * Temporary Phase 1 host UI. It only dispatches registered commands and renders state; the real
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

  const tables = doc.project ? listTables(doc.project) : [];
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
        <MessageBarBody>{STATUS_NOTICE} This is a temporary Phase 1 host screen: ribbons, data, DAX and reports are not yet implemented.</MessageBarBody>
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
        <Tree aria-label="Model">
          {tables.map((t) => (
            <TreeItem key={t.name} itemType="branch" value={t.name}>
              <TreeItemLayout>{t.name}</TreeItemLayout>
              <Tree>
                {t.columns.map((c) => (
                  <TreeItem key={`c-${c.name}`} itemType="leaf" value={`${t.name}.${c.name}`}>
                    <TreeItemLayout>{c.name}{c.dataType ? ` (${c.dataType})` : ""}</TreeItemLayout>
                  </TreeItem>
                ))}
                {t.measures.map((m) => (
                  <TreeItem key={`m-${m.name}`} itemType="leaf" value={`${t.name}.[${m.name}]`}>
                    <TreeItemLayout>Σ {m.name}</TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          ))}
        </Tree>
      )}
    </main>
  );
}
