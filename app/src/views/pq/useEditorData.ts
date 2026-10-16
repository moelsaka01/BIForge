import { useEffect, useState } from "react";
import type { RowPage } from "../../core/data/types";
import type { DraftSnapshot } from "../../core/queries/draft";
import type { MApi, ParsedStep, StepColumn, StepResult } from "../../core/queries/types";

export interface StepView {
  name: string;
  expr: string;
  function: string | null;
  error: string | null;
  kind: string;
  columns: StepColumn[];
}

export interface EditorData {
  steps: StepView[];
  /** The query text is not a let ... in expression, or does not parse. */
  parseError: string | null;
  /** The step the preview shows. */
  active: string | null;
  columns: StepColumn[];
  page: RowPage | null;
  previewError: string | null;
  loading: boolean;
  output: string;
}

const empty: EditorData = { steps: [], parseError: null, active: null, columns: [], page: null, previewError: null, loading: false, output: "" };

const PREVIEW_ROWS = 1000;

/** Loads the steps (with their columns and errors) and the preview of the selected step of the selected query. */
export function useEditorData(m: MApi, snap: DraftSnapshot, texts: Record<string, string>, reloadKey: number): EditorData {
  const [data, setData] = useState<EditorData>(empty);
  const text = snap.selected ? texts[snap.selected] : undefined;

  useEffect(() => {
    let live = true;
    if (!snap.selected || text === undefined) {
      setData(empty);
      return;
    }
    setData((d) => ({ ...d, loading: true }));
    (async () => {
      let parsed: { steps: ParsedStep[]; output: string } | null = null;
      let parseError: string | null = null;
      try {
        parsed = await m.parseQuery(text);
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e);
      }
      let results: StepResult[] = [];
      try {
        results = await m.analyze(texts, snap.selected!);
      } catch (e) {
        if (!parseError) parseError = e instanceof Error ? e.message : String(e);
      }
      const byName = new Map(results.map((r) => [r.name, r]));
      const steps: StepView[] = (parsed?.steps ?? []).map((s) => {
        const r = byName.get(s.name);
        return { name: s.name, expr: s.expr, function: s.function, error: r?.error ? r.error.message : null, kind: r?.kind ?? "table", columns: r?.columns ?? [] };
      });
      const outputStep = parsed ? steps.find((s) => s.name === parsed!.output || s.name === parsed!.output.replace(/^#"|"$/g, "")) : undefined;
      const active = snap.step ?? outputStep?.name ?? steps[steps.length - 1]?.name ?? null;
      const cur = steps.find((s) => s.name === active);
      let page: RowPage | null = null;
      let previewError: string | null = null;
      if (cur?.error) previewError = cur.error;
      else if (cur && cur.kind !== "table") previewError = `This step returns ${cur.kind === "error" ? "an error" : `a ${cur.kind}`}, not a table.`;
      else {
        try {
          page = await m.preview(texts, snap.selected!, snap.step, PREVIEW_ROWS);
        } catch (e) {
          previewError = e instanceof Error ? e.message : String(e);
        }
      }
      if (!live) return;
      setData({ steps, parseError, active, columns: cur?.columns ?? page?.columns.map((c) => ({ name: c.name, duckdbType: c.duckdbType })) ?? [], page, previewError, loading: false, output: parsed?.output ?? "" });
    })();
    return () => {
      live = false;
    };
    // texts changes whenever the draft version changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, snap.selected, snap.step, snap.version, text, reloadKey]);

  return data;
}
