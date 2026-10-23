import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input, MessageBar, MessageBarBody, Spinner } from "@fluentui/react-components";
import type { Session } from "../../core/session/session";
import { errText } from "../../core/session/session";
import type { CommandRegistry } from "../../core/commands/registry";
import type { EditorFactory } from "../../core/dax/editorTypes";
import { createMMonacoEditor } from "../../core/queries/mMonaco";
import { dialogFor, DATA_TYPES, type DialogAction, type DialogContext, type DialogKind, type Values } from "../../core/queries/dialogs";
import { itemState, RIBBON, type RibbonContext, type RibbonItem } from "../../core/queries/ribbon";
import type { StepColumn } from "../../core/queries/types";
import { Ribbon } from "./Ribbon";
import { QueriesPane, StepsPane } from "./Panes";
import { ExamplesDialog } from "./ExamplesDialog";
import { parseParameter } from "../../core/queries/parameters";
import { PreviewGrid, type HeaderMenuEntry } from "./PreviewGrid";
import { ProfilePane } from "./ProfilePane";
import { useProfiles } from "./useProfiles";
import { FormDialog } from "./FormDialog";
import { AdvancedEditor } from "./AdvancedEditor";
import { ValuePane } from "./ValuePane";
import { DependenciesView } from "./DependenciesView";
import { DEFAULT_PREVIEW_ROWS, useEditorData } from "./useEditorData";

export interface PowerQueryEditorProps {
  session: Session;
  registry: CommandRegistry<Session>;
  /** Code editor for the Advanced Editor (Monaco in the app). */
  factory?: EditorFactory;
}

const ALL_ITEMS: Map<string, RibbonItem> = (() => {
  const m = new Map<string, RibbonItem>();
  const add = (i: RibbonItem) => {
    m.set(i.id, i);
    i.menu?.forEach(add);
  };
  RIBBON.forEach((t) => t.groups.forEach((g) => g.items.forEach(add)));
  return m;
})();

const HEADER_MENU = ["removeColumns.sel", "removeColumns.other", "a.dup", "t.rename", "replace", "splitColumn", "filterRows", "sort.asc", "sort.desc", "t.fill.down", "t.fill.up", "t.pivot", "t.unpivot.sel", "t.unpivot.other", "groupBy"];

type DialogState = { kind: DialogKind; after?: string | null } | null;

/**
 * The Power Query editor: queries, applied steps, a preview of the selected step and the ribbon. It only dispatches
 * registered commands (query.*) and shows what the M engine returns; edits stay in the draft until Close & Apply.
 */
