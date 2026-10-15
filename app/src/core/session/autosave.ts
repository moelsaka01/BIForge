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

  private onChange(): void {
    const snap = this.session.store.getSnapshot();
    if (!snap.isDirty || !this.session.root) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
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
