import { useEffect, useState } from "react";
import { Button, Select, Tab, TabList } from "@fluentui/react-components";
import { AGG_LABELS, fieldKey, fieldLabel, type AggFn, type FieldRef } from "../../core/report/fields";
import { fieldForRole } from "../../core/report/fieldRouting";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { VISUAL_TYPES, visualType } from "../../core/report/visualTypes";
import { analyticsCards } from "../../core/report/formatSchema";
import { GroupPane } from "./GroupPane";
import { PageFormatPane } from "./PageFormatPane";
import { FormatPane } from "./FormatPane";
import { useReport } from "./reportContext";

export const FIELD_MIME = "application/x-biforge-field";

/** Several fields at once (a hierarchy dragged from the Data pane: its levels, top to bottom). */
export const FIELDS_MIME = "application/x-biforge-fields";

/** Everything the Data pane put on a drag: the levels of a hierarchy, or the one field. */
export function fieldsFromDrag(dt: DataTransfer): FieldRef[] {
  const raw = dt.getData(FIELDS_MIME);
  if (raw) {
    try {
      const list = JSON.parse(raw) as FieldRef[];
      const ok = Array.isArray(list) && list.every((f) => f && typeof f.table === "string" && typeof f.name === "string" && f.kind === "column");
      if (ok) return list;
    } catch {
      /* fall through to the single field */
    }
  }
  const one = fieldFromDrag(dt);
  return one ? [one] : [];
}

/** Parses what the Data pane puts on a drag. */
export function fieldFromDrag(dt: DataTransfer): FieldRef | null {
  const raw = dt.getData(FIELD_MIME);
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as FieldRef;
    return f && typeof f.table === "string" && typeof f.name === "string" && (f.kind === "column" || f.kind === "measure" || f.kind === "agg") ? f : null;
  } catch {
    return null;
  }
}

export interface VisualizationsPaneProps {
  page: PageModel;
  visual: VisualModel | null;
  onAdded(name: string | null): void;
}

