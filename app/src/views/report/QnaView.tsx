import { useMemo, useState } from "react";
import { Button, Input } from "@fluentui/react-components";
import { parseQuestion, QNA_EXAMPLES, type Answer } from "../../core/report/qna";
import { fieldToPbir } from "../../core/report/pbir";
import { writeFilters } from "../../core/report/filters";
import { qnaLook, savedQuestion } from "../../core/report/qnaLook";
import { parseVisual, projectionJson, type PageModel, type VisualModel } from "../../core/report/visualDoc";
import { useReport } from "./reportContext";

/** The visual that answers a question: built in memory, never saved in the report. */
export function answerVisual(answer: Answer, pageName: string, name: string, width: number, height: number): VisualModel {
  const queryState: Record<string, unknown> = {};
  for (const [role, fs] of Object.entries(answer.roles)) queryState[role] = { projections: fs.map((field) => projectionJson({ field })) };
  const json: Record<string, unknown> = {
    name,
    position: { x: 0, y: 0, z: 0, width, height },
    visual: {
      visualType: answer.type,
      query: { queryState, ...(answer.top ? { sortDefinition: { sort: [{ field: fieldToPbir(answer.top.by), direction: answer.top.dir === "top" ? "Descending" : "Ascending" }] } } : {}) },
    },
  };
  if (answer.top) writeFilters(json, [{ name: "qna", field: answer.roles.Category[0], cond: { kind: "topN", n: answer.top.n, dir: answer.top.dir, by: answer.top.by } }], []);
  return parseVisual(pageName, json)!;
}

/** Q&A: type a question, see the answer as a visual. The question is stored with the visual (qna.question). */
export function QnaView({ page, visual, width, height, render }: { page: PageModel; visual: VisualModel; width: number; height: number; render(v: VisualModel, w: number, h: number): React.ReactNode }) {
  const c = useReport();
  const saved = savedQuestion(visual);
  const [text, setText] = useState(saved);
  const parsed = useMemo(() => (saved.trim() ? parseQuestion(saved, c.model) : null), [saved, c.model]);
  const answer = parsed && parsed.ok ? parsed.answer : null;
  const headerH = 64;
  const vis = useMemo(() => (answer ? answerVisual(answer, page.name, `${visual.name}__answer`, width, Math.max(60, height - headerH)) : null), [answer, page.name, visual.name, width, height]);
  const look = qnaLook(visual, c.theme);
  const ask = (q: string) => c.dispatch("report.format.set", { page: page.name, visual: visual.name, object: "hiddenProperties", prop: "savedUtterance", value: q.trim() ? { t: "string", v: q.trim() } : null });
  return (
    <div data-testid="qna" style={{ width, height, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 4, padding: 6, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 4 }}>
        <Input size="small" style={{ flex: 1 }} input={{ style: look.input }} root={{ style: { background: look.input.background } }} aria-label="Ask a question about your data" placeholder="Ask a question about your data" value={text} onChange={(_, d) => setText(d.value)} onKeyDown={(e) => e.key === "Enter" && ask(text)} />
        <Button size="small" appearance="primary" style={look.commitBackground ? { background: look.commitBackground } : undefined} onClick={() => ask(text)}>
          Ask
        </Button>
      </div>
      <div style={{ fontSize: 11, minHeight: 16 }} aria-live="polite">
        {answer && (
          <span data-testid="qna-restated" style={look.restatement}>
            <span style={{ color: look.accepted }}>✓ </span>Showing: {answer.restated}
            {answer.assumed && (
              <span data-testid="qna-assumed" style={{ color: look.warning, marginLeft: 8 }}>
                {answer.assumed}
              </span>
            )}
          </span>
        )}
        {parsed && !parsed.ok && (
          <span role="alert" style={{ color: look.error }}>
            {parsed.message}
          </span>
        )}
        {!parsed && look.showSuggestions && (
          <span data-testid="qna-suggestions" style={look.suggestionHeader}>
            Try:{" "}
            {QNA_EXAMPLES.slice(0, 3).map((e) => (
              <button key={e} type="button" className="qna-suggestion" onMouseEnter={(ev) => look.hover && (ev.currentTarget.style.background = look.hover)} onMouseLeave={(ev) => (ev.currentTarget.style.background = String(look.suggestionCard.background ?? "transparent"))} onClick={() => (setText(e), ask(e))} style={{ border: "none", cursor: "pointer", padding: "1px 6px", marginRight: 6, borderRadius: 3, ...look.suggestionCard, background: look.suggestionCard.background ?? "transparent" }}>
                {e}
              </button>
            ))}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{vis && render(vis, width - 12, Math.max(60, height - headerH - 12))}</div>
    </div>
  );
}