export function PowerQueryEditor({ session, registry, factory = createMMonacoEditor }: PowerQueryEditorProps) {
  const snap = useSyncExternalStore(session.queries.subscribe, session.queries.getSnapshot);
  const m = session.m;
  const texts = useMemo(() => session.queries.texts(), [session, snap.queries]);
  const [reloadKey, setReloadKey] = useState(0);
  const pqOptions = session.shell.settings.getSnapshot().options;
  const previewRows = typeof pqOptions["pq.previewRows"] === "number" ? Math.min(10000, Math.max(100, pqOptions["pq.previewRows"] as number)) : DEFAULT_PREVIEW_ROWS;
  const data = useEditorData(m!, snap, texts, reloadKey, previewRows);
  const [selCols, setSelCols] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [advanced, setAdvanced] = useState(false);
  // Options > Power Query Editor > Show Query dependencies when the editor opens
  const [deps, setDeps] = useState(session.shell.settings.getSnapshot().options["pq.dependencies"] === true);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  // Options > Power Query Editor > Display the formula bar sets the starting state
  const [showFormula, setShowFormula] = useState(session.shell.settings.getSnapshot().options["pq.formulaBar"] !== false);
  // View > Data Preview: column quality, column distribution, column profile (off until switched on)
  const [showQuality, setShowQuality] = useState(false);
  const [showDistribution, setShowDistribution] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [profileAll, setProfileAll] = useState(false);
  const [message, setMessage] = useState<{ intent: "error" | "info"; text: string } | null>(null);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [otherCols, setOtherCols] = useState<Record<string, string[]>>({});
  const [sheets, setSheets] = useState<string[] | undefined>(undefined);
  const [formula, setFormula] = useState("");

  const parameterNames = new Set(snap.queries.filter((q) => parseParameter(q.text) !== null).map((q) => q.name));
  const selectedQuery = snap.queries.find((q) => q.name === snap.selected);
  const selectedParameter = selectedQuery && parseParameter(selectedQuery.text) ? { name: selectedQuery.name, def: parseParameter(selectedQuery.text)! } : null;
  const activeName = snap.step ?? data.active;
  const activeStep = data.steps.find((s) => s.name === activeName);
  const prof = useProfiles(m!, snap.selected, snap.step, texts, showQuality || showDistribution || showProfile, profileAll, snap.version, reloadKey, !!data.page && !data.previewError);
  useEffect(() => setFormula(activeStep?.expr ?? ""), [activeStep?.expr, snap.selected, activeName]);
  useEffect(() => {
    setSelCols((c) => c.filter((n) => data.columns.some((x) => x.name === n)));
  }, [data.columns]);
  useEffect(() => {
    if (!m) return;
    let live = true;
    m.queryKinds(texts).then((k) => live && setKinds(k), () => undefined);
    return () => {
      live = false;
    };
  }, [m, texts]);

  if (!m || !snap.open) return null;

  const run = async (id: string, args?: unknown): Promise<string | null> => {
    const r = await registry.execute(id, args);
    if (r.ok) {
      setMessage(null);
      return null;
    }
    setMessage({ intent: "error", text: r.message });
    return r.message;
  };

  const rc = (sel: string[]): RibbonContext => ({
    columns: data.columns,
    selected: data.columns.map((c) => c.name).filter((n) => sel.includes(n)),
    hasTable: !!data.page && !data.previewError,
    hasQuery: !!snap.selected,
    dirty: session.queries.dirty,
    parameter: !!selectedParameter,
  });

  const dialogCtx = (): DialogContext => ({
    columns: data.columns,
    selected: rc(selCols).selected,
    query: snap.selected ?? "",
    queries: snap.queries.filter((q) => q.name !== snap.selected).map((q) => q.name),
    queryColumns: otherCols,
    sheets,
    parameter: selectedParameter,
    groups: snap.groups,
    group: snap.queries.find((q) => q.name === snap.selected)?.group ?? null,
  });

  const openDialog = async (kind: DialogKind, after?: string | null) => {
    if (kind === "merge" || kind === "append") {
      const others = snap.queries.filter((q) => q.name !== snap.selected).map((q) => q.name);
      if (others.length === 0) {
        setMessage({ intent: "error", text: "There are no other queries. Create another query first." });
        return;
      }
      const cols: Record<string, string[]> = {};
      for (const o of others) {
        try {
          const steps = await m.analyze(texts, o);
          cols[o] = steps[steps.length - 1]?.columns.map((c) => c.name) ?? [];
        } catch {
          cols[o] = [];
        }
      }
      setOtherCols(cols);
    }
    setSheets(undefined);
    try {
      dialogFor(kind, dialogCtx()); // a dialog that cannot open says why instead of failing while it draws
    } catch (e) {
      setMessage({ intent: "error", text: errText(e) });
      return;
    }
    setDialog({ kind, after });
  };

  const onItem = (item: RibbonItem, selection: string[] = selCols) => {
    const ctx = rc(selection);
    const st = itemState(item, ctx);
    if (!st.enabled) {
      setMessage({ intent: "error", text: `${item.label}: ${st.reason}` });
      return;
    }
    const a = item.action;
    if (a.type === "transform") {
      let t;
      try {
        t = a.build(ctx);
      } catch (e) {
        setMessage({ intent: "error", text: errText(e) });
        return;
      }
      void run("query.transform", { transform: t }).then(() => setSelCols([]));
    } else if (a.type === "dialog") {
      void openDialog(a.dialog);
    } else if (a.type === "command") {
      void run(a.id, a.argsFor ? a.argsFor(ctx) : a.args);
    } else if (a.type === "ui") {
      if (a.what === "advanced") setAdvanced(true);
      else if (a.what === "dependencies") setDeps(true);
      else if (a.what === "examples") setExamplesOpen(true);
      else if (a.what === "settings") setShowSettings((v) => !v);
      else if (a.what === "formulaBar") setShowFormula((v) => !v);
      else if (a.what === "quality") setShowQuality((v) => !v);
      else if (a.what === "distribution") setShowDistribution((v) => !v);
      else if (a.what === "profile") setShowProfile((v) => !v);
      else if (a.what === "refresh") setReloadKey((k) => k + 1);
      else if (a.what === "close") {
        if (session.queries.dirty) setConfirmClose(true);
        else void run("query.editor.close");
      }
    }
  };

  const headerMenu = (column: string): HeaderMenuEntry[] => {
    const sel = selCols.includes(column) ? selCols : [column];
    const ctx = rc(sel);
    const entries = HEADER_MENU.flatMap((id) => {
      const item = ALL_ITEMS.get(id);
      if (!item) return [];
      const st = itemState(item, ctx);
      return [{ id, label: id === "removeColumns.sel" ? "Remove" : id === "a.dup" ? "Duplicate Column" : id === "t.rename" ? "Rename..." : item.label, enabled: st.enabled, reason: st.reason }];
    });
    for (const t of DATA_TYPES) entries.splice(2, 0, { id: `type.${t.type}`, label: `Change Type: ${t.label}`, enabled: ctx.hasTable, reason: undefined });
    return entries;
  };

  const onHeaderMenu = (id: string, column: string) => {
    const item = ALL_ITEMS.get(id);
    if (!item) return;
    const sel = selCols.includes(column) ? selCols : [column];
    if (!selCols.includes(column)) setSelCols([column]);
    if (id === "t.rename") {
      void openDialog("rename");
      return;
    }
    onItem(item, sel);
  };

  const selectColumn = (name: string, mode: "single" | "toggle" | "range") => {
    const names = data.columns.map((c) => c.name);
    if (mode === "toggle") setSelCols((c) => (c.includes(name) ? c.filter((x) => x !== name) : [...c, name]));
    else if (mode === "range" && anchor) {
      const [a, b] = [names.indexOf(anchor), names.indexOf(name)];
      setSelCols(names.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else setSelCols([name]);
    if (mode !== "range") setAnchor(name);
  };

  const submitDialog = async (action: DialogAction): Promise<string | null> => {
    const err = "transform" in action ? await run("query.transform", { transform: action.transform, ...(dialog?.after !== undefined ? { after: dialog.after } : {}) }) : await run(action.command, action.args);
    if (!err) {
      setDialog(null);
      setSelCols([]);
    }
    return err;
  };

  const stepAction = async (action: "delete" | "deleteFrom" | "up" | "down" | "rename" | "insert", step: string, extra?: string) => {
    if (action === "insert") return void openDialog("customStep", step);
    const edit =
      action === "delete" ? { op: "delete" as const, name: step }
      : action === "deleteFrom" ? { op: "deleteFrom" as const, name: step }
      : action === "rename" ? { op: "rename" as const, old: step, new: (extra ?? "").trim() }
      : { op: "move" as const, name: step, delta: action === "up" ? -1 : 1 };
    await run("query.step.edit", { edit });
  };

  const queryAction = async (action: "new" | "duplicate" | "delete" | "rename" | "setLoad", name: string, extra?: unknown) => {
    if (action === "new") await run("query.add", {});
    else if (action === "duplicate") await run("query.duplicate", { name });
    else if (action === "delete") await run("query.delete", { name });
    else if (action === "rename") await run("query.rename", { name, to: String(extra ?? "") });
    else await run("query.setLoad", { name, loaded: !!extra });
  };

  const groupAction = (action: "new" | "move" | "ungroup" | "rename" | "delete") => {
    if (action === "ungroup") {
      if (snap.selected) void run("query.setGroup", { query: snap.selected, group: null });
    } else void openDialog(action === "new" ? "newGroup" : action === "move" ? "moveToGroup" : action === "rename" ? "renameGroup" : "deleteGroup");
  };

  const changedCount = snap.queries.filter((q) => session.queries.isChanged(q)).length + snap.removed.length + (session.queries.groupsChanged ? 1 : 0);
  const loadedSet = new Set(snap.queries.filter((q) => q.loaded).map((q) => q.name));
  const mCtx = { columns: data.columns.map((c) => c.name), queries: snap.queries.filter((q) => q.name !== snap.selected).map((q) => q.name), steps: data.steps.map((s) => s.name) };
  const total = data.page?.total ?? 0;

  return (
    <div role="dialog" aria-label="Power Query Editor" style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#fff", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "6px 10px", background: "#106ebe", color: "#fff", display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span>Power Query Editor — {session.store.project?.name}</span>
        <span>{changedCount > 0 ? `${changedCount} change${changedCount === 1 ? "" : "s"} not applied` : "No unapplied changes"}</span>
      </div>
      <Ribbon ctx={rc(selCols)} onItem={(i) => onItem(i)} on={new Set([showSettings ? "v.settings" : "", showFormula ? "v.formula" : "", showQuality ? "v.quality" : "", showDistribution ? "v.distribution" : "", showProfile ? "v.profile" : ""])} />
      {message && (
        <MessageBar intent={message.intent}>
          <MessageBarBody>{message.text}</MessageBarBody>
        </MessageBar>
      )}
      <div style={{ display: "grid", gridTemplateColumns: `220px 1fr ${showSettings ? "260px" : ""}`, flex: 1, minHeight: 0 }}>
        <div style={{ borderRight: "1px solid #d1d1d1", display: "flex", minHeight: 0 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <QueriesPane queries={snap.queries} changed={(q) => session.queries.isChanged(q)} selected={snap.selected} kinds={kinds} groups={snap.groups} parameters={parameterNames} onGroup={groupAction} onSelect={(n) => void run("query.select", { query: n })} onAction={(a, n, x) => void queryAction(a, n, x)} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, padding: 6, gap: 6 }}>
          {showFormula && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span aria-hidden style={{ fontStyle: "italic", color: "#605e5c" }}>
                fx
              </span>
              <Input
                aria-label="Formula bar"
                style={{ flex: 1, fontFamily: "Consolas, monospace" }}
                disabled={!activeStep}
                value={formula}
                onChange={(_, d) => setFormula(d.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && activeStep && formula.trim() !== activeStep.expr.trim()) void run("query.step.edit", { edit: { op: "setExpr", name: activeStep.name, expr: formula } });
                  if (e.key === "Escape") setFormula(activeStep?.expr ?? "");
                }}
              />
            </div>
          )}
          {data.loading && !data.page && <Spinner size="tiny" label="Loading preview…" />}
          {data.previewError && (
            <MessageBar intent="error">
              <MessageBarBody data-testid="preview-error">{data.previewError}</MessageBarBody>
            </MessageBar>
          )}
          {!snap.selected && <div style={{ color: "#605e5c" }}>There are no queries. Use New Source on the Home tab.</div>}
          {data.value && !data.previewError && <ValuePane value={data.value} />}
          {data.page && !data.previewError && <PreviewGrid page={data.page} columns={data.columns} selected={selCols} onSelect={selectColumn} menu={headerMenu} onMenu={onHeaderMenu} profiles={prof.profiles} showQuality={showQuality} showDistribution={showDistribution} monospace={pqOptions["pq.monospace"] === true} showWhitespace={pqOptions["pq.whitespace"] === true} />}
          {showProfile && data.page && !data.previewError && <ProfilePane profile={selCols.length ? (prof.profiles[selCols[selCols.length - 1]] ?? null) : null} all={profileAll} onAll={setProfileAll} loading={prof.loading} error={prof.error} />}
          <div role="status" style={{ fontSize: 12, color: "#605e5c" }}>
            {data.page && !data.previewError ? `${data.columns.length} columns, ${total > data.page.rows.length ? `${data.page.rows.length}+ (of ${total.toLocaleString("en-US")})` : total.toLocaleString("en-US")} rows — the preview shows at most ${previewRows} rows` : ""}
          </div>
        </div>
        {showSettings && (
          <div style={{ borderLeft: "1px solid #d1d1d1", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <StepsPane query={snap.selected} steps={data.steps} active={activeName} parseError={data.parseError} onSelect={(s) => void run("query.step.select", { step: s })} onAction={(a, s, x) => void stepAction(a, s, x)} />
          </div>
        )}
      </div>

      {dialog && (
        <FormDialog
          key={dialog.kind}
          def={dialogFor(dialog.kind, dialogCtx())}
          pickFile={(name, ext) => session.dialogs.pickFile(name, ext)}
          pickFolder={() => session.dialogs.pickFolder()}
          onSubmit={submitDialog}
          onCancel={() => setDialog(null)}
          onValues={(v: Values) => {
            if (dialog.kind === "newExcel" && typeof v.path === "string" && v.path && session.engine) {
              session.engine.excelSheets(v.path).then(setSheets, () => setSheets([]));
            }
          }}
        />
      )}
      {advanced && snap.selected && (
        <AdvancedEditor
          query={snap.selected}
          text={texts[snap.selected] ?? ""}
          m={m}
          factory={factory}
          context={mCtx}
          onDone={async (t) => {
            const err = await run("query.setText", { query: snap.selected, text: t });
            if (!err) setAdvanced(false);
            return err;
          }}
          onCancel={() => setAdvanced(false)}
        />
      )}
      {examplesOpen && data.page && (
        <ExamplesDialog
          page={data.page}
          columns={data.columns}
          onCancel={() => setExamplesOpen(false)}
          onDone={async (name, formula) => {
            const err = await run("query.transform", { transform: { kind: "addCustomColumn", name, formula, valueType: "text" } });
            if (!err) setExamplesOpen(false);
            return err;
          }}
        />
      )}
      {deps && <DependenciesView m={m} texts={texts} loaded={loadedSet} onClose={() => setDeps(false)} />}
      {confirmClose && (
        <Dialog open modalType="modal" onOpenChange={(_, d) => !d.open && setConfirmClose(false)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Discard changes?</DialogTitle>
              <DialogContent>{changedCount} change{changedCount === 1 ? " has" : "s have"} not been applied. Closing the editor discards them.</DialogContent>
              <DialogActions>
                <Button
                  appearance="primary"
                  onClick={() => {
                    setConfirmClose(false);
                    void run("query.editor.close");
                  }}
                >
                  Discard
                </Button>
                <Button onClick={() => setConfirmClose(false)}>Keep editing</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}

export type { StepColumn };