export function VisualizationsPane(p: VisualizationsPaneProps) {
  const c = useReport();
  const [tab, setTab] = useState<"build" | "format" | "analytics">("build");
  const { visual, page } = p;
  const focus = c.snap.formatFocus;
  useEffect(() => {
    if (focus && visual && focus.visual === visual.name) setTab("format");
  }, [focus?.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = visual ? visualType(visual.visualType) : undefined;
  // one selected group: its own settings instead of those of a visual
  const group = !visual && c.snap.canvas.length === 1 ? (page.groups.find((g) => g.name === c.snap.canvas[0]) ?? null) : null;
  if (group) return <GroupPane page={page} group={group} />;

  const pick = (id: string) => {
    if (visual) c.dispatch("report.visual.setType", { page: page.name, visual: visual.name, type: id });
    else c.dispatch("report.visual.add", { page: page.name, type: id });
  };

  const fieldMenu = (role: string, index: number, f: FieldRef, count: number, x: number, y: number) => {
    const items = [
      ...(f.kind !== "measure"
        ? (Object.keys(AGG_LABELS) as unknown as AggFn[]).map((k) => ({
            label: `${f.kind === "agg" && f.fn === Number(k) ? "✓ " : "   "}${AGG_LABELS[Number(k) as AggFn]}`,
            onClick: () => c.dispatch("report.field.setAggregation", { page: page.name, visual: visual!.name, role, index, fn: Number(k) }),
          }))
        : []),
      ...(f.kind !== "measure" ? [{ separator: true, label: "", onClick: () => undefined }] : []),
      { label: "Rename for this visual", onClick: () => {
          const name = window.prompt("Name to show in this visual", fieldLabel(f));
          if (name !== null) c.dispatch("report.field.rename", { page: page.name, visual: visual!.name, role, index, name });
        } },
      { label: "Move up", disabled: index === 0, onClick: () => c.dispatch("report.field.move", { page: page.name, visual: visual!.name, role, from: index, to: index - 1 }) },
      { label: "Move down", disabled: index >= count - 1, onClick: () => c.dispatch("report.field.move", { page: page.name, visual: visual!.name, role, from: index, to: index + 1 }) },
      { separator: true, label: "", onClick: () => undefined },
      { label: "Remove field", onClick: () => c.dispatch("report.field.remove", { page: page.name, visual: visual!.name, role, index }) },
    ];
    c.onMenu(items, x, y);
  };

  const sortables = visual ? Object.values(visual.roles).flat().map((x) => x.field) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }} aria-label="Visualizations pane">
      <div style={{ padding: "6px 8px 0" }}>
        <TabList size="small" selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="build">Build visual</Tab>
          <Tab value="format">
            {visual ? "Format visual" : "Format page"}
          </Tab>
          <Tab value="analytics" disabled={!visual || analyticsCards(visual.visualType).length === 0}>
            Analytics
          </Tab>
        </TabList>
      </div>
      {tab === "analytics" && visual ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <FormatPane analytics page={page} visual={visual} pages={c.pages} dispatch={c.dispatch} />
        </div>
      ) : tab === "format" && !visual ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <PageFormatPane page={page} />
        </div>
      ) : tab === "format" && visual ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <FormatPane page={page} visual={visual} pages={c.pages} dispatch={c.dispatch} />
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          <div role="group" aria-label="Visual types" style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4 }}>
            {VISUAL_TYPES.filter((t) => !t.static).map((t) => (
              <Button
                key={t.id}
                size="small"
                appearance={visual?.visualType === t.id ? "primary" : "outline"}
                aria-label={t.label}
                aria-pressed={visual?.visualType === t.id}
                title={t.label}
                onClick={() => pick(t.id)}
                style={{ minWidth: 0, padding: "2px 0", fontSize: 13 }}
              >
                {t.glyph}
              </Button>
            ))}
          </div>
          {!visual && <div style={{ fontSize: 12, opacity: 0.7 }}>Select a visual on the canvas to change its fields, or choose a type above to add a new visual.</div>}
          {visual && type && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{type.label}</div>
              {type.roles.map((r) => {
                const list = visual.roles[r.name] ?? [];
                return (
                  <div key={r.name} role="group" aria-label={`${r.label} well`} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontSize: 12 }}>
                      {r.label}
                      {r.accepts === "value" ? " (values)" : ""}
                    </span>
                    <div
                      data-well={r.name}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        for (const f of fieldsFromDrag(e.dataTransfer)) c.dispatch("report.field.add", { page: page.name, visual: visual.name, role: r.name, field: fieldForRole(c.model, r.accepts, f) });
                      }}
                      style={{ minHeight: 28, border: "1px dashed #aaa", borderRadius: 4, padding: 3, display: "flex", flexDirection: "column", gap: 3 }}
                    >
                      {list.length === 0 && <span style={{ fontSize: 11, opacity: 0.6, padding: "2px 4px" }}>Add data fields here</span>}
                      {list.map((pr, i) => (
                        <div key={fieldKey(pr.field)} style={{ display: "flex", alignItems: "center", background: "#e8f1fb", color: "#123", borderRadius: 3, padding: "1px 4px", fontSize: 12, gap: 4 }}>
                          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fieldKey(pr.field)}>
                            {pr.displayName ?? fieldLabel(pr.field)}
                          </span>
                          <button
                            aria-label={`Options for ${fieldLabel(pr.field)}`}
                            onClick={(e) => fieldMenu(r.name, i, pr.field, list.length, e.clientX, e.clientY)}
                            style={{ border: "none", background: "transparent", cursor: "pointer", color: "inherit" }}
                          >
                            ▾
                          </button>
                          <button aria-label={`Remove ${fieldLabel(pr.field)}`} onClick={() => c.dispatch("report.field.remove", { page: page.name, visual: visual.name, role: r.name, index: i })} style={{ border: "none", background: "transparent", cursor: "pointer", color: "inherit" }}>
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {sortables.length > 0 && (
                <div style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                  Sort by
                  <Select
                    size="small"
                    aria-label="Sort by"
                    value={visual.sort ? fieldKey(visual.sort.field) : ""}
                    onChange={(_, d) => c.dispatch("report.visual.setSort", { page: page.name, visual: visual.name, sort: d.value ? { field: sortables.find((f) => fieldKey(f) === d.value), dir: visual.sort?.dir ?? "asc" } : null })}
                  >
                    <option value="">Default</option>
                    {sortables.map((f) => (
                      <option key={fieldKey(f)} value={fieldKey(f)}>
                        {fieldLabel(f)}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="small"
                    aria-label={visual.sort?.dir === "desc" ? "Sort descending" : "Sort ascending"}
                    disabled={!visual.sort}
                    onClick={() => c.dispatch("report.visual.setSort", { page: page.name, visual: visual.name, sort: { field: visual.sort!.field, dir: visual.sort!.dir === "asc" ? "desc" : "asc" } })}
                  >
                    {visual.sort?.dir === "desc" ? "▼" : "▲"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
