// View state of the open report that is not part of the document: the selected data points, drill positions,
// an active drillthrough, collapsed matrix rows, the page being viewed. Observable with useSyncExternalStore.
import type { FilterDef } from "./filters";
import { toggleSelection, type SelectedPoint, type Selection } from "./interactions";
import type { DrillState } from "./queryBuilder";
import { NO_DRILL } from "./queryBuilder";

export interface ViewSnapshot {
  page: string | null;
  selection: Selection | null;
  drill: Record<string, DrillState>;
  /** Drillthrough in effect on the current page: the page it came from and the filters it applied. */
  drillthrough: { from: string; fromSelection: Selection | null; filters: FilterDef[] } | null;
  collapsed: Record<string, string[]>;
  /** Bumped when imported data changes. */
  epoch: number;
  /** Visual whose drill mode is on: a click on a data point drills down instead of selecting. */
  drillMode: string | null;
  /** Page being edited for visual interactions: the source visual whose controls are shown. */
  editInteractions: string | null;
  /** Optimize > Pause visuals: the visuals keep what they show while selections, drilling and data changes pile up. */
  paused: boolean;
  /** Bumped by Refresh visuals: a paused report catches up once. */
  refreshTick: number;
  /** On-object formatting: the Format pane opens this card for this visual (tick makes the same request repeatable). */
  formatFocus: { visual: string; card: string; tick: number } | null;
  /** Visuals selected on the canvas of the current page, in the order they were selected (the last one is the one the panes show). */
  canvas: string[];
  /** Visuals copied or cut in this window (a copy also goes to the system clipboard as JSON). */
  clipboard: unknown | null;
  /** The canvas shows the phone layout instead of the desktop page. */
  mobile: boolean;
}

export class ReportRuntime {
  private snap: ViewSnapshot = { page: null, selection: null, drill: {}, drillthrough: null, collapsed: {}, epoch: 0, drillMode: null, editInteractions: null, paused: false, refreshTick: 0, formatFocus: null, canvas: [], clipboard: null, mobile: false };
  private listeners = new Set<() => void>();

  getSnapshot = (): ViewSnapshot => this.snap;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<ViewSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  focusFormat(visual: string, card: string): void {
    this.set({ formatFocus: { visual, card, tick: (this.snap.formatFocus?.tick ?? 0) + 1 } });
  }

  setPaused(paused: boolean): void {
    if (paused !== this.snap.paused) this.set({ paused });
  }

  /** Refresh visuals: a paused report catches up with the current state. */
  refreshVisuals(): void {
    this.set({ refreshTick: this.snap.refreshTick + 1 });
  }

  /** Switches page; selections and drillthrough belong to the page they were made on. */
  goToPage(page: string): void {
    if (page === this.snap.page) return;
    this.set({ page, selection: null, drillthrough: null, editInteractions: null, drillMode: null, canvas: [] });
  }

  /** Called when the document's pages change: drops state that refers to pages or visuals that are gone. */
  reconcile(pages: { name: string; visuals: string[] }[]): void {
    const names = new Set(pages.map((p) => p.name));
    const visuals = new Set(pages.flatMap((p) => p.visuals));
    const patch: Partial<ViewSnapshot> = {};
    if (this.snap.page && !names.has(this.snap.page)) patch.page = pages[0]?.name ?? null;
    if (this.snap.selection && (!names.has(this.snap.selection.page) || !visuals.has(this.snap.selection.visual))) patch.selection = null;
    const drill = Object.fromEntries(Object.entries(this.snap.drill).filter(([v]) => visuals.has(v)));
    if (Object.keys(drill).length !== Object.keys(this.snap.drill).length) patch.drill = drill;
    if (this.snap.drillMode && !visuals.has(this.snap.drillMode)) patch.drillMode = null;
    if (this.snap.editInteractions && !visuals.has(this.snap.editInteractions)) patch.editInteractions = null;
    const canvas = this.snap.canvas.filter((v) => visuals.has(v));
    if (canvas.length !== this.snap.canvas.length) patch.canvas = canvas;
    if (Object.keys(patch).length) this.set(patch);
  }

