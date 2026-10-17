import { SettingsStore, resolveTheme, type KeyValueStorage, type ResolvedTheme, type ShellKind } from "./settings";
import { noWindow, type WindowApi } from "./windowApi";

export type ViewId = "report" | "data" | "model" | "dax" | "tmdl";
export const VIEW_IDS: readonly ViewId[] = ["report", "data", "model", "dax", "tmdl"];
export type Zoom = "fit" | number;

/** A dialog a command asked for. The shell draws it; the dialog's buttons dispatch commands again. */
export type DialogRequest =
  | { kind: "newProject"; /** create the sample project instead of a blank one */ sample?: boolean; /** open the import dialog (for this source) right after the project exists */ thenImport?: string | true }
  | { kind: "import"; source?: string }
  | { kind: "newTable" }
  | { kind: "unsaved"; /** the command to run again (with discard: true) once the user has decided */ resume: { id: string; args?: Record<string, unknown> } }
  | { kind: "options"; page?: string }
  | { kind: "saveAs"; copy?: boolean }
  | { kind: "exportMenu" }
  | { kind: "importMenu" }
  | { kind: "about" }
  | { kind: "publish" }
  | { kind: "openPackage"; /** the package file (from a link, a file association or the file picker) */ path?: string; /** a feed address from a link: the package is downloaded first */ feedUrl?: string; fromLink?: boolean }
  | { kind: "guide"; guideId: string; /** shows only when not hidden by the user */ once?: boolean }
  | { kind: "shortcuts" };

export interface ShellState {
  /** "start" is the start screen (and, while a project is open, the File backstage). */
  screen: "start" | "workspace";
  view: ViewId;
  /** Ribbon tab per view; null = the first tab. */
  ribbonTab: Partial<Record<ViewId, string>>;
  daxTab: "query" | "measures";
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
  sideTab: "visualizations" | "filters" | "bookmarks" | "selection" | "sync";
  systemDark: boolean;
  /** Bumped by the TMDL ribbon's Apply so the TMDL view applies its edits. */
  applyTmdlTick: number;
}

const INITIAL: ShellState = {
  screen: "start",
  view: "report",
  ribbonTab: {},
  daxTab: "query",
  selectedVisual: null,
  selectedTable: null,
  zoom: "fit",
  dialog: null,
  newMeasureTick: 0,
  runQueryTick: 0,
  daxQuery: "",
  sideTab: "visualizations",
  systemDark: false,
  applyTmdlTick: 0,
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

  /** Whether Windows is in dark mode (set by the host window; "Use system setting" follows it). */
  private systemDarkNow = false;

  get systemDark(): boolean {
    return this.systemDarkNow;
  }

  setSystemDark(dark: boolean): void {
    if (dark === this.systemDarkNow) return;
    this.systemDarkNow = dark;
    this.set({ systemDark: dark });
  }

  /** The theme in effect: the chosen one, or the system's when "Use system setting" is on. */
  resolvedTheme(): ResolvedTheme {
    return resolveTheme(this.settings.getSnapshot().theme, this.systemDarkNow);
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

  requestApplyTmdl(): void {
    this.set({ view: "tmdl", screen: "workspace", applyTmdlTick: this.snap.applyTmdlTick + 1 });
  }

  requestRunQuery(): void {
    this.set({ view: "dax", daxTab: "query", screen: "workspace", runQueryTick: this.snap.runQueryTick + 1 });
  }

  requestNewMeasure(): void {
    this.set({ view: "dax", daxTab: "measures", screen: "workspace", newMeasureTick: this.snap.newMeasureTick + 1 });
  }
}
