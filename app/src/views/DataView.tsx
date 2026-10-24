import { useEffect, useMemo, useRef, useState } from "react";
import type { BiType, EngineApi, SortSpec, TableInfo } from "../core/data/types";
import { visibleRange } from "./gridMath";
import { PageCache } from "./pageCache";
import { formatCell } from "./format";

export const ROW_HEIGHT = 28;
const COL_WIDTH = 170;

/** Header and body cells share this box (same width, border-box sizing, padding and border), so columns line up exactly. */
const cellBox = (numeric: boolean, width = COL_WIDTH): React.CSSProperties => ({
  width,
  flex: "none",
  boxSizing: "border-box",
  padding: "0 8px",
  borderRight: "1px solid transparent",
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
  textAlign: numeric ? "right" : "left",
});
const FALLBACK_VIEWPORT = 480;
const MIN_COL_WIDTH = 50;
const COPY_ROW_LIMIT = 100_000;

/** Tab-separated text of a table (the format Excel and Power BI paste); a cell with a tab, quote or line break is quoted. */
export function toTsv(header: string[], rows: (string | null)[][]): string {
  const cell = (v: string | null) => (v === null ? "" : /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header, ...rows].map((r) => r.map((v) => cell(v)).join("\t")).join("\r\n");
}

const TYPE_LABEL: Record<BiType, string> = {
  int64: "Whole number",
  double: "Decimal number",
  decimal: "Fixed decimal",
  boolean: "True/False",
  dateTime: "Date/time",
  string: "Text",
  binary: "Binary",
};

const isNumeric = (t: BiType) => t === "int64" || t === "double" || t === "decimal";

export interface DataViewProps {
  engine: EngineApi;
  table: string | null;
  /** Changes whenever the table's data was refreshed, so the grid reloads. */
  reloadKey: number;
  /** The model language: dates are written the way this culture writes them. Without it they show as the engine sends them. */
  culture?: string;
}

