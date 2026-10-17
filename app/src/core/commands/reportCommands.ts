// Report commands: pages, visuals, fields, formatting, filters, interactions, bookmarks, themes and the view
// actions (selection, drilling, drillthrough). Shells and panes only dispatch these ids.
import type { CommandRegistry } from "./registry";
import type { Session } from "../session/session";
import * as bm from "../report/bookmarks";
import { lit, type FieldRef, type Lit } from "../report/fields";
import type { FilterDef } from "../report/filters";
import { drillthroughFilters, drillthroughTargets, type SelectedPoint } from "../report/interactions";
import type { J } from "../report/pbir";
import * as ops from "../report/reportOps";
import { applyThemeToProject, BUILTIN_THEMES, clearCustomTheme, parseThemeJson } from "../report/theme";
import { activePageName, listPageNames, parsePage, type Position, type SortSpec } from "../report/visualDoc";
import { VISUAL_TYPES } from "../report/visualTypes";
import { actionProblem, readAction, writeTextbox, type TextboxModel } from "../report/staticVisuals";
import { listBookmarks } from "../report/bookmarks";

const hasProject = (s: Session) => s.store.project !== null;

function need<T extends object>(args: unknown, keys: (keyof T & string)[]): T {
  const a = (args ?? {}) as Record<string, unknown>;
  for (const k of keys) if (a[k] === undefined || a[k] === null) throw new Error(`Missing value: ${k}.`);
  return a as T;
}

/** The page the user is looking at: the runtime's, else the document's active page. */
export function currentPage(s: Session): string {
  const p = s.store.project;
  const page = s.report.getSnapshot().page ?? (p ? activePageName(p) : null);
  if (!page) throw new Error("There is no page.");
  return page;
}

