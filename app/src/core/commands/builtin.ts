import { CommandRegistry } from "./registry";
import type { SourceLocation } from "../data/dataSources";
import type { Session } from "../session/session";
import * as ops from "../model/ops";
import type { PrivacyLevel } from "../model/tables";
import * as rel from "../model/relationships";
import type { SourceSpec } from "../data/types";
import { registerReportCommands } from "./reportCommands";
import { registerQueryCommands } from "./queryCommands";
import { registerShellCommands } from "./shellCommands";
import { registerPublishCommands } from "./publishCommands";
import { registerHostCommands } from "./hostCommands";
import { createSampleProject } from "../session/sample";

function argsOf<T extends object>(args: unknown, required: (keyof T & string)[]): T {
  const a = (args ?? {}) as Record<string, unknown>;
  for (const k of required) {
    if (typeof a[k] !== "string") throw new Error(`Missing value: ${k}.`);
  }
  return a as T;
}

const hasProject = (s: Session) => s.store.project !== null;

/**
 * Replacing the open project with unsaved edits asks first. Returns true when the command must stop here (the
 * question is showing); with discard: true the old project's recovery snapshot is dropped and the command goes on.
 */
async function askBeforeLeaving(s: Session, id: string, args: Record<string, unknown>, given: unknown): Promise<boolean> {
  if (!s.store.getSnapshot().isDirty) return false;
  if ((given as { discard?: boolean } | undefined)?.discard !== true) {
    s.shell.openDialog({ kind: "unsaved", resume: { id, args: { ...args, discard: true } } });
    return true;
  }
  await s.discardUnsavedForExit().catch(() => undefined);
  return false;
}

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
      if (await askBeforeLeaving(s, "file.new", { name, folder }, args)) return;
      await s.newProject(folder, name);
    },
  });
  r.register({ id: "file.newSample", label: "Learn with sample data", category: "File", isEnabled: (s) => s.engine !== null, run: (s) => s.shell.openDialog({ kind: "newProject", sample: true }) });
  r.register({
    id: "file.newSample.run",
    label: "Create the sample project",
    category: "File",
    isEnabled: (s) => s.engine !== null,
    async run(s, args) {
      const { name } = argsOf<{ name: string }>(args, ["name"]);
      const folder = (args as { folder?: string }).folder;
      if (!folder) throw new Error("Missing folder.");
      if (await askBeforeLeaving(s, "file.newSample.run", { name, folder }, args)) return;
      await createSampleProject(s, folder, name);
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
      if (await askBeforeLeaving(s, "file.open", { path }, args)) return;
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

  // ---- Phase 2: data and relationships ----
  const hasEngineProject = (s: Session) => hasProject(s) && s.root !== null && s.engine !== null;

  r.register({
    id: "data.import",
    label: "Import data",
    category: "Data",
    isEnabled: hasEngineProject,
    run: async (s, args) => {
      const a = args as { name?: string; spec?: SourceSpec } | undefined;
      if (!a?.name?.trim() || !a.spec) throw new Error("Missing table name or source.");
      await s.importTable(a.name.trim(), a.spec);
    },
  });
  r.register({
    id: "data.sourceSettings",
    label: "Data source settings",
    category: "Data",
    isEnabled: (s) => hasProject(s),
    run: (s) => s.shell.openDialog({ kind: "dataSources" }),
  });
  r.register({
    id: "data.source.change",
    label: "Change data source",
    category: "Data",
    isEnabled: hasEngineProject,
    run: async (s, args) => {
      const a = argsOf<{ id: string }>(args, ["id"]);
      const location = (args as { location?: SourceLocation }).location;
      if (!location || typeof location !== "object") throw new Error("Missing value: location.");
      await s.changeDataSource(a.id, location);
    },
  });
  r.register({
    id: "data.source.setPrivacy",
    label: "Set the privacy level of a data source",
    category: "Data",
    isEnabled: (s) => hasProject(s),
    run: (s, args) => {
      const a = argsOf<{ id: string; level: string }>(args, ["id", "level"]);
      s.setDataSourcePrivacy(a.id, a.level as PrivacyLevel);
    },
  });
  r.register({
    id: "data.source.setSecret",
    label: "Set data source password",
    category: "Data",
    isEnabled: hasEngineProject,
    run: async (s, args) => {
      const a = argsOf<{ id: string; secret: string }>(args, ["id", "secret"]);
      await s.setDataSourceSecret(a.id, a.secret);
    },
  });
  r.register({
    id: "data.source.clearSecret",
    label: "Clear data source password",
    category: "Data",
    isEnabled: hasEngineProject,
    run: async (s, args) => {
      const a = argsOf<{ id: string }>(args, ["id"]);
      await s.setDataSourceSecret(a.id, null);
    },
  });
  r.register({
    id: "data.refreshTable",
    label: "Refresh table",
    category: "Data",
    isEnabled: hasEngineProject,
    run: async (s, args) => {
      const { name } = argsOf<{ name: string }>(args, ["name"]);
      await s.refreshTable(name);
    },
  });
  r.register({
    id: "data.refreshAll",
    label: "Refresh all",
    category: "Data",
    isEnabled: hasEngineProject,
    run: async (s) => {
      const failures = await s.refreshAll();
      if (failures.length) throw new Error(`Refresh failed for: ${failures.map((f) => f.table).join(", ")}.`);
    },
  });

  r.register({
    id: "model.addRelationship",
    label: "New relationship",
    category: "Modeling",
    isEnabled: hasProject,
    run: (s, args) => {
      const a = args as rel.NewRelationship | undefined;
      if (!a?.fromTable || !a.fromColumn || !a.toTable || !a.toColumn) throw new Error("Missing relationship columns.");
      let createdInactive = false;
      s.store.transact(`New relationship ${a.fromTable}[${a.fromColumn}] to ${a.toTable}[${a.toColumn}]`, (p) => {
        createdInactive = rel.addRelationship(p, a).createdInactive;
      });
      s.setMessage(
        createdInactive ? "Relationship created but inactive: another active path already connects these tables." : "Relationship created.",
      );
    },
  });
  r.register({
    id: "model.updateRelationship",
    label: "Edit relationship",
    category: "Modeling",
    isEnabled: hasProject,
    run: (s, args) => {
      const a = args as { id?: string; patch?: rel.RelationshipPatch } | undefined;
      if (!a?.id || !a.patch) throw new Error("Missing relationship or changes.");
      s.store.transact("Edit relationship", (p) => rel.updateRelationship(p, a.id!, a.patch!));
    },
  });
  r.register({
    id: "model.deleteRelationship",
    label: "Delete relationship",
    category: "Modeling",
    isEnabled: hasProject,
    run: (s, args) => {
      const { id } = argsOf<{ id: string }>(args, ["id"]);
      s.store.transact("Delete relationship", (p) => rel.deleteRelationship(p, id));
    },
  });

  registerReportCommands(r);
  registerQueryCommands(r);
  registerShellCommands(r);
  registerPublishCommands(r);
  registerHostCommands(r);

  return r;
}
