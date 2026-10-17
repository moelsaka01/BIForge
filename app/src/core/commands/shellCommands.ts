// Commands of the app frame: start screen and backstage, views, panes, theme, shell choice, dialogs. The shells and
// the start screen only dispatch these ids; nothing here knows about components.
import type { CommandRegistry } from "./registry";
import { optionDef, optionValue } from "../options/schema";
import { setModelCulture } from "../model/ops";
import type { TmdlDocument } from "../model/types";
import type { Session } from "../session/session";
import { PANE_IDS, type PaneId, type ShellKind } from "../shell/settings";
import { VIEW_IDS, type ViewId, type Zoom } from "../shell/shellStore";

const hasProject = (s: Session) => s.store.project !== null;
const VIEW_LABELS: Record<ViewId, string> = { report: "Report view", data: "Table view", model: "Model view", dax: "DAX query view", tmdl: "TMDL view" };

export function registerShellCommands(r: CommandRegistry<Session>): void {
  r.register({ id: "app.showStart", label: "File", category: "File", run: (s) => s.shell.showStart() });
  r.register({ id: "app.backToDocument", label: "Back to the report", category: "File", isEnabled: hasProject, run: (s) => s.shell.setView(s.shell.getSnapshot().view) });

  r.register({ id: "file.newBlank", label: "Blank report", category: "File", run: (s) => s.shell.openDialog({ kind: "newProject" }) });
  r.register({ id: "file.saveAs", label: "Save as", category: "File", isEnabled: hasProject, run: (s) => s.shell.openDialog({ kind: "saveAs" }) });
  r.register({
    id: "file.saveAs.run",
    label: "Save the project under a new name or in a new folder",
    category: "File",
    isEnabled: hasProject,
    async run(s, args) {
      const a = (args ?? {}) as { name?: string; folder?: string; copy?: boolean };
      if (!a.name || !a.folder) throw new Error("Missing name or folder.");
      await s.saveAs(a.folder, a.name, a.copy === true);
    },
  });
  r.register({ id: "file.importMenu", label: "Import", category: "File", isEnabled: hasProject, run: (s) => s.shell.openDialog({ kind: "importMenu" }) });
  r.register({ id: "file.exportMenu", label: "Export", category: "File", isEnabled: hasProject, run: (s) => s.shell.openDialog({ kind: "exportMenu" }) });
  r.register({
    id: "file.close",
    label: "Close project",
    category: "File",
    isEnabled: hasProject,
    async run(s, args) {
      const discard = (args as { discard?: boolean } | undefined)?.discard === true;
      if (s.store.getSnapshot().isDirty && !discard) return s.shell.openDialog({ kind: "unsaved", resume: { id: "file.close", args: { discard: true } } });
      await s.closeProjectDiscarding();
    },
  });
  r.register({
    id: "app.exit",
    label: "Exit",
    category: "File",
    async run(s, args) {
      const discard = (args as { discard?: boolean } | undefined)?.discard === true;
      if (s.store.getSnapshot().isDirty && !discard) return s.shell.openDialog({ kind: "unsaved", resume: { id: "app.exit", args: { discard: true } } });
      // leaving on purpose: the snapshot of unsaved edits is not a crash recovery
      await s.discardUnsavedForExit().catch(() => undefined);
      await s.shell.window.destroy();
    },
  });

  for (const v of VIEW_IDS) {
    r.register({ id: `view.${v}`, label: VIEW_LABELS[v], category: "View", isEnabled: hasProject, run: (s) => s.shell.setView(v) });
  }
  r.register({
    id: "view.zoom",
    label: "Zoom",
    category: "View",
    isEnabled: (s) => hasProject(s) && s.shell.getSnapshot().view === "report",
    run(s, args) {
      const z = (args as { zoom?: Zoom } | undefined)?.zoom;
      if (z !== "fit" && !(typeof z === "number" && z >= 0.1 && z <= 4)) throw new Error("Zoom must be \"fit\" or a number between 10% and 400%.");
      s.shell.setZoom(z);
    },
  });
  r.register({
    id: "pane.toggle",
    label: "Show or hide a pane",
    category: "View",
    run(s, args) {
      const pane = (args as { pane?: PaneId } | undefined)?.pane;
      if (!pane || !PANE_IDS.includes(pane)) throw new Error("Missing or unknown pane.");
      const kind = s.shell.settings.getSnapshot().shell;
      const panes = s.shell.settings.getSnapshot().layouts[kind].panes;
      // the Modern sidebar shows one of Visualizations, Filters and Bookmarks at a time
      if (kind === "modern" && (pane === "filters" || pane === "visualizations" || pane === "bookmarks" || pane === "selection" || pane === "sync")) {
        if (panes.visualizations.open && s.shell.getSnapshot().sideTab === pane) s.shell.settings.setPane(kind, "visualizations", { open: false });
        else {
          s.shell.setSideTab(pane);
          s.shell.settings.setPane(kind, "visualizations", { open: true });
        }
        return;
      }
      s.shell.settings.setPane(kind, pane, { open: !panes[pane].open });
    },
  });

  r.register({
    id: "app.theme.toggle",
    label: "Switch between light and dark",
    category: "App",
    // the opposite of what is on screen now (also when the theme follows the system)
    run: (s) => s.shell.settings.setTheme(s.shell.resolvedTheme() === "dark" ? "light" : "dark"),
  });
  r.register({
    id: "app.theme.set",
    label: "Set the theme",
    category: "App",
    run(s, args) {
      const theme = (args as { theme?: string } | undefined)?.theme;
      if (theme !== "light" && theme !== "dark" && theme !== "system") throw new Error("The theme must be light, dark or system.");
      s.shell.settings.setTheme(theme);
    },
  });
  r.register({
    id: "app.shell.set",
    label: "Switch the interface",
    category: "App",
    run(s, args) {
      const shell = (args as { shell?: ShellKind } | undefined)?.shell;
      if (shell !== "classic" && shell !== "modern") throw new Error("The interface must be classic or modern.");
      s.shell.settings.setShell(shell);
    },
  });
  r.register({
    id: "app.ribbon.toggle",
    label: "Collapse or expand the ribbon",
    category: "App",
    run(s) {
      const kind = s.shell.settings.getSnapshot().shell;
      s.shell.settings.setRibbonCollapsed(kind, !s.shell.settings.getSnapshot().layouts[kind].ribbonCollapsed);
    },
  });
  r.register({
    id: "app.ribbon.mode",
    label: "Ribbon: one line or several",
    category: "App",
    run(s, args) {
      const mode = (args as { mode?: string } | undefined)?.mode;
      if (mode !== "multiline" && mode !== "singleline") throw new Error("The ribbon mode must be multiline or singleline.");
      s.shell.settings.setRibbonMode(s.shell.settings.getSnapshot().shell, mode);
    },
  });
  r.register({ id: "app.layout.reset", label: "Reset the panes and ribbon of this interface", category: "App", run: (s) => s.shell.settings.resetLayout(s.shell.settings.getSnapshot().shell) });
  r.register({
    id: "app.recent.remove",
    label: "Remove from recent projects",
    category: "File",
    run(s, args) {
      const path = (args as { path?: string } | undefined)?.path;
      if (!path) throw new Error("Missing project path.");
      s.shell.settings.removeRecent(path);
    },
  });
  r.register({ id: "app.options", label: "Options and settings", category: "App", run: (s, args) => s.shell.openDialog({ kind: "options", page: (args as { page?: string } | undefined)?.page }) });
  r.register({
    id: "app.option.set",
    label: "Change a setting",
    category: "App",
    run(s, args) {
      const a = (args ?? {}) as { id?: string; value?: unknown };
      const def = a.id ? optionDef(a.id) : undefined;
      if (!def || !def.implemented) throw new Error("This setting is not available.");
      const next = optionValue({ [def.id]: a.value as never }, def);
      if (def.type !== "bool" && def.type !== "number" && def.type !== "enum" && def.type !== "text") throw new Error("This setting cannot be changed.");
      if (next !== a.value && !(def.type === "number" && typeof a.value === "number")) throw new Error(`"${String(a.value)}" is not a valid value for "${def.label}".`);
      s.shell.settings.setOption(def.id, next);
    },
  });
  r.register({
    id: "model.setCulture",
    label: "Set the model language",
    category: "Modeling",
    isEnabled: hasProject,
    run(s, args) {
      const culture = (args as { culture?: string } | undefined)?.culture;
      if (!culture) throw new Error("Missing culture.");
      s.store.transact("Set model language", (p) => setModelCulture(p, culture));
    },
  });
  r.register({ id: "app.about", label: "About", category: "Help", run: (s) => s.shell.openDialog({ kind: "about" }) });
  r.register({ id: "app.shortcuts", label: "Keyboard shortcuts", category: "Help", run: (s) => s.shell.openDialog({ kind: "shortcuts" }) });

  r.register({
    id: "data.getData",
    label: "Get data",
    category: "Data",
    isEnabled: (s) => s.engine !== null,
    run(s, args) {
      const source = (args as { source?: string } | undefined)?.source;
      // without a project the data needs one first: create it, then show the import dialog
      if (!hasProject(s)) s.shell.openDialog({ kind: "newProject", thenImport: source ?? true });
      else s.shell.openDialog({ kind: "import", source });
    },
  });
  r.register({ id: "model.newMeasure", label: "New measure", category: "Modeling", isEnabled: hasProject, run: (s) => s.shell.requestNewMeasure() });
  r.register({ id: "model.newTableDialog", label: "New table", category: "Modeling", isEnabled: hasProject, run: (s) => s.shell.openDialog({ kind: "newTable" }) });
  r.register({ id: "model.manageRelationships", label: "Manage relationships", category: "Modeling", isEnabled: hasProject, run: (s) => s.shell.setView("model") });
  r.register({ id: "tmdl.apply", label: "Apply TMDL changes", category: "Modeling", isEnabled: hasProject, run: (s) => s.shell.requestApplyTmdl() });
  r.register({
    id: "model.setTmdlDocument",
    label: "Edit a TMDL file",
    category: "Modeling",
    isEnabled: hasProject,
    run(s, args) {
      const a = (args ?? {}) as { path?: string; document?: TmdlDocument };
      if (!a.path || !/^[^\\:*?"<>|]+\.tmdl$/.test(a.path) || a.path.split("/").some((p) => p === ".." || p === "" || p === ".")) throw new Error("A TMDL file path looks like model.tmdl or tables/Sales.tmdl.");
      if (!a.document || !Array.isArray(a.document.nodes)) throw new Error("Missing TMDL document.");
      const document = a.document;
      const path = a.path;
      s.store.transact(`Edit ${path}`, (p) => {
        if (!(path in p.model.tmdl)) throw new Error(`The model has no file ${path}.`);
        p.model.tmdl[path] = document;
      });
    },
  });
  r.register({ id: "dax.query.run", label: "Run query", category: "DAX", isEnabled: hasProject, run: (s) => s.shell.requestRunQuery() });
  r.register({
    id: "dax.tab",
    label: "DAX query view tab",
    category: "DAX",
    isEnabled: hasProject,
    run(s, args) {
      const tab = (args as { tab?: string } | undefined)?.tab;
      if (tab !== "query" && tab !== "measures") throw new Error("Unknown tab.");
      s.shell.setView("dax");
      s.shell.setDaxTab(tab);
    },
  });
}
