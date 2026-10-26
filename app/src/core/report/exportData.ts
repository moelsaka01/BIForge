// Export data: the rows a visual was drawn from (its summarized data) as CSV. Pure.
import type { Loaded } from "./dataLoader";
import { labelOf } from "./chartData";

const csvCell = (t: string) => (/[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

/** The CSV text of the visual's data, or null when the visual has no table of rows (a matrix, a slicer, a text box). */
export function loadedToCsv(loaded: Loaded): string | null {
  if (loaded.kind !== "grouped") return null;
  const cols = loaded.query.columns.filter((c) => c.kind !== "helper").sort((a, b) => a.index - b.index);
  const lines = [cols.map((c) => csvCell(c.label)).join(",")];
  for (const row of loaded.rows) {
    lines.push(
      cols
        .map((c) => {
          const v = row[c.index];
          if (!v || v.kind === "blank") return "";
          // numbers are written as numbers (not as formatted text), dates and text as shown
          return csvCell(v.num !== null && v.kind !== "datetime" ? String(v.num) : labelOf(v, c.format));
        })
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** A file name for the data of a visual: its title or kind, without characters Windows does not allow. */
export const exportFileName = (title: string, ext: string): string => `${title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "data"}.${ext}`;
