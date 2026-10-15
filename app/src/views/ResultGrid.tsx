import type { QueryResult } from "../core/dax/types";

const NUMERIC = new Set(["int", "real", "currency"]);

/** A small read-only table for query results (at most `maxRows` shown; the total is stated). */
export function ResultGrid({ result, maxRows = 200, label }: { result: QueryResult; maxRows?: number; label: string }) {
  const shown = result.rows.slice(0, maxRows);
  const cut = result.totalRows > shown.length;
  return (
    <div>
      <div style={{ overflow: "auto", maxHeight: 260, border: "1px solid #e1dfdd" }}>
        <table aria-label={label} style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th key={i} style={{ position: "sticky", top: 0, background: "#f3f2f1", textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #c8c6c4" }}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} style={{ padding: "2px 8px", textAlign: NUMERIC.has(c.t) ? "right" : "left", color: c.t === "blank" ? "#8a8886" : undefined }}>
                    {c.t === "blank" ? "(Blank)" : c.v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: "#605e5c" }}>
        {result.totalRows.toLocaleString("en-US")} {result.totalRows === 1 ? "row" : "rows"}
        {cut ? ` (showing the first ${shown.length.toLocaleString("en-US")})` : ""}
        {result.truncated ? " — the engine returned only the first rows" : ""}
      </div>
    </div>
  );
}
