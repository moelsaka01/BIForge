import { useState } from "react";
import { Button, Input, Tree, TreeItem, TreeItemLayout } from "@fluentui/react-components";
import type { Project } from "../core/model/types";
import { listTables } from "../core/model/ops";
import { getTableSource } from "../core/model/tables";
import type { FieldRef } from "../core/report/fields";
import { FIELD_MIME } from "./report/VisualizationsPane";

export interface FieldUse {
  /** True when the field is used by the selected visual. */
  isUsed(f: FieldRef): boolean;
  /** Adds the field to the selected visual (or to a new one), or removes it when it is used. */
  onToggle(f: FieldRef): void;
}

export interface DataPaneProps {
  /** Present while the report is open: fields get a checkbox and can be dragged onto visuals. */
  fieldUse?: FieldUse;
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
                      <FieldLabel p={p} field={{ kind: "column", table: t.name, name: c.name }} glyph={typeGlyph(c.dataType)} />
                    </TreeItemLayout>
                  </TreeItem>
                ))}
                {t.measures.map((m) => (
                  <TreeItem key={`m-${m.name}`} itemType="leaf" value={`${t.name}.[${m.name}]`}>
                    <TreeItemLayout>
                      <FieldLabel p={p} field={{ kind: "measure", table: t.name, name: m.name }} glyph="fx" />
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

/** A field row: a checkbox (when a report is open) and a drag source for the report canvas. */
function FieldLabel({ p, field, glyph }: { p: DataPaneProps; field: FieldRef; glyph: string }) {
  const use = p.fieldUse;
  return (
    <span
      draggable={!!use}
      onDragStart={(e) => {
        e.dataTransfer.setData(FIELD_MIME, JSON.stringify(field));
        e.dataTransfer.effectAllowed = "copy";
      }}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      {use && (
        <input
          type="checkbox"
          aria-label={`Use ${field.name} in the selected visual`}
          checked={use.isUsed(field)}
          onChange={() => use.onToggle(field)}
          onClick={(e) => e.stopPropagation()}
          style={{ marginRight: 4 }}
        />
      )}
      <span style={{ opacity: 0.6, marginRight: 6 }}>{glyph}</span>
      {field.name}
    </span>
  );
}