  setMobile(on: boolean): void {
    if (this.snap.mobile === on) return;
    this.set({ mobile: on, canvas: [], selection: null });
  }

  setCanvasSelection(names: string[]): void {
    const a = this.snap.canvas;
    if (a.length === names.length && a.every((n, i) => n === names[i])) return;
    this.set({ canvas: names });
  }

  setClipboard(c: unknown | null): void {
    this.set({ clipboard: c });
  }

  select(page: string, visual: string, point: SelectedPoint, additive: boolean): void {
    this.set({ selection: toggleSelection(this.snap.selection, page, visual, point, additive) });
  }

  clearSelection(): void {
    if (this.snap.selection) this.set({ selection: null });
  }

  refreshData(): void {
    this.set({ epoch: this.snap.epoch + 1 });
  }

  // ---- drilling ----

  drillOf(visual: string): DrillState {
    return this.snap.drill[visual] ?? NO_DRILL;
  }

  private setDrill(visual: string, d: DrillState): void {
    const drill = { ...this.snap.drill };
    if (d.level === 0 && !d.expand && d.path.length === 0) delete drill[visual];
    else drill[visual] = d;
    this.set({ drill, selection: this.snap.selection?.visual === visual ? null : this.snap.selection });
  }

  /** Drill down on a data point of a visual with `levels` category fields. */
  drillDown(visual: string, levels: number, point: SelectedPoint["values"][number]): void {
    const d = this.drillOf(visual);
    if (d.level >= levels - 1) return;
    const path = [...d.path];
    path[d.level] = point;
    this.setDrill(visual, { level: d.level + 1, path, expand: false });
  }

  drillUp(visual: string): void {
    const d = this.drillOf(visual);
    if (d.level === 0) return;
    this.setDrill(visual, { level: d.level - 1, path: d.path.slice(0, d.level - 1), expand: false });
  }

  /** Show the next level for all values ("go to the next level in the hierarchy"). */
  nextLevel(visual: string, levels: number): void {
    const d = this.drillOf(visual);
    if (d.level >= levels - 1) return;
    this.setDrill(visual, { level: d.level + 1, path: [...d.path, null].slice(0, d.level + 1), expand: false });
  }

  /** Show all levels down to the next one ("expand all down one level"). */
  expandAll(visual: string, levels: number): void {
    const d = this.drillOf(visual);
    if (d.level >= levels - 1) return;
    this.setDrill(visual, { level: d.level + 1, path: d.path, expand: true });
  }

  resetDrill(visual: string): void {
    this.setDrill(visual, NO_DRILL);
  }

  setDrillMode(visual: string | null): void {
    this.set({ drillMode: visual });
  }

  setEditInteractions(source: string | null): void {
    this.set({ editInteractions: source });
  }

  // ---- drillthrough ----

  drillThrough(toPage: string, fromPage: string, filters: FilterDef[]): void {
    this.set({ page: toPage, drillthrough: { from: fromPage, fromSelection: this.snap.selection, filters }, selection: null, editInteractions: null, drillMode: null });
  }

  /** Return from a drillthrough page to the page and selection it was opened from. */
  back(): void {
    const dt = this.snap.drillthrough;
    if (!dt) return;
    this.set({ page: dt.from, selection: dt.fromSelection, drillthrough: null });
  }

  // ---- matrix ----

  toggleCollapsed(visual: string, rowKey: string): void {
    const cur = new Set(this.snap.collapsed[visual] ?? []);
    if (cur.has(rowKey)) cur.delete(rowKey);
    else cur.add(rowKey);
    this.set({ collapsed: { ...this.snap.collapsed, [visual]: [...cur] } });
  }

  /** Restores drill and selection (bookmarks). */
  restore(state: { page: string; selection: Selection | null; drill: Record<string, DrillState> }): void {
    this.set({ page: state.page, selection: state.selection, drill: state.drill, drillthrough: null, drillMode: null, editInteractions: null });
  }
}
