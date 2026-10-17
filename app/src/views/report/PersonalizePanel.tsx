import { Button, Select } from "@fluentui/react-components";
import { column, fieldKey, fieldLabel, measure } from "../../core/report/fields";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { VISUAL_TYPES, visualType } from "../../core/report/visualTypes";
import { useReport } from "./reportContext";

/**
 * What a reader gets from the Personalize button of a visual in a shared report: another visual type and other fields.
 * These are view changes: nothing is saved, and Reset view in the viewing bar takes them back.
 */
export function PersonalizePanel({ page, visual, onClose }: { page: PageModel; visual: VisualModel; onClose(): void }) {
  const c = useReport();
  const fields = Object.entries(visual.roles).flatMap(([role, list]) => list.map((pr, index) => ({ role, index, field: pr.field })));
  const all = c.model.tables().flatMap((t) => [...c.model.columns(t).map((n) => ({ key: `c|${t}|${n}`, label: `${t}[${n}]`, ref: column(t, n) })), ...c.model.measures(t).map((n) => ({ key: `m|${t}|${n}`, label: `${t}[${n}] (measure)`, ref: measure(t, n) }))]);
  return (
    <div role="dialog" aria-label="Personalize this visual" style={{ position: "absolute", right: 4, top: 24, width: 250, maxHeight: "80%", overflow: "auto", zIndex: 9, background: "#fff", color: "#222", border: "1px solid #aaa", borderRadius: 4, padding: 8, display: "flex", flexDirection: "column", gap: 6, fontSize: 12, boxShadow: "0 4px 14px rgba(0,0,0,.25)" }} onPointerDown={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Personalize this visual</strong>
        <Button size="small" appearance="subtle" aria-label="Close personalize" onClick={onClose}>
          ✕
        </Button>
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        Visual type
        <Select size="small" aria-label="Visual type" value={visual.visualType} onChange={(_, d) => c.dispatch("report.visual.setType", { page: page.name, visual: visual.name, type: d.value })}>
          {VISUAL_TYPES.filter((t) => !t.static && !t.deferred).map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
      </label>
      <div style={{ fontWeight: 600 }}>Fields</div>
      {fields.length === 0 && <div style={{ opacity: 0.7 }}>No fields.</div>}
      {fields.map((f) => (
        <div key={`${f.role}-${f.index}-${fieldKey(f.field)}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ flex: 1 }}>
            {fieldLabel(f.field)} <span style={{ opacity: 0.6 }}>({visualType(visual.visualType)?.roles.find((r) => r.name === f.role)?.label ?? f.role})</span>
          </span>
          <Button size="small" appearance="subtle" aria-label={`Remove ${fieldLabel(f.field)}`} onClick={() => c.dispatch("report.field.remove", { page: page.name, visual: visual.name, role: f.role, index: f.index })}>
            ✕
          </Button>
        </div>
      ))}
      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        Add a field
        <Select
          size="small"
          aria-label="Add a field"
          value=""
          onChange={(_, d) => {
            const hit = all.find((x) => x.key === d.value);
            if (hit) c.dispatch("report.field.add", { page: page.name, visual: visual.name, field: hit.ref });
          }}
        >
          <option value="">Choose a field…</option>
          {all.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label}
            </option>
          ))}
        </Select>
      </label>
      <Button size="small" onClick={() => c.dispatch("report.view.resetChanges")}>
        Reset all changes
      </Button>
    </div>
  );
}
