import { CommandRegistry } from "./registry";
import type { Session } from "../session/session";
import * as ops from "../model/ops";

function argsOf<T extends object>(args: unknown, required: (keyof T & string)[]): T {
  const a = (args ?? {}) as Record<string, unknown>;
  for (const k of required) {
    if (typeof a[k] !== "string") throw new Error(`Missing value: ${k}.`);
  }
  return a as T;
}

const hasProject = (s: Session) => s.store.project !== null;

/** Registers the Phase 1 commands. Shells reference these ids; they contain no logic themselves. */
export function createRegistry(session: Session): CommandRegistry<Session> {
  const r = new CommandRegistry<Session>(session);

  r.register({
    id: "file.new",
    label: "New project",
    category: "File",
    shortcut: "Ctrl+N",
    async run(s, args) {
      const { name } = argsOf<{ name: string }>(args, ["name"]);
      const folder = (args as { folder?: string }).folder ?? (await s.dialogs.pickFolder());
      if (!folder) return;
      await s.newProject(folder, name);
    },
  });
  r.register({
    id: "file.open",
    label: "Open project",
    category: "File",
    shortcut: "Ctrl+O",
    async run(s, args) {
      const path = (args as { path?: string } | undefined)?.path ?? (await s.dialogs.pickPbip());
      if (!path) return;
      await s.openProject(path);
    },
  });
  r.register({
    id: "file.save",
    label: "Save",
    category: "File",
    shortcut: "Ctrl+S",
    isEnabled: (s) => hasProject(s) && s.root !== null,
    async run(s) {
      await s.save();
    },
  });
  r.register({
    id: "file.restoreRecovery",
    label: "Restore unsaved changes",
    category: "File",
    isEnabled: (s) => s.getSnapshot().pendingRecovery !== null,
    run: (s) => s.restoreRecovery(),
  });
  r.register({
    id: "file.discardRecovery",
    label: "Discard unsaved changes",
    category: "File",
    isEnabled: (s) => s.getSnapshot().pendingRecovery !== null,
    run: (s) => s.discardRecovery(),
  });

  r.register({
    id: "edit.undo",
    label: "Undo",
    category: "Edit",
    shortcut: "Ctrl+Z",
    isEnabled: (s) => s.store.getSnapshot().canUndo,
    run: (s) => void s.store.undo(),
  });
  r.register({
    id: "edit.redo",
    label: "Redo",
    category: "Edit",
    shortcut: "Ctrl+Y",
    isEnabled: (s) => s.store.getSnapshot().canRedo,
    run: (s) => void s.store.redo(),
  });

  r.register({
    id: "model.addTable",
    label: "New table",
    category: "Modeling",
    isEnabled: hasProject,
    run: (s, args) => {
      const { name } = argsOf<{ name: string }>(args, ["name"]);
      s.store.transact(`New table "${name}"`, (p) => ops.addTable(p, name));
    },
  });
  r.register({
    id: "model.deleteTable",
    label: "Delete table",
    category: "Modeling",
    isEnabled: hasProject,
    run: (s, args) => {
      const { name } = argsOf<{ name: string }>(args, ["name"]);
      s.store.transact(`Delete table "${name}"`, (p) => ops.deleteTable(p, name));
    },
  });
  r.register({
    id: "model.addMeasure",
    label: "New measure",
    category: "Modeling",
    isEnabled: hasProject,
    run: (s, args) => {
      const a = argsOf<{ table: string; name: string; expression: string }>(args, ["table", "name", "expression"]);
      s.store.transact(`New measure "${a.name}"`, (p) => ops.addMeasure(p, a.table, a.name, a.expression));
    },
  });
  r.register({
    id: "model.setMeasureExpression",
    label: "Edit measure",
    category: "Modeling",
    isEnabled: hasProject,
    run: (s, args) => {
      const a = argsOf<{ name: string; expression: string }>(args, ["name", "expression"]);
      s.store.transact(`Edit measure "${a.name}"`, (p) => ops.setMeasureExpression(p, a.name, a.expression));
    },
  });
  r.register({
    id: "model.deleteMeasure",
    label: "Delete measure",
    category: "Modeling",
    isEnabled: hasProject,
    run: (s, args) => {
      const { name } = argsOf<{ name: string }>(args, ["name"]);
      s.store.transact(`Delete measure "${name}"`, (p) => ops.deleteMeasure(p, name));
    },
  });

  return r;
}
