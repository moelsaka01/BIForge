import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Select, ToggleButton } from "@fluentui/react-components";
import type { DaxApi } from "../../core/dax/types";
import type { Project } from "../../core/model/types";
import { ReportData, type ViewState } from "../../core/report/dataLoader";
import type { SelectedPoint } from "../../core/report/interactions";
import { modelInfo } from "../../core/report/modelInfo";
import type { ReportRuntime } from "../../core/report/runtime";
import { BUILTIN_THEMES, resolveTheme, themeToJson } from "../../core/report/theme";
import { activePageName, listPages, type PageModel } from "../../core/report/visualDoc";
import { BookmarksPane } from "./BookmarksPane";
import { ContextMenu } from "./ContextMenu";
import { FiltersPane } from "./FiltersPane";
import { PageCanvas } from "./PageCanvas";
import { PageTabs } from "./PageTabs";
import { ReportContext, useReport, type Dispatch, type MenuItem as CtxMenuItem, type ReportCtx } from "./reportContext";
import { VisualizationsPane } from "./VisualizationsPane";

export interface ReportViewProps {
  project: Project;
  runtime: ReportRuntime;
  dax: DaxApi;
  dispatch: Dispatch;
  /** Bumped by the host when imported data changed. */
  dataEpoch: number;
  /** Notified when the user selects a visual (the Data pane shows which fields it uses). */
  onSelectVisual?(page: string | null, visual: string | null): void;
}

