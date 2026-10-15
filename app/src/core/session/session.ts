import { DocumentStore } from "../store/documentStore";
import type { Project, SaveReport } from "../model/types";

export interface ProjectIO {
  newProject(root: string, name: string): Promise<Project>;
  openProject(pbipPath: string): Promise<Project>;
  saveProject(root: string, project: Project): Promise<SaveReport>;
  writeRecovery(root: string, project: Project): Promise<void>;
  readRecovery(root: string): Promise<Project | null>;
  clearRecovery(root: string): Promise<void>;
}

export interface Dialogs {
  pickPbip(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
}

export interface SessionSnapshot {
  root: string | null;
  pendingRecovery: Project | null;
  lastMessage: string | null;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? path : path.slice(0, i);
}

/** App-level state around the document: where it lives, recovery offers, last user-facing message. */
export class Session {
  readonly store = new DocumentStore();
  private snap: SessionSnapshot = { root: null, pendingRecovery: null, lastMessage: null };
  private listeners = new Set<() => void>();

  constructor(
    readonly io: ProjectIO,
    readonly dialogs: Dialogs,
  ) {}

  getSnapshot = (): SessionSnapshot => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<SessionSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  get root(): string | null {
    return this.snap.root;
  }

  setMessage(message: string | null): void {
    this.set({ lastMessage: message });
  }

  async newProject(root: string, name: string): Promise<void> {
    const project = await this.io.newProject(root, name);
    this.store.load(project);
    this.set({ root, pendingRecovery: null, lastMessage: `Created project "${name}".` });
  }

  async openProject(pbipPath: string): Promise<void> {
    const project = await this.io.openProject(pbipPath);
    const root = dirname(pbipPath);
    this.store.load(project);
    let pending: Project | null = null;
    let message: string | null = `Opened "${project.name}".`;
    try {
      const rec = await this.io.readRecovery(root);
      if (rec && JSON.stringify(rec) !== JSON.stringify(project)) pending = rec;
      else if (rec) await this.io.clearRecovery(root);
    } catch (e) {
      message = `Opened "${project.name}", but its recovery file could not be read: ${errText(e)}`;
    }
    this.set({ root, pendingRecovery: pending, lastMessage: pending ? "Unsaved changes from an earlier session were found." : message });
  }

  async save(): Promise<SaveReport> {
    const root = this.snap.root;
    const project = this.store.project;
    if (!root || !project) throw new Error("There is no project to save.");
    const report = await this.io.saveProject(root, project);
    this.store.markSaved(project);
    try {
      await this.io.clearRecovery(root);
    } catch {
      /* a stale recovery file is harmless: it equals the saved project */
    }
    this.set({ lastMessage: report.written.length ? `Saved ${report.written.length} file(s).` : "Saved (no changes on disk)." });
    return report;
  }

  /** Loads the recovery snapshot as unsaved edits on top of the on-disk project. */
  restoreRecovery(): void {
    const rec = this.snap.pendingRecovery;
    const onDisk = this.store.project;
    if (!rec || !onDisk) throw new Error("There is nothing to restore.");
    this.store.loadUnsaved(rec, onDisk);
    this.set({ pendingRecovery: null, lastMessage: "Restored unsaved changes." });
  }

  async discardRecovery(): Promise<void> {
    const root = this.snap.root;
    if (root) await this.io.clearRecovery(root);
    this.set({ pendingRecovery: null, lastMessage: "Discarded recovered changes." });
  }

  closeProject(): void {
    this.store.close();
    this.set({ root: null, pendingRecovery: null, lastMessage: null });
  }
}

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  return e instanceof Error ? e.message : JSON.stringify(e);
}
