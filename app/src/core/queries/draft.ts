// Editing state of the Power Query editor. Edits live here until "Close & Apply"; the document changes only then.
import type { ProjectQuery } from "./queries";

export interface DraftQuery {
  name: string;
  text: string;
  loaded: boolean;
  /** Query properties: free text, and whether Refresh all reloads the query. */
  description: string;
  refresh: boolean;
  /** Not in the project yet. */
  isNew: boolean;
  /** Query group (a folder in the Queries pane) or null. */
  group: string | null;
  /** Text, load flag and group in the project (null for a new query). */
  original: { text: string; loaded: boolean; group: string | null; description: string; refresh: boolean } | null;
  /** BIForge wrote the M and it is unchanged. */
  generated: boolean;
}

export interface DraftSnapshot {
  open: boolean;
  queries: DraftQuery[];
  selected: string | null;
  /** Selected applied step of the selected query; null = the last step. */
  step: string | null;
  /** Query groups, in order (a group can be empty). */
  groups: string[];
  /** The groups in the project. */
  originalGroups: string[];
  /** Queries the user removed (existing in the project). */
  removed: string[];
  /** Bumped by every change, so views reload their previews. */
  version: number;
  message: string | null;
}

const empty: DraftSnapshot = { open: false, queries: [], selected: null, step: null, groups: [], originalGroups: [], removed: [], version: 0, message: null };

export class QueryDraft {
  private snap: DraftSnapshot = empty;
  private listeners = new Set<() => void>();

