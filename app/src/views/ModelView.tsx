import { Fragment, useRef, useState } from "react";
import type { CommandRegistry } from "../core/commands/registry";
import type { Session } from "../core/session/session";
import type { Project } from "../core/model/types";
import type { EngineApi } from "../core/data/types";
import { listTables, type TableView } from "../core/model/ops";
import { getTableSource } from "../core/model/tables";
import { PaneFrame } from "./shell/PaneFrame";
import { ModelProperties } from "./ModelProperties";
import { FieldIcon, fieldIconKind } from "./fieldIcon";
import { getProperty, listHierarchies } from "../core/model/modeling";
import { listRelationships, type EndCardinality, type NewRelationship, type Relationship } from "../core/model/relationships";

const CARD_W = 220;
const HEAD_H = 28;
const ROW_H = 22;
const GAP_X = 70;
const GAP_Y = 40;
const COLS = 4;
const MAX_ROWS = 14;
const CARD_PAD = 10; // border (2) + bottom padding (8): the card is always tall enough for its rows

const TYPE_NAMES: Record<string, string> = { int64: "Whole number", double: "Decimal number", decimal: "Fixed decimal number", dateTime: "Date/time", string: "Text", boolean: "True/false", binary: "Binary" };

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Automatic grid layout; card positions are not user-editable yet. */
export function layoutCards(tables: { name: string; columns: unknown[]; measures?: unknown[]; hierarchies?: unknown[]; folders?: number }[]): Map<string, Box> {
  const out = new Map<string, Box>();
  const rowBottoms: number[] = [];
  tables.forEach((t, i) => {
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    const h = HEAD_H + Math.min(Math.max(t.columns.length + (t.measures?.length ?? 0) + (t.hierarchies?.length ?? 0) + (t.folders ?? 0), 1), MAX_ROWS) * ROW_H + CARD_PAD;
    const y = r === 0 ? 20 : rowBottoms[r - 1] + GAP_Y;
    rowBottoms[r] = Math.max(rowBottoms[r] ?? 0, y + h);
    out.set(t.name, { x: 20 + c * (CARD_W + GAP_X), y, w: CARD_W, h });
  });
  return out;
}

/** Point on the card's border facing `toward`, at the card's vertical middle. */
function anchor(a: Box, b: Box): { x: number; y: number; side: 1 | -1 } {
  const right = b.x + b.w / 2 >= a.x + a.w / 2;
  return { x: right ? a.x + a.w : a.x, y: a.y + a.h / 2, side: right ? 1 : -1 };
}

function describe(r: Relationship): string {
  const end = (c: EndCardinality) => (c === "one" ? "1" : "*");
  return `${r.fromTable}[${r.fromColumn}] ${end(r.fromCardinality)}:${end(r.toCardinality)} ${r.toTable}[${r.toColumn}]${r.isActive ? "" : " (inactive)"}`;
}

export interface ModelViewProps {
  project: Project;
  session: Session;
  registry: CommandRegistry<Session>;
  engine: EngineApi | null;
  onError(message: string | null): void;
  /** The collapsible Properties pane. Without it the pane is always shown (used by tests). */
  properties?: { open: boolean; width: number; onOpenChange(open: boolean): void; onResize(width: number): void };
}

type Sel = { kind: "none" } | { kind: "rel"; id: string } | { kind: "table"; table: string } | { kind: "column"; table: string; column: string } | { kind: "measure"; table: string; name: string };

