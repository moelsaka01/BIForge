import { DocumentStore } from "../store/documentStore";
import type { Project, SaveReport } from "../model/types";
import type { EngineApi, SourceSpec } from "../data/types";
import { applyImport, getTableSource, importedTables } from "../model/tables";
import { listTables } from "../model/ops";

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
  /** Picks one data file; `extensions` without dots. */
  pickFile(name: string, extensions: string[]): Promise<string | null>;
}

export interface SessionSnapshot {
  root: string | null;
  pendingRecovery: Project | null;
  lastMessage: string | null;
  /** Names of tables that currently have data in the engine's store. */
  dataTables: string[];
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? path : path.slice(0, i);
}

/** App-level state around the document: where it lives, recovery offers, last user-facing message. */
export class Session {
  readonly store = new DocumentStore();
  private snap: SessionSnapshot = { root: null, pendingRecovery: null, lastMessage: null, dataTables: [] };
  private listeners = new Set<() => void>();

  constructor(
    readonly io: ProjectIO,
    readonly dialogs: Dialogs,
    readonly engine: EngineApi | null = null,
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
    const dataNote = await this.openDataStore(root, project);
    this.set({ root, pendingRecovery: null, lastMessage: `Created project "${name}".${dataNote}` });
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
    const dataNote = await this.openDataStore(root, project);
    this.set({
      root,
      pendingRecovery: pending,
      lastMessage: (pending ? "Unsaved changes from an earlier session were found." : message) + dataNote,
    });
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
    this.set({ root: null, pendingRecovery: null, lastMessage: null, dataTables: [] });
  }

  /** Opens the project's data store and drops stored tables that are no longer in the model. Never throws. */
  private async openDataStore(root: string, project: Project): Promise<string> {
    if (!this.engine) return "";
    try {
      const present = await this.engine.openStore(root);
      const inModel = new Set(listTables(project).map((t) => t.name.toLowerCase()));
      const keep: string[] = [];
      for (const n of present) {
        if (inModel.has(n.toLowerCase())) keep.push(n);
        else await this.engine.dropTable(n);
      }
      this.set({ dataTables: keep });
      const missing = importedTables(project).filter((t) => !keep.some((k) => k.toLowerCase() === t.toLowerCase()));
      return missing.length ? ` Data for ${missing.length} table(s) is not loaded; use Refresh all.` : "";
    } catch (e) {
      this.set({ dataTables: [] });
      return ` The data store could not be opened: ${errText(e)}`;
    }
  }

  private requireEngine(): EngineApi {
    if (!this.engine) throw new Error("The data engine is not available.");
    if (!this.store.project || !this.snap.root) throw new Error("Open or create a project first.");
    return this.engine;
  }

  private markLoaded(name: string): void {
    const rest = this.snap.dataTables.filter((t) => t.toLowerCase() !== name.toLowerCase());
    this.set({ dataTables: [...rest, name] });
  }

  /** Imports (or re-imports) a source into table `name`. The document only changes if the engine import succeeds. */
  async importTable(name: string, spec: SourceSpec): Promise<void> {
    const engine = this.requireEngine();
    const info = await engine.importSource(name, spec);
    let removed: string[] = [];
    let created = false;
    this.store.transact(`Import "${name}"`, (p) => {
      const r = applyImport(p, info, spec);
      removed = r.removedRelationships;
      created = r.created;
    });
    this.markLoaded(info.name);
    this.setMessage(
      `${created ? "Imported" : "Refreshed"} "${info.name}": ${info.rowCount} rows, ${info.columns.length} columns.` +
        (removed.length ? ` ${removed.length} relationship(s) removed because their columns no longer exist.` : ""),
    );
  }

  async refreshTable(name: string): Promise<void> {
    const p = this.store.project;
    const spec = p ? getTableSource(p, name) : null;
    if (!spec) throw new Error(`Table "${name}" was not imported from a source, so it cannot be refreshed.`);
    await this.importTable(name, spec);
  }

  /** Refreshes every imported table; one failing table does not stop the others. Returns the failures. */
  async refreshAll(): Promise<{ table: string; error: string }[]> {
    const p = this.store.project;
    if (!p) throw new Error("Open or create a project first.");
    const failures: { table: string; error: string }[] = [];
    const tables = importedTables(p);
    for (const t of tables) {
      try {
        await this.refreshTable(t);
      } catch (e) {
        failures.push({ table: t, error: errText(e) });
      }
    }
    this.setMessage(
      failures.length
        ? `Refreshed ${tables.length - failures.length} of ${tables.length} table(s). Failed: ${failures.map((f) => `${f.table} (${f.error})`).join("; ")}`
        : `Refreshed ${tables.length} table(s).`,
    );
    return failures;
  }
}

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  return e instanceof Error ? e.message : JSON.stringify(e);
}
