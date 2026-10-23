import { useMemo, useState } from "react";
import { Button, Input, MessageBar, MessageBarBody } from "@fluentui/react-components";
import type { RowPage } from "../../core/data/types";
import { valueTypeOf } from "../../core/queries/dialogs";
import { suggestFormula, type ExampleColumn } from "../../core/queries/examples";
import type { StepColumn } from "../../core/queries/types";

const SAMPLE_ROWS = 12;

export interface ExamplesDialogProps {
  page: RowPage;
  columns: StepColumn[];
  onDone(name: string, formula: string): Promise<string | null>;
  onCancel(): void;
}

/** Column From Examples: type the wanted value in a few rows; the formula that gives them is suggested and previewed. */
export function ExamplesDialog({ page, columns, onDone, onCancel }: ExamplesDialogProps) {
  const [examples, setExamples] = useState<Record<number, string>>({});
  const [name, setName] = useState("Custom");
  const [error, setError] = useState<string | null>(null);
  const cols: ExampleColumn[] = useMemo(
    () =>
      page.columns.map((c, i) => {
        const vt = valueTypeOf(columns[i]?.duckdbType ?? c.duckdbType);
        return { name: c.name, kind: vt === "text" ? "text" : vt === "number" ? "number" : vt === "date" && /^DATE$/i.test(columns[i]?.duckdbType ?? c.duckdbType) ? "date" : "other" };
      }),
    [page, columns],
  );
  const rows = page.rows.slice(0, 1000);
  const filled = useMemo(() => new Map(Object.entries(examples).filter(([, v]) => v !== "").map(([k, v]) => [Number(k), v])), [examples]);
  const suggestion = useMemo(() => suggestFormula(cols, rows, filled), [cols, rows, filled]);
  return (
    <div role="dialog" aria-label="Column From Examples" style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", width: "min(900px, 94vw)", maxHeight: "86vh", display: "flex", flexDirection: "column", padding: 14, gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Column From Examples</div>
        <div style={{ fontSize: 12, color: "#605e5c" }}>Type the value you want in one or more rows. BIForge looks for a formula over the columns that gives exactly those values.</div>
        <div style={{ overflow: "auto", border: "1px solid #e1dfdd", flex: 1 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                {page.columns.map((c) => (
                  <th key={c.name} style={{ textAlign: "left", padding: "3px 8px", background: "#f3f2f1", position: "sticky", top: 0 }}>
                    {c.name}
                  </th>
                ))}
                <th style={{ padding: "3px 8px", background: "#e6f2fb", position: "sticky", top: 0 }}>Example</th>
                <th style={{ padding: "3px 8px", background: "#e6f2fb", position: "sticky", top: 0 }}>Suggested</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, SAMPLE_ROWS).map((r, ri) => (
                <tr key={ri}>
                  {r.map((cell, ci) => (
                    <td key={ci} style={{ padding: "2px 8px", whiteSpace: "nowrap", color: cell === null ? "#8a8886" : undefined }}>
                      {cell === null ? "null" : cell}
                    </td>
                  ))}
                  <td style={{ padding: 2 }}>
                    <Input size="small" aria-label={`Example for row ${ri + 1}`} value={examples[ri] ?? ""} onChange={(_, d) => setExamples((x) => ({ ...x, [ri]: d.value }))} />
                  </td>
                  <td data-testid={`suggested-${ri}`} style={{ padding: "2px 8px", color: "#605e5c", whiteSpace: "nowrap" }}>
                    {suggestion ? (suggestion.values[ri] ?? "null") : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div data-testid="suggested-formula" style={{ fontFamily: "Consolas, monospace", fontSize: 13, minHeight: 20 }}>
          {filled.size === 0 ? "" : suggestion ? `= ${suggestion.formula}` : "No formula in BIForge's search fits these examples. Add or correct an example, or use Custom Column."}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Input aria-label="New column name" value={name} onChange={(_, d) => setName(d.value)} />
          <span style={{ flex: 1 }} />
          <Button
            appearance="primary"
            disabled={!suggestion || !name.trim()}
            onClick={async () => {
              const err = await onDone(name.trim(), suggestion!.formula);
              setError(err);
            }}
          >
            OK
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
      </div>
    </div>
  );
}
