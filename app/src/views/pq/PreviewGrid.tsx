import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from "@fluentui/react-components";
import type { RowPage } from "../../core/data/types";
import { typeLabelOf, valueTypeOf } from "../../core/queries/dialogs";
import { formatCell } from "../format";
import type { StepColumn } from "../../core/queries/types";

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
}

const GLYPH: Record<string, string> = { number: "123", text: "ABC", date: "📅", logical: "T/F" };

/** Read-only preview of the first rows of a step. Clicking a header selects the column (Ctrl toggles, Shift selects a range). */
export function PreviewGrid({ page, columns, selected, onSelect, menu, onMenu }: PreviewGridProps) {
  const typeOf = (i: number) => columns[i]?.duckdbType ?? page.columns[i].duckdbType;
  return (
    <div style={{ overflow: "auto", flex: 1, minHeight: 0, border: "1px solid #e1dfdd", background: "#fff" }}>
      <table aria-label="Data preview" style={{ borderCollapse: "collapse", fontSize: 13, minWidth: "100%" }}>
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
                return (
                  <td key={ci} style={{ padding: "2px 8px", textAlign: num ? "right" : "left", borderRight: "1px solid #f3f2f1", color: cell === null ? "#8a8886" : undefined, whiteSpace: "nowrap" }}>
                    {cell === null ? "null" : formatCell(cell, page.columns[ci].biType)}
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
