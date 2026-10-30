import { useState } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Textarea } from "@fluentui/react-components";
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
  onAction(action: "new" | "duplicate" | "delete" | "rename" | "setLoad" | "properties", name: string, extra?: unknown): void;
  /** Query groups (folders), in order. */
  groups?: string[];
  /** Queries that are parameters. */
  parameters?: Set<string>;
  onGroup?(action: "new" | "move" | "ungroup" | "rename" | "delete"): void;
}

/** What the Query properties dialog writes. */
export interface QueryProperties {
  name: string;
  description: string;
  loaded: boolean;
  refresh: boolean;
}

/** Query properties: name, description, Enable load and Include in report refresh of one query. */
function QueryPropertiesDialog({ query, canRename, canLoad, onClose, onOk }: { query: DraftQuery; canRename: boolean; canLoad: boolean; onClose(): void; onOk(p: QueryProperties): void }) {
  const [name, setName] = useState(query.name);
  const [description, setDescription] = useState(query.description);
  const [loaded, setLoaded] = useState(query.loaded);
  const [refresh, setRefresh] = useState(query.refresh);
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface aria-label="Query Properties">
        <DialogBody>
          <DialogTitle>Query Properties</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Name">
              <Input value={name} disabled={!canRename} title={canRename ? undefined : "A query that is loaded into the model cannot be renamed yet."} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label="Description">
              <Textarea value={description} onChange={(_, d) => setDescription(d.value)} />
            </Field>
            <Checkbox label="Enable load to report" disabled={!canLoad} checked={loaded} onChange={(_, d) => setLoaded(!!d.checked)} />
            <Checkbox label="Include in report refresh" checked={refresh} onChange={(_, d) => setRefresh(!!d.checked)} />
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={name.trim() === ""} onClick={() => onOk({ name: name.trim(), description, loaded, refresh })}>
              OK
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function QueriesPane({ queries, changed, selected, kinds, onSelect, onAction, groups = [], parameters, onGroup }: QueriesPaneProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [properties, setProperties] = useState(false);
  const sel = queries.find((q) => q.name === selected);
  const renameAllowed = !!sel && (!sel.loaded || sel.isNew);
  const sections: { group: string | null; items: DraftQuery[] }[] = [
    { group: null, items: queries.filter((q) => !q.group || !groups.includes(q.group)) },
    ...groups.map((g) => ({ group: g as string | null, items: queries.filter((q) => q.group === g) })),
  ];
  const row = (q: DraftQuery, indent: boolean) => (
    <li
      key={q.name}
      role="option"
      aria-selected={q.name === selected}
      tabIndex={0}
      onClick={() => onSelect(q.name)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(q.name)}
      title={q.loaded ? "Loaded into the model" : "Not loaded into the model"}
      style={{ padding: "4px 8px", paddingLeft: indent ? 24 : 8, cursor: "pointer", background: q.name === selected ? "#e6f2fb" : undefined, fontStyle: q.loaded ? undefined : "italic", display: "flex", gap: 6 }}
    >
      <span aria-hidden style={{ color: "#605e5c", width: 18 }}>
        {parameters?.has(q.name) ? "(p)" : kinds[q.name] === "table" || kinds[q.name] === undefined ? "▦" : kinds[q.name] === "error" ? "⚠" : "fx"}
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
  );
  return (
    <div style={paneStyle} aria-label="Queries">
      <div style={titleStyle}>Queries [{queries.length}]</div>
      <ul role="listbox" aria-label="Query list" style={{ listStyle: "none", margin: 0, padding: 0, overflow: "auto", flex: 1 }}>
        {sections.map((s) => (
          <li key={s.group ?? "(ungrouped)"} role="presentation" style={{ listStyle: "none" }}>
            {s.group !== null && (
              <div
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed.has(s.group)}
                aria-label={`Group ${s.group}`}
                onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(s.group!)) n.delete(s.group!); else n.add(s.group!); return n; })}
                onKeyDown={(e) => e.key === "Enter" && setCollapsed((c) => { const n = new Set(c); if (n.has(s.group!)) n.delete(s.group!); else n.add(s.group!); return n; })}
                style={{ padding: "4px 8px", fontWeight: 600, cursor: "pointer", background: "#f3f2f1" }}
              >
                {collapsed.has(s.group) ? "▸" : "▾"} {s.group} [{s.items.length}]
              </div>
            )}
            {(s.group === null || !collapsed.has(s.group)) && <ul role="presentation" style={{ listStyle: "none", margin: 0, padding: 0 }}>{s.items.map((q) => row(q, s.group !== null))}</ul>}
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
        <Button size="small" disabled={!sel} onClick={() => setProperties(true)}>
          Properties...
        </Button>
        {sel && properties && (
          <QueryPropertiesDialog
            query={sel}
            canRename={renameAllowed}
            canLoad={!(kinds[sel.name] && kinds[sel.name] !== "table") && !(sel.original?.loaded && sel.loaded)}
            onClose={() => setProperties(false)}
            onOk={(p) => {
              setProperties(false);
              onAction("properties", sel.name, p);
            }}
          />
        )}
        {onGroup && (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small">Group ▾</Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem onClick={() => onGroup("new")}>New Group...</MenuItem>
                <MenuItem disabled={!sel || groups.length === 0} onClick={() => onGroup("move")}>
                  Move to Group...
                </MenuItem>
                <MenuItem disabled={!sel?.group} onClick={() => onGroup("ungroup")}>
                  Remove from Group
                </MenuItem>
                <MenuItem disabled={groups.length === 0} onClick={() => onGroup("rename")}>
                  Rename Group...
                </MenuItem>
                <MenuItem disabled={groups.length === 0} onClick={() => onGroup("delete")}>
                  Delete Group...
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
        {sel && <Checkbox label="Enable load" disabled={!!kinds[sel.name] && kinds[sel.name] !== "table"} title={kinds[sel.name] && kinds[sel.name] !== "table" ? "Only a table can be loaded into the model." : undefined} checked={sel.loaded && (!kinds[sel.name] || kinds[sel.name] === "table")} onChange={(_, d) => onAction("setLoad", sel.name, !!d.checked)} />}
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
