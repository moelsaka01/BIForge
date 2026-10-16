// App-level settings: which shell, light/dark, recent projects and the layout of each shell. They live in the
// app's own storage (localStorage in the window), never in the document: switching shells never alters a project.

export type ShellKind = "classic" | "modern";
export type ThemeMode = "light" | "dark" | "system";
/** Light or dark after "system" has been looked up. */
export type ResolvedTheme = "light" | "dark";
export const resolveTheme = (mode: ThemeMode, systemDark: boolean): ResolvedTheme => (mode === "system" ? (systemDark ? "dark" : "light") : mode);
export type OptionValue = boolean | number | string;
export type RibbonMode = "multiline" | "singleline";
export const PANE_IDS = ["filters", "visualizations", "data", "properties", "bookmarks"] as const;
export type PaneId = (typeof PANE_IDS)[number];

export interface PaneLayout {
  open: boolean;
  width: number;
}

export interface ShellLayout {
  ribbonCollapsed: boolean;
  ribbonMode: RibbonMode;
  panes: Record<PaneId, PaneLayout>;
}

export interface RecentProject {
  path: string;
  name: string;
  /** Epoch milliseconds of the last time it was opened or created here. */
  openedAt: number;
}

export interface AppSettings {
  shell: ShellKind;
  theme: ThemeMode;
  recent: RecentProject[];
  layouts: Record<ShellKind, ShellLayout>;
  /** Global options of the Options dialog that are not shell, theme or layout (see core/options/schema.ts). */
  options: Record<string, OptionValue>;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SETTINGS_KEY = "biforge.settings.v1";
export const MAX_RECENT = 20;
const MAX_RECENT_LIMIT = 50;
export const MIN_PANE_WIDTH = 180;
export const MAX_PANE_WIDTH = 520;

export function defaultLayout(shell: ShellKind): ShellLayout {
  const base = (open: boolean, width: number): PaneLayout => ({ open, width });
  return shell === "classic"
    ? {
        ribbonCollapsed: false,
        ribbonMode: "multiline",
        panes: { filters: base(true, 220), visualizations: base(true, 260), data: base(true, 230), properties: base(true, 260), bookmarks: base(false, 240) },
      }
    : {
        ribbonCollapsed: false,
        ribbonMode: "singleline",
        panes: { filters: base(true, 280), visualizations: base(true, 300), data: base(true, 240), properties: base(true, 260), bookmarks: base(false, 260) },
      };
}

export function defaultSettings(): AppSettings {
  return { shell: "classic", theme: "light", recent: [], options: {}, layouts: { classic: defaultLayout("classic"), modern: defaultLayout("modern") } };
}

const clampWidth = (w: unknown, fallback: number) => (typeof w === "number" && isFinite(w) ? Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, Math.round(w))) : fallback);

function sanitizeLayout(raw: unknown, shell: ShellKind): ShellLayout {
  const d = defaultLayout(shell);
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<ShellLayout>;
  const panes = { ...d.panes };
  for (const id of PANE_IDS) {
    const p = (r.panes as Record<string, Partial<PaneLayout>> | undefined)?.[id];
    if (p && typeof p === "object") panes[id] = { open: typeof p.open === "boolean" ? p.open : d.panes[id].open, width: clampWidth(p.width, d.panes[id].width) };
  }
  return {
    ribbonCollapsed: typeof r.ribbonCollapsed === "boolean" ? r.ribbonCollapsed : d.ribbonCollapsed,
    ribbonMode: r.ribbonMode === "multiline" || r.ribbonMode === "singleline" ? r.ribbonMode : d.ribbonMode,
    panes,
  };
}

/** Reads stored settings defensively: anything unreadable or out of range falls back to the defaults. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<AppSettings>;
  const recent = Array.isArray(r.recent)
    ? r.recent
        .filter((x): x is RecentProject => !!x && typeof x.path === "string" && typeof x.name === "string" && typeof x.openedAt === "number")
        .slice(0, MAX_RECENT_LIMIT)
    : [];
  return {
    shell: r.shell === "modern" ? "modern" : "classic",
    theme: r.theme === "dark" || r.theme === "system" ? r.theme : "light",
    recent,
    options: sanitizeOptions(r.options),
    layouts: { classic: sanitizeLayout(r.layouts?.classic, "classic"), modern: sanitizeLayout(r.layouts?.modern, "modern") },
  };
}

function sanitizeOptions(raw: unknown): Record<string, OptionValue> {
  const out: Record<string, OptionValue> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.length <= 80 && (typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && isFinite(v)))) out[k] = v;
  }
  return out;
}

const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

export class SettingsStore {
  private snap: AppSettings;
  private listeners = new Set<() => void>();

  constructor(private storage: KeyValueStorage | null = null) {
    let raw: unknown = null;
    try {
      const text = storage?.getItem(SETTINGS_KEY);
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = null; // damaged settings are replaced by the defaults
    }
    this.snap = sanitizeSettings(raw);
  }

  getSnapshot = (): AppSettings => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private commit(next: AppSettings): void {
    this.snap = next;
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* storage may be blocked; the settings then last for this run only */
    }
    this.listeners.forEach((l) => l());
  }

  setShell(shell: ShellKind): void {
    if (shell !== this.snap.shell) this.commit({ ...this.snap, shell });
  }

  setTheme(theme: ThemeMode): void {
    if (theme !== this.snap.theme) this.commit({ ...this.snap, theme });
  }

  setOption(id: string, value: OptionValue): void {
    if (this.snap.options[id] === value) return;
    this.commit({ ...this.snap, options: { ...this.snap.options, [id]: value } });
  }

  addRecent(path: string, name: string, now = Date.now()): void {
    const rest = this.snap.recent.filter((r) => !samePath(r.path, path));
    const max = typeof this.snap.options["interface.recentCount"] === "number" ? Math.min(MAX_RECENT_LIMIT, Math.max(1, this.snap.options["interface.recentCount"] as number)) : MAX_RECENT;
    this.commit({ ...this.snap, recent: [{ path, name, openedAt: now }, ...rest].slice(0, max) });
  }

  removeRecent(path: string): void {
    this.commit({ ...this.snap, recent: this.snap.recent.filter((r) => !samePath(r.path, path)) });
  }

  private patchLayout(shell: ShellKind, patch: (l: ShellLayout) => ShellLayout): void {
    this.commit({ ...this.snap, layouts: { ...this.snap.layouts, [shell]: patch(this.snap.layouts[shell]) } });
  }

  setPane(shell: ShellKind, pane: PaneId, patch: Partial<PaneLayout>): void {
    this.patchLayout(shell, (l) => {
      const cur = l.panes[pane];
      const next = { open: patch.open ?? cur.open, width: patch.width === undefined ? cur.width : clampWidth(patch.width, cur.width) };
      return next.open === cur.open && next.width === cur.width ? l : { ...l, panes: { ...l.panes, [pane]: next } };
    });
  }

  setRibbonCollapsed(shell: ShellKind, collapsed: boolean): void {
    this.patchLayout(shell, (l) => (l.ribbonCollapsed === collapsed ? l : { ...l, ribbonCollapsed: collapsed }));
  }

  setRibbonMode(shell: ShellKind, mode: RibbonMode): void {
    this.patchLayout(shell, (l) => (l.ribbonMode === mode ? l : { ...l, ribbonMode: mode }));
  }

  /** Puts one shell's layout back to its defaults. */
  resetLayout(shell: ShellKind): void {
    this.patchLayout(shell, () => defaultLayout(shell));
  }
}
