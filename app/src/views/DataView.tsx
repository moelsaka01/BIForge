import { useEffect, useMemo, useRef, useState } from "react";
import type { BiType, EngineApi, SortSpec, TableInfo } from "../core/data/types";
import { visibleRange } from "./gridMath";
import { PageCache } from "./pageCache";

export const ROW_HEIGHT = 28;
const COL_WIDTH = 170;
const FALLBACK_VIEWPORT = 480;

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
}

/** Virtualized, read-only data grid. Rows are fetched from the engine page by page; only visible rows are rendered. */
export function DataView({ engine, table, reloadKey }: DataViewProps) {
  const [info, setInfo] = useState<TableInfo | null | undefined>(undefined);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [, setTick] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSort(null);
    setScrollTop(0);
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
  const width = info.columns.length * COL_WIDTH;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ fontSize: 12, padding: "4px 8px" }} data-testid="data-status">
        {info.name} — {info.rowCount.toLocaleString()} rows, {info.columns.length} columns
        {sort ? ` — sorted by ${sort.column} ${sort.descending ? "descending" : "ascending"}` : ""}
        {cache?.error ? ` — error: ${cache.error}` : ""}
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
              <button
                key={c.name}
                role="columnheader"
                aria-sort={active ? (sort!.descending ? "descending" : "ascending") : "none"}
                onClick={() => toggleSort(c.name)}
                title={`${c.name} — ${TYPE_LABEL[c.biType]} (${c.duckdbType}). Click to sort.`}
                style={{
                  width: COL_WIDTH,
                  flex: "none",
                  height: ROW_HEIGHT + 8,
                  textAlign: isNumeric(c.biType) ? "right" : "left",
                  border: 0,
                  borderRight: "1px solid #ddd",
                  background: "transparent",
                  cursor: "pointer",
                  padding: "2px 8px",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                  fontWeight: 600,
                  lineHeight: 1.1,
                }}
              >
                {c.name}
                {active ? (sort!.descending ? " ▼" : " ▲") : ""}
                <div style={{ fontWeight: 400, fontSize: 10, opacity: 0.7 }}>{TYPE_LABEL[c.biType]}</div>
              </button>
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
                    style={{
                      width: COL_WIDTH,
                      flex: "none",
                      padding: "0 8px",
                      lineHeight: `${ROW_HEIGHT}px`,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                      textAlign: isNumeric(c.biType) ? "right" : "left",
                    }}
                  >
                    {row ? (row[j] ?? "") : "…"}
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
