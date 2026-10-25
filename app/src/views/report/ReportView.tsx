import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@fluentui/react-components";
import type { DaxApi } from "../../core/dax/types";
import type { Project } from "../../core/model/types";
import { DEFAULT_CANVAS, type CanvasOptions } from "../../core/report/canvasOptions";
import { ReportData, type ViewState } from "../../core/report/dataLoader";
import type { SelectedPoint } from "../../core/report/interactions";
import { modelInfo } from "../../core/report/modelInfo";
import type { ReportRuntime } from "../../core/report/runtime";
import { resolveTheme } from "../../core/report/theme";
import { activePageName, listPages, type PageModel, type VisualModel } from "../../core/report/visualDoc";
import { ContextMenu } from "./ContextMenu";
import { FiltersPane } from "./FiltersPane";
import { MobileLayoutPane, mobilePageOf } from "./MobileLayoutPane";
import { MOBILE_MIN_HEIGHT } from "../../core/report/reportOps";
import { PageCanvas } from "./PageCanvas";
import { layerStyle, readVerticalAlignment, readWallpaper } from "../../core/report/pageFormat";
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
  /** Page zoom: "fit" or a scale (1 = 100%). */
  zoom?: Zoom;
  /** Reports the scale the page is drawn at (the status bar shows it). */
  onScale?(scale: number): void;
  /** Panes docked left and right of the canvas. Without it the Filters and Visualizations panes sit on the right. */
  docks?(api: ReportDockApi): { left?: React.ReactNode; right?: React.ReactNode };
  /** On-object formatting is on (Modern interface with the preview feature enabled). */
  onObject?: boolean;
  /** Viewing mode: the canvas cannot be edited. */
  readOnly?: boolean;
  /** Canvas view options (smart guides, gridlines, snap to grid, lock objects); the defaults when absent. */
  canvas?: CanvasOptions;
}

type Zoom = "fit" | "width" | number;

/** What the docked panes need to know about the canvas. */
export interface ReportDockApi {
  page: PageModel;
  visual: VisualModel | null;
  /** A pane added a visual: select it. */
  onAdded(name: string | null): void;
}

