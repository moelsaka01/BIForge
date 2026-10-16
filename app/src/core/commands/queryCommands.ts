// Power Query editor commands: they change the editor's draft (queries and their M text) and apply it to the document.
// Shells, ribbons and panes only dispatch these ids.
import type { CommandRegistry } from "./registry";
import type { Session } from "../session/session";
import type { StepEdit, Transform } from "../queries/types";

const hasProject = (s: Session) => s.store.project !== null && s.m !== null;
const editorOpen = (s: Session) => hasProject(s) && s.queries.getSnapshot().open;

function need<T extends object>(args: unknown, keys: (keyof T & string)[]): T {
  const a = (args ?? {}) as Record<string, unknown>;
  for (const k of keys) if (a[k] === undefined || a[k] === null) throw new Error(`Missing value: ${k}.`);
  return a as T;
}

function selected(s: Session, query?: string) {
  const snap = s.queries.getSnapshot();
  const name = query ?? snap.selected;
  const q = name ? s.queries.get(name) : undefined;
  if (!q) throw new Error("Select a query first.");
  return { q, step: query && query !== snap.selected ? null : snap.step };
}

function api(s: Session) {
  if (!s.m) throw new Error("The query engine is not available.");
  return s.m;
}

export function registerQueryCommands(r: CommandRegistry<Session>): void {
  const reg = (id: string, label: string, run: (s: Session, args: unknown) => void | Promise<void>, enabled: (s: Session) => boolean = editorOpen) =>
    r.register({ id, label, category: "Power Query", isEnabled: enabled, run });

  reg("query.editor.open", "Transform data", (s, a) => s.openQueryEditor((a as { query?: string } | undefined)?.query), hasProject);
  // closing without applying discards the draft; the view asks for confirmation when there are unapplied changes
  reg("query.editor.close", "Close", (s) => s.queries.close());
  reg("query.apply", "Apply", async (s) => {
    await s.applyQueries();
  });
  reg("query.applyAndClose", "Close & Apply", async (s) => {
    const r = await s.applyQueries();
    if (r.failures.length === 0) s.queries.close();
    else throw new Error(`Some queries could not be applied: ${r.failures.map((f) => `${f.query}: ${f.error}`).join("; ")}`);
  });

  reg("query.select", "Select query", (s, a) => {
    const { query, step } = need<{ query: string; step?: string | null }>(a, ["query"]);
    s.queries.select(query, step ?? null);
  });
  reg("query.step.select", "Select step", (s, a) => {
    s.queries.selectStep(((a ?? {}) as { step?: string | null }).step ?? null);
  });

  reg("query.transform", "Apply transform", async (s, a) => {
    const args = need<{ transform: Transform; query?: string; after?: string | null }>(a, ["transform"]);
    const { q, step } = selected(s, args.query);
    const after = args.after === undefined ? step : args.after;
    const out = await api(s).applyTransform(q.text, after, args.transform);
    s.queries.setText(q.name, out.text, out.added[out.added.length - 1] ?? null);
  });

  reg("query.step.edit", "Edit step", async (s, a) => {
    const args = need<{ edit: StepEdit; query?: string }>(a, ["edit"]);
    const { q } = selected(s, args.query);
    const text = await api(s).editStep(q.text, args.edit);
    const e = args.edit;
    let next: string | null = s.queries.getSnapshot().step;
    if (e.op === "insert") next = e.name;
    else if (e.op === "rename") next = next === e.old ? e.new : next;
    else if (e.op === "delete" || e.op === "deleteFrom") next = null;
    s.queries.setText(q.name, text, next);
  });

  reg("query.setText", "Edit query", async (s, a) => {
    const args = need<{ query: string; text: string; step?: string | null }>(a, ["query", "text"]);
    selected(s, args.query);
    s.queries.setText(args.query, args.text, args.step ?? null);
  });

  reg("query.add", "New query", (s, a) => {
    const args = (a ?? {}) as { name?: string; text?: string; loaded?: boolean };
    const name = s.queries.uniqueName(args.name?.trim() || "Query");
    s.queries.add(name, args.text ?? 'let\n    Source = #table({"Column1"}, {})\nin\n    Source', args.loaded ?? true);
  });

  reg("query.addFromFolder", "New query from folder", async (s, a) => {
    const args = need<{ folder: string; extension: string; delimiter?: string; name?: string }>(a, ["folder", "extension"]);
    const text = await api(s).folderQuery(args.folder, args.extension, args.delimiter ?? ",");
    const base = args.name?.trim() || args.folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Folder";
    s.queries.add(s.queries.uniqueName(base), text, true);
  });

  reg("query.delete", "Delete query", async (s, a) => {
    const { name } = need<{ name: string }>(a, ["name"]);
    const deps = await api(s).dependencies(s.queries.texts());
    const users = Object.entries(deps).filter(([k, v]) => k !== name && v.includes(name)).map(([k]) => k);
    if (users.length) throw new Error(`"${name}" cannot be deleted: ${users.map((u) => `"${u}"`).join(", ")} use${users.length === 1 ? "s" : ""} it.`);
    s.queries.remove(name);
  });

  reg("query.rename", "Rename query", async (s, a) => {
    const { name, to } = need<{ name: string; to: string }>(a, ["name", "to"]);
    const texts = s.queries.texts();
    const deps = await api(s).dependencies(texts);
    const rewritten: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps)) {
      if (k !== name && v.includes(name)) rewritten[k] = await api(s).editStep(texts[k], { op: "renameRef", old: name, new: to.trim() });
    }
    s.queries.rename(name, to, rewritten);
  });

  reg("query.duplicate", "Duplicate query", (s, a) => {
    const { name } = need<{ name: string }>(a, ["name"]);
    const q = s.queries.get(name);
    if (!q) throw new Error(`The query "${name}" does not exist.`);
    s.queries.add(s.queries.uniqueName(name), q.text, true);
  });

  reg("query.setLoad", "Enable load", (s, a) => {
    const { name, loaded } = need<{ name: string; loaded: boolean }>(a, ["name", "loaded"]);
    s.queries.setLoaded(name, loaded);
  });
}
