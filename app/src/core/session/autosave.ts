import type { Session } from "./session";

/**
 * Writes a crash-recovery snapshot shortly after the document becomes dirty (debounced), so that
 * unsaved work survives a crash. The snapshot is removed again on save (see Session.save).
 */
export class AutosaveController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private unsubscribe: () => void;
  lastError: string | null = null;

  constructor(
    private session: Session,
    private debounceMs = 2000,
  ) {
    this.unsubscribe = session.store.subscribe(() => this.onChange());
  }

  dispose(): void {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Options > Auto recovery: whether to write recovery copies, and after how many seconds of quiet. */
  private get settings(): { enabled: boolean; delayMs: number } {
    const o = this.session.shell.settings.getSnapshot().options;
    const secs = typeof o["autosave.seconds"] === "number" ? Math.min(600, Math.max(1, o["autosave.seconds"] as number)) : null;
    return { enabled: o["autosave.enabled"] !== false, delayMs: secs === null ? this.debounceMs : secs * 1000 };
  }

  private onChange(): void {
    const snap = this.session.store.getSnapshot();
    if (!snap.isDirty || !this.session.root) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      // back in the saved state (every edit undone): the snapshot written earlier is stale
      if (this.session.root && snap.project) void this.session.dropOwnRecoveryWhenClean().catch(() => undefined);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    const { enabled, delayMs } = this.settings;
    if (!enabled) {
      this.timer = null;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  /** Writes the snapshot now (also used on window close). Resolves when written. */
  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const snap = this.session.store.getSnapshot();
      if (!this.session.root || !snap.project || !snap.isDirty) return;
      try {
        await this.session.writeRecovery();
        this.lastError = null;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
      }
    });
    return this.writing;
  }
}
