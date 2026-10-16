import { useState } from "react";
import { Button, Checkbox, Input } from "@fluentui/react-components";
import type { DraftQuery } from "../../core/queries/draft";
import type { StepView } from "./useEditorData";

const paneStyle = { display: "flex", flexDirection: "column", minHeight: 0, background: "#fff" } as const;
const titleStyle = { fontWeight: 600, fontSize: 13, padding: "6px 8px", borderBottom: "1px solid #e1dfdd", background: "#faf9f8" } as const;

export interface QueriesPaneProps {
  queries: DraftQuery[];
  changed: (q: DraftQuery) => boolean;
  selected: string | null;
  kinds: Record<string, string>;
  onSelect(name: string): void;
  onAction(action: "new" | "duplicate" | "delete" | "rename" | "setLoad", name: string, extra?: unknown): void;
}

export function QueriesPane({ queries, changed, selected, kinds, onSelect, onAction }: QueriesPaneProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const sel = queries.find((q) => q.name === selected);
  const renameAllowed = !!sel && (!sel.loaded || sel.isNew);
  return (
    <div style={paneStyle} aria-label="Queries">
      <div style={titleStyle}>Queries [{queries.length}]</div>
      <ul role="listbox" aria-label="Query list" style={{ listStyle: "none", margin: 0, padding: 0, overflow: "auto", flex: 1 }}>
        {queries.map((q) => (
          <li
            key={q.name}
            role="option"
            aria-selected={q.name === selected}
            tabIndex={0}
            onClick={() => onSelect(q.name)}
            onKeyDown={(e) => e.key === "Enter" && onSelect(q.name)}
            title={q.loaded ? "Loaded into the model" : "Not loaded into the model"}
            style={{ padding: "4px 8px", cursor: "pointer", background: q.name === selected ? "#e6f2fb" : undefined, fontStyle: q.loaded ? undefined : "italic", display: "flex", gap: 6 }}
          >
            <span aria-hidden style={{ color: "#605e5c", width: 18 }}>
              {kinds[q.name] === "table" || kinds[q.name] === undefined ? "▦" : kinds[q.name] === "error" ? "⚠" : "fx"}
            </span>
            {renaming === q.name ? (
              <Input
                size="small"
                aria-label="New query name"
                autoFocus
                value={draft}
                onChange={(_, d) => setDraft(d.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onAction("rename", q.name, draft);
                    setRenaming(null);
                  } else if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span style={{ flex: 1 }}>
                {q.name}
                {changed(q) ? " *" : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: 6, borderTop: "1px solid #e1dfdd" }}>
        <Button size="small" onClick={() => onAction("new", "")}>
          New
        </Button>
        <Button size="small" disabled={!sel} onClick={() => sel && onAction("duplicate", sel.name)}>
          Duplicate
        </Button>
        <Button
          size="small"
          disabled={!renameAllowed}
          title={!sel ? "Select a query" : renameAllowed ? "Rename" : "A query that is loaded into the model cannot be renamed yet."}
          onClick={() => {
            if (sel) {
              setDraft(sel.name);
              setRenaming(sel.name);
            }
          }}
        >
          Rename
        </Button>
        <Button size="small" disabled={!sel} onClick={() => sel && onAction("delete", sel.name)}>
          Delete
        </Button>
        {sel && <Checkbox label="Enable load" checked={sel.loaded} onChange={(_, d) => onAction("setLoad", sel.name, !!d.checked)} />}
      </div>
    </div>
  );
}

export interface StepsPaneProps {
  query: string | null;
  steps: StepView[];
  active: string | null;
  parseError: string | null;
  onSelect(step: string): void;
  onAction(action: "delete" | "deleteFrom" | "up" | "down" | "rename" | "insert", step: string, extra?: string): void;
}

export function StepsPane({ query, steps, active, parseError, onSelect, onAction }: StepsPaneProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const idx = steps.findIndex((s) => s.name === active);
  const cur = idx >= 0 ? steps[idx] : null;
  return (
    <div style={paneStyle} aria-label="Query settings">
      <div style={titleStyle}>Query Settings</div>
      <div style={{ padding: "6px 8px", fontSize: 13 }}>
        <div style={{ color: "#605e5c" }}>Name</div>
        <div data-testid="query-name">{query ?? "(no query)"}</div>
      </div>
      <div style={titleStyle}>Applied Steps</div>
      {parseError && (
        <div role="alert" style={{ padding: 8, fontSize: 12, color: "#a4262c" }}>
          {parseError}
        </div>
      )}
      <ol aria-label="Applied steps" style={{ listStyle: "none", margin: 0, padding: 0, overflow: "auto", flex: 1 }}>
        {steps.map((s) => (
          <li
            key={s.name}
            role="option"
            aria-selected={s.name === active}
            tabIndex={0}
            onClick={() => onSelect(s.name)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSelect(s.name);
              if (e.key === "Delete") onAction("delete", s.name);
            }}
            title={s.error ?? s.expr}
            style={{ padding: "4px 8px", cursor: "pointer", background: s.name === active ? "#e6f2fb" : undefined, display: "flex", gap: 6, alignItems: "center" }}
          >
            {renaming === s.name ? (
              <Input
                size="small"
                aria-label="New step name"
                autoFocus
                value={draft}
                onChange={(_, d) => setDraft(d.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onAction("rename", s.name, draft);
                    setRenaming(null);
                  } else if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span style={{ flex: 1, color: s.error ? "#a4262c" : undefined }}>{s.name}</span>
            )}
            {s.error && (
              <span role="img" aria-label="Step has an error" title={s.error} style={{ color: "#a4262c" }}>
                ⚠
              </span>
            )}
          </li>
        ))}
      </ol>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: 6, borderTop: "1px solid #e1dfdd" }}>
        <Button size="small" disabled={!cur || idx === 0} onClick={() => cur && onAction("up", cur.name)}>
          Move up
        </Button>
        <Button size="small" disabled={!cur || idx === steps.length - 1} onClick={() => cur && onAction("down", cur.name)}>
          Move down
        </Button>
        <Button
          size="small"
          disabled={!cur}
          onClick={() => {
            if (cur) {
              setDraft(cur.name);
              setRenaming(cur.name);
            }
          }}
        >
          Rename
        </Button>
        <Button size="small" disabled={!cur || steps.length < 2} onClick={() => cur && onAction("delete", cur.name)}>
          Delete
        </Button>
        <Button size="small" disabled={!cur || idx === 0} onClick={() => cur && onAction("deleteFrom", cur.name)}>
          Delete until end
        </Button>
        <Button size="small" disabled={!cur} onClick={() => cur && onAction("insert", cur.name)}>
          Insert step after
        </Button>
      </div>
    </div>
  );
}
