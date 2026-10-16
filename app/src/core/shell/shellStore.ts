import { SettingsStore, type KeyValueStorage, type ShellKind } from "./settings";
import { noWindow, type WindowApi } from "./windowApi";

export type ViewId = "report" | "data" | "model" | "dax" | "tmdl";
export const VIEW_IDS: readonly ViewId[] = ["report", "data", "model", "dax", "tmdl"];
export type Zoom = "fit" | number;

/** A dialog a command asked for. The shell draws it; the dialog's buttons dispatch commands again. */
export type DialogRequest =
  | { kind: "newProject"; /** open the import dialog (for this source) right after the project exists */ thenImport?: string | true }
  | { kind: "import"; source?: string }
  | { kind: "newTable" }
  | { kind: "unsaved"; /** the command to run again (with discard: true) once the user has decided */ resume: { id: string; args?: Record<string, unknown> } }
  | { kind: "options" }
  | { kind: "about" }
  | { kind: "shortcuts" };

export interface ShellState {
  /** "start" is the start screen (and, while a project is open, the File backstage). */
  screen: "start" | "workspace";
  view: ViewId;
  /** Ribbon tab per view; null = the first tab. */
  ribbonTab: Partial<Record<ViewId, string>>;
  daxTab: "query" | "measures";
  startTab: "recent" | "shared";
  selectedVisual: { page: string; visual: string } | null;
  selectedTable: string | null;
  zoom: Zoom;
  dialog: DialogRequest | null;
  /** Bumped by "New measure" so the measure editor starts a fresh one. */
  newMeasureTick: number;
  /** Bumped by "Run" so the DAX query view runs its query. */
  runQueryTick: number;
  /** Text of the DAX query view (kept while the user looks at other views). */
  daxQuery: string;
  /** Modern shell: which pane the right-hand sidebar shows. */
  sideTab: "visualizations" | "filters" | "bookmarks";
}

const INITIAL: ShellState = {
  screen: "start",
  view: "report",
  ribbonTab: {},
  daxTab: "query",
  startTab: "recent",
  selectedVisual: null,
  selectedTable: null,
  zoom: "fit",
  dialog: null,
  newMeasureTick: 0,
  runQueryTick: 0,
  daxQuery: "",
  sideTab: "visualizations",
};

/** Transient UI state of the app frame (which screen, which view, which dialog) plus the persisted settings. */
export class ShellStore {
  readonly settings: SettingsStore;
  private snap: ShellState = { ...INITIAL };
  private listeners = new Set<() => void>();

  constructor(
    storage: KeyValueStorage | null = null,
    readonly window: WindowApi = noWindow,
  ) {
    this.settings = new SettingsStore(storage);
  }

  getSnapshot = (): ShellState => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<ShellState>): void {
    const next = { ...this.snap, ...patch };
    if ((Object.keys(patch) as (keyof ShellState)[]).every((k) => Object.is(next[k], this.snap[k]))) return;
    this.snap = next;
    this.listeners.forEach((l) => l());
  }

  get shell(): ShellKind {
    return this.settings.getSnapshot().shell;
  }

  showStart(): void {
    this.set({ screen: "start" });
  }

  enterWorkspace(view: ViewId = "report"): void {
    this.set({ screen: "workspace", view, selectedVisual: null, selectedTable: null, zoom: "fit", daxTab: "query" });
  }

  /** The project was closed: back to the plain start screen. */
  leaveWorkspace(): void {
    this.set({ screen: "start", selectedVisual: null, selectedTable: null });
  }

  setView(view: ViewId): void {
    this.set({ view, screen: "workspace" });
  }

  setRibbonTab(view: ViewId, tab: string): void {
    if (this.snap.ribbonTab[view] !== tab) this.set({ ribbonTab: { ...this.snap.ribbonTab, [view]: tab } });
  }

  setDaxTab(tab: "query" | "measures"): void {
    this.set({ daxTab: tab });
  }

  setStartTab(tab: "recent" | "shared"): void {
    this.set({ startTab: tab });
  }

  selectVisual(v: { page: string; visual: string } | null): void {
    const cur = this.snap.selectedVisual;
    if (cur?.page === v?.page && cur?.visual === v?.visual) return;
    this.set({ selectedVisual: v });
  }

  selectTable(name: string | null): void {
    this.set({ selectedTable: name });
  }

  setZoom(zoom: Zoom): void {
    this.set({ zoom });
  }

  openDialog(d: DialogRequest): void {
    this.set({ dialog: d });
  }

  closeDialog(): void {
    this.set({ dialog: null });
  }

  setDaxQuery(text: string): void {
    this.set({ daxQuery: text });
  }

  setSideTab(tab: ShellState["sideTab"]): void {
    this.set({ sideTab: tab });
  }

  requestRunQuery(): void {
    this.set({ view: "dax", daxTab: "query", screen: "workspace", runQueryTick: this.snap.runQueryTick + 1 });
  }

  requestNewMeasure(): void {
    this.set({ view: "dax", daxTab: "measures", screen: "workspace", newMeasureTick: this.snap.newMeasureTick + 1 });
  }
}