/** Fixed Filters and Visualizations panes on the right (used by the harness and tests; the shells draw their own). */
export function plainDocks(api: ReportDockApi): { left?: React.ReactNode; right?: React.ReactNode } {
  return {
    right: (
      <>
        <div style={{ width: 240, flex: "none", borderLeft: "1px solid #ddd", overflow: "hidden" }}>
          <FiltersPane page={api.page} visual={api.visual} />
        </div>
        <div style={{ width: 290, flex: "none", borderLeft: "1px solid #ddd", overflow: "hidden" }}>
          <VisualizationsPane page={api.page} visual={api.visual} onAdded={api.onAdded} />
        </div>
      </>
    ),
  };
}

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [s, setS] = useState({ w: 900, h: 560 });
  // measured before the first paint, so the page does not flash at a wrong scale
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (w: number, h: number) => (w > 0 && h > 0 ? setS({ w: Math.max(100, w), h: Math.max(100, h) }) : undefined);
    const cs = getComputedStyle(el);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0;
    measure(el.clientWidth - padX, el.clientHeight - padY);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => measure(e.contentRect.width, e.contentRect.height));
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
        <PageCanvas page={page} scale={1} editing={false} selection={[]} onSelection={() => undefined} />
      </ReportContext.Provider>
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
  // the canvas selection lives in the runtime, so that ribbon commands (align, copy, delete) can act on it
  const selection = snap.canvas;
  const selected = selection.at(-1) ?? null;
  const setSelected = useCallback((name: string | null) => p.runtime.setCanvasSelection(name ? [name] : []), [p.runtime]);
  const setSelection = useCallback((names: string[]) => p.runtime.setCanvasSelection(names), [p.runtime]);
  const zoom = p.zoom ?? "fit";
  const [menu, setMenu] = useState<{ items: CtxMenuItem[]; x: number; y: number } | null>(null);
  const [tip, setTip] = useState<{ page: PageModel; point: SelectedPoint; x: number; y: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const size = useSize(area);

  // keep the runtime in step with the document
  useEffect(() => {
    p.runtime.reconcile(pages.map((pg) => ({ name: pg.name, visuals: [...pg.visuals.map((v) => v.name), ...pg.groups.map((g) => g.name)] })));
    if (!p.runtime.getSnapshot().page) {
      const a = activePageName(p.project);
      if (a) p.runtime.goToPage(a);
    }
  }, [pages, p.project, p.runtime]);

  const pageName = snap.page ?? activePageName(p.project);
  const page = pages.find((x) => x.name === pageName) ?? pages[0];
  useEffect(() => {
    const keep = selection.filter((n) => page?.visuals.some((v) => v.name === n) || page?.groups.some((g) => g.name === n));
    if (keep.length !== selection.length) p.runtime.setCanvasSelection(keep);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => p.onSelectVisual?.(page?.name ?? null, selected), [page?.name, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const liveView: ViewState = useMemo(() => ({ selection: snap.selection, drill: snap.drill, drillthrough: snap.drillthrough?.filters ?? [], epoch: snap.epoch + p.dataEpoch, crossDefault: (p.canvas ?? DEFAULT_CANVAS).crossDefault }), [snap.selection, snap.drill, snap.drillthrough, snap.epoch, p.dataEpoch, p.canvas]);
  // Pause visuals: the visuals keep the view they had when paused (so they send no new queries) until Refresh visuals
  const frozen = useRef({ view: liveView, tick: snap.refreshTick });
  if (!snap.paused || frozen.current.tick !== snap.refreshTick) frozen.current = { view: liveView, tick: snap.refreshTick };
  const view = snap.paused ? frozen.current.view : liveView;
  const onTooltip = useCallback((pg: PageModel, _v: string, point: SelectedPoint | null, x: number, y: number) => setTip(point ? { page: pg, point, x, y } : null), []);
  const onMenu = useCallback((items: CtxMenuItem[], x: number, y: number) => setMenu({ items, x, y }), []);

  const ctx: ReportCtx = useMemo(
    () => ({ project: p.project, pages, theme, model, data, view, snap, onObject: p.onObject === true, readOnly: p.readOnly === true, canvas: p.canvas ?? DEFAULT_CANVAS, focusFormat: (v: string, c: string) => p.runtime.focusFormat(v, c), dispatch: p.dispatch, onTooltip, onMenu }),
    [p.project, pages, theme, model, data, view, snap, p.onObject, p.readOnly, p.canvas, p.runtime, p.dispatch, onTooltip, onMenu],
  );

  const fit = page ? Math.min(size.w / page.width, size.h / page.height) : 1;
  const fitWidth = page ? size.w / page.width : 1;
  const scale = zoom === "fit" ? Math.max(0.2, Math.min(1.5, fit)) : zoom === "width" ? Math.max(0.2, Math.min(1.5, fitWidth)) : zoom;
  const onScale = p.onScale;
  // the phone layout is drawn at a fixed readable scale (it is narrow and scrolls)
  const mobileScale = Math.max(0.5, Math.min(1.2, (size.h - 24) / MOBILE_MIN_HEIGHT));
  useEffect(() => onScale?.(scale), [scale, onScale]);

  if (!page) return <div style={{ padding: 16 }}>This report has no pages.</div>;
  const selectedVisual = page.visuals.find((v) => v.name === selected) ?? null;
  const drillthroughNote = snap.drillthrough && page.type === "Drillthrough";
  const docks = (p.docks ?? plainDocks)({ page, visual: selectedVisual, onAdded: setSelected });

  return (
    <ReportContext.Provider value={ctx}>
      <div className="report-root" aria-label="Report">
        {docks.left}
        <div className="report-main">
          {(snap.drillthrough || snap.selection) && (
            <div role="status" className="notice-bar">
              {drillthroughNote ? "Drillthrough from another page is applied to this page." : snap.drillthrough ? "Showing a drillthrough." : "Data points are selected."}
              <span style={{ flex: 1 }} />
              {snap.selection && (
                <Button size="small" onClick={() => p.dispatch("report.view.clearSelection")}>
                  Clear selection
                </Button>
              )}
              {snap.drillthrough && (
                <Button size="small" appearance="primary" onClick={() => p.dispatch("report.view.back")}>
                  ← Back
                </Button>
              )}
            </div>
          )}
          <div ref={area} className="report-canvas" data-testid="wallpaper" style={{ ...(snap.mobile ? { display: "flex" } : {}), ...layerStyle(readWallpaper(page.json), null), ...(readVerticalAlignment(page.json) === "Middle" && !snap.mobile ? { alignItems: "center" } : {}) }}>
            {snap.mobile ? (
              <>
                <MobileLayoutPane page={page} />
                <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "flex-start", overflow: "auto", paddingTop: 8 }} data-testid="mobile-canvas">
                  <PageCanvas page={mobilePageOf(page)} scale={mobileScale} editing selection={selection} onSelection={setSelection} layout="mobile" />
                </div>
              </>
            ) : (
              <PageCanvas page={page} scale={scale} editing selection={selection} onSelection={setSelection} />
            )}
          </div>
          <PageTabs pages={pages} active={page.name} />
        </div>
        {docks.right}
      </div>
      {menu && <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {tip && <TooltipOverlay page={tip.page} point={tip.point} x={tip.x} y={tip.y} />}
    </ReportContext.Provider>
  );
}
