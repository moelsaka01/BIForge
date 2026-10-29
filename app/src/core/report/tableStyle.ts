// The look of tables and matrices from their formatting objects: grid, column headers, row headers, values (with
// alternating row colors), totals and subtotals. Pure; the views apply the CSS this returns.
import type { CSSProperties } from "react";
import { cssFont, mergeFonts, readFont } from "../format/styles";
import type { FormatReader } from "./formatReader";
import type { Theme } from "./theme";

export interface TableStyle {
  rowHeight: number;
  headHeight: number;
  header: CSSProperties;
  /** Text alignment override for headers (columnHeaders.alignment), or null for "by data type". */
  headerAlign: CSSProperties["textAlign"] | null;
  rowHeaderCell: CSSProperties;
  /** Style of a body cell of the given 0-based row (alternating colors). */
  cell(row: number): CSSProperties;
  total: CSSProperties;
  totalLabel: string;
  rowTotal: CSSProperties;
  columnTotal: CSSProperties;
  subtotal: CSSProperties;
  /** Column widths: "fit" columns share the width, "fixed" use defaultColumnWidth. */
  columnWidth: string;
  /** Show subtotals of matrix rows / columns. */
  rowSubtotals: boolean;
  columnSubtotals: boolean;
  rowSubtotalLabel: string;
  columnSubtotalLabel: string;
  subtotalsOnTop: boolean;
}

const ALIGN: Record<string, CSSProperties["textAlign"] | null> = { Auto: null, Left: "left", Center: "center", Right: "right" };
const LINE: Record<number, string> = { 0: "none", 1: "solid", 2: "dashed", 3: "dotted" };

function outline(f: FormatReader, object: string): string | undefined {
  const w = f.num(object, "outlineWeight", 0);
  if (!w) return undefined;
  return `${w}px ${LINE[f.num(object, "outlineStyle", 1)] ?? "solid"} ${f.color(object, "outlineColor") ?? "#888888"}`;
}

export function tableStyle(f: FormatReader, theme: Theme): TableStyle {
  const label = theme.textClasses.label;
  const base = { family: label.fontFace, size: f.has("grid", "textSize") ? f.num("grid", "textSize", label.fontSize + 2) : label.fontSize + 2, color: theme.foreground };
  const pad = Math.max(0, f.num("grid", "rowPadding", 0));
  const rowHeight = 24 + pad * 2;
  const headHeight = 28 + pad * 2;

  const gridH = f.bool("grid", "gridHorizontal", true) ? `${f.num("grid", "gridHorizontalWeight", 1)}px solid ${f.color("grid", "gridHorizontalColor") ?? (theme.dark ? "#333333" : "#eeeeee")}` : undefined;
  const gridV = f.bool("grid", "gridVertical", false) ? `${f.num("grid", "gridVerticalWeight", 1)}px solid ${f.color("grid", "gridVerticalColor") ?? (theme.dark ? "#333333" : "#eeeeee")}` : undefined;

  const valuesFont = readFont(f, "values");
  const headFont = readFont(f, "columnHeaders");
  const rowHeadFont = mergeFonts(valuesFont, readFont(f, "rowHeaders"));
  const totalFont = readFont(f, "total");
  // "total" is the grand total in general; the row and column grand totals refine it
  const rowTotalFont = mergeFonts(totalFont, readFont(f, "rowTotal"));
  const colTotalFont = mergeFonts(totalFont, readFont(f, "columnTotal"));
  const subFont = readFont(f, "subTotals");

  const wrap = (object: string, dflt = false): CSSProperties => (f.bool(object, "wordWrap", dflt) ? { whiteSpace: "normal", height: "auto", minHeight: rowHeight, lineHeight: 1.3 } : {});

  const cellBase = (fontObj: typeof valuesFont, object: string): CSSProperties => ({
    ...cssFont(fontObj, base),
    padding: "0 8px",
    boxSizing: "border-box",
    borderBottom: gridH,
    borderRight: gridV,
    outline: outline(f, object),
    ...wrap(object),
  });

  const primaryBg = f.color("values", "backColorPrimary") ?? f.color("values", "backColor");
  const secondaryBg = f.color("values", "backColorSecondary");
  const primaryFg = f.color("values", "fontColorPrimary") ?? valuesFont.color;
  const secondaryFg = f.color("values", "fontColorSecondary");

  const header: CSSProperties = {
    ...cellBase(headFont, "columnHeaders"),
    fontWeight: headFont.bold ? 700 : 600,
    background: f.color("columnHeaders", "backColor") ?? (theme.dark ? "#2b2b2b" : "#f3f2f1"),
    borderBottom: gridH ?? `1px solid ${theme.dark ? "#444" : "#ddd"}`,
  };
  const totalBg = f.color("total", "backColor");

  const width = f.bool("columnHeaders", "customColumnWidth", false) || f.str("columnHeaders", "columnAdjustment", "growToFit") === "fixedWidth" ? `${Math.max(40, f.num("columnHeaders", "defaultColumnWidth", 120))}px` : "minmax(90px, 1fr)";

  return {
    rowHeight,
    headHeight,
    header,
    headerAlign: ALIGN[f.str("columnHeaders", "alignment", "Auto")] ?? null,
    rowHeaderCell: { ...cellBase(rowHeadFont, "rowHeaders"), background: f.color("rowHeaders", "backColor") },
    cell: (row) => {
      const alt = row % 2 === 1 && secondaryBg !== undefined;
      const bg = alt ? secondaryBg : primaryBg;
      const fg = alt ? (secondaryFg ?? primaryFg) : primaryFg;
      return { ...cellBase(valuesFont, "values"), ...(bg ? { background: bg } : {}), ...(fg ? { color: fg } : {}) };
    },
    total: { ...cellBase(totalFont, "total"), fontWeight: totalFont.bold ? 700 : 600, ...(totalBg ? { background: totalBg } : {}), borderTop: `2px solid ${theme.dark ? "#555" : "#cccccc"}`, borderBottom: undefined },
    totalLabel: f.str("total", "label", "Total"),
    rowTotal: { ...cellBase(rowTotalFont, "rowTotal"), fontWeight: rowTotalFont.bold ? 700 : 600, background: f.color("rowTotal", "backColor") ?? totalBg },
    columnTotal: { ...cellBase(colTotalFont, "columnTotal"), fontWeight: colTotalFont.bold ? 700 : 600, background: f.color("columnTotal", "backColor") ?? totalBg },
    subtotal: { ...cellBase(subFont, "subTotals"), fontWeight: subFont.bold ? 700 : 600, background: f.color("subTotals", "backColor") },
    columnWidth: width,
    rowSubtotals: f.bool("subTotals", "rowSubtotals", true),
    columnSubtotals: f.bool("subTotals", "columnSubtotals", true),
    rowSubtotalLabel: f.str("subTotals", "rowSubtotalsLabel", "Total"),
    columnSubtotalLabel: f.str("subTotals", "columnSubtotalsLabel", "Total"),
    subtotalsOnTop: f.str("subTotals", "rowSubtotalsPosition", "Top") === "Top",
  };
}
