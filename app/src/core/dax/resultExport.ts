// A query result as text: CSV for a file, tab-separated for the clipboard (it pastes into a spreadsheet). Pure.
import type { QueryResult } from "./types";

const csvCell = (t: string) => (/[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
const shown = (c: { t: string; v: string }) => (c.t === "blank" ? "" : c.v);

export function resultToCsv(r: QueryResult): string {
  return [r.columns.map(csvCell).join(","), ...r.rows.map((row) => row.map((c) => csvCell(shown(c))).join(","))].join("\r\n") + "\r\n";
}

export function resultToTsv(r: QueryResult): string {
  const clean = (t: string) => t.replace(/[\t\r\n]+/g, " ");
  return [r.columns.map(clean).join("\t"), ...r.rows.map((row) => row.map((c) => clean(shown(c))).join("\t"))].join("\n");
}

/** The text of a query file when the person saves a tab: the tab name makes the file name. */
export const daxFileName = (tabName: string): string => `${tabName.replace(/[\\/:*?"<>|]+/g, "_").trim() || "Query"}.dax`;
