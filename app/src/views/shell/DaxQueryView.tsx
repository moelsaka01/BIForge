import { useEffect, useMemo, useRef, useState } from "react";
import { Button, MessageBar, MessageBarBody, Text } from "@fluentui/react-components";
import { buildContext, modelDocuments } from "../../core/dax/context";
import type { EditorFactory } from "../../core/dax/editorTypes";
import type { DaxApi, FunctionInfo, QueryOutcome } from "../../core/dax/types";
import { listTables } from "../../core/model/ops";
import type { Project } from "../../core/model/types";
import { daxFileName, resultToCsv, resultToTsv } from "../../core/dax/resultExport";
import { DaxEditor } from "../DaxEditor";
import { ResultGrid } from "../ResultGrid";
import { useEnv, useShellState } from "./ShellContext";

type Run = { status: "idle" } | { status: "running" } | { status: "error"; message: string } | { status: "done"; outcome: QueryOutcome };

/** Starter text: the first table of the model. Empty when the model has no table. */
export function starterQuery(project: Project): string {
  const t = listTables(project)[0];
  return t ? `EVALUATE\n'${t.name.replace(/'/g, "''")}'` : "";
}

/** DAX query view: write an EVALUATE query, run it over the loaded data and see the tables it returns. */
export function DaxQueryView({ project, dax, factory }: { project: Project; dax: DaxApi; factory: EditorFactory }) {
  const env = useEnv();
  const st = useShellState();
  const text = st.daxQuery;
  const [run, setRun] = useState<Run>({ status: "idle" });
  const [catalog, setCatalog] = useState<FunctionInfo[]>([]);
  const seq = useRef(0);
  const docs = useMemo(() => modelDocuments(project), [project]);

  useEffect(() => {
    if (text === "") env.session.shell.setDaxQuery(starterQuery(project));
    // the starter is only offered while nothing has been typed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let alive = true;
    dax.catalog().then((c) => alive && setCatalog(c), () => undefined);
    return () => {
      alive = false;
    };
  }, [dax]);

  const selection = useRef<(() => string) | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Run runs the selected text when something is selected, otherwise the whole query
  const execute = async () => {
    const mine = ++seq.current;
    const picked = selection.current?.() ?? "";
    setRun({ status: "running" });
    try {
      const outcome = await dax.query(docs, picked.trim() !== "" ? picked : text);
      if (mine === seq.current) setRun({ status: "done", outcome });
    } catch (e) {
      if (mine === seq.current) setRun({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
  const latest = useRef(execute);
  latest.current = execute;
  const latestText = useRef(text);
  latestText.current = text;
  // F5 and Ctrl+Enter run the query (capture phase, so the editor does not swallow them and the WebView never reloads on F5)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const run = e.key === "F5" || (e.key === "Enter" && (e.ctrlKey || e.metaKey));
      if (!run || e.altKey) return;
      e.preventDefault();
      if (latestText.current.trim() !== "") void latest.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const cancel = () => {
    // the engine finishes a query it has started; the view stops waiting for it and drops its result
    seq.current++;
    setRun({ status: "idle" });
    setNote("The query was cancelled. The engine may still finish it in the background; its result is dropped.");
  };
  const firstTick = useRef(st.runQueryTick);
  useEffect(() => {
    if (st.runQueryTick !== firstTick.current) {
      firstTick.current = st.runQueryTick;
      if (text.trim() !== "") void latest.current();
    }
  }, [st.runQueryTick, text]);

  return (
    <div className="panel-pad" aria-label="DAX query area">
      <div role="tablist" aria-label="Query tabs" style={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        {st.daxTabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === st.daxActive} tabIndex={0} onClick={() => env.session.shell.selectDaxTab(t.id)} onDoubleClick={() => setRenaming(t.id)} onKeyDown={(e) => { if (e.key === "F2") { e.stopPropagation(); setRenaming(t.id); } }} style={{ padding: "2px 8px", cursor: "pointer", borderBottom: t.id === st.daxActive ? "2px solid var(--colorBrandForeground1, #0f6cbd)" : "2px solid transparent", display: "flex", gap: 4, alignItems: "center", fontSize: 13 }}>
            {renaming === t.id ? (
              <input
                autoFocus
                aria-label="Query name"
                defaultValue={t.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => (env.session.shell.renameDaxTab(t.id, e.currentTarget.value), setRenaming(null))}
                onKeyDown={(e) => (e.key === "Enter" ? e.currentTarget.blur() : e.key === "Escape" && setRenaming(null))}
              />
            ) : (
              <span>{t.name}</span>
            )}
            <button type="button" aria-label={`Close ${t.name}`} onClick={(e) => (e.stopPropagation(), env.session.shell.closeDaxTab(t.id))} style={{ border: "none", background: "transparent", cursor: "pointer", color: "inherit" }}>
              ✕
            </button>
          </div>
        ))}
        <Button size="small" appearance="subtle" aria-label="New query tab" onClick={() => env.session.shell.addDaxTab(starterQuery(project))}>
          +
        </Button>
      </div>
      <DaxEditor key={st.daxActive} value={text} onChange={(v) => env.session.shell.setDaxQuery(v)} context={buildContext(catalog, project)} markers={[]} ariaLabel="DAX query" factory={factory} height={200} selectionRef={selection} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button size="small" appearance="primary" disabled={text.trim() === "" || run.status === "running"} onClick={() => void execute()}>
          Run
        </Button>
        {run.status === "running" && (
          <Button size="small" onClick={cancel}>
            Cancel
          </Button>
        )}
        <Button
          size="small"
          onClick={() => {
            const t = st.daxTabs.find((x) => x.id === st.daxActive)!;
            env.files.save(daxFileName(t.name), t.text, "text/plain");
          }}
        >
          Save query
        </Button>
        <Button
          size="small"
          onClick={async () => {
            const picked = await env.files.pickText(".dax,.txt");
            if (picked !== null) env.session.shell.addDaxTab(picked);
          }}
        >
          Open query
        </Button>
        <Button size="small" disabled={!/DEFINE/i.test(text)} onClick={() => void env.run("dax.query.updateModel")}>
          Update model with changes
        </Button>
        <Text size={200}>Write an EVALUATE query; select part of it to run only that part. Errors are reported when it runs.</Text>
      </div>
      {note && run.status === "idle" && <Text size={200} role="status">{note}</Text>}
      <div aria-label="Query result" aria-live="polite">
        {run.status === "running" && <Text>Running…</Text>}
        {run.status === "error" && (
          <MessageBar intent="error">
            <MessageBarBody>{run.message}</MessageBarBody>
          </MessageBar>
        )}
        {run.status === "done" && (
          <div style={{ display: "grid", gap: 10 }}>
            {run.outcome.results.map((r, i) => (
              <div key={i}>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <Button size="small" appearance="subtle" aria-label={`Copy result ${i + 1}`} onClick={() => void navigator.clipboard?.writeText(resultToTsv(r)).then(() => setNote("Result copied."))}>
                    Copy
                  </Button>
                  <Button size="small" appearance="subtle" aria-label={`Save result ${i + 1} as CSV`} onClick={() => env.files.save(`Result ${i + 1}.csv`, resultToCsv(r), "text/csv")}>
                    Save as CSV
                  </Button>
                </div>
                <ResultGrid result={r} label={`Result ${i + 1}`} maxRows={500} />
              </div>
            ))}
            <Text size={200}>{run.outcome.elapsedMs} ms</Text>
          </div>
        )}
      </div>
    </div>
  );
}
