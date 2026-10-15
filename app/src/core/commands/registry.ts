export interface Command<Ctx> {
  id: string;
  label: string;
  category?: string;
  /** Alt-key sequence shown in the ribbon, e.g. "H". Layout data may override it per shell. */
  keytip?: string;
  /** Keyboard shortcut, e.g. "Ctrl+Z". Normalized on registration. */
  shortcut?: string;
  isEnabled?: (ctx: Ctx) => boolean;
  run: (ctx: Ctx, args?: unknown) => void | Promise<void>;
}

export type ExecuteResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "disabled" | "failed"; message: string };

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];

export function normalizeShortcut(s: string): string {
  const parts = s.split("+").map((p) => p.trim()).filter(Boolean);
  const mods = new Set<string>();
  let key = "";
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "ctrl" || l === "control") mods.add("Ctrl");
    else if (l === "alt") mods.add("Alt");
    else if (l === "shift") mods.add("Shift");
    else if (l === "meta" || l === "cmd" || l === "win") mods.add("Meta");
    else key = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1).toLowerCase();
  }
  if (!key) throw new Error(`Shortcut "${s}" has no key.`);
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function eventToShortcut(e: KeyLike): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(e.key);
  return normalizeShortcut(parts.join("+"));
}

export class CommandRegistry<Ctx> {
  private commands = new Map<string, Command<Ctx>>();
  private shortcuts = new Map<string, string>();

  constructor(private ctx: Ctx) {}

  register(cmd: Command<Ctx>): void {
    if (this.commands.has(cmd.id)) throw new Error(`Command "${cmd.id}" is already registered.`);
    let shortcut: string | undefined;
    if (cmd.shortcut) {
      shortcut = normalizeShortcut(cmd.shortcut);
      const owner = this.shortcuts.get(shortcut);
      if (owner) throw new Error(`Shortcut ${shortcut} is already used by "${owner}".`);
    }
    this.commands.set(cmd.id, { ...cmd, shortcut });
    if (shortcut) this.shortcuts.set(shortcut, cmd.id);
  }

  get(id: string): Command<Ctx> | undefined {
    return this.commands.get(id);
  }

  all(): Command<Ctx>[] {
    return [...this.commands.values()];
  }

  isEnabled(id: string): boolean {
    const c = this.commands.get(id);
    if (!c) return false;
    try {
      return c.isEnabled ? c.isEnabled(this.ctx) : true;
    } catch {
      return false;
    }
  }

  byShortcut(shortcut: string): Command<Ctx> | undefined {
    const id = this.shortcuts.get(normalizeShortcut(shortcut));
    return id ? this.commands.get(id) : undefined;
  }

  /** Never throws: failures come back as a result the UI can show. */
  async execute(id: string, args?: unknown): Promise<ExecuteResult> {
    const c = this.commands.get(id);
    if (!c) return { ok: false, reason: "unknown", message: `Unknown command "${id}".` };
    if (!this.isEnabled(id)) return { ok: false, reason: "disabled", message: `"${c.label}" is not available right now.` };
    try {
      await c.run(this.ctx, args);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }
}
