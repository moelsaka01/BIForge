import { useState } from "react";
import { Button, Input } from "@fluentui/react-components";
import { visualDisplayName } from "../../core/report/reportOps";
import { visualType } from "../../core/report/visualTypes";
import { useReport } from "./reportContext";

/** Selection pane: the visuals of the page, front first. Select, rename, show or hide, change the stacking order. */
export function SelectionPane() {
  const c = useReport();
  const page = c.pages.find((p) => p.name === c.snap.page) ?? c.pages[0];
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!page) return null;
  const list = [...page.visuals].sort((a, b) => b.position.z - a.position.z);
  const label = (v: (typeof list)[number]) => visualDisplayName(v.json) ?? visualType(v.visualType)?.label ?? v.visualType;
  const selected = new Set(c.snap.canvas);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, height: "100%", overflow: "auto" }} aria-label="Selection pane">
      <div style={{ fontSize: 12, opacity: 0.7 }}>Layer order on {page.displayName}: the top item is in front.</div>
      <div role="list" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {list.map((v, i) => (
          <div key={v.name} role="listitem" data-selected={selected.has(v.name)} style={{ display: "flex", alignItems: "center", gap: 2, background: selected.has(v.name) ? "#e8f1fb" : undefined, color: selected.has(v.name) ? "#123" : undefined, borderRadius: 3, opacity: v.hidden ? 0.55 : 1 }}>
            {renaming === v.name ? (
              <Input
                size="small"
                autoFocus
                aria-label="Visual name"
                defaultValue={visualDisplayName(v.json) ?? ""}
                placeholder={label(v)}
                style={{ flex: 1 }}
                onBlur={(e) => {
                  c.dispatch("report.visual.rename", { page: page.name, visual: v.name, name: e.currentTarget.value });
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button
                aria-label={`Select ${label(v)}`}
                onClick={(e) => c.dispatch("report.canvas.select", { names: e.shiftKey || e.ctrlKey ? [...new Set([...c.snap.canvas, v.name])] : [v.name] })}
                onDoubleClick={() => !c.readOnly && setRenaming(v.name)}
                style={{ flex: 1, textAlign: "left", border: "none", background: "transparent", color: "inherit", padding: "4px 6px", cursor: "pointer", font: "inherit" }}
              >
                {label(v)}
              </button>
            )}
            <button aria-label={`${v.hidden ? "Show" : "Hide"} ${label(v)}`} aria-pressed={v.hidden} onClick={() => c.dispatch("report.visual.setHidden", { page: page.name, visual: v.name, hidden: !v.hidden })} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}>
              {v.hidden ? "◌" : "◉"}
            </button>
            <Button size="small" appearance="subtle" aria-label={`Bring ${label(v)} forward`} disabled={i === 0} onClick={() => c.dispatch("report.visual.moveInOrder", { page: page.name, visual: v.name, dir: "up" })}>
              ↑
            </Button>
            <Button size="small" appearance="subtle" aria-label={`Send ${label(v)} backward`} disabled={i === list.length - 1} onClick={() => c.dispatch("report.visual.moveInOrder", { page: page.name, visual: v.name, dir: "down" })}>
              ↓
            </Button>
          </div>
        ))}
        {list.length === 0 && <div style={{ fontSize: 12 }}>This page has no visuals.</div>}
      </div>
    </div>
  );
}
