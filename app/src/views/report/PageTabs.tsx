import { useState } from "react";
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Select } from "@fluentui/react-components";
import { column, fieldKey, fieldLabel, type FieldRef } from "../../core/report/fields";
import { readFilters } from "../../core/report/filters";
import type { PageModel } from "../../core/report/visualDoc";
import { useReport } from "./reportContext";

function DrillthroughFields({ page, onClose }: { page: PageModel; onClose(): void }) {
  const c = useReport();
  const params: { boundFilter: string }[] = page.json.pageBinding?.parameters ?? [];
  const current: FieldRef[] = readFilters(page.json).defs.filter((d) => params.some((x) => x.boundFilter === d.name)).map((d) => d.field);
  const [fields, setFields] = useState<FieldRef[]>(current);
  const options = c.model.tables().flatMap((t) => c.model.columns(t).map((n) => column(t, n)));
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface aria-label="Drillthrough fields">
        <DialogBody>
          <DialogTitle>Drillthrough fields of "{page.displayName}"</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12 }}>A data point can drill through to this page when it carries all of these fields.</div>
            {fields.map((f) => (
              <div key={fieldKey(f)} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ flex: 1 }}>{fieldLabel(f)}</span>
                <Button size="small" aria-label={`Remove ${fieldLabel(f)}`} onClick={() => setFields(fields.filter((x) => fieldKey(x) !== fieldKey(f)))}>
                  ✕
                </Button>
              </div>
            ))}
            <Select aria-label="Add a drillthrough field" value="" onChange={(_, d) => {
              const f = options.find((o) => fieldKey(o) === d.value);
              if (f && !fields.some((x) => fieldKey(x) === fieldKey(f))) setFields([...fields, f]);
            }}>
              <option value="">Add field…</option>
              {options.map((f) => (
                <option key={fieldKey(f)} value={fieldKey(f)}>
                  {f.table}: {f.name}
                </option>
              ))}
            </Select>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              appearance="primary"
              onClick={() => {
                c.dispatch("report.page.setDrillthroughFields", { page: page.name, fields });
                onClose();
              }}
            >
              OK
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function PageTabs({ pages, active }: { pages: PageModel[]; active: string }) {
  const c = useReport();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dt, setDt] = useState<string | null>(null);
  const dtPage = pages.find((p) => p.name === dt);

  const menu = (e: React.MouseEvent, p: PageModel, index: number) => {
    e.preventDefault();
    c.onMenu(
      [
        { label: "Rename page", onClick: () => setRenaming(p.name) },
        { label: "Duplicate page", onClick: () => c.dispatch("report.page.duplicate", { page: p.name }) },
        { label: "Move left", disabled: index === 0, onClick: () => c.dispatch("report.page.move", { page: p.name, index: index - 1 }) },
        { label: "Move right", disabled: index === pages.length - 1, onClick: () => c.dispatch("report.page.move", { page: p.name, index: index + 1 }) },
        { label: p.hidden ? "Show page" : "Hide page", onClick: () => c.dispatch("report.page.setHidden", { page: p.name, hidden: !p.hidden }) },
        { separator: true, label: "", onClick: () => undefined },
        { label: p.type === undefined ? "✓ Normal page" : "Normal page", onClick: () => c.dispatch("report.page.setType", { page: p.name, type: null }) },
        { label: p.type === "Drillthrough" ? "✓ Drillthrough page" : "Drillthrough page", onClick: () => c.dispatch("report.page.setType", { page: p.name, type: "Drillthrough" }) },
        { label: p.type === "Tooltip" ? "✓ Tooltip page" : "Tooltip page", onClick: () => c.dispatch("report.page.setType", { page: p.name, type: "Tooltip" }) },
        { label: "Drillthrough fields…", disabled: p.type !== "Drillthrough", onClick: () => setDt(p.name) },
        { separator: true, label: "", onClick: () => undefined },
        { label: "Delete page", disabled: pages.length <= 1, onClick: () => c.dispatch("report.page.delete", { page: p.name }) },
      ],
      e.clientX,
      e.clientY,
    );
  };

  return (
    <div role="tablist" aria-label="Report pages" style={{ display: "flex", alignItems: "stretch", gap: 2, padding: "2px 8px", borderTop: "1px solid #ccc", overflowX: "auto", flex: "none" }}>
      {pages.map((p, i) => (
        <div
          key={p.name}
          role="tab"
          aria-selected={p.name === active}
          tabIndex={0}
          onClick={() => c.dispatch("report.page.go", { page: p.name })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") c.dispatch("report.page.go", { page: p.name });
            if (e.key === "F2") setRenaming(p.name);
          }}
          onDoubleClick={() => setRenaming(p.name)}
          onContextMenu={(e) => menu(e, p, i)}
          style={{ padding: "4px 12px", cursor: "pointer", borderBottom: p.name === active ? "3px solid #0f6cbd" : "3px solid transparent", fontWeight: p.name === active ? 600 : 400, opacity: p.hidden ? 0.55 : 1, whiteSpace: "nowrap", fontSize: 13, display: "flex", gap: 4, alignItems: "center" }}
        >
          {p.type === "Tooltip" && <span title="Tooltip page">ⓘ</span>}
          {p.type === "Drillthrough" && <span title="Drillthrough page">↳</span>}
          {renaming === p.name ? (
            <input
              autoFocus
              aria-label="Page name"
              defaultValue={p.displayName}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const name = e.currentTarget.value.trim();
                setRenaming(null);
                if (name && name !== p.displayName) c.dispatch("report.page.rename", { page: p.name, name });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(null);
              }}
              style={{ width: 110 }}
            />
          ) : (
            p.displayName
          )}
        </div>
      ))}
      <Button size="small" appearance="subtle" aria-label="New page" onClick={() => c.dispatch("report.page.add")}>
        ＋
      </Button>
      {dtPage && <DrillthroughFields page={dtPage} onClose={() => setDt(null)} />}
    </div>
  );
}