/** Virtualized, read-only data grid. Rows are fetched from the engine page by page; only visible rows are rendered. */
export function DataView({ engine, table, reloadKey, culture }: DataViewProps) {
  const [info, setInfo] = useState<TableInfo | null | undefined>(undefined);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [, setTick] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSort(null);
    setScrollTop(0);
    setWidths({});
    setCopied(null);
  }, [table]);

  useEffect(() => {
    let live = true;
    setInfo(undefined);
    if (!table) return;
    engine
      .tableInfo(table)
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [engine, table, reloadKey]);

  const cache = useMemo(() => (table && info ? new PageCache(engine, table, sort) : null), [engine, table, info, sort]);
  useEffect(() => {
    const off = cache?.subscribe(() => setTick((t) => t + 1));
    return () => void off?.();
  }, [cache]);

  const total = info?.rowCount ?? 0;
  const viewport = box.current?.clientHeight || FALLBACK_VIEWPORT;
  const range = visibleRange(scrollTop, viewport, ROW_HEIGHT, total);
  useEffect(() => {
    cache?.ensure(range.first, range.end);
  });

  if (!table) return <Notice>Select a table in the Data pane to see its rows.</Notice>;
  if (info === undefined) return <Notice>Loading…</Notice>;
  if (info === null) {
    return <Notice>No data is loaded for "{table}". Use Refresh to load it from its source.</Notice>;
  }

  const toggleSort = (column: string) =>
    setSort((s) => (s?.column !== column ? { column, descending: false } : !s.descending ? { column, descending: true } : null));

  const rows: number[] = [];
  for (let i = range.first; i < range.end; i++) rows.push(i);
  const widthOf = (name: string) => widths[name] ?? COL_WIDTH;
  const width = info.columns.reduce((sum, c) => sum + widthOf(c.name), 0);

  /** Drag the right edge of a header to resize its column. */
  const startResize = (name: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widthOf(name);
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [name]: Math.max(MIN_COL_WIDTH, w0 + ev.clientX - x0) }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Copy table: the header and every row (up to a limit) in the current sort order, as tab-separated text. */
  const copyTable = async () => {
    try {
      const rowsOut: (string | null)[][] = [];
      const limit = Math.min(info.rowCount, COPY_ROW_LIMIT);
      while (rowsOut.length < limit) {
        const page = await engine.fetchPage(info.name, rowsOut.length, Math.min(1000, limit - rowsOut.length), sort);
        if (page.rows.length === 0) break;
        rowsOut.push(...page.rows);
      }
      await navigator.clipboard.writeText(toTsv(info.columns.map((c) => c.name), rowsOut));
      setCopied(`Copied ${rowsOut.length.toLocaleString()} rows${info.rowCount > limit ? ` of ${info.rowCount.toLocaleString()}` : ""}`);
    } catch (e) {
      setCopied(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ fontSize: 12, padding: "4px 8px" }} data-testid="data-status">
        {info.name} — {info.rowCount.toLocaleString()} rows, {info.columns.length} columns
        {sort ? ` — sorted by ${sort.column} ${sort.descending ? "descending" : "ascending"}` : ""}
        {cache?.error ? ` — error: ${cache.error}` : ""}
        <button type="button" onClick={() => void copyTable()} style={{ marginLeft: 12, font: "inherit" }}>
          Copy table
        </button>
        {copied ? <span role="status" style={{ marginLeft: 8 }}>{copied}</span> : null}
      </div>
      <div
        ref={box}
        data-testid="grid-scroll"
        role="grid"
        aria-rowcount={total + 1}
        style={{ flex: 1, overflow: "auto", position: "relative", minHeight: 0 }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div role="row" style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", width, background: "var(--colorNeutralBackground3, #f3f3f3)" }}>
          {info.columns.map((c) => {
            const active = sort?.column === c.name;
            return (
              <div key={c.name} style={{ position: "relative", flex: "none", display: "flex" }}>
              <button
                role="columnheader"
                aria-sort={active ? (sort!.descending ? "descending" : "ascending") : "none"}
                onClick={() => toggleSort(c.name)}
                title={`${c.name} — ${TYPE_LABEL[c.biType]} (${c.duckdbType}). Click to sort.`}
                style={{
                  font: "inherit",
                  ...cellBox(isNumeric(c.biType), widthOf(c.name)),
                  height: ROW_HEIGHT + 8,
                  borderTop: 0,
                  borderBottom: 0,
                  borderLeft: 0,
                  background: "transparent",
                  cursor: "pointer",
                  paddingTop: 2,
                  paddingBottom: 2,
                  fontWeight: 600,
                  lineHeight: 1.1,
                }}
              >
                {c.name}
                {active ? (sort!.descending ? " ▼" : " ▲") : ""}
                <div style={{ fontWeight: 400, fontSize: 10, opacity: 0.7 }}>{TYPE_LABEL[c.biType]}</div>
              </button>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${c.name}`}
                onPointerDown={(e) => startResize(c.name, e)}
                style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize" }}
              />
              </div>
            );
          })}
        </div>
        <div style={{ position: "relative", height: total * ROW_HEIGHT, width }}>
          {rows.map((i) => {
            const row = cache?.row(i);
            return (
              <div
                key={i}
                role="row"
                aria-rowindex={i + 2}
                data-row={i}
                style={{ position: "absolute", top: i * ROW_HEIGHT, height: ROW_HEIGHT, display: "flex", width, borderBottom: "1px solid #eee" }}
              >
                {info.columns.map((c, j) => (
                  <div
                    key={c.name}
                    role="gridcell"
                    style={{ ...cellBox(isNumeric(c.biType), widthOf(c.name)), lineHeight: `${ROW_HEIGHT}px` }}
                  >
                    {row ? formatCell(row[j], c.biType, culture) : "…"}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 16 }}>{children}</div>;
}