export function ModelView({ project, session, registry, engine, onError, properties }: ModelViewProps) {
  const tables = listTables(project);
  const rels = listRelationships(project);
  const hierarchiesOf = (name: string) => listHierarchies(project, name);
  // a field's display folder: the cards list fields under a heading per folder
  const folderOf = (table: string, field: { kind: "column"; column: string } | { kind: "measure"; name: string }): string => {
    const v = getProperty(project, { table, ...field } as never, "displayFolder");
    return typeof v === "string" ? v : "";
  };
  const foldersIn = (t: TableView) => new Set([...t.columns.map((c) => folderOf(t.name, { kind: "column", column: c.name })), ...t.measures.map((m) => folderOf(t.name, { kind: "measure", name: m.name }))].filter(Boolean));
  const boxes = layoutCards(tables.map((t) => ({ ...t, hierarchies: hierarchiesOf(t.name), folders: foldersIn(t).size })));
  const [sel0, setSel] = useState<Sel>({ kind: "none" });
  const selected = sel0.kind === "rel" ? sel0.id : null;
  const setSelected = (id: string | null) => setSel(id ? { kind: "rel", id } : { kind: "none" });
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // cards folded to their header (Alt+Shift+1 folds all, Alt+Shift+9 unfolds all)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (name: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const dragging = useRef<{ table: string; column: string } | null>(null);

  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    onError(r.ok ? null : r.message);
    return r.ok;
  };

  const createRelationship = async (from: { table: string; column: string }, to: { table: string; column: string }) => {
    let spec: NewRelationship = { fromTable: from.table, fromColumn: from.column, toTable: to.table, toColumn: to.column };
    const loaded = session.getSnapshot().dataTables.map((t) => t.toLowerCase());
    if (engine && loaded.includes(from.table.toLowerCase()) && loaded.includes(to.table.toLowerCase())) {
      try {
        const hint = await engine.suggestRelationship([from.table, from.column], [to.table, to.column]);
        if (hint.cardinality === "oneToMany") {
          // keep the "many" side as `from`
          spec = { fromTable: to.table, fromColumn: to.column, toTable: from.table, toColumn: from.column };
        } else if (hint.cardinality === "oneToOne") {
          spec = { ...spec, fromCardinality: "one", toCardinality: "one" };
        } else if (hint.cardinality === "manyToMany") {
          spec = { ...spec, fromCardinality: "many", toCardinality: "many" };
        }
      } catch (e) {
        onError(`Could not inspect the data to detect cardinality (${e instanceof Error ? e.message : String(e)}); using many-to-one.`);
      }
    }
    await run("model.addRelationship", spec);
  };

  const boxOf = (name: string) => {
    const b = boxes.get(name);
    return b && collapsed.has(name) ? { ...b, h: HEAD_H + 2 } : b;
  };
  const height = Math.max(300, ...[...boxes.values()].map((b) => b.y + b.h + 20));
  const width = Math.max(400, ...[...boxes.values()].map((b) => b.x + b.w + 20));
  const sel = rels.find((r) => r.id === selected) ?? null;
  // the tables joined to the selected table by a relationship are drawn highlighted
  const selectedTable = sel0.kind === "table" || sel0.kind === "column" || sel0.kind === "measure" ? sel0.table : null;
  const related = new Set(selectedTable ? rels.flatMap((r) => (r.fromTable === selectedTable ? [r.toTable] : r.toTable === selectedTable ? [r.fromTable] : [])) : []);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div
        style={{ flex: 1, overflow: "auto", position: "relative" }}
        data-testid="model-canvas"
        tabIndex={0}
        onKeyDown={(e) => {
          if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
          if (e.code === "Digit1") {
            e.preventDefault();
            setCollapsed(new Set(tables.map((t) => t.name)));
          } else if (e.code === "Digit9") {
            e.preventDefault();
            setCollapsed(new Set());
          }
        }}
      >
        {tables.length === 0 && <div style={{ padding: 16 }}>The model has no tables. Import data to start.</div>}
        <div style={{ position: "relative", width, height }}>
          <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {rels.map((r) => {
              const a = boxOf(r.fromTable);
              const b = boxOf(r.toTable);
              if (!a || !b) return null;
              const p = anchor(a, b);
              const q = anchor(b, a);
              const mid = (p.x + q.x) / 2;
              const end = (c: EndCardinality) => (c === "one" ? "1" : "*");
              // Filters flow from the "one" side towards the "many" side (to -> from); both ends when bidirectional.
              return (
                <g key={r.id} data-testid={`rel-${r.id}`} data-active={r.isActive} style={{ pointerEvents: "auto", cursor: "pointer" }} onClick={() => setSelected(r.id)}>
                  <path
                    d={`M ${p.x} ${p.y} C ${mid} ${p.y}, ${mid} ${q.y}, ${q.x} ${q.y}`}
                    fill="none"
                    stroke={selected === r.id ? "#0f6cbd" : "#605e5c"}
                    strokeWidth={selected === r.id ? 3 : 2}
                    strokeDasharray={r.isActive ? undefined : "6 4"}
                  />
                  <path d={`M ${p.x} ${p.y} C ${mid} ${p.y}, ${mid} ${q.y}, ${q.x} ${q.y}`} fill="none" stroke="transparent" strokeWidth={14} />
                  <text x={p.x + 8 * p.side} y={p.y - 6} fontSize={12} textAnchor={p.side === 1 ? "start" : "end"}>
                    {end(r.fromCardinality)}
                  </text>
                  <text x={q.x + 8 * q.side} y={q.y - 6} fontSize={12} textAnchor={q.side === 1 ? "start" : "end"}>
                    {end(r.toCardinality)}
                  </text>
                  <text x={mid} y={(p.y + q.y) / 2 - 6} fontSize={12} textAnchor="middle">
                    {r.crossFilter === "both" ? "◄►" : p.x < q.x ? "◄" : "►"}
                  </text>
                </g>
              );
            })}
          </svg>
          {tables.map((t) => {
            const base = boxes.get(t.name)!;
            const folded = collapsed.has(t.name);
            const shownFolders = new Set<string>();
            const folderRow = (table: string, folder: string) => (
              <div key={`f:${folder}`} data-testid={`folder-${table}.${folder}`} style={{ height: ROW_H, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 6, padding: "0 8px", fontWeight: 600, opacity: 0.8 }}>
                <span aria-hidden style={{ width: 16, textAlign: "center" }}>▾</span>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{folder}</span>
              </div>
            );
            const box = folded ? { ...base, h: HEAD_H + 2 } : base;
            const selTable = (sel0.kind === "table" || sel0.kind === "column" || sel0.kind === "measure") && sel0.table === t.name;
            return (
              <div
                key={t.name}
                data-testid={`card-${t.name}`}
                data-collapsed={folded}
                data-related={related.has(t.name)}
                style={{
                  position: "absolute",
                  left: box.x,
                  top: box.y,
                  width: box.w,
                  height: box.h,
                  boxSizing: "border-box",
                  border: selTable ? "2px solid #0f6cbd" : related.has(t.name) ? "2px dashed #0f6cbd" : "1px solid #8a8886",
                  borderRadius: 4,
                  background: "var(--colorNeutralBackground1, #fff)",
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div
                  data-testid={`card-head-${t.name}`}
                  onClick={() => setSel({ kind: "table", table: t.name })}
                  style={{ height: HEAD_H, lineHeight: `${HEAD_H}px`, padding: "0 8px", fontWeight: 600, background: "var(--colorNeutralBackground3, #e1dfdd)", flex: "none", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  <button
                    type="button"
                    aria-label={`${folded ? "Expand" : "Collapse"} ${t.name}`}
                    aria-expanded={!folded}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapsed(t.name);
                    }}
                    style={{ all: "unset", cursor: "pointer", marginRight: 6, fontSize: 10 }}
                  >
                    {folded ? "▸" : "▾"}
                  </button>
                  {t.name}
                </div>
                {!folded && <div style={{ overflowY: t.columns.length + t.measures.length + hierarchiesOf(t.name).length + foldersIn(t).size > MAX_ROWS ? "auto" : "hidden", flex: 1, minHeight: 0 }}>
                  {t.columns.length + t.measures.length === 0 && <div style={{ padding: "2px 8px", opacity: 0.6 }}>(no columns)</div>}
                  {[...t.columns].sort((a, b) => folderOf(t.name, { kind: "column", column: a.name }).localeCompare(folderOf(t.name, { kind: "column", column: b.name }))).map((c) => {
                    const key = `${t.name}.${c.name}`;
                    const folder = folderOf(t.name, { kind: "column", column: c.name });
                    const head = folder && !shownFolders.has(folder) ? (shownFolders.add(folder), folderRow(t.name, folder)) : null;
                    const isSel = sel0.kind === "column" && sel0.table === t.name && sel0.column === c.name;
                    return (
                      <Fragment key={c.name}>
                      {head}
                      <div
                        data-testid={`col-${key}`}
                        data-hidden={getProperty(project, { kind: "column", table: t.name, column: c.name }, "isHidden") === true}
                        draggable
                        title="Drag onto a column of another table to create a relationship"
                        onClick={() => setSel({ kind: "column", table: t.name, column: c.name })}
                        onDragStart={(e) => {
                          dragging.current = { table: t.name, column: c.name };
                          e.dataTransfer?.setData("text/plain", key);
                        }}
                        onDragEnd={() => {
                          dragging.current = null;
                          setDropTarget(null);
                        }}
                        onDragOver={(e) => {
                          const d = dragging.current;
                          if (d && d.table !== t.name) {
                            e.preventDefault();
                            setDropTarget(key);
                          }
                        }}
                        onDragLeave={() => setDropTarget((k) => (k === key ? null : k))}
                        onDrop={(e) => {
                          e.preventDefault();
                          const d = dragging.current;
                          dragging.current = null;
                          setDropTarget(null);
                          if (d && d.table !== t.name) void createRelationship(d, { table: t.name, column: c.name });
                        }}
                        style={{
                          height: ROW_H,
                          boxSizing: "border-box",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "0 8px",
                          cursor: "grab",
                          background: dropTarget === key ? "#cfe4fa" : isSel ? "var(--colorSubtleBackgroundSelected, #e6f2fb)" : undefined,
                          opacity: getProperty(project, { kind: "column", table: t.name, column: c.name }, "isHidden") === true ? 0.5 : undefined,
                        }}
                      >
                        <FieldIcon kind={fieldIconKind(c.dataType, c.summarizeBy)} />
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{c.name}</span>
                      </div>
                      </Fragment>
                    );
                  })}
                  {[...t.measures].sort((a, b) => folderOf(t.name, { kind: "measure", name: a.name }).localeCompare(folderOf(t.name, { kind: "measure", name: b.name }))).map((m) => {
                    const folder = folderOf(t.name, { kind: "measure", name: m.name });
                    const head = folder && !shownFolders.has(folder) ? (shownFolders.add(folder), folderRow(t.name, folder)) : null;
                    return (
                    <Fragment key={`m:${m.name}`}>
                    {head}
                    <div
                      data-testid={`measure-${t.name}.${m.name}`}
                      data-hidden={getProperty(project, { kind: "measure", table: t.name, name: m.name }, "isHidden") === true}
                      onClick={() => setSel({ kind: "measure", table: t.name, name: m.name })}
                      style={{ height: ROW_H, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 6, padding: "0 8px", cursor: "pointer", background: sel0.kind === "measure" && sel0.table === t.name && sel0.name === m.name ? "var(--colorSubtleBackgroundSelected, #e6f2fb)" : undefined, opacity: getProperty(project, { kind: "measure", table: t.name, name: m.name }, "isHidden") === true ? 0.5 : undefined }}
                    >
                      <FieldIcon kind="measure" />
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{m.name}</span>
                    </div>
                    </Fragment>
                    );
                  })}
                  {hierarchiesOf(t.name).map((h) => (
                    <div
                      key={`h:${h.name}`}
                      data-testid={`hierarchy-${t.name}.${h.name}`}
                      title={`Hierarchy: ${h.levels.map((l) => l.column).join(" > ")}`}
                      style={{ height: ROW_H, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 6, padding: "0 8px" }}
                    >
                      <span aria-hidden style={{ width: 16, textAlign: "center", opacity: 0.8 }}>≣</span>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{h.name}</span>
                    </div>
                  ))}
                </div>}
              </div>
            );
          })}
        </div>
      </div>

      {properties ? (
        <PaneFrame title="Properties" side="right" open={properties.open} width={properties.width} onOpenChange={properties.onOpenChange} onResize={properties.onResize}>
          {propertiesBody()}
        </PaneFrame>
      ) : (
        <aside style={{ width: 280, borderLeft: "1px solid #ddd", overflow: "auto" }} aria-label="Properties">
          {propertiesBody()}
        </aside>
      )}
    </div>
  );

  function propertiesBody() {
    const table = (name: string): TableView | undefined => tables.find((t) => t.name === name);
    const field = (label: string, value: string) => (
      <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 6, padding: "2px 0", fontSize: 13 }}>
        <span style={{ opacity: 0.7 }}>{label}</span>
        <span style={{ overflowWrap: "anywhere" }}>{value}</span>
      </div>
    );
    const numeric = (t: string | null | undefined) => t === "int64" || t === "double" || t === "decimal";
    return (
      <div style={{ padding: 12 }} data-testid="properties">
        {(sel0.kind === "table" || sel0.kind === "column" || sel0.kind === "measure") && <ModelProperties project={project} tables={tables} sel={sel0} run={run} />}
        <strong style={{ display: "block", marginTop: sel0.kind === "none" || sel0.kind === "rel" ? 0 : 14 }}>Relationships ({rels.length})</strong>
        <ul style={{ paddingLeft: 16, margin: "6px 0" }}>
          {rels.map((r) => (
            <li key={r.id}>
              <button style={{ all: "unset", cursor: "pointer", fontWeight: r.id === selected ? 700 : 400 }} data-testid={`rel-item-${r.id}`} onClick={() => setSelected(r.id)}>
                {describe(r)}
              </button>
            </li>
          ))}
        </ul>
        {sel ? (
          <fieldset style={{ border: "1px solid #ddd" }} data-testid="rel-editor">
            <legend>Edit relationship</legend>
            <div style={{ fontSize: 12, marginBottom: 6 }}>{describe(sel)}</div>
            <label style={{ display: "block" }}>
              {sel.fromTable} side{" "}
              <select aria-label="From cardinality" value={sel.fromCardinality} onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { fromCardinality: e.target.value } })}>
                <option value="many">Many (*)</option>
                <option value="one">One (1)</option>
              </select>
            </label>
            <label style={{ display: "block" }}>
              {sel.toTable} side{" "}
              <select aria-label="To cardinality" value={sel.toCardinality} onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { toCardinality: e.target.value } })}>
                <option value="many">Many (*)</option>
                <option value="one">One (1)</option>
              </select>
            </label>
            <label style={{ display: "block" }}>
              Cross-filter direction{" "}
              <select aria-label="Cross-filter direction" value={sel.crossFilter} onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { crossFilter: e.target.value } })}>
                <option value="single">Single</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label style={{ display: "block" }} title="Only with the cross-filter direction Both: a security filter on the many side then also hides the one side rows that have no visible row left.">
              <input type="checkbox" disabled={sel.crossFilter !== "both"} checked={sel.securityBoth} onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { securityBoth: e.target.checked } })} /> Apply security filter in both directions
            </label>
            <label style={{ display: "block" }} title="Kept in the file for Power BI Desktop, which uses it for DirectQuery sources only. BIForge imports the data, so it changes no result here.">
              <input type="checkbox" checked={sel.assumeRI} onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { assumeRI: e.target.checked } })} /> Assume referential integrity
            </label>
            <label style={{ display: "block" }}>
              <input type="checkbox" checked={sel.isActive} onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { isActive: e.target.checked } })} /> Make this relationship active
            </label>
            <button
              onClick={async () => {
                if (await run("model.deleteRelationship", { id: sel.id })) setSelected(null);
              }}
            >
              Delete
            </button>
          </fieldset>
        ) : (
          <div style={{ fontSize: 12, opacity: 0.7 }}>Select a table, column, measure or relationship line to see its properties. Drag a column onto a column of another table to create a relationship.</div>
        )}
      </div>
    );
  }
}
