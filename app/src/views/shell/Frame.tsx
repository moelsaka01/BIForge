import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Tab, TabList } from "@fluentui/react-components";
import { listRelationships } from "../../core/model/relationships";
import { allTables, getModelCulture, listTables, textProp } from "../../core/model/ops";
import { getProperty } from "../../core/model/modeling";
import { resolveTheme, themeToJson } from "../../core/report/theme";
import { activePageName, listPageNames, parsePage, parseVisual, visualKey } from "../../core/report/visualDoc";
import { visibleTabs, ribbonFor, type RibbonCtx, type RibbonTab } from "../../core/shell/ribbon";
import type { PaneId } from "../../core/shell/settings";
import type { ViewId } from "../../core/shell/shellStore";
import { DataView } from "../DataView";
import { MeasureEditor } from "../MeasureEditor";
import { ModelView } from "../ModelView";
import { canvasOptionsOf } from "../../core/report/canvasOptions";
import { PowerQueryEditor, ReportView } from "./lazyViews";
import { DataPaneHost } from "./DataPaneHost";
import { DaxQueryView } from "./DaxQueryView";
import { Dialogs } from "./Dialogs";
import { PaneFrame } from "./PaneFrame";
import { Ribbon } from "./Ribbon";
import { useDoc, useEnv, useSession, useSettings, useShellState } from "./ShellContext";
import type { ShellSpec } from "./spec";
import { StartScreen } from "./StartScreen";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { TmdlView } from "./TmdlView";
import { ViewSwitcher } from "./ViewSwitcher";
import { ViewingBar } from "./ViewingBar";
import { ViewAsBar } from "./RolesDialogs";
import { eventToShortcut } from "../../core/commands/registry";

/** A Data pane docked to the side the shell prefers, remembering its width and whether it is open. */
export function DataDock({ spec, forReport }: { spec: ShellSpec; forReport: boolean }) {
  const env = useEnv();
  const settings = useSettings();
  const pane = settings.layouts[spec.kind].panes.data;
  return (
    <PaneFrame
      title="Data"
      side={spec.dataSide}
      open={pane.open}
      width={pane.width}
      onOpenChange={(open) => env.session.shell.settings.setPane(spec.kind, "data", { open })}
      onResize={(width) => env.session.shell.settings.setPane(spec.kind, "data", { width })}
    >
      <DataPaneHost forReport={forReport} />
    </PaneFrame>
  );
}

/** Row count shown in the status bar for the selected table. */
function useRowCount(table: string | null, epoch: number): number | null {
  const env = useEnv();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setN(null);
    if (table && env.session.engine) {
      env.session.engine.tableInfo(table).then(
        (i) => alive && setN(i?.rowCount ?? null),
        () => undefined,
      );
    }
    return () => {
      alive = false;
    };
  }, [env.session.engine, table, epoch]);
  return n;
}

function DaxView({ spec }: { spec: ShellSpec }) {
  const env = useEnv();
  const doc = useDoc();
  const st = useShellState();
  if (!doc.project) return null;
  const tab = st.daxTab;
  return (
    <div className="view-row">
      {spec.dataSide === "left" && <DataDock spec={spec} forReport={false} />}
      <div className="view-content">
        <TabList size="small" selectedValue={tab} onTabSelect={(_, d) => void env.run("dax.tab", { tab: d.value })} style={{ padding: "4px 8px", flex: "none" }}>
          <Tab value="query">Query</Tab>
          <Tab value="measures">Measures</Tab>
        </TabList>
        <div className="view-content" style={{ minHeight: 0 }}>
          {tab === "query" ? (
            <DaxQueryView project={doc.project} dax={env.dax} factory={env.editorFactory} />
          ) : (
            <MeasureEditor key={st.newMeasureTick} project={doc.project} dax={env.dax} registry={env.registry} factory={env.editorFactory} onError={env.setError} />
          )}
        </div>
      </div>
      {spec.dataSide === "right" && <DataDock spec={spec} forReport={false} />}
    </div>
  );
}

