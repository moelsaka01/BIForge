import { DocumentStore } from "../store/documentStore";
import { ReportRuntime } from "../report/runtime";
import type { Project, SaveReport } from "../model/types";
import type { EngineApi, SourceSpec } from "../data/types";
import { applyImport, getTableSource, importedTables } from "../model/tables";
import { listTables, deleteTable } from "../model/ops";
import { QueryDraft } from "../queries/draft";
import type { MApi } from "../queries/types";
import { applyQueryLoad, expressionExists, listQueries, queryTexts, removeExpression, upsertExpression, userMTables } from "../queries/queries";
import { findTable } from "../model/ops";
import { ShellStore } from "../shell/shellStore";

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
  /** Bumped whenever table data is loaded, refreshed or dropped, so views know to reload. */
  dataEpoch: number;
}

/** JSON with object keys sorted, so two equal projects compare equal whatever order their keys were built in. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

const rootKey = (root: string) => root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

export function joinPath(folder: string, name: string): string {
  const sep = folder.includes("/") && !folder.includes("\\") ? "/" : "\\";
  return folder.replace(/[\\/]+$/, "") + sep + name;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? path : path.slice(0, i);
}

/** App-level state around the document: where it lives, recovery offers, last user-facing message. */
export class Session {
  readonly store = new DocumentStore();
  /** View state of the open report (selection, drilling, current page). */
  readonly report = new ReportRuntime();
  /** Editing state of the Power Query editor. */
  readonly queries = new QueryDraft();
  private snap: SessionSnapshot = { root: null, pendingRecovery: null, lastMessage: null, dataTables: [], dataEpoch: 0 };
  private listeners = new Set<() => void>();
  /** Project roots whose recovery snapshot was written by this running app (not left behind by a crash). */
  private ownRecovery = new Set<string>();
  /** Snapshot writes and clears run one after another, so a slow write cannot land after a later clear. */
  private recoveryQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly io: ProjectIO,
    readonly dialogs: Dialogs,
    readonly engine: EngineApi | null = null,
    readonly m: MApi | null = null,
    /** Frame state (start screen / views / dialogs) and the app settings. */
    readonly shell: ShellStore = new ShellStore(null),
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
    try {
      // a snapshot left in this folder belongs to some other, earlier project
      await this.io.clearRecovery(root);
    } catch {
      /* harmless: it is overwritten by the next autosave */
    }
    const dataNote = await this.openDataStore(root, project);
    this.set({ root, pendingRecovery: null, lastMessage: `Created project "${name}".${dataNote}` });
    this.shell.settings.addRecent(joinPath(root, `${name}.pbip`), name);
    this.shell.enterWorkspace();
  }

  async openProject(pbipPath: string): Promise<void> {
    const project = await this.io.openProject(pbipPath);
    const root = dirname(pbipPath);
    this.store.load(project);
    let pending: Project | null = null;
    let message: string | null = `Opened "${project.name}".`;
    try {
      const rec = await this.io.readRecovery(root);
      // Only a snapshot from an earlier run of the app is a recovery. One this run wrote itself (the project was
      // already open here) or one equal to the saved files is dropped.
      const own = this.ownRecovery.has(rootKey(root));
      if (rec && !own && canonicalJson(rec) !== canonicalJson(project)) pending = rec;
      else if (rec) {
        await this.io.clearRecovery(root);
        this.ownRecovery.delete(rootKey(root));
      }
    } catch (e) {
      message = `Opened "${project.name}", but its recovery file could not be read: ${errText(e)}`;
    }
    const dataNote = await this.openDataStore(root, project);
    this.set({
      root,
      pendingRecovery: pending,
      lastMessage: (pending ? "Unsaved changes from an earlier session were found." : message) + dataNote,
    });
    this.shell.settings.addRecent(pbipPath, project.name);
    this.shell.enterWorkspace();
  }

  async save(): Promise<SaveReport> {
    const root = this.snap.root;
    const project = this.store.project;
    if (!root || !project) throw new Error("There is no project to save.");
    const report = await this.io.saveProject(root, project);
    this.store.markSaved(project);
    try {
      await this.clearRecoveryOf(root);
    } catch {
      /* a stale recovery file is harmless: it equals the saved project */
    }
    this.set({ lastMessage: report.written.length ? `Saved ${report.written.length} file(s).` : "Saved (no changes on disk)." });
    return report;
  }

  /** Writes the crash-recovery snapshot for the open project (used by autosave) and remembers that this run wrote it. */
  async writeRecovery(): Promise<void> {
    const root = this.snap.root;
    if (!root || !this.store.project) return;
    await this.queueRecovery(async () => {
      // re-check when this write's turn comes: the user may have saved or undone everything in the meantime
      const project = this.store.project;
      if (this.snap.root !== root || !project || !this.store.getSnapshot().isDirty) return;
      this.ownRecovery.add(rootKey(root));
      await this.io.writeRecovery(root, project);
    });
  }

  private queueRecovery(task: () => Promise<void>): Promise<void> {
    const run = this.recoveryQueue.then(task);
    this.recoveryQueue = run.catch(() => undefined);
    return run;
  }

  private clearRecoveryOf(root: string): Promise<void> {
    return this.queueRecovery(async () => {
      await this.io.clearRecovery(root);
      this.ownRecovery.delete(rootKey(root));
    });
  }

  /**
   * Called when the document is back in its saved state (everything undone): the snapshot this run wrote no longer
   * describes unsaved work. A snapshot offered from an earlier run is left alone until the user decides.
   */
  async dropOwnRecoveryWhenClean(): Promise<void> {
    const root = this.snap.root;
    if (!root || this.snap.pendingRecovery || !this.ownRecovery.has(rootKey(root))) return;
    await this.clearRecoveryOf(root);
  }

  /** The user leaves on purpose without saving: the snapshot is not a crash recovery and must not be offered later. */
  async discardUnsavedForExit(): Promise<void> {
    const root = this.snap.root;
    if (!root || this.snap.pendingRecovery) return;
    await this.clearRecoveryOf(root);
  }

  /** Closes the project and drops the snapshot of its unsaved edits (the user chose not to keep them). */
  async closeProjectDiscarding(): Promise<void> {
    await this.discardUnsavedForExit().catch(() => undefined);
    this.closeProject();
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
    if (root) await this.clearRecoveryOf(root);
    this.set({ pendingRecovery: null, lastMessage: "Discarded recovered changes." });
  }

  closeProject(): void {
    this.store.close();
    this.set({ root: null, pendingRecovery: null, lastMessage: null, dataTables: [], dataEpoch: this.snap.dataEpoch + 1 });
    this.shell.leaveWorkspace();
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
      this.set({ dataTables: keep, dataEpoch: this.snap.dataEpoch + 1 });
      const missing = [...importedTables(project), ...userMTables(project)].filter((t) => !keep.some((k) => k.toLowerCase() === t.toLowerCase()));
      return missing.length ? ` Data for ${missing.length} table(s) is not loaded; use Refresh all.` : "";
    } catch (e) {
      this.set({ dataTables: [], dataEpoch: this.snap.dataEpoch + 1 });
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
    this.set({ dataTables: [...rest, name], dataEpoch: this.snap.dataEpoch + 1 });
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
    if (spec) return this.importTable(name, spec);
    if (p && userMTables(p).some((t) => t.toLowerCase() === name.toLowerCase())) return this.refreshQuery(name);
    throw new Error(`Table "${name}" was not imported from a source, so it cannot be refreshed.`);
  }

  /** Runs the M query of a table and replaces its data (the document changes only if the query succeeds). */
  private async refreshQuery(name: string): Promise<void> {
    const engine = this.requireEngine();
    if (!this.m) throw new Error("The query engine is not available.");
    const p = this.store.project!;
    const texts = queryTexts(p);
    const info = await this.m.load(texts, name, name);
    this.store.transact(`Refresh "${name}"`, (pp) => void applyQueryLoad(pp, info, texts[name]));
    void engine;
    this.markLoaded(info.name);
    this.setMessage(`Refreshed "${info.name}": ${info.rowCount} rows, ${info.columns.length} columns.`);
  }

  /** Opens the Power Query editor on the project's queries. */
  openQueryEditor(select?: string | null): void {
    const p = this.store.project;
    if (!p) throw new Error("Open or create a project first.");
    this.queries.open(listQueries(p), select);
  }

  /**
   * Applies the editor's changes: changed loaded queries (and the ones that use them) run and replace their tables,
   * other queries are stored as named expressions. A query that fails stays in the editor, the others are applied.
   */
  async applyQueries(): Promise<{ loaded: string[]; failures: { query: string; error: string }[] }> {
    const engine = this.requireEngine();
    const m = this.m;
    if (!m) throw new Error("The query engine is not available.");
    const draft = this.queries;
    const snap = draft.getSnapshot();
    const texts = draft.texts();
    const deps = await m.dependencies(texts);
    const changed = new Set(snap.queries.filter((q) => draft.isChanged(q)).map((q) => q.name));
    const usesChanged = (name: string, seen = new Set<string>()): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      return (deps[name] ?? []).some((d) => changed.has(d) || usesChanged(d, seen));
    };
    const toLoad = snap.queries.filter((q) => q.loaded && (changed.has(q.name) || usesChanged(q.name)));
    const loaded: { name: string; info: Awaited<ReturnType<MApi["load"]>> }[] = [];
    const failures: { query: string; error: string }[] = [];
    for (const q of toLoad) {
      try {
        loaded.push({ name: q.name, info: await m.load(texts, q.name, q.name) });
      } catch (e) {
        failures.push({ query: q.name, error: errText(e) });
      }
    }
    let kinds: Record<string, string> = {};
    try {
      kinds = await m.queryKinds(texts);
    } catch {
      /* the result type annotation falls back to Table */
    }
    const resultType = (k: string | undefined) => ({ table: "Table", number: "Number", text: "Text", function: "Function", list: "List", record: "Record", logical: "Logical" })[k ?? "table"] ?? "Table";
    const removedDone: string[] = [];
    const applied = snap.queries.filter((q) => !q.loaded && changed.has(q.name)).map((q) => q.name);
    this.store.transact("Apply query changes", (p) => {
      for (const { name, info } of loaded) applyQueryLoad(p, info, texts[name]);
      for (const q of snap.queries) if (!q.loaded && changed.has(q.name)) upsertExpression(p, q.name, q.text, resultType(kinds[q.name]));
      for (const r of snap.removed) {
        if (expressionExists(p, r)) removeExpression(p, r);
        else if (findTable(p, r)) deleteTable(p, r);
        removedDone.push(r);
      }
    });
    for (const r of removedDone) {
      if (!snap.queries.some((q) => q.name === r)) await engine.dropTable(r).catch(() => undefined);
      this.set({ dataTables: this.snap.dataTables.filter((t) => t.toLowerCase() !== r.toLowerCase()), dataEpoch: this.snap.dataEpoch + 1 });
    }
    for (const { name } of loaded) this.markLoaded(name);
    draft.markApplied([...loaded.map((l) => l.name), ...applied], removedDone);
    this.setMessage(
      failures.length
        ? `Applied ${loaded.length} of ${toLoad.length} loaded quer${toLoad.length === 1 ? "y" : "ies"}. Failed: ${failures.map((f) => `${f.query} (${f.error})`).join("; ")}`
        : `Applied query changes: ${loaded.length} table(s) loaded.`,
    );
    return { loaded: loaded.map((l) => l.name), failures };
  }

  /** Refreshes every imported table; one failing table does not stop the others. Returns the failures. */
  async refreshAll(): Promise<{ table: string; error: string }[]> {
    const p = this.store.project;
    if (!p) throw new Error("Open or create a project first.");
    const failures: { table: string; error: string }[] = [];
    const tables = [...importedTables(p), ...userMTables(p)];
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
