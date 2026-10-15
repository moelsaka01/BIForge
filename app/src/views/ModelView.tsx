import { useRef, useState } from "react";
import type { CommandRegistry } from "../core/commands/registry";
import type { Session } from "../core/session/session";
import type { Project } from "../core/model/types";
import type { EngineApi } from "../core/data/types";
import { listTables } from "../core/model/ops";
import { listRelationships, type EndCardinality, type NewRelationship, type Relationship } from "../core/model/relationships";

const CARD_W = 220;
const HEAD_H = 28;
const ROW_H = 22;
const GAP_X = 70;
const GAP_Y = 40;
const COLS = 4;
const MAX_ROWS = 10;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Automatic grid layout; card positions are not user-editable yet. */
export function layoutCards(tables: { name: string; columns: unknown[] }[]): Map<string, Box> {
  const out = new Map<string, Box>();
  const rowBottoms: number[] = [];
  tables.forEach((t, i) => {
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    const h = HEAD_H + Math.min(Math.max(t.columns.length, 1), MAX_ROWS) * ROW_H + 8;
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
}

export function ModelView({ project, session, registry, engine, onError }: ModelViewProps) {
  const tables = listTables(project);
  const rels = listRelationships(project);
  const boxes = layoutCards(tables);
  const [selected, setSelected] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
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

  const height = Math.max(300, ...[...boxes.values()].map((b) => b.y + b.h + 20));
  const width = Math.max(400, ...[...boxes.values()].map((b) => b.x + b.w + 20));
  const sel = rels.find((r) => r.id === selected) ?? null;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, overflow: "auto", position: "relative" }} data-testid="model-canvas">
        {tables.length === 0 && <div style={{ padding: 16 }}>The model has no tables. Import data to start.</div>}
        <div style={{ position: "relative", width, height }}>
          <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {rels.map((r) => {
              const a = boxes.get(r.fromTable);
              const b = boxes.get(r.toTable);
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
            const box = boxes.get(t.name)!;
            return (
              <div
                key={t.name}
                data-testid={`card-${t.name}`}
                style={{
                  position: "absolute",
                  left: box.x,
                  top: box.y,
                  width: box.w,
                  height: box.h,
                  border: "1px solid #8a8886",
                  borderRadius: 4,
                  background: "var(--colorNeutralBackground1, #fff)",
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ height: HEAD_H, lineHeight: `${HEAD_H}px`, padding: "0 8px", fontWeight: 600, background: "#e1dfdd", flex: "none" }}>
                  {t.name}
                </div>
                <div style={{ overflowY: "auto", flex: 1 }}>
                  {t.columns.length === 0 && <div style={{ padding: "2px 8px", opacity: 0.6 }}>(no columns)</div>}
                  {t.columns.map((c) => {
                    const key = `${t.name}.${c.name}`;
                    return (
                      <div
                        key={c.name}
                        data-testid={`col-${key}`}
                        draggable
                        title="Drag onto a column of another table to create a relationship"
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
                          lineHeight: `${ROW_H}px`,
                          padding: "0 8px",
                          cursor: "grab",
                          background: dropTarget === key ? "#cfe4fa" : undefined,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {c.name} <span style={{ opacity: 0.55, fontSize: 11 }}>{c.dataType ?? ""}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <aside style={{ width: 280, borderLeft: "1px solid #ddd", padding: 12, overflow: "auto" }} aria-label="Relationships">
        <strong>Relationships ({rels.length})</strong>
        <ul style={{ paddingLeft: 16, margin: "6px 0" }}>
          {rels.map((r) => (
            <li key={r.id}>
              <button
                style={{ all: "unset", cursor: "pointer", fontWeight: r.id === selected ? 700 : 400 }}
                data-testid={`rel-item-${r.id}`}
                onClick={() => setSelected(r.id)}
              >
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
              <select
                aria-label="From cardinality"
                value={sel.fromCardinality}
                onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { fromCardinality: e.target.value } })}
              >
                <option value="many">Many (*)</option>
                <option value="one">One (1)</option>
              </select>
            </label>
            <label style={{ display: "block" }}>
              {sel.toTable} side{" "}
              <select
                aria-label="To cardinality"
                value={sel.toCardinality}
                onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { toCardinality: e.target.value } })}
              >
                <option value="many">Many (*)</option>
                <option value="one">One (1)</option>
              </select>
            </label>
            <label style={{ display: "block" }}>
              Cross-filter direction{" "}
              <select
                aria-label="Cross-filter direction"
                value={sel.crossFilter}
                onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { crossFilter: e.target.value } })}
              >
                <option value="single">Single</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={sel.isActive}
                onChange={(e) => void run("model.updateRelationship", { id: sel.id, patch: { isActive: e.target.checked } })}
              />{" "}
              Make this relationship active
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
          <div style={{ fontSize: 12, opacity: 0.7 }}>Select a relationship line or list entry to edit it. Drag a column onto a column of another table to create one.</div>
        )}
      </aside>
    </div>
  );
}