function ViewBody({ spec, onScale }: { spec: ShellSpec; onScale(s: number): void }) {
  const env = useEnv();
  const doc = useDoc();
  const sess = useSession();
  const st = useShellState();
  const settings = useSettings();
  const { session } = env;
  const project = doc.project;
  if (!project) return null;
  const dataTable = st.selectedTable ?? sess.dataTables[0] ?? null;

  const withData = (content: React.ReactNode) => (
    <div className="view-row">
      {spec.dataSide === "left" && <DataDock spec={spec} forReport={false} />}
      <div className="view-content">{content}</div>
      {spec.dataSide === "right" && <DataDock spec={spec} forReport={false} />}
    </div>
  );

  switch (st.view) {
    case "report":
      return (
        <div className="view-row">
          <ReportView
            project={project}
            runtime={session.report}
            dax={env.dax}
            dispatch={(id, args) => void env.run(id, args)}
            dataEpoch={sess.dataEpoch}
            zoom={st.zoom}
            onScale={onScale}
            onSelectVisual={(page, visual) => session.shell.selectVisual(page && visual ? { page, visual } : null)}
            docks={sess.viewing ? () => ({}) : spec.reportDocks}
            onObject={spec.kind === "modern" && settings.options["preview.onObject"] !== false && !sess.viewing}
            readOnly={sess.viewing !== null}
            canvas={canvasOptionsOf(settings.options)}
          />
        </div>
      );
    case "data":
      return withData(session.engine ? <DataView engine={session.engine} table={dataTable} reloadKey={sess.dataEpoch + sess.dataTables.length} hiddenColumns={doc.project ? hiddenColumnsOf(doc.project, dataTable) : undefined} culture={doc.project ? (getModelCulture(doc.project) ?? undefined) : undefined} columnMeta={doc.project ? columnMetaOf(doc.project, dataTable) : undefined} onColumnCommand={(cmd, column) => dataTable && void columnCommand(env.run, dataTable, cmd, column)} onEditFormula={(column, expression) => dataTable && void env.run("model.editCalculatedColumn", { table: dataTable, name: column, expression })} /> : <div className="empty-note">The data engine is not available.</div>);
    case "model":
      return withData(
        <ModelView
          project={project}
          session={session}
          registry={env.registry}
          engine={session.engine}
          onError={env.setError}
          properties={{
            open: settings.layouts[spec.kind].panes.properties.open,
            width: settings.layouts[spec.kind].panes.properties.width,
            onOpenChange: (open) => session.shell.settings.setPane(spec.kind, "properties", { open }),
            onResize: (width) => session.shell.settings.setPane(spec.kind, "properties", { width }),
          }}
        />,
      );
    case "dax":
      return <DaxView spec={spec} />;
    case "tmdl":
      return <TmdlView project={project} printer={env.tmdl} />;
  }
}

