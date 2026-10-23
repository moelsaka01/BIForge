// Modeling commands: properties of tables, columns and measures, calculated columns and tables, hierarchies.
// Dialogs, ribbons and the Properties pane only dispatch these ids.
import type { CommandRegistry } from "./registry";
import type { Session } from "../session/session";
import * as mod from "../model/modeling";
import * as ops from "../model/ops";

const hasProject = (s: Session) => s.store.project !== null;

function need<T extends object>(args: unknown, keys: (keyof T & string)[]): T {
  const a = (args ?? {}) as Record<string, unknown>;
  for (const k of keys) if (a[k] === undefined || a[k] === null) throw new Error(`Missing value: ${k}.`);
  return a as T;
}

export function registerModelingCommands(r: CommandRegistry<Session>): void {
  const reg = (id: string, label: string, run: (s: Session, args: unknown) => void | Promise<void>, enabled: (s: Session) => boolean = hasProject) =>
    r.register({ id, label, category: "Modeling", isEnabled: enabled, run });

  reg("model.setProperty", "Set property", (s, a) => {
    const { target, key } = need<{ target: mod.Target; key: mod.PropKey }>(a, ["target", "key"]);
    const value = (a as { value?: string | boolean | null }).value ?? null;
    s.store.transact(`Set ${key}`, (p) => mod.setProperty(p, target, key, value));
  });

  reg("model.addCalculatedColumn", "New calculated column", (s, a) => {
    const { table, name, expression } = need<{ table: string; name: string; expression: string }>(a, ["table", "name", "expression"]);
    return s.addCalculatedColumn(table, name, expression);
  });
  reg("model.editCalculatedColumn", "Edit calculated column", (s, a) => {
    const { table, name, expression } = need<{ table: string; name: string; expression: string }>(a, ["table", "name", "expression"]);
    return s.editCalculatedColumn(table, name, expression);
  });
  reg("model.setCalculatedTable", "Calculated table", (s, a) => {
    const { name, expression } = need<{ name: string; expression: string }>(a, ["name", "expression"]);
    return s.setCalculatedTable(name, expression);
  });
  reg("model.recalculate", "Recalculate calculated columns and tables", async (s) => {
    const failures = await s.recalculate();
    if (failures.length) throw new Error(failures.map((f) => `${f.table}: ${f.error}`).join("; "));
  });

  reg("model.addHierarchy", "New hierarchy", (s, a) => {
    const { table, name, columns } = need<{ table: string; name: string; columns: string[] }>(a, ["table", "name", "columns"]);
    s.store.transact(`New hierarchy "${name}"`, (p) => mod.addHierarchy(p, table, name, columns));
  });
  reg("model.removeHierarchy", "Delete hierarchy", (s, a) => {
    const { table, name } = need<{ table: string; name: string }>(a, ["table", "name"]);
    s.store.transact(`Delete hierarchy "${name}"`, (p) => mod.removeHierarchy(p, table, name));
  });

  // dialogs
  const dialog = (id: string, label: string, dlg: "newColumn" | "newCalculatedTable") =>
    reg(id, label, (s) => {
      s.shell.openDialog({ kind: "modelDialog", id: dlg, table: s.shell.getSnapshot().selectedTable });
    });
  dialog("model.newColumnDialog", "New column", "newColumn");
  dialog("model.newCalculatedTableDialog", "New calculated table", "newCalculatedTable");
  reg("model.addWhatIf", "New what-if parameter", async (s, a) => {
    const { name, min, max, step } = need<{ name: string; min: number; max: number; step: number }>(a, ["name", "min", "max", "step"]);
    const def = (a as { default?: number }).default ?? min;
    // a table of the values, and a measure that reads the selected one (the user puts the table's column in a slicer)
    await s.setCalculatedTable(name, `SELECTCOLUMNS(GENERATESERIES(${min}, ${max}, ${step}), "${name.replace(/"/g, '""')}", [Value])`);
    s.store.transact(`What-if measure "${name} Value"`, (p) => ops.addMeasure(p, name, `${name} Value`, `SELECTEDVALUE('${name.replace(/'/g, "''")}'[${name}], ${def})`));
  });
  reg("model.whatIfDialog", "New parameter", (s) => {
    s.shell.openDialog({ kind: "modelDialog", id: "whatIf" });
  });
  reg("model.manageRolesDialog", "Manage roles", (s) => s.shell.openDialog({ kind: "roles" }));
  reg("model.viewAsDialog", "View as", (s) => s.shell.openDialog({ kind: "viewAs" }));
  reg("model.setRole", "Save role", (s, a) => {
    const { role, oldName } = need<{ role: mod.RoleView; oldName?: string }>(a, ["role"]);
    s.store.transact(`Role "${role.name}"`, (p) => mod.setRole(p, role, oldName));
  });
  reg("model.removeRole", "Delete role", (s, a) => {
    const { name } = need<{ name: string }>(a, ["name"]);
    s.store.transact(`Delete role "${name}"`, (p) => mod.removeRole(p, name));
  });
  reg("model.viewAs", "View as roles", (s, a) => {
    const { roles, identity } = (a ?? {}) as { roles?: string[]; identity?: string };
    s.setViewAs(roles?.length ? { roles, identity: identity ?? "" } : null);
  });
  reg("model.quickMeasureDialog", "Quick measure", (s) => {
    s.shell.openDialog({ kind: "modelDialog", id: "quickMeasure", table: s.shell.getSnapshot().selectedTable });
  });
  reg("model.newHierarchyDialog", "New hierarchy", (s, a) => {
    const table = (a as { table?: string } | undefined)?.table ?? s.shell.getSnapshot().selectedTable;
    if (!table) throw new Error("Select a table first.");
    s.shell.openDialog({ kind: "modelDialog", id: "newHierarchy", table });
  });
  reg("model.editCalculatedDialog", "Edit calculated column or table", (s, a) => {
    const { kind, table, column } = need<{ kind: "column" | "table"; table: string; column?: string }>(a, ["kind", "table"]);
    s.shell.openDialog({ kind: "modelDialog", id: kind === "column" ? "editColumn" : "editCalculatedTable", table, column });
  });
}
