import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from "@fluentui/react-components";
import type { RowPage } from "../../core/data/types";
import { typeLabelOf, valueTypeOf } from "../../core/queries/dialogs";
import { formatCell } from "../format";
import { distributionBars, distributionLabel, qualityLabel, qualityOf } from "../../core/queries/profileText";
import type { ColumnProfile, StepColumn } from "../../core/queries/types";

export interface HeaderMenuEntry {
  id: string;
  label: string;
  enabled: boolean;
  reason?: string;
}

export interface PreviewGridProps {
  page: RowPage;
  columns: StepColumn[];
  selected: string[];
  onSelect(column: string, mode: "single" | "toggle" | "range"): void;
  menu(column: string): HeaderMenuEntry[];
  onMenu(id: string, column: string): void;
  /** Column profiles (View > Column quality / distribution); a bar under each header when one is on. */
  profiles?: Record<string, ColumnProfile>;
  showQuality?: boolean;
  showDistribution?: boolean;
  /** Options > Power Query Editor: monospace font and visible whitespace. */
  monospace?: boolean;
  showWhitespace?: boolean;
}

const GLYPH: Record<string, string> = { number: "123", text: "ABC", date: "📅", logical: "T/F" };

/** Read-only preview of the first rows of a step. Clicking a header selects the column (Ctrl toggles, Shift selects a range). */
/** Makes spaces and tabs visible: a space becomes a middle dot, a tab an arrow. */
export const visibleWhitespace = (s: string): string => s.replace(/ /g, "\u00b7").replace(/\t/g, "\u2192");

export function PreviewGrid({ page, columns, selected, onSelect, menu, onMenu, profiles, showQuality, showDistribution, monospace, showWhitespace }: PreviewGridProps) {
  const typeOf = (i: number) => columns[i]?.duckdbType ?? page.columns[i].duckdbType;
  const errors = new Set((page.errorCells ?? []).map(([r, c]) => `${r},${c}`));
  return (
    <div style={{ overflow: "auto", flex: 1, minHeight: 0, border: "1px solid #e1dfdd", background: "#fff" }}>
      <table aria-label="Data preview" data-monospace={monospace ? "true" : undefined} style={{ borderCollapse: "collapse", fontSize: 13, minWidth: "100%", ...(monospace ? { fontFamily: "Consolas, 'Cascadia Mono', monospace" } : {}) }}>
        <thead>
          <tr>
            <th style={{ position: "sticky", top: 0, background: "#f3f2f1", width: 40, borderBottom: "1px solid #c8c6c4" }} />
            {page.columns.map((c, i) => {
              const isSel = selected.includes(c.name);
              const vt = valueTypeOf(typeOf(i));
              return (
                <th
                  key={c.name}
                  scope="col"
                  aria-selected={isSel}
                  title={`${c.name} — ${typeLabelOf(typeOf(i))}`}
                  onClick={(e) => onSelect(c.name, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "single")}
                  style={{
                    position: "sticky",
                    top: 0,
                    background: isSel ? "#cfe4f5" : "#f3f2f1",
                    textAlign: "left",
                    padding: "4px 8px",
                    borderBottom: "1px solid #c8c6c4",
                    borderRight: "1px solid #e1dfdd",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  <span aria-hidden style={{ color: "#605e5c", fontSize: 10, marginRight: 4 }}>
                    {GLYPH[vt]}
                  </span>
                  {c.name}
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <button
                        type="button"
                        aria-label={`Menu for ${c.name}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{ border: "none", background: "transparent", cursor: "pointer", marginLeft: 6, color: "#605e5c" }}
                      >
                        ▾
                      </button>
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        {menu(c.name).map((m) => (
                          <MenuItem key={m.id} disabled={!m.enabled} title={m.enabled ? m.label : `${m.label} — ${m.reason ?? ""}`} onClick={() => onMenu(m.id, c.name)}>
                            {m.label}
                          </MenuItem>
                        ))}
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                  {showQuality && profiles?.[c.name] && <QualityBar p={profiles[c.name]} />}
                  {showDistribution && profiles?.[c.name] && <MiniDistribution p={profiles[c.name]} />}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {page.rows.map((r, ri) => (
            <tr key={ri} style={{ background: ri % 2 ? "#faf9f8" : undefined }}>
              <td style={{ color: "#8a8886", textAlign: "right", padding: "2px 6px", borderRight: "1px solid #e1dfdd" }}>{ri + 1}</td>
              {r.map((cell, ci) => {
                const num = valueTypeOf(typeOf(ci)) === "number";
                if (errors.has(`${ri},${ci}`)) {
                  return (
                    <td key={ci} data-error="true" title="This value could not be converted to the column's data type" style={{ padding: "2px 8px", textAlign: "left", borderRight: "1px solid #f3f2f1", color: "#a4262c", background: "#fde7e9", whiteSpace: "nowrap" }}>
                      Error
                    </td>
                  );
                }
                return (
                  <td key={ci} style={{ padding: "2px 8px", textAlign: num ? "right" : "left", borderRight: "1px solid #f3f2f1", color: cell === null ? "#8a8886" : undefined, whiteSpace: "nowrap" }}>
                    {cell === null ? "null" : showWhitespace ? visibleWhitespace(formatCell(cell, page.columns[ci].biType)) : formatCell(cell, page.columns[ci].biType)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Valid (green), error (red) and empty (grey) shares of a column, as a bar with the percentages under it. */
function QualityBar({ p }: { p: ColumnProfile }) {
  const q = qualityOf(p);
  return (
    <div aria-label={`Quality of ${p.name}: ${qualityLabel(p)}`} title={qualityLabel(p)} style={{ marginTop: 3, fontWeight: 400, fontSize: 10 }}>
      <div style={{ display: "flex", height: 5, background: "#e1dfdd" }}>
        <span style={{ width: `${q.validWidth}%`, background: "#107c10" }} />
        <span style={{ width: `${q.errorWidth}%`, background: "#a4262c" }} />
        <span style={{ width: `${q.emptyWidth}%`, background: "#8a8886" }} />
      </div>
      <div>{qualityLabel(p).replace(/, /g, " \u00b7 ")}</div>
    </div>
  );
}

/** The most frequent values as small bars, and the number of distinct and unique values. */
function MiniDistribution({ p }: { p: ColumnProfile }) {
  const bars = distributionBars(p).slice(0, 12);
  return (
    <div aria-label={`Distribution of ${p.name}: ${distributionLabel(p)}`} title={distributionLabel(p)} style={{ marginTop: 3, fontWeight: 400, fontSize: 10 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 22 }}>
        {bars.map((b) => (
          <span key={b.label} title={`${b.label}: ${b.count}`} style={{ flex: 1, minWidth: 3, maxWidth: 14, height: `${Math.max(8, b.width * 100)}%`, background: "#0f6cbd" }} />
        ))}
      </div>
      <div>{distributionLabel(p)}</div>
    </div>
  );
}