/** The whole window: title bar, start screen or (ribbon, view switcher, view, panes), status bar, dialogs. */
export function Frame({ spec }: { spec: ShellSpec }) {
  const env = useEnv();
  const { session, registry } = env;
  const doc = useDoc();
  const sess = useSession();
  const st = useShellState();
  const settings = useSettings();
  const report = useSyncExternalStore(session.report.subscribe, session.report.getSnapshot);
  const queriesOpen = useSyncExternalStore(session.queries.subscribe, session.queries.getSnapshot).open;
  const [scale, setScale] = useState<number | null>(null);
  const layout = settings.layouts[spec.kind];
  const project = doc.project;
  const inWorkspace = st.screen === "workspace" && project !== null;
  const rowCount = useRowCount(st.view === "data" ? (st.selectedTable ?? sess.dataTables[0] ?? null) : null, sess.dataEpoch);

  // shortcuts of registered commands (never while typing in a field or an editor)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const sc = eventToShortcut(e);
      const cmd = sc ? registry.byShortcut(sc) : undefined;
      if (cmd) {
        e.preventDefault();
        void env.run(cmd.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [registry, env]);

  // closing the window goes through the Exit command so unsaved changes are asked about
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void session.shell.window.onCloseRequested(() => void env.run("app.exit")).then((f) => {
      if (gone) f();
      else off = f;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [session, env]);

  const ctx: RibbonCtx = useMemo(() => {
    const pageName = project ? (report.page ?? activePageName(project)) : null;
    const sel = st.selectedVisual;
    const vm = project && sel ? parseVisual(sel.page, project.report.files[visualKey(sel.page, sel.visual)]) : null;
    const side = st.sideTab;
    const modern = spec.kind === "modern";
    const open = (id: PaneId) => layout.panes[id].open;
    return {
      view: st.view,
      hasProject: project !== null,
      pageName,
      pageCount: project ? listPageNames(project).length : 0,
      selectedCount: report.canvas.length,
      selectedGroups: project ? (parsePage(project, report.page ?? activePageName(project) ?? "")?.groups.filter((g) => report.canvas.includes(g.name)).length ?? 0) : 0,
      selectedGroupNames: project ? (parsePage(project, report.page ?? activePageName(project) ?? "")?.groups.filter((g) => report.canvas.includes(g.name)).map((g) => g.name) ?? []) : [],
      visual: vm ? { page: vm.pageName, name: vm.name, type: vm.visualType, categories: (vm.roles.Category ?? []).length, drillLevel: report.drill[vm.name]?.level ?? 0, drillMode: report.drillMode === vm.name, editingInteractions: report.editInteractions === vm.name } : null,
      table: st.selectedTable ?? sess.dataTables[0] ?? null,
      daxTab: st.daxTab,
      panes: {
        filters: modern ? open("visualizations") && side === "filters" : open("filters"),
        visualizations: modern ? open("visualizations") && side === "visualizations" : open("visualizations"),
        data: open("data"),
        properties: open("properties"),
        bookmarks: modern ? open("visualizations") && side === "bookmarks" : open("bookmarks"),
        selection: modern ? open("visualizations") && side === "selection" : open("selection"),
        sync: modern ? open("visualizations") && side === "sync" : open("sync"),
      },
      themeName: project ? resolveTheme(project).name : "",
      canvas: canvasOptionsOf(settings.options),
      mobileLayout: report.mobile,
      paused: report.paused,
      zoom: st.zoom,
    };
  }, [project, report, st, layout, spec.kind, sess.dataTables, settings.options]);

  const allTabs: RibbonTab[] = useMemo(() => ribbonFor(spec.kind, st.view), [spec.kind, st.view]);
  const tabs = useMemo(() => visibleTabs(allTabs, ctx), [allTabs, ctx]);
  const ui = useMemo(
    () => ({
      "theme.import": () =>
        void env.files.pickText(".json,application/json").then((text) => {
          if (text !== null) void env.run("report.theme.apply", { json: text });
        }),
      "theme.export": () => {
        if (project) {
          const t = resolveTheme(project);
          env.files.save(`${t.name}.json`, JSON.stringify(themeToJson(t), null, 2));
        }
      },
    }),
    [env, project],
  );

  const pages = project ? listPageNames(project) : [];
  const statusText = (() => {
    if (!inWorkspace || !project) return "";
    const base =
      st.view === "report"
        ? `Page ${Math.max(1, pages.indexOf(ctx.pageName ?? "") + 1)} of ${pages.length}`
        : st.view === "data"
          ? ctx.table
            ? `Table: ${ctx.table}${rowCount !== null ? ` (${rowCount.toLocaleString("en-US")} rows)` : ""}`
            : "No table selected"
          : st.view === "model"
            ? `${listTables(project).length} tables, ${listRelationships(project).length} relationships`
            : st.view === "dax"
              ? "DAX query view"
              : "TMDL view (read-only)";
    const co = sess.coedit;
    const coText = co ? `Editing together${co.status === "offline" ? " (offline, will retry)" : co.status === "sending" ? " (sending)" : ""}${co.received ? `, ${co.received} update${co.received === 1 ? "" : "s"} from others` : ""}` : "";
    const shown = sess.viewing ? `Viewing (read only)  ·  ${base}` : co ? `${coText}  ·  ${base}` : base;
    return sess.lastMessage ? `${shown}  ·  ${sess.lastMessage}` : shown;
  })();

  return (
    <div className={`app ${spec.kind}`} data-shell={spec.kind} data-screen={inWorkspace ? "workspace" : "start"}>
      <TitleBar variant={spec.kind} tabs={tabs} ctx={ctx} ui={ui} />
      {!inWorkspace ? (
        <StartScreen variant={spec.kind} />
      ) : (
        <>
          {sess.viewing ? (
            <ViewingBar viewing={sess.viewing} />
          ) : (
          <Ribbon
            variant={spec.kind}
            mode={layout.ribbonMode}
            collapsed={layout.ribbonCollapsed}
            tabs={tabs}
            active={st.ribbonTab[st.view] ?? "home"}
            ctx={ctx}
            onTab={(id) => session.shell.setRibbonTab(st.view as ViewId, id)}
            onToggleCollapsed={() => void env.run("app.ribbon.toggle")}
            ui={ui}
          />
          )}
          <div className="workspace">
            {!sess.viewing && <ViewSwitcher variant={spec.kind} />}
            <div className="view-main">
              {sess.pendingRecovery && (
                <div className="notice-bar" role="status">
                  Unsaved changes from an earlier session were found.
                  <button type="button" className="link-btn" disabled={!registry.isEnabled("file.restoreRecovery")} onClick={() => void env.run("file.restoreRecovery")}>
                    Restore
                  </button>
                  <button type="button" className="link-btn" disabled={!registry.isEnabled("file.discardRecovery")} onClick={() => void env.run("file.discardRecovery")}>
                    Discard
                  </button>
                </div>
              )}
              {env.error && (
                <div className="notice-bar error" role="alert">
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{env.error}</span>
                  <button type="button" className="link-btn" onClick={() => env.setError(null)}>
                    Dismiss
                  </button>
                </div>
              )}
              <ViewBody spec={spec} onScale={setScale} />
            </div>
          </div>
        </>
      )}
      {inWorkspace && <ViewAsBar />}
      {inWorkspace && <StatusBar text={statusText} scale={st.view === "report" ? scale : null} zoom={st.zoom} />}
      {queriesOpen && <PowerQueryEditor session={session} registry={registry} />}
      <Dialogs />
    </div>
  );
}

/** The columns of a table that the model hides. */
/** Format string, data category and formula of the columns of a table, for the Table view. */
export function columnMetaOf(project: import("../../core/model/types").Project, table: string | null): Record<string, { format?: string; category?: string; formula?: string }> {
  const t = table ? allTables(project).find((x) => x.name === table) : undefined;
  const out: Record<string, { format?: string; category?: string; formula?: string }> = {};
  for (const c of t?.children.filter((x) => x.kind === "column" && x.name) ?? []) {
    const m: { format?: string; category?: string; formula?: string } = {};
    const f = textProp(c, "formatString");
    const cat = textProp(c, "dataCategory");
    if (f) m.format = f;
    if (cat) m.category = cat;
    if (c.default) m.formula = c.default.text;
    if (Object.keys(m).length) out[c.name!] = m;
  }
  return out;
}

/** The column menu and the table header menu of the Table view, as model commands. */
export async function columnCommand(run: (id: string, args?: unknown) => Promise<unknown>, table: string, cmd: "hide" | "unhide" | "rename" | "newColumn" | "editFormula", column?: string): Promise<void> {
  switch (cmd) {
    case "hide":
    case "unhide":
      if (column) await run("model.setProperty", { target: { kind: "column", table, column }, key: "isHidden", value: cmd === "hide" });
      return;
    case "rename":
      if (column) await run("model.renameDialog", { kind: "column", table, name: column });
      return;
    case "newColumn":
      await run("model.newColumnDialog", { table });
      return;
    case "editFormula":
      if (column) await run("model.editCalculatedDialog", { kind: "column", table, column });
  }
}

function hiddenColumnsOf(project: import("../../core/model/types").Project, table: string | null): Set<string> {
  const t = table ? listTables(project).find((x) => x.name === table) : undefined;
  return new Set((t?.columns ?? []).filter((c) => getProperty(project, { kind: "column", table: t!.name, column: c.name }, "isHidden") === true).map((c) => c.name));
}
