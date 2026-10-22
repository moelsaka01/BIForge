import type { Project } from "../model/types";
import { migrateProject } from "../report/migrate";

interface HistoryEntry {
  label: string;
  before: Project;
  after: Project;
}

export interface StoreSnapshot {
  project: Project | null;
  revision: number;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** A shared report opened for viewing: no change can be made to it. */
  readOnly: boolean;
  /** In viewing mode: the reader changed what is shown (slicers, bookmarks) since opening it. */
  viewChanged: boolean;
}

export type ChangeKind = "edit" | "undo" | "redo";
export type ChangeListener = (prev: Project, next: Project, label: string, kind: ChangeKind) => void;

const MAX_HISTORY = 100;
export const READ_ONLY_MESSAGE = "This report is open for viewing only; it cannot be changed.";

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Holds the single open document. Every change goes through `transact`, which edits a clone,
 * so a throwing edit leaves the document untouched. Each successful transaction is one undo step.
 * Limitation: history keeps whole-project snapshots (memory grows with model size x history).
 */
export class DocumentStore {
  private current: Project | null = null;
  private saved: Project | null = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private revision = 0;
  private readOnly = false;
  private listeners = new Set<() => void>();
  private changeListeners = new Set<ChangeListener>();
  private snapshot: StoreSnapshot = this.makeSnapshot();

  get project(): Project | null {
    return this.current;
  }

  getSnapshot = (): StoreSnapshot => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Called after every change the person makes (an edit, undo or redo) with the project before and after it. */
  onProjectChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /**
   * A change made by someone else while co-editing: it becomes the current project without an undo step, and the undo
   * history ends here (an undo of an older step would otherwise silently take the others' work away as well).
   */
  applyRemote(next: Project): void {
    if (this.readOnly) throw new Error(READ_ONLY_MESSAGE);
    if (!this.current) throw new Error("No project is open.");
    this.current = next;
    this.undoStack = [];
    this.redoStack = [];
    this.bump();
  }

  /** Replaces the document and clears history. The loaded state counts as saved. */
  load(project: Project): void {
    this.readOnly = false;
    const current = migrateProject(project); // names written by earlier versions become the names Desktop uses
    this.current = current;
    this.saved = current;
    this.undoStack = [];
    this.redoStack = [];
    this.bump();
  }

  /** Opens a document that can only be read (viewing mode): transact, undo and redo refuse until the next load. */
  loadReadOnly(project: Project): void {
    this.load(project);
    this.readOnly = true;
    this.bump();
  }

  /**
   * A change of what a reader sees in a report opened for viewing (a slicer selection, a bookmark): applied to a copy,
   * never saved, not an undo step, and the report does not count as changed. Refused for a project that can be edited.
   */
  applyViewChange(change: (draft: Project) => void): boolean {
    if (!this.readOnly) throw new Error("View changes are for a report opened for viewing.");
    if (!this.current) throw new Error("No project is open.");
    const draft = structuredClone(this.current);
    change(draft);
    if (deepEqual(this.current, draft)) return false;
    this.current = draft;
    this.bump();
    return true;
  }

  /** Back to the report as it was published: drops every view change. */
  resetViewChanges(): void {
    if (!this.readOnly || this.current === this.saved) return;
    this.current = this.saved;
    this.bump();
  }

  /** Replaces the document but keeps it marked as unsaved (used when restoring a recovery file). */
  loadUnsaved(project: Project, savedBaseline: Project): void {
    if (this.readOnly) throw new Error(READ_ONLY_MESSAGE);
    this.current = migrateProject(project);
    this.saved = savedBaseline;
    this.undoStack = [];
    this.redoStack = [];
    this.bump();
  }

  close(): void {
    this.readOnly = false;
    this.current = null;
    this.saved = null;
    this.undoStack = [];
    this.redoStack = [];
    this.bump();
  }

  /** Marks exactly the given snapshot as saved; later edits keep the document dirty. */
  markSaved(savedProject: Project): void {
    this.saved = savedProject;
    this.bump();
  }

  /** Runs `edit` on a clone. Returns false (and records nothing) if it changed nothing. */
  transact(label: string, edit: (draft: Project) => void): boolean {
    if (this.readOnly) throw new Error(READ_ONLY_MESSAGE);
    if (!this.current) throw new Error("No project is open.");
    const before = this.current;
    const draft = structuredClone(before);
    edit(draft);
    if (deepEqual(before, draft)) return false;
    this.undoStack.push({ label, before, after: draft });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.current = draft;
    this.bump();
    this.changeListeners.forEach((l) => l(before, draft, label, "edit"));
    return true;
  }

  undo(): boolean {
    if (this.readOnly) return false;
    const e = this.undoStack.pop();
    if (!e) return false;
    this.redoStack.push(e);
    const from = this.current;
    this.current = e.before;
    this.bump();
    if (from) this.changeListeners.forEach((l) => l(from, e.before, e.label, "undo"));
    return true;
  }

  redo(): boolean {
    if (this.readOnly) return false;
    const e = this.redoStack.pop();
    if (!e) return false;
    this.undoStack.push(e);
    const from = this.current;
    this.current = e.after;
    this.bump();
    if (from) this.changeListeners.forEach((l) => l(from, e.after, e.label, "redo"));
    return true;
  }

  private makeSnapshot(): StoreSnapshot {
    return {
      project: this.current,
      revision: this.revision,
      isDirty: !this.readOnly && this.current !== null && this.current !== this.saved,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
      readOnly: this.readOnly,
      viewChanged: this.readOnly && this.current !== this.saved,
    };
  }

  private bump(): void {
    this.revision++;
    this.snapshot = this.makeSnapshot();
    this.listeners.forEach((l) => l());
  }
}