  getSnapshot = (): DraftSnapshot => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<DraftSnapshot>, bump = true): void {
    this.snap = { ...this.snap, ...patch, version: bump ? this.snap.version + 1 : this.snap.version };
    this.listeners.forEach((l) => l());
  }

  open(queries: ProjectQuery[], select?: string | null, groups: string[] = []): void {
    const qs = queries.map<DraftQuery>((q) => ({
      name: q.name,
      text: q.text,
      loaded: q.loaded,
      description: q.description ?? "",
      refresh: q.refresh ?? true,
      isNew: false,
      group: q.group ?? null,
      original: { text: q.text, loaded: q.loaded, group: q.group ?? null, description: q.description ?? "", refresh: q.refresh ?? true },
      generated: q.generated,
    }));
    const all = [...new Set([...groups, ...qs.map((q) => q.group).filter((g): g is string => !!g)])];
    const selected = select && qs.some((q) => q.name === select) ? select : (qs.find((q) => q.loaded) ?? qs[0])?.name ?? null;
    this.set({ open: true, queries: qs, selected, step: null, groups: all, originalGroups: all, removed: [], message: null });
  }

  close(): void {
    this.set({ ...empty, version: this.snap.version + 1 }, false);
    this.listeners.forEach((l) => l());
  }

  get(name: string): DraftQuery | undefined {
    return this.snap.queries.find((q) => q.name === name);
  }

  texts(): Record<string, string> {
    return Object.fromEntries(this.snap.queries.map((q) => [q.name, q.text]));
  }

  isChanged(q: DraftQuery): boolean {
    return q.isNew || !q.original || q.original.text !== q.text || q.original.loaded !== q.loaded || q.original.group !== q.group;
  }

  /** Only the Query properties (description, Include in report refresh) differ from the project: nothing has to run. */
  propsChanged(q: DraftQuery): boolean {
    return !!q.original && (q.original.description !== q.description || q.original.refresh !== q.refresh);
  }

  get groupsChanged(): boolean {
    const a = this.snap.groups;
    const b = this.snap.originalGroups;
    return a.length !== b.length || a.some((g, i) => g !== b[i]);
  }

  get dirty(): boolean {
    return this.snap.removed.length > 0 || this.groupsChanged || this.snap.queries.some((q) => this.isChanged(q) || this.propsChanged(q));
  }

  private checkGroup(name: string, except?: string): string {
    const n = name.trim();
    if (n === "") throw new Error("A group name cannot be empty.");
    if (/[\r\n\t\\]/.test(n)) throw new Error("A group name cannot contain line breaks, tabs or backslashes.");
    if (this.snap.groups.some((g) => g.toLowerCase() === n.toLowerCase() && g !== except)) throw new Error(`A group named "${n}" already exists.`);
    return n;
  }

  addGroup(name: string): string {
    const n = this.checkGroup(name);
    this.set({ groups: [...this.snap.groups, n] });
    return n;
  }

  renameGroup(old: string, to: string): void {
    if (!this.snap.groups.includes(old)) throw new Error(`The group "${old}" does not exist.`);
    const n = this.checkGroup(to, old);
    this.set({ groups: this.snap.groups.map((g) => (g === old ? n : g)), queries: this.snap.queries.map((q) => (q.group === old ? { ...q, group: n } : q)) });
  }

  /** Deletes a group; its queries are ungrouped, not deleted. */
  removeGroup(name: string): void {
    if (!this.snap.groups.includes(name)) throw new Error(`The group "${name}" does not exist.`);
    this.set({ groups: this.snap.groups.filter((g) => g !== name), queries: this.snap.queries.map((q) => (q.group === name ? { ...q, group: null } : q)) });
  }

  setGroup(query: string, group: string | null): void {
    if (!this.get(query)) throw new Error(`The query "${query}" does not exist.`);
    if (group !== null && !this.snap.groups.includes(group)) throw new Error(`The group "${group}" does not exist.`);
    this.set({ queries: this.snap.queries.map((q) => (q.name === query ? { ...q, group } : q)) });
  }

  select(query: string, step: string | null = null): void {
    if (!this.get(query)) throw new Error(`The query "${query}" does not exist.`);
    this.set({ selected: query, step });
  }

  selectStep(step: string | null): void {
    this.set({ step }, false);
    this.listeners.forEach((l) => l());
  }

  setMessage(message: string | null): void {
    this.set({ message }, false);
  }

  /** Replaces the M text of a query; the step selection moves to `step` (null = last step). */
  setText(name: string, text: string, step: string | null = null): void {
    const q = this.get(name);
    if (!q) throw new Error(`The query "${name}" does not exist.`);
    this.set({ queries: this.snap.queries.map((x) => (x.name === name ? { ...x, text, generated: x.generated && x.text === text } : x)), step: this.snap.selected === name ? step : this.snap.step });
  }

  private checkName(name: string, except?: string): string {
    const n = name.trim();
    if (n === "") throw new Error("A query name cannot be empty.");
    if (/[\r\n\t]/.test(n)) throw new Error("A query name cannot contain line breaks or tabs.");
    if (this.snap.queries.some((q) => q.name.toLowerCase() === n.toLowerCase() && q.name !== except)) throw new Error(`A query named "${n}" already exists.`);
    return n;
  }

  uniqueName(base: string): string {
    const taken = new Set(this.snap.queries.map((q) => q.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
  }

  add(name: string, text: string, loaded: boolean): string {
    const n = this.checkName(name);
    const q: DraftQuery = { name: n, text, loaded, description: "", refresh: true, isNew: true, group: null, original: null, generated: false };
    this.set({ queries: [...this.snap.queries, q], selected: n, step: null });
    return n;
  }

  remove(name: string): void {
    const q = this.get(name);
    if (!q) throw new Error(`The query "${name}" does not exist.`);
    const queries = this.snap.queries.filter((x) => x.name !== name);
    this.set({
      queries,
      removed: q.isNew ? this.snap.removed : [...this.snap.removed, name],
      selected: this.snap.selected === name ? (queries[0]?.name ?? null) : this.snap.selected,
      step: this.snap.selected === name ? null : this.snap.step,
    });
  }

  /** Renames a query that is not in the project yet or is not loaded (a loaded table cannot be renamed yet).
   *  `rewritten` holds the texts of the queries that used the old name. */
  rename(old: string, to: string, rewritten: Record<string, string>): void {
    const q = this.get(old);
    if (!q) throw new Error(`The query "${old}" does not exist.`);
    if (q.loaded && !q.isNew) throw new Error("A query that is loaded into the model cannot be renamed yet in this editor: rename the table in the Data pane (right-click > Rename).");
    const n = this.checkName(to, old);
    const queries = this.snap.queries.map((x) => {
      const text = rewritten[x.name] ?? x.text;
      // an existing query under a new name is a new query, and the old name is removed when applying
      return x.name === old ? { ...x, name: n, text, isNew: true, original: null, generated: false } : { ...x, text };
    });
    this.set({
      queries,
      removed: q.isNew ? this.snap.removed : [...this.snap.removed, old],
      selected: this.snap.selected === old ? n : this.snap.selected,
    });
  }

  setLoaded(name: string, loaded: boolean): void {
    const q = this.get(name);
    if (!q) throw new Error(`The query "${name}" does not exist.`);
    if (q.original?.loaded && !loaded) throw new Error("Loading cannot be switched off for a table that is already in the model yet: deleting the table would also delete its relationships and measures.");
    this.set({ queries: this.snap.queries.map((x) => (x.name === name ? { ...x, loaded } : x)) });
  }

  /** Query properties: the description and Include in report refresh. */
  setProperties(name: string, props: { description?: string; refresh?: boolean }): void {
    const q = this.get(name);
    if (!q) throw new Error(`The query "${name}" does not exist.`);
    this.set({ queries: this.snap.queries.map((x) => (x.name === name ? { ...x, description: props.description ?? x.description, refresh: props.refresh ?? x.refresh } : x)) });
  }

  /** After a successful apply the applied queries become the new baseline. */
  markApplied(names: string[], removedDone: string[]): void {
    this.set({
      queries: this.snap.queries.map((q) => (names.includes(q.name) ? { ...q, isNew: false, original: { text: q.text, loaded: q.loaded, group: q.group, description: q.description, refresh: q.refresh }, generated: false } : q)),
      originalGroups: this.snap.groups,
      removed: this.snap.removed.filter((r) => !removedDone.includes(r)),
    });
  }
}
