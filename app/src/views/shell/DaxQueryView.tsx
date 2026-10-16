import { useEffect, useMemo, useRef, useState } from "react";
import { Button, MessageBar, MessageBarBody, Text } from "@fluentui/react-components";
import { buildContext, modelDocuments } from "../../core/dax/context";
import type { EditorFactory } from "../../core/dax/editorTypes";
import type { DaxApi, FunctionInfo, QueryOutcome } from "../../core/dax/types";
import { listTables } from "../../core/model/ops";
import type { Project } from "../../core/model/types";
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

  const execute = async () => {
    const mine = ++seq.current;
    setRun({ status: "running" });
    try {
      const outcome = await dax.query(docs, text);
      if (mine === seq.current) setRun({ status: "done", outcome });
    } catch (e) {
      if (mine === seq.current) setRun({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
  const latest = useRef(execute);
  latest.current = execute;
  const firstTick = useRef(st.runQueryTick);
  useEffect(() => {
    if (st.runQueryTick !== firstTick.current) {
      firstTick.current = st.runQueryTick;
      if (text.trim() !== "") void latest.current();
    }
  }, [st.runQueryTick, text]);

  return (
    <div className="panel-pad" aria-label="DAX query area">
      <DaxEditor value={text} onChange={(v) => env.session.shell.setDaxQuery(v)} context={buildContext(catalog, project)} markers={[]} ariaLabel="DAX query" factory={factory} height={200} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button size="small" appearance="primary" disabled={text.trim() === "" || run.status === "running"} onClick={() => void execute()}>
          Run
        </Button>
        <Text size={200}>Write an EVALUATE query. Errors are reported when it runs.</Text>
      </div>
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
              <ResultGrid key={i} result={r} label={`Result ${i + 1}`} maxRows={500} />
            ))}
            <Text size={200}>{run.outcome.elapsedMs} ms</Text>
          </div>
        )}
      </div>
    </div>
  );
}
