import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, MessageBar, MessageBarBody, Select, Text } from "@fluentui/react-components";
import type { Project } from "../core/model/types";
import { listTables } from "../core/model/ops";
import type { CommandRegistry } from "../core/commands/registry";
import type { Session } from "../core/session/session";
import type { DaxApi, EditorDiagnostic, FunctionInfo, QueryResult } from "../core/dax/types";
import type { EditorFactory } from "../core/dax/editorTypes";
import { buildContext, modelDocuments } from "../core/dax/context";
import { byColumnQuery, valueQuery } from "../core/dax/measureQuery";
import { formatDax } from "../core/dax/format";
import { DaxEditor } from "./DaxEditor";
import { ResultGrid } from "./ResultGrid";

export interface MeasureEditorProps {
  project: Project;
  dax: DaxApi;
  registry: CommandRegistry<Session>;
  factory: EditorFactory;
  onError(message: string | null): void;
}

type Target = { kind: "new" } | { kind: "existing"; name: string };
type Run =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error"; message: string }
  | { status: "done"; value: QueryResult; by: QueryResult | null; elapsedMs: number; text: string };

const NO_BREAKDOWN = "";
const sep = "\u0000";

/**
 * Creating and editing measures: a DAX editor (highlighting, IntelliSense, error squiggles), the measure's value,
 * and the value split by any column. Saving goes through the shared command registry like every other change.
 */
