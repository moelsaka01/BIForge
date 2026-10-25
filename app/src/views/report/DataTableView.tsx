import type { Loaded } from "../../core/report/dataLoader";
import { displayValue } from "../../core/report/tableModels";

/** "See data": the rows a visual was drawn from, as a plain table (the header's table button). */
export function DataTableView({ loaded, width, height }: { loaded: Extract<Loaded, { kind: "grouped" }>; width: number; height: number }) {
  const cols = loaded.query.columns.filter((c) => c.kind !== "helper").sort((a, b) => a.index - b.index);
  return (
    <div role="region" aria-label="Data of the visual" data-testid="visual-data" style={{ width, height, overflow: "auto", fontSize: 12 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.index} style={{ position: "sticky", top: 0, textAlign: c.kind === "value" ? "right" : "left", padding: "2px 8px", background: "#f3f2f1", color: "#222", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loaded.rows.map((row, r) => (
            <tr key={r}>
              {cols.map((c) => (
                <td key={c.index} style={{ textAlign: c.kind === "value" ? "right" : "left", padding: "2px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                  {displayValue(row[c.index], c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
