import { useState } from "react";
import { Button, Input, Tree, TreeItem, TreeItemLayout } from "@fluentui/react-components";
import type { Project } from "../core/model/types";
import { listTables } from "../core/model/ops";
import { getTableSource } from "../core/model/tables";

export interface DataPaneProps {
  project: Project;
  /** Tables that currently have data in the engine. */
  dataTables: string[];
  selected: string | null;
  onSelect(table: string): void;
  onRefresh(table: string): void;
  onRefreshAll(): void;
  onImport(): void;
  canImport: boolean;
}

const typeGlyph = (t: string | null) =>
  t === "int64" || t === "double" || t === "decimal" ? "Σ#" : t === "dateTime" ? "📅" : t === "boolean" ? "☑" : t === "string" ? "Abc" : "";

/** Field list: tables, their columns and measures, with search. Contains no logic beyond filtering and display. */
export function DataPane(p: DataPaneProps) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const loaded = new Set(p.dataTables.map((t) => t.toLowerCase()));
  const tables = listTables(p.project)
    .map((t) => {
      const tableHit = t.name.toLowerCase().includes(needle);
      const columns = t.columns.filter((c) => tableHit || c.name.toLowerCase().includes(needle));
      const measures = t.measures.filter((m) => tableHit || m.name.toLowerCase().includes(needle));
      return { ...t, columns, measures, show: needle === "" || tableHit || columns.length > 0 || measures.length > 0 };
    })
    .filter((t) => t.show);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, height: "100%", overflow: "auto" }} aria-label="Data pane">
      <strong>Data</strong>
      <Input size="small" placeholder="Search" aria-label="Search fields" value={q} onChange={(_, d) => setQ(d.value)} />
      <div style={{ display: "flex", gap: 4 }}>
        <Button size="small" disabled={!p.canImport} onClick={p.onImport}>
          Import data
        </Button>
        <Button size="small" disabled={!p.canImport} onClick={p.onRefreshAll}>
          Refresh all
        </Button>
      </div>
      <Tree aria-label="Fields">
        {tables.map((t) => {
          const refreshable = getTableSource(p.project, t.name) !== null;
          const hasData = loaded.has(t.name.toLowerCase());
          return (
            <TreeItem key={t.name} itemType="branch" value={t.name}>
              <TreeItemLayout
                onClick={() => p.onSelect(t.name)}
                style={{ fontWeight: p.selected === t.name ? 700 : 400 }}
              >
                {t.name}
                {refreshable && !hasData ? " (no data loaded)" : ""}
                {refreshable && (
                  <Button
                    size="small"
                    appearance="subtle"
                    aria-label={`Refresh ${t.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onRefresh(t.name);
                    }}
                  >
                    ⟳
                  </Button>
                )}
              </TreeItemLayout>
              <Tree>
                {t.columns.map((c) => (
                  <TreeItem key={`c-${c.name}`} itemType="leaf" value={`${t.name}.${c.name}`}>
                    <TreeItemLayout>
                      <span style={{ opacity: 0.6, marginRight: 6 }}>{typeGlyph(c.dataType)}</span>
                      {c.name}
                    </TreeItemLayout>
                  </TreeItem>
                ))}
                {t.measures.map((m) => (
                  <TreeItem key={`m-${m.name}`} itemType="leaf" value={`${t.name}.[${m.name}]`}>
                    <TreeItemLayout>
                      <span style={{ opacity: 0.6, marginRight: 6 }}>fx</span>
                      {m.name}
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          );
        })}
      </Tree>
      {tables.length === 0 && <div style={{ fontSize: 12, opacity: 0.7 }}>{needle ? "No matching fields." : "No tables yet. Choose Import data."}</div>}
    </div>
  );
}
