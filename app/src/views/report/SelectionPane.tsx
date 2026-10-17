import { useState } from "react";
import { Button, Input } from "@fluentui/react-components";
import { treeRows } from "../../core/report/groups";
import { visualDisplayName } from "../../core/report/reportOps";
import type { GroupModel, VisualModel } from "../../core/report/visualDoc";
import { visualType } from "../../core/report/visualTypes";
import { useReport } from "./reportContext";

/** Selection pane: the visuals and groups of the page, front first, a group above its members. Select, rename, show or hide, change the stacking order. */
export function SelectionPane() {
  const c = useReport();
  const page = c.pages.find((p) => p.name === c.snap.page) ?? c.pages[0];
  const [renaming, setRenaming] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  if (!page) return null;
  const rows = treeRows(page, collapsed);
  const isGroup = (i: VisualModel | GroupModel): i is GroupModel => "displayName" in i;
  const label = (i: VisualModel | GroupModel) => (isGroup(i) ? i.displayName : (visualDisplayName(i.json) ?? visualType(i.visualType)?.label ?? i.visualType));
  const selected = new Set(c.snap.canvas);
  const toggle = (name: string) => setCollapsed((s) => (s.has(name) ? new Set([...s].filter((x) => x !== name)) : new Set([...s, name])));
  // neighbours at the same level, for the stacking arrows
  const siblings = (i: VisualModel | GroupModel) => rows.filter((r) => r.item.parent === i.parent);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, height: "100%", overflow: "auto" }} aria-label="Selection pane">
      <div style={{ fontSize: 12, opacity: 0.7 }}>Layer order on {page.displayName}: the top item is in front.</div>
      <div role="tree" aria-label="Visuals and groups" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.map((r) => {
          const i = r.item;
          const name = label(i);
          const sib = siblings(i);
          const at = sib.findIndex((s) => s.name === r.name);
          return (
            <div
              key={r.name}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-expanded={r.kind === "group" ? !collapsed.has(r.name) : undefined}
              data-selected={selected.has(r.name)}
              data-kind={r.kind}
              style={{ display: "flex", alignItems: "center", gap: 2, paddingLeft: r.depth * 14, background: selected.has(r.name) ? "#e8f1fb" : undefined, color: selected.has(r.name) ? "#123" : undefined, borderRadius: 3, opacity: r.hidden ? 0.55 : 1 }}
            >
              {r.kind === "group" ? (
                <button aria-label={`${collapsed.has(r.name) ? "Expand" : "Collapse"} ${name}`} onClick={() => toggle(r.name)} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", width: 16, padding: 0 }}>
                  {collapsed.has(r.name) ? "▸" : "▾"}
                </button>
              ) : (
                <span style={{ width: 16 }} />
              )}
              {renaming === r.name ? (
                <Input
                  size="small"
                  autoFocus
                  aria-label={r.kind === "group" ? "Group name" : "Visual name"}
                  defaultValue={r.kind === "group" ? (i as GroupModel).displayName : (visualDisplayName((i as VisualModel).json) ?? "")}
                  placeholder={name}
                  style={{ flex: 1 }}
                  onBlur={(e) => {
                    if (r.kind === "group") {
                      if (e.currentTarget.value.trim()) c.dispatch("report.group.rename", { page: page.name, group: r.name, name: e.currentTarget.value });
                    } else c.dispatch("report.visual.rename", { page: page.name, visual: r.name, name: e.currentTarget.value });
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <button
                  aria-label={`Select ${name}`}
                  onClick={(e) => c.dispatch("report.canvas.select", { names: e.shiftKey || e.ctrlKey ? [...new Set([...c.snap.canvas, r.name])] : [r.name] })}
                  onDoubleClick={() => !c.readOnly && setRenaming(r.name)}
                  style={{ flex: 1, textAlign: "left", border: "none", background: "transparent", color: "inherit", padding: "4px 6px", cursor: "pointer", font: "inherit", fontWeight: r.kind === "group" ? 600 : 400 }}
                >
                  {name}
                </button>
              )}
              <button aria-label={`${r.hidden ? "Show" : "Hide"} ${name}`} aria-pressed={r.hidden} onClick={() => c.dispatch("report.visual.setHidden", { page: page.name, visual: r.name, hidden: !r.hidden })} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}>
                {r.hidden ? "◌" : "◉"}
              </button>
              <Button size="small" appearance="subtle" aria-label={`Bring ${name} forward`} disabled={at === 0} onClick={() => c.dispatch("report.visual.moveInOrder", { page: page.name, visual: r.name, dir: "up" })}>
                ↑
              </Button>
              <Button size="small" appearance="subtle" aria-label={`Send ${name} backward`} disabled={at === sib.length - 1} onClick={() => c.dispatch("report.visual.moveInOrder", { page: page.name, visual: r.name, dir: "down" })}>
                ↓
              </Button>
            </div>
          );
        })}
        {rows.length === 0 && <div style={{ fontSize: 12 }}>This page has no visuals.</div>}
      </div>
    </div>
  );
}