export function MeasureEditor({ project, dax, registry, factory, onError }: MeasureEditorProps) {
  const tables = useMemo(() => listTables(project), [project]);
  const [target, setTarget] = useState<Target>({ kind: "new" });
  const [name, setName] = useState("");
  const [table, setTable] = useState(tables[0]?.name ?? "");
  const [expr, setExpr] = useState("");
  const [diags, setDiags] = useState<EditorDiagnostic[]>([]);
  const [checkFailure, setCheckFailure] = useState<string | null>(null);
  const [by, setBy] = useState(NO_BREAKDOWN);
  const [run, setRun] = useState<Run>({ status: "idle" });
  const [catalog, setCatalog] = useState<FunctionInfo[]>([]);
  const runSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    dax.catalog().then(
      (c) => alive && setCatalog(c),
      (e: unknown) => alive && setCheckFailure(`The function list could not be loaded: ${e instanceof Error ? e.message : String(e)}`),
    );
    return () => {
      alive = false;
    };
  }, [dax]);

  const stored = target.kind === "existing" ? tables.flatMap((t) => t.measures.map((m) => ({ ...m, table: t.name }))).find((m) => m.name.toLowerCase() === target.name.toLowerCase()) : undefined;
  // the measure being edited disappeared (undo, delete elsewhere): start a new one
  useEffect(() => {
    if (target.kind === "existing" && !stored) setTarget({ kind: "new" });
  }, [target, stored]);
  useEffect(() => {
    if (!table || !tables.some((t) => t.name === table)) setTable(tables[0]?.name ?? "");
  }, [tables, table]);

  // diagnostics follow the text (debounced) and the model
  const docs = useMemo(() => modelDocuments(project), [project]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      dax.check(docs, expr).then(
        (d) => {
          if (!alive) return;
          setDiags(d);
          setCheckFailure(null);
        },
        (e: unknown) => alive && setCheckFailure(`The expression could not be checked: ${e instanceof Error ? e.message : String(e)}`),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [dax, docs, expr]);

  const select = (t: Target) => {
    setTarget(t);
    setRun({ status: "idle" });
    onError(null);
    if (t.kind === "new") {
      setName("");
      setExpr("");
      return;
    }
    const m = tables.flatMap((x) => x.measures.map((y) => ({ ...y, table: x.name }))).find((y) => y.name === t.name);
    if (m) {
      setName(m.name);
      setTable(m.table);
      setExpr(m.expression);
    }
  };

  const errors = diags.filter((d) => d.severity === "error");
  const warnings = diags.filter((d) => d.severity === "warning");
  const blocked = expr.trim() === "" || errors.length > 0;
  const dirty = target.kind === "new" ? expr.trim() !== "" || name.trim() !== "" : stored !== undefined && stored.expression !== expr;

  const columns = tables.flatMap((t) => t.columns.map((c) => ({ key: `${t.name}${sep}${c.name}`, label: `${t.name}[${c.name}]` })));

  const evaluate = async () => {
    const seq = ++runSeq.current;
    setRun({ status: "running" });
    const home = target.kind === "existing" && stored ? stored.table : table;
    try {
      const total = await dax.query(docs, valueQuery(home, expr));
      let split: QueryResult | null = null;
      let elapsed = total.elapsedMs;
      if (by !== NO_BREAKDOWN) {
        const [bt, bc] = by.split(sep);
        const r = await dax.query(docs, byColumnQuery(home, expr, bt, bc));
        split = r.results[0] ?? null;
        elapsed += r.elapsedMs;
      }
      if (seq !== runSeq.current) return;
      setRun({ status: "done", value: total.results[0], by: split, elapsedMs: elapsed, text: expr });
    } catch (e) {
      if (seq !== runSeq.current) return;
      setRun({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async () => {
    const r =
      target.kind === "new"
        ? await registry.execute("model.addMeasure", { table, name: name.trim(), expression: expr })
        : await registry.execute("model.setMeasureExpression", { name: target.name, expression: expr });
    onError(r.ok ? null : r.message);
    if (r.ok && target.kind === "new") setTarget({ kind: "existing", name: name.trim() });
  };

  const remove = async () => {
    if (target.kind !== "existing") return;
    const r = await registry.execute("model.deleteMeasure", { name: target.name });
    onError(r.ok ? null : r.message);
    if (r.ok) select({ kind: "new" });
  };

  const allMeasures = tables.flatMap((t) => t.measures.map((m) => ({ ...m, table: t.name })));
  const canSave = !blocked && (target.kind === "existing" ? stored !== undefined && dirty : name.trim() !== "" && table !== "");
  const valueCell = run.status === "done" ? run.value.rows[0]?.[0] : undefined;

  return (
    <div style={{ display: "flex", height: "100%" }} aria-label="Measure editor">
      <div style={{ width: 220, borderRight: "1px solid #ddd", padding: 8, display: "flex", flexDirection: "column", gap: 6, overflow: "auto", flex: "none" }}>
        <strong>Measures</strong>
        <Button size="small" appearance={target.kind === "new" ? "primary" : "secondary"} onClick={() => select({ kind: "new" })}>
          New measure
        </Button>
        {allMeasures.length === 0 && <Text size={200}>No measures yet.</Text>}
        {allMeasures.map((m) => (
          <Button
            key={m.name}
            size="small"
            appearance={target.kind === "existing" && target.name === m.name ? "primary" : "subtle"}
            style={{ justifyContent: "flex-start" }}
            onClick={() => select({ kind: "existing", name: m.name })}
            title={`${m.table}[${m.name}]`}
          >
            {m.name}
          </Button>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, padding: 8, display: "flex", flexDirection: "column", gap: 8, overflow: "auto" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Input size="small" aria-label="Measure name" placeholder="Measure name" value={name} disabled={target.kind === "existing"} onChange={(_, d) => setName(d.value)} />
          <Select size="small" aria-label="Home table" value={target.kind === "existing" && stored ? stored.table : table} disabled={target.kind === "existing" || tables.length === 0} onChange={(_, d) => setTable(d.value)}>
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </Select>
          <Text size={200}>{target.kind === "existing" ? (dirty ? "Edited, not saved" : "Saved") : "New, not saved"}</Text>
        </div>

        <DaxEditor
          value={expr}
          onChange={setExpr}
          context={buildContext(catalog, project)}
          markers={diags.map((d) => ({ severity: d.severity, message: d.message, start: d.start, end: d.end }))}
          ariaLabel="DAX expression"
          factory={factory}
        />

        <div aria-label="Problems" style={{ fontSize: 12 }}>
          {checkFailure && (
            <MessageBar intent="error">
              <MessageBarBody>{checkFailure}</MessageBarBody>
            </MessageBar>
          )}
          {!checkFailure && expr.trim() !== "" && diags.length === 0 && <span style={{ color: "#107c10" }}>No problems found.</span>}
          {diags.map((d, i) => (
            <div key={i} style={{ color: d.severity === "error" ? "#a4262c" : "#8a6d00" }}>
              {d.severity === "error" ? "Error" : "Warning"}: {d.message}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button size="small" appearance="primary" disabled={blocked || run.status === "running" || (target.kind === "new" && table === "")} onClick={() => void evaluate()}>
            Evaluate
          </Button>
          <Button
            size="small"
            disabled={expr.trim() === ""}
            onClick={() => {
              try {
                setExpr(formatDax(expr));
                setCheckFailure(null);
              } catch (e) {
                setCheckFailure(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Format
          </Button>
          <Select size="small" aria-label="Show by" value={by} onChange={(_, d) => setBy(d.value)}>
            <option value={NO_BREAKDOWN}>Total only</option>
            {columns.map((c) => (
              <option key={c.key} value={c.key}>
                By {c.label}
              </option>
            ))}
          </Select>
          <Button size="small" disabled={!canSave} onClick={() => void save()}>
            {target.kind === "new" ? "Add measure" : "Save changes"}
          </Button>
          {target.kind === "existing" && (
            <Button size="small" onClick={() => void remove()}>
              Delete
            </Button>
          )}
          {warnings.length > 0 && <Text size={200}>Functions marked "not implemented" cannot be evaluated yet.</Text>}
        </div>

        <div aria-label="Result" aria-live="polite">
          {run.status === "running" && <Text>Evaluating…</Text>}
          {run.status === "error" && (
            <MessageBar intent="error">
              <MessageBarBody>{run.message}</MessageBarBody>
            </MessageBar>
          )}
          {run.status === "done" && (
            <div style={{ display: "grid", gap: 8 }}>
              <div>
                <Text size={200}>Value{run.text !== expr ? " (of the text before your last edit)" : ""}</Text>
                <div data-testid="measure-value" style={{ fontSize: 28, fontWeight: 600, color: valueCell?.t === "blank" ? "#8a8886" : undefined }}>
                  {valueCell ? (valueCell.t === "blank" ? "(Blank)" : valueCell.v) : "(no value)"}
                </div>
                <Text size={200}>{run.elapsedMs} ms</Text>
              </div>
              {run.by && <ResultGrid result={run.by} label="Measure by column" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