export function registerReportCommands(r: CommandRegistry<Session>): void {
  const reg = (id: string, label: string, run: (s: Session, args: unknown) => void | Promise<void>, extra: { shortcut?: string; enabled?: (s: Session) => boolean } = {}) =>
    r.register({ id, label, category: "Report", shortcut: extra.shortcut, isEnabled: extra.enabled ?? hasProject, run });
  const edit = (s: Session, label: string, fn: (p: NonNullable<Session["store"]["project"]>) => void) => s.store.transact(label, (p) => fn(p));

  // ---- pages ----
  reg("report.page.add", "New page", (s, a) => {
    const args = (a ?? {}) as { name?: string; type?: "Drillthrough" | "Tooltip" };
    let id = "";
    edit(s, "New page", (p) => {
      id = ops.addPage(p, args.name, { type: args.type, afterPage: s.report.getSnapshot().page ?? undefined });
    });
    s.report.goToPage(id);
  });
  reg("report.page.go", "Go to page", (s, a) => {
    const { page } = need<{ page: string }>(a, ["page"]);
    if (!listPageNames(s.store.project!).includes(page)) throw new Error(`Page "${page}" does not exist.`);
    s.report.goToPage(page);
    // a shared report is read-only: the page changes in the view only
    if (!s.store.getSnapshot().readOnly) edit(s, "Switch page", (p) => ops.setActivePage(p, page));
  });
  reg("report.page.rename", "Rename page", (s, a) => {
    const x = need<{ page: string; name: string }>(a, ["page", "name"]);
    edit(s, "Rename page", (p) => ops.renamePage(p, x.page, x.name));
  });
  reg("report.page.duplicate", "Duplicate page", (s, a) => {
    const { page } = need<{ page: string }>(a, ["page"]);
    let id = "";
    edit(s, "Duplicate page", (p) => {
      id = ops.duplicatePage(p, page);
    });
    s.report.goToPage(id);
  });
  reg("report.page.delete", "Delete page", (s, a) => {
    const { page } = need<{ page: string }>(a, ["page"]);
    edit(s, "Delete page", (p) => ops.deletePage(p, page));
    const p = s.store.project!;
    s.report.goToPage(activePageName(p) ?? listPageNames(p)[0]);
  });
  reg("report.page.move", "Move page", (s, a) => {
    const x = need<{ page: string; index: number }>(a, ["page", "index"]);
    edit(s, "Reorder pages", (p) => ops.movePage(p, x.page, x.index));
  });
  reg("report.page.setSize", "Page size", (s, a) => {
    const x = need<{ page: string; width: number; height: number }>(a, ["page", "width", "height"]);
    edit(s, "Page size", (p) => ops.setPageSize(p, x.page, x.width, x.height));
  });
  reg("report.page.setHidden", "Hide page", (s, a) => {
    const x = need<{ page: string; hidden: boolean }>(a, ["page", "hidden"]);
    edit(s, x.hidden ? "Hide page" : "Show page", (p) => ops.setPageHidden(p, x.page, x.hidden));
  });
  reg("report.page.setType", "Page type", (s, a) => {
    const x = need<{ page: string }>(a, ["page"]);
    const type = (a as { type?: "Drillthrough" | "Tooltip" | null }).type ?? null;
    edit(s, "Page type", (p) => ops.setPageType(p, x.page, type));
  });
  reg("report.page.setDrillthroughFields", "Drillthrough fields", (s, a) => {
    const x = need<{ page: string; fields: FieldRef[] }>(a, ["page", "fields"]);
    edit(s, "Drillthrough fields", (p) => ops.setDrillthroughFields(p, x.page, x.fields));
  });

  // ---- visuals ----
  r.register({ id: "report.visuals.pause", label: "Pause visuals", category: "Report", isEnabled: (s) => s.store.project !== null, run: (s, a) => s.report.setPaused((a as { paused?: boolean } | undefined)?.paused ?? !s.report.getSnapshot().paused) });
  r.register({ id: "report.visuals.refresh", label: "Refresh visuals", category: "Report", isEnabled: (s) => s.store.project !== null, run: (s) => s.report.refreshVisuals() });
  reg("report.visual.add", "Add visual", (s, a) => {
    const x = need<{ type: string }>(a, ["type"]);
    const args = a as { page?: string; position?: Partial<Position>; fields?: { role: string; field: FieldRef }[]; format?: { object: string; prop: string; value: Lit }[] };
    if (!VISUAL_TYPES.some((t) => t.id === x.type)) throw new Error(`Unknown visual type "${x.type}".`);
    edit(s, "Add visual", (p) => {
      const page = args.page ?? currentPage(s);
      const name = ops.addVisual(p, page, x.type, { position: args.position, fields: args.fields });
      for (const f of args.format ?? []) ops.setVisualFormat(p, page, name, f.object, f.prop, f.value);
    });
  });
  reg("report.textbox.set", "Edit text box", (s, a) => {
    const x = need<{ page: string; visual: string }>(a, ["page", "visual"]);
    const patch = (a as { patch?: Partial<TextboxModel> }).patch ?? {};
    edit(s, "Edit text box", (p) => ops.editStatic(p, x.page, x.visual, "textbox", (json) => writeTextbox(json, patch)));
  });
  reg("report.image.insert", "Insert image", async (s, a) => {
    const path = await s.dialogs.pickFile("Picture", ["png", "jpg", "jpeg", "gif", "svg", "webp"]);
    if (!path) return;
    if (!s.io.readImage) throw new Error("Choosing an image is not available here.");
    const uri = await s.io.readImage(path);
    edit(s, "Insert image", (p) => {
      const page = ((a ?? {}) as { page?: string }).page ?? currentPage(s);
      const name = ops.addVisual(p, page, "image");
      ops.setVisualFormat(p, page, name, "image", "imageUrl", lit.str(uri));
    });
  });
  reg("report.image.choose", "Choose image", async (s, a) => {
    const x = need<{ page: string; visual: string }>(a, ["page", "visual"]);
    const path = await s.dialogs.pickFile("Picture", ["png", "jpg", "jpeg", "gif", "svg", "webp"]);
    if (path) await r.execute("report.image.set", { ...x, path }).then((res) => { if (!res.ok) throw new Error(res.message); });
  });
  reg("report.image.set", "Choose image", async (s, a) => {
    const x = need<{ page: string; visual: string; path: string }>(a, ["page", "visual", "path"]);
    if (!s.io.readImage) throw new Error("Choosing an image is not available here.");
    const uri = await s.io.readImage(x.path);
    edit(s, "Choose image", (p) => ops.setVisualFormat(p, x.page, x.visual, "image", "imageUrl", lit.str(uri)));
  });
  reg(
    "report.button.run",
    "Run button action",
    async (s, a) => {
      const x = need<{ page: string; visual: string }>(a, ["page", "visual"]);
      const p = s.store.project!;
      const v = parsePage(p, x.page)?.visuals.find((y) => y.name === x.visual);
      if (!v) throw new Error(`Visual "${x.visual}" does not exist.`);
      const act = readAction(v.json);
      const problem = actionProblem(act, listPageNames(p), listBookmarks(p).map((b) => b.id));
      if (problem) throw new Error(problem);
      switch (act.type) {
        case "PageNavigation":
          s.report.goToPage(act.page!);
          if (!s.store.getSnapshot().readOnly) edit(s, "Switch page", (d) => ops.setActivePage(d, act.page!));
          break;
        case "Bookmark":
          if (s.store.getSnapshot().readOnly) throw new Error("Bookmark buttons do not work yet in a report opened for viewing.");
          await r.execute("report.bookmark.apply", { id: act.bookmark });
          break;
        case "Back":
          s.report.back();
          break;
        case "WebUrl":
          if (!s.io.openUrl) throw new Error("Opening a web link is not available here.");
          await s.io.openUrl(act.url!);
          break;
        default:
          break;
      }
    },
  );
  reg("report.visual.delete", "Delete visual", (s, a) => {
    const x = need<{ page: string; visual: string }>(a, ["page", "visual"]);
    edit(s, "Delete visual", (p) => ops.deleteVisual(p, x.page, x.visual));
    s.report.clearSelection();
  });
  reg("report.visual.setPosition", "Move visual", (s, a) => {
    const x = need<{ page: string; visual: string; position: Partial<Position> }>(a, ["page", "visual", "position"]);
    edit(s, "Move or resize visual", (p) => ops.setPosition(p, x.page, x.visual, x.position));
  });
  reg("report.visual.arrange", "Bring to front / send to back", (s, a) => {
    const x = need<{ page: string; visual: string; where: "front" | "back" }>(a, ["page", "visual", "where"]);
    edit(s, "Arrange visual", (p) => ops.arrange(p, x.page, x.visual, x.where));
  });
  reg("report.visual.setType", "Change visual type", (s, a) => {
    const x = need<{ page: string; visual: string; type: string }>(a, ["page", "visual", "type"]);
    edit(s, "Change visual type", (p) => ops.setVisualType(p, x.page, x.visual, x.type));
    s.report.resetDrill(x.visual);
  });
  reg("report.visual.setHidden", "Show or hide visual", (s, a) => {
    const x = need<{ page: string; visual: string; hidden: boolean }>(a, ["page", "visual", "hidden"]);
    edit(s, x.hidden ? "Hide visual" : "Show visual", (p) => ops.setHidden(p, x.page, x.visual, x.hidden));
  });
  reg("report.visual.setSort", "Sort visual", (s, a) => {
    const x = need<{ page: string; visual: string }>(a, ["page", "visual"]);
    edit(s, "Sort visual", (p) => ops.setSort(p, x.page, x.visual, (a as { sort?: SortSpec | null }).sort ?? null));
  });
  reg("report.visual.duplicate", "Duplicate visual", (s, a) => {
    const x = need<{ page: string; visual: string }>(a, ["page", "visual"]);
    edit(s, "Duplicate visual", (p) => {
      ops.duplicateVisual(p, x.page, x.visual);
    });
  });

  // ---- fields ----
  reg("report.field.add", "Add field to visual", (s, a) => {
    const x = need<{ page: string; visual: string; field: FieldRef }>(a, ["page", "visual", "field"]);
    const args = a as { role?: string | null; index?: number };
    edit(s, "Add field", (p) => ops.addField(p, x.page, x.visual, args.role ?? null, x.field, args.index));
    s.report.resetDrill(x.visual);
  });
  reg("report.field.remove", "Remove field from visual", (s, a) => {
    const x = need<{ page: string; visual: string; role: string; index: number }>(a, ["page", "visual", "role", "index"]);
    edit(s, "Remove field", (p) => ops.removeField(p, x.page, x.visual, x.role, x.index));
    s.report.resetDrill(x.visual);
  });
  reg("report.field.move", "Reorder field", (s, a) => {
    const x = need<{ page: string; visual: string; role: string; from: number; to: number }>(a, ["page", "visual", "role", "from", "to"]);
    edit(s, "Reorder field", (p) => ops.moveField(p, x.page, x.visual, x.role, x.from, x.to));
    s.report.resetDrill(x.visual);
  });
  reg("report.field.setAggregation", "Summarize field", (s, a) => {
    const x = need<{ page: string; visual: string; role: string; index: number; fn: number }>(a, ["page", "visual", "role", "index", "fn"]);
    edit(s, "Summarize field", (p) => ops.setAggregation(p, x.page, x.visual, x.role, x.index, x.fn));
  });
  reg("report.field.rename", "Rename field in visual", (s, a) => {
    const x = need<{ page: string; visual: string; role: string; index: number; name: string }>(a, ["page", "visual", "role", "index", "name"]);
    edit(s, "Rename field", (p) => ops.renameField(p, x.page, x.visual, x.role, x.index, x.name));
  });

  // ---- formatting ----
  reg("report.format.set", "Format visual", (s, a) => {
    const x = need<{ page: string; visual: string; object: string; prop: string }>(a, ["page", "visual", "object", "prop"]);
    const args = a as { value?: Lit | null; selector?: string };
    edit(s, "Format visual", (p) => ops.setVisualFormat(p, x.page, x.visual, x.object, x.prop, args.value ?? null, args.selector));
  });
  reg("report.format.setRaw", "Conditional formatting", (s, a) => {
    const x = need<{ page: string; visual: string; object: string; prop: string }>(a, ["page", "visual", "object", "prop"]);
    const args = a as { node?: J | null; selector?: string };
    edit(s, "Conditional formatting", (p) => ops.setVisualRaw(p, x.page, x.visual, x.object, x.prop, args.node ?? null, args.selector));
  });

  // ---- filters, slicers, interactions ----
  reg("report.filter.upsert", "Set filter", (s, a) => {
    const x = need<{ scope: ops.FilterScope; filter: FilterDef }>(a, ["scope", "filter"]);
    edit(s, "Set filter", (p) => ops.upsertFilter(p, x.scope, x.filter));
  });
  reg("report.filter.remove", "Clear filter", (s, a) => {
    const x = need<{ scope: ops.FilterScope; name: string }>(a, ["scope", "name"]);
    edit(s, "Clear filter", (p) => ops.removeFilter(p, x.scope, x.name));
  });
  reg("report.slicer.select", "Slicer selection", (s, a) => {
    const x = need<{ page: string; visual: string; field: FieldRef }>(a, ["page", "visual", "field"]);
    const cond = (a as { cond?: FilterDef["cond"] | null }).cond ?? null;
    edit(s, "Slicer selection", (p) => {
      const scope = { level: "visual", page: x.page, visual: x.visual } as const;
      if (!cond) ops.removeFilter(p, scope, "slicer");
      else ops.upsertFilter(p, scope, { name: "slicer", field: x.field, cond });
    });
  });
  reg("report.interaction.set", "Edit interactions", (s, a) => {
    const x = need<{ page: string; source: string; target: string; type: ops.InteractionType }>(a, ["page", "source", "target", "type"]);
    edit(s, "Edit interaction", (p) => ops.setInteraction(p, x.page, x.source, x.target, x.type));
  });
  reg("report.interaction.edit", "Edit interactions mode", (s, a) => {
    s.report.setEditInteractions(((a ?? {}) as { source?: string | null }).source ?? null);
  });

  // ---- bookmarks ----
  const runtimeState = (s: Session) => ({ selection: s.report.getSnapshot().selection, drill: s.report.getSnapshot().drill });
  reg("report.bookmark.add", "Add bookmark", (s, a) => {
    const args = (a ?? {}) as { name?: string; options?: bm.BookmarkOptions };
    edit(s, "Add bookmark", (p) => bm.createBookmark(p, args.name ?? "", currentPage(s), runtimeState(s), args.options));
  });
  reg("report.bookmark.apply", "Apply bookmark", (s, a) => {
    const { id } = need<{ id: string }>(a, ["id"]);
    let applied: bm.Applied | null = null;
    edit(s, "Apply bookmark", (p) => {
      applied = bm.applyBookmark(p, id, currentPage(s));
    });
    const ap = applied as bm.Applied | null;
    if (ap) {
      if (ap.runtime) s.report.restore({ page: ap.page, selection: ap.runtime.selection, drill: ap.runtime.drill });
      else s.report.goToPage(ap.page);
    }
  });
  reg("report.bookmark.update", "Update bookmark", (s, a) => {
    const { id } = need<{ id: string }>(a, ["id"]);
    edit(s, "Update bookmark", (p) => bm.updateBookmark(p, id, currentPage(s), runtimeState(s)));
  });
  reg("report.bookmark.rename", "Rename bookmark", (s, a) => {
    const x = need<{ id: string; name: string }>(a, ["id", "name"]);
    edit(s, "Rename bookmark", (p) => bm.renameBookmark(p, x.id, x.name));
  });
  reg("report.bookmark.delete", "Delete bookmark", (s, a) => {
    const { id } = need<{ id: string }>(a, ["id"]);
    edit(s, "Delete bookmark", (p) => bm.deleteBookmark(p, id));
  });
  reg("report.bookmark.setOptions", "Bookmark options", (s, a) => {
    const x = need<{ id: string; options: bm.BookmarkOptions }>(a, ["id", "options"]);
    edit(s, "Bookmark options", (p) => bm.setBookmarkOptions(p, x.id, x.options));
  });
  reg("report.bookmark.move", "Reorder bookmark", (s, a) => {
    const x = need<{ id: string; index: number }>(a, ["id", "index"]);
    edit(s, "Reorder bookmarks", (p) => bm.moveBookmark(p, x.id, x.index));
  });

  // ---- themes ----
  reg("report.theme.apply", "Apply theme", (s, a) => {
    const args = (a ?? {}) as { builtin?: string; json?: unknown };
    if (args.builtin) {
      const t = BUILTIN_THEMES.find((b) => b.name === args.builtin);
      if (!t) throw new Error(`There is no built-in theme "${args.builtin}".`);
      edit(s, `Theme: ${t.name}`, (p) => applyThemeToProject(p, t));
      return;
    }
    if (args.json === undefined) throw new Error("Missing theme.");
    const { theme, ignored } = parseThemeJson(typeof args.json === "string" ? JSON.parse(args.json) : args.json);
    edit(s, `Theme: ${theme.name}`, (p) => applyThemeToProject(p, theme));
    s.setMessage(ignored.length ? `Theme "${theme.name}" applied. ${ignored.length} setting(s) in the file are not supported and were ignored: ${ignored.slice(0, 6).join(", ")}${ignored.length > 6 ? ", ..." : ""}.` : `Theme "${theme.name}" applied.`);
  });
  reg("report.theme.reset", "Reset theme", (s) => {
    edit(s, "Reset theme", (p) => clearCustomTheme(p));
  });

  // ---- view state (not part of the document) ----
  const view = (id: string, label: string, run: (s: Session, a: Record<string, unknown>) => void) => reg(id, label, (s, a) => run(s, (a ?? {}) as Record<string, unknown>), { enabled: hasProject });
  view("report.view.select", "Select data point", (s, a) => {
    const x = need<{ page: string; visual: string; point: SelectedPoint }>(a, ["page", "visual", "point"]);
    s.report.select(x.page, x.visual, x.point, a.additive === true);
  });
  view("report.view.clearSelection", "Clear selection", (s) => s.report.clearSelection());
  view("report.view.drillDown", "Drill down", (s, a) => {
    const x = need<{ visual: string; levels: number; value: Lit }>(a, ["visual", "levels", "value"]);
    s.report.drillDown(x.visual, x.levels, x.value);
  });
  view("report.view.drillUp", "Drill up", (s, a) => s.report.drillUp(need<{ visual: string }>(a, ["visual"]).visual));
  view("report.view.nextLevel", "Go to the next level", (s, a) => {
    const x = need<{ visual: string; levels: number }>(a, ["visual", "levels"]);
    s.report.nextLevel(x.visual, x.levels);
  });
  view("report.view.expandAll", "Expand all down one level", (s, a) => {
    const x = need<{ visual: string; levels: number }>(a, ["visual", "levels"]);
    s.report.expandAll(x.visual, x.levels);
  });
  view("report.view.resetDrill", "Reset drill", (s, a) => s.report.resetDrill(need<{ visual: string }>(a, ["visual"]).visual));
  view("report.view.drillMode", "Drill mode", (s, a) => {
    const v = (a.visual as string | null | undefined) ?? null;
    s.report.setDrillMode(s.report.getSnapshot().drillMode === v ? null : v);
  });
  view("report.view.drillthrough", "Drillthrough", (s, a) => {
    const x = need<{ page: string; target: string; point: SelectedPoint }>(a, ["page", "target", "point"]);
    const p = s.store.project!;
    const t = drillthroughTargets(p, listPageNames(p), x.point).find((d) => d.page === x.target);
    if (!t) throw new Error("This data point cannot drill through to that page.");
    s.report.drillThrough(t.page, x.page, drillthroughFilters(t, x.point));
  });
  view("report.view.back", "Back", (s) => s.report.back());
  view("report.view.toggleRow", "Expand or collapse row", (s, a) => {
    const x = need<{ visual: string; key: string }>(a, ["visual", "key"]);
    s.report.toggleCollapsed(x.visual, x.key);
  });
}