type Zoom = "fit" | number;

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [s, setS] = useState({ w: 900, h: 560 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setS({ w: Math.max(100, e.contentRect.width), h: Math.max(100, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return s;
}

/** Overlay that draws a report page as the tooltip of a data point. */
function TooltipOverlay({ page, point, x, y }: { page: PageModel; point: SelectedPoint; x: number; y: number }) {
  const base = useReport();
  const filters = useMemo(
    () => point.fields.map((f, i) => ({ name: `tooltip${i}`, field: f, cond: { kind: "in" as const, values: [point.values[i]] } })),
    [point],
  );
  const ctx: ReportCtx = { ...base, view: { ...base.view, selection: null, drillthrough: filters }, snap: { ...base.snap, selection: null, drill: {}, drillMode: null, editInteractions: null }, onTooltip: () => undefined, onMenu: () => undefined, dispatch: () => undefined };
  const left = Math.min(x + 14, window.innerWidth - page.width - 8);
  const top = Math.min(y + 14, window.innerHeight - page.height - 8);
  return (
    <div role="tooltip" style={{ position: "fixed", left, top, width: page.width, height: page.height, zIndex: 3000, boxShadow: "0 4px 16px rgba(0,0,0,.35)", pointerEvents: "none", background: "#fff" }} data-testid="tooltip-page">
      <ReportContext.Provider value={ctx}>
        <PageCanvas page={page} scale={1} editing={false} selected={null} onSelect={() => undefined} />
      </ReportContext.Provider>
    </div>
  );
}

function Toolbar(p: { zoom: Zoom; setZoom(z: Zoom): void; panes: Record<string, boolean>; togglePane(k: string): void; selected: string | null; editing: boolean }) {
  const c = useReport();
  const file = useRef<HTMLInputElement>(null);
  const importTheme = async (f: File | undefined) => {
    if (!f) return;
    c.dispatch("report.theme.apply", { json: await f.text() });
  };
  const exportTheme = () => {
    const blob = new Blob([JSON.stringify(themeToJson(c.theme), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${c.theme.name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div role="toolbar" aria-label="Report tools" style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 8px", borderBottom: "1px solid #ddd", flexWrap: "wrap" }}>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button size="small" aria-label="Themes">
            Themes ▾
          </Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {BUILTIN_THEMES.map((t) => (
              <MenuItem key={t.name} onClick={() => c.dispatch("report.theme.apply", { builtin: t.name })}>
                {c.theme.name === t.name ? "✓ " : ""}
                {t.name}
              </MenuItem>
            ))}
            <MenuItem onClick={() => file.current?.click()}>Import theme file…</MenuItem>
            <MenuItem onClick={exportTheme}>Export the current theme…</MenuItem>
            <MenuItem onClick={() => c.dispatch("report.theme.reset")}>Reset to the default theme</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      <input ref={file} type="file" accept=".json,application/json" hidden aria-label="Theme file" onChange={(e) => void importTheme(e.target.files?.[0]).then(() => (e.target.value = ""))} />
      <ToggleButton size="small" checked={!!c.snap.editInteractions} disabled={!p.selected} onClick={() => c.dispatch("report.interaction.edit", { source: c.snap.editInteractions ? null : p.selected })}>
        Edit interactions
      </ToggleButton>
      <Button size="small" disabled={!c.snap.selection} onClick={() => c.dispatch("report.view.clearSelection")}>
        Clear selection
      </Button>
      {c.snap.drillthrough && (
        <Button size="small" appearance="primary" onClick={() => c.dispatch("report.view.back")}>
          ← Back
        </Button>
      )}
      <span style={{ flex: 1 }} />
      <Select size="small" aria-label="Zoom" value={String(p.zoom)} onChange={(_, d) => p.setZoom(d.value === "fit" ? "fit" : Number(d.value))} style={{ width: 120 }}>
        <option value="fit">Fit to page</option>
        <option value="0.5">50%</option>
        <option value="0.75">75%</option>
        <option value="1">100%</option>
        <option value="1.5">150%</option>
      </Select>
      {(["filters", "visualizations", "bookmarks"] as const).map((k) => (
        <ToggleButton key={k} size="small" checked={p.panes[k]} onClick={() => p.togglePane(k)}>
          {k === "filters" ? "Filters" : k === "visualizations" ? "Visualizations" : "Bookmarks"}
        </ToggleButton>
      ))}
    </div>
  );
}

/** The report canvas with page tabs and the Visualizations, Filters and Bookmarks panes. */
export function ReportView(p: ReportViewProps) {
  const snap = useSyncExternalStore(p.runtime.subscribe, p.runtime.getSnapshot);
  const pages = useMemo(() => listPages(p.project), [p.project]);
  const theme = useMemo(() => resolveTheme(p.project), [p.project]);
  const model = useMemo(() => modelInfo(p.project), [p.project]);
  const data = useMemo(() => new ReportData(p.dax), [p.dax]);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [panes, setPanes] = useState({ filters: true, visualizations: true, bookmarks: false });
  const [menu, setMenu] = useState<{ items: CtxMenuItem[]; x: number; y: number } | null>(null);
  const [tip, setTip] = useState<{ page: PageModel; point: SelectedPoint; x: number; y: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const size = useSize(area);

  // keep the runtime in step with the document
  useEffect(() => {
    p.runtime.reconcile(pages.map((pg) => ({ name: pg.name, visuals: pg.visuals.map((v) => v.name) })));
    if (!p.runtime.getSnapshot().page) {
      const a = activePageName(p.project);
      if (a) p.runtime.goToPage(a);
    }
  }, [pages, p.project, p.runtime]);

  const pageName = snap.page ?? activePageName(p.project);
  const page = pages.find((x) => x.name === pageName) ?? pages[0];
  useEffect(() => setSelected((s) => (s && page?.visuals.some((v) => v.name === s) ? s : null)), [page]);
  useEffect(() => p.onSelectVisual?.(page?.name ?? null, selected), [page?.name, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const view: ViewState = useMemo(() => ({ selection: snap.selection, drill: snap.drill, drillthrough: snap.drillthrough?.filters ?? [], epoch: snap.epoch + p.dataEpoch }), [snap.selection, snap.drill, snap.drillthrough, snap.epoch, p.dataEpoch]);
  const onTooltip = useCallback((pg: PageModel, _v: string, point: SelectedPoint | null, x: number, y: number) => setTip(point ? { page: pg, point, x, y } : null), []);
  const onMenu = useCallback((items: CtxMenuItem[], x: number, y: number) => setMenu({ items, x, y }), []);

  const ctx: ReportCtx = useMemo(
    () => ({ project: p.project, pages, theme, model, data, view, snap, dispatch: p.dispatch, onTooltip, onMenu }),
    [p.project, pages, theme, model, data, view, snap, p.dispatch, onTooltip, onMenu],
  );

  if (!page) return <div style={{ padding: 16 }}>This report has no pages.</div>;
  const selectedVisual = page.visuals.find((v) => v.name === selected) ?? null;
  const fit = Math.min((size.w - 24) / page.width, (size.h - 24) / page.height);
  const scale = zoom === "fit" ? Math.max(0.2, Math.min(1.5, fit)) : zoom;
  const drillthroughNote = snap.drillthrough && page.type === "Drillthrough";

  return (
    <ReportContext.Provider value={ctx}>
      <div style={{ display: "flex", height: "100%", minWidth: 0 }} aria-label="Report">
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Toolbar zoom={zoom} setZoom={setZoom} panes={panes} togglePane={(k) => setPanes((s) => ({ ...s, [k]: !s[k as keyof typeof s] }))} selected={selected} editing />
          {drillthroughNote && (
            <div role="status" style={{ fontSize: 12, padding: "2px 8px", background: "#eef5fc", color: "#123" }}>
              Drillthrough from another page is applied to this page.
            </div>
          )}
          <div ref={area} style={{ flex: 1, minHeight: 0, overflow: "auto", background: "#e9e9e9", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 12, boxSizing: "border-box" }}>
            <PageCanvas page={page} scale={scale} editing selected={selected} onSelect={setSelected} />
          </div>
          <PageTabs pages={pages} active={page.name} />
        </div>
        {panes.filters && (
          <div style={{ width: 240, flex: "none", borderLeft: "1px solid #ddd", overflow: "hidden" }}>
            <FiltersPane page={page} visual={selectedVisual} />
          </div>
        )}
        {panes.visualizations && (
          <div style={{ width: 290, flex: "none", borderLeft: "1px solid #ddd", overflow: "hidden" }}>
            <VisualizationsPane page={page} visual={selectedVisual} onAdded={setSelected} />
          </div>
        )}
        {panes.bookmarks && (
          <div style={{ width: 230, flex: "none", borderLeft: "1px solid #ddd", overflow: "hidden" }}>
            <BookmarksPane />
          </div>
        )}
      </div>
      {menu && <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {tip && <TooltipOverlay page={tip.page} point={tip.point} x={tip.x} y={tip.y} />}
    </ReportContext.Provider>
  );
}
