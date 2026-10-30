// Visuals drawn with HTML: table, matrix, cards and KPI.
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { withOpacity } from "../../core/report/chartFormat";
import { valueToLit } from "../../core/report/chartData";
import type { FieldRef } from "../../core/report/fields";
import type { SelectedPoint } from "../../core/report/interactions";
import type { NarrativeModel } from "../../core/report/narrative";
import type { CardModel, CellStyle, KpiModel, MatrixModel, MultiRowCardModel, NewCardModel, TableModel } from "../../core/report/tableModels";
import type { Theme } from "../../core/report/theme";
import { fieldKey } from "../../core/report/fields";
import { echarts } from "./echartsSetup";
import { useEffect } from "react";

const ROW_H = 24;
const HEAD_H = 28;

const cellBase = (t: Theme): CSSProperties => ({
  padding: "0 8px",
  height: ROW_H,
  lineHeight: `${ROW_H}px`,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontSize: t.textClasses.label.fontSize + 2,
  fontFamily: t.textClasses.label.fontFace,
  color: t.foreground,
  boxSizing: "border-box",
});

function styled(base: CSSProperties, s: CellStyle): CSSProperties {
  const out: CSSProperties = { ...base };
  if (s.background) out.background = s.background;
  if (s.color) out.color = s.color;
  if (s.bar) {
    const side = s.bar.negative ? "right" : "left";
    out.backgroundImage = `linear-gradient(to ${side === "left" ? "right" : "left"}, ${s.bar.color} ${(s.bar.ratio * 100).toFixed(1)}%, transparent ${(s.bar.ratio * 100).toFixed(1)}%)`;
    out.backgroundRepeat = "no-repeat";
    out.backgroundSize = "100% 70%";
    out.backgroundPosition = "center";
  }
  return out;
}

// ---- table ---------------------------------------------------------------------------------------------

export interface TableViewProps {
  model: TableModel;
  theme: Theme;
  width: number;
  height: number;
  selected: SelectedPoint[];
  onSort(field: FieldRef): void;
  onRow(point: SelectedPoint, additive: boolean): void;
  onContext(point: SelectedPoint, x: number, y: number): void;
}

export function TableView(p: TableViewProps) {
  const [top, setTop] = useState(0);
  const { model, theme } = p;
  const st = model.style;
  const ROW_H = st.rowHeight;
  const HEAD_H = st.headHeight;
  const groupCols = model.columns.map((c, i) => ({ c, i })).filter((x) => !x.c.isValue);
  const pointOf = (ri: number): SelectedPoint => ({ fields: groupCols.map((g) => g.c.field), values: groupCols.map((g) => valueToLit(model.rows[ri][g.i].raw)) });
  const selKeys = new Set(p.selected.map((s) => JSON.stringify(s.values)));
  const bodyH = Math.max(40, p.height - HEAD_H - (model.totals ? ROW_H : 0));
  const first = Math.max(0, Math.floor(top / ROW_H) - 3);
  const last = Math.min(model.rows.length, Math.ceil((top + bodyH) / ROW_H) + 3);
  const head: CSSProperties = { ...cellBase(theme), ...st.header, height: HEAD_H, lineHeight: `${HEAD_H}px`, cursor: "pointer" };
  const widths = `repeat(${model.columns.length}, ${st.columnWidth})`;
  return (
    <div style={{ width: p.width, height: p.height, display: "flex", flexDirection: "column", overflow: "hidden", ...st.frame }} role="table" aria-label="Table">
      <div style={{ display: "grid", gridTemplateColumns: widths }} role="row">
        {model.columns.map((c) => (
          <div
            key={fieldKey(c.field)}
            role="columnheader"
            aria-sort={c.sort === "asc" ? "ascending" : c.sort === "desc" ? "descending" : "none"}
            style={{ ...head, textAlign: st.headerAlign ?? c.align }}
            onClick={() => p.onSort(c.field)}
            title="Click to sort"
          >
            {c.label}
            {c.sort ? (c.sort === "asc" ? " ▲" : " ▼") : ""}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto" }} onScroll={(e) => setTop(e.currentTarget.scrollTop)} data-testid="table-body">
        <div style={{ height: model.rows.length * ROW_H, position: "relative" }}>
          {model.rows.slice(first, last).map((row, k) => {
            const ri = first + k;
            const pt = groupCols.length ? pointOf(ri) : null;
            const isSel = pt ? selKeys.has(JSON.stringify(pt.values)) : false;
            return (
              <div
                key={ri}
                role="row"
                data-row={ri}
                style={{ position: "absolute", top: ri * ROW_H, left: 0, right: 0, display: "grid", gridTemplateColumns: widths, background: isSel ? (theme.dark ? "#334b66" : "#d6e8fa") : undefined, opacity: selKeys.size && !isSel ? 0.55 : 1, cursor: pt ? "pointer" : "default" }}
                onClick={(e) => pt && p.onRow(pt, e.ctrlKey || e.metaKey || e.shiftKey)}
                onContextMenu={(e) => {
                  if (!pt) return;
                  e.preventDefault();
                  p.onContext(pt, e.clientX, e.clientY);
                }}
              >
                {row.map((cell, ci) => (
                  <div key={ci} role="cell" style={styled({ ...cellBase(theme), ...st.cell(ri), height: ROW_H, lineHeight: `${ROW_H}px`, textAlign: model.columns[ci].align }, cell.style)} title={cell.text}>
                    {cell.text}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {model.totals && (
        <div style={{ display: "grid", gridTemplateColumns: widths }} role="row" data-testid="table-totals">
          {model.totals.map((t, i) => (
            <div key={i} role="cell" style={{ ...cellBase(theme), ...st.total, height: ROW_H, lineHeight: `${ROW_H}px`, textAlign: model.columns[i].align }}>
              {t}
            </div>
          ))}
        </div>
      )}
      {model.truncated && (
        <div style={{ ...cellBase(theme), color: theme.muted, fontSize: 11 }}>Showing the first 10,000 rows.</div>
      )}
    </div>
  );
}

// ---- matrix --------------------------------------------------------------------------------------------

export interface MatrixViewProps {
  model: MatrixModel;
  rowFields: FieldRef[];
  theme: Theme;
  width: number;
  height: number;
  selected: SelectedPoint[];
  onToggle(key: string): void;
  onRow(point: SelectedPoint, additive: boolean): void;
}

export function MatrixView(p: MatrixViewProps) {
  const { model, theme } = p;
  const st = model.style;
  const selKeys = new Set(p.selected.map((s) => JSON.stringify(s.values)));
  const th: CSSProperties = { ...cellBase(theme), ...st.header, textAlign: st.headerAlign ?? "center", position: "sticky", top: 0, zIndex: 1, height: st.headHeight };
  // Grid > row padding: the height of a row
  const rowH: CSSProperties = { height: st.rowHeight };
  // Column headers > column adjustment / custom column width: value columns of a fixed width
  const fixed = st.columnWidth.endsWith("px");
  const colW: CSSProperties = fixed ? { width: st.columnWidth, minWidth: st.columnWidth, maxWidth: st.columnWidth } : {};
  const showTotals = model.showRowTotals;
  return (
    <div style={{ width: p.width, height: p.height, overflow: "auto", ...st.frame }} data-testid="matrix">
      <table role="table" aria-label="Matrix" style={{ borderCollapse: "collapse", ...(fixed ? { width: "auto" } : { minWidth: "100%" }) }}>
        <thead>
          {model.headers.map((h, hi) => (
            <tr key={hi}>
              {hi === 0 && (
                <th rowSpan={model.headers.length || 1} style={{ ...th, textAlign: "left", minWidth: 140 }} scope="col">
                  {model.rowHeader}
                </th>
              )}
              {h.map((c, ci) => (
                <th key={ci} colSpan={c.span} style={{ ...th, ...(c.span === 1 ? colW : {}) }} scope="col">
                  {c.text}
                </th>
              ))}
              {hi === 0 && showTotals && model.totalLabels.map((t) => (
                <th key={t} rowSpan={model.headers.length || 1} style={th} scope="col">
                  {t}
                </th>
              ))}
            </tr>
          ))}
          {model.headers.length === 0 && (
            <tr>
              <th style={{ ...th, textAlign: "left" }}>{model.rowHeader}</th>
            </tr>
          )}
        </thead>
        <tbody>
          {model.rows.map((r, ri) => {
            const pt: SelectedPoint | null = r.path.length ? { fields: p.rowFields.slice(0, r.path.length), values: r.path.map(valueToLit) } : null;
            const isSel = pt ? selKeys.has(JSON.stringify(pt.values)) : false;
            return (
              <tr key={r.key} data-row={r.key} style={{ background: isSel ? (theme.dark ? "#334b66" : "#d6e8fa") : undefined, fontWeight: r.isGrand || r.expandable || r.isSubtotal ? 600 : 400, opacity: selKeys.size && !isSel && pt ? 0.55 : 1 }}>
                <td
                  style={{ ...cellBase(theme), ...st.rowHeaderCell, ...(r.isGrand ? st.columnTotal : r.expandable || r.isSubtotal ? st.subtotal : {}), paddingLeft: 8 + r.depth * 16, ...rowH, cursor: pt ? "pointer" : "default", textAlign: "left" }}
                  onClick={(e) => pt && p.onRow(pt, e.ctrlKey || e.metaKey || e.shiftKey)}
                >
                  {r.expandable ? (
                    <button
                      aria-label={`${r.expanded ? "Collapse" : "Expand"} ${r.label}`}
                      aria-expanded={r.expanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        p.onToggle(r.key);
                      }}
                      style={{ width: 16, border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: 0, marginRight: 2 }}
                    >
                      {r.expanded ? "−" : "+"}
                    </button>
                  ) : (
                    <span style={{ display: "inline-block", width: 18 }} />
                  )}
                  {r.label}
                </td>
                {r.cells.map((c, ci) => (
                  <td key={ci} style={styled({ ...cellBase(theme), ...st.cell(ri), ...(r.isGrand ? st.columnTotal : r.expandable || r.isSubtotal ? st.subtotal : {}), ...rowH, ...colW, textAlign: "right" }, c.style)}>
                    {c.text}
                  </td>
                ))}
                {showTotals && r.total.map((c, ci) => (
                  <td key={`t${ci}`} style={styled({ ...cellBase(theme), ...st.rowTotal, ...rowH, textAlign: "right", borderLeft: `1px solid ${theme.dark ? "#444" : "#ddd"}` }, c.style)}>
                    {c.text}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- cards ---------------------------------------------------------------------------------------------

export function CardView({ model, theme, width, height }: { model: CardModel; theme: Theme; width: number; height: number }) {
  const size = Math.max(14, Math.min(model.fontSize, height * 0.45, width / Math.max(3, model.text.length * 0.65)));
  return (
    <div style={{ width, height, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden" }} data-testid="card" role="group" aria-label={model.label}>
      <div style={{ ...model.valueStyle, fontSize: size, lineHeight: 1.1 }} data-testid="card-value">
        {model.text}
      </div>
      {model.showLabel && <div style={{ ...model.labelStyle, marginTop: 4 }}>{model.label}</div>}
    </div>
  );
}

export function NewCardView({ model, theme, width, height }: { model: NewCardModel; theme: Theme; width: number; height: number }) {
  return (
    <div data-testid="new-card" style={{ width, height, boxSizing: "border-box", padding: 8, display: "flex", flexDirection: model.orientation, flexWrap: "wrap", gap: 12, alignContent: "flex-start", alignItems: model.alignBaselines ? "baseline" : undefined, overflow: "auto" }}>
      {model.tiles.map((t, i) => {
        const a = model.accent;
        const bar = a ? { [`border${a.position}`]: `${a.width}px solid ${withOpacity(a.color, a.opacity)}` } : {};
        // Grid: a line between the tiles, on the side the next tile follows
        const line = model.grid && i > 0 ? { [model.orientation === "row" ? "borderLeft" : "borderTop"]: model.grid.border } : {};
        const label = model.showLabel && <div style={model.labelStyle} data-testid="new-card-label" {...(model.labelLevel ? { role: "heading", "aria-level": model.labelLevel } : {})}>{t.label}</div>;
        return (
          <div key={i} data-testid="new-card-tile" style={{ flex: "1 1 120px", minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", padding: "4px 8px", ...line, ...bar }}>
            {model.labelAbove && label}
            {model.showValue && <div style={{ ...model.valueStyle, ...model.callout, lineHeight: 1.15 }} data-testid="new-card-value">{t.value}</div>}
            {!model.labelAbove && label}
          </div>
        );
      })}
      {model.tiles.length === 0 && <span style={{ color: theme.muted }}>No data</span>}
    </div>
  );
}

export function NarrativeView({ model, theme, width, height }: { model: NarrativeModel; theme: Theme; width: number; height: number }) {
  return (
    <div data-testid="narrative" style={{ width, height, boxSizing: "border-box", padding: 10, overflow: "auto", ...model.style }}>
      {model.sentences.map((sent, i) => (
        <p key={i} style={{ margin: "0 0 6px" }}>
          {sent.map((seg, j) => (seg.strong ? <strong key={j}>{seg.text}</strong> : <span key={j}>{seg.text}</span>))}
        </p>
      ))}
    </div>
  );
}

export function MultiRowCardView({ model, theme, width, height }: { model: MultiRowCardModel; theme: Theme; width: number; height: number }) {
  return (
    <div style={{ width, height, overflow: "auto", display: "flex", flexDirection: "column", gap: 8, padding: 8, boxSizing: "border-box" }} data-testid="multirow">
      {model.cards.map((c, i) => (
        <div key={i} style={{ borderBottom: `1px solid ${theme.dark ? "#333" : "#eee"}`, paddingBottom: 6, position: "relative", ...model.cardStyle, ...(model.bar ? { paddingLeft: (model.cardStyle.padding as number) + model.bar.weight + 6 } : {}) }}>
          {model.bar && <div data-testid="multirow-bar" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: model.bar.weight, background: model.bar.color }} />}
          {c.items.map((it, j) => (
            <div key={j} style={{ display: "flex", flexDirection: "column", marginBottom: 2 }}>
              <span style={j === 0 ? { fontWeight: 600, ...model.titleStyle } : model.valueStyle}>{it.text}</span>
              {model.showCaptions && <span style={model.captionStyle}>{it.label}</span>}
            </div>
          ))}
        </div>
      ))}
      {model.cards.length === 0 && <span style={{ color: theme.muted }}>No data</span>}
    </div>
  );
}

export function KpiView({ model, theme, width, height }: { model: KpiModel; theme: Theme; width: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const color = model.status === "good" ? model.colors.good : model.status === "bad" ? model.colors.bad : model.colors.neutral;
  const trend = useMemo(() => model.trend, [model.trend]);
  useEffect(() => {
    if (!ref.current || trend.length < 2 || !model.showTrend) return;
    const c = echarts.init(ref.current, null, { renderer: "svg", width: Math.max(20, width), height: Math.max(20, height * 0.4) });
    c.setOption({
      animation: false,
      grid: { left: 0, right: 0, top: 4, bottom: 0 },
      xAxis: { type: "category", show: false, data: trend.map((t) => t.x), boundaryGap: false },
      yAxis: { type: "value", show: false, scale: true },
      series: [{ type: "line", data: trend.map((t) => t.y), showSymbol: false, areaStyle: { opacity: 0.25 * (1 - model.trendTransparency / 100) * 4 }, lineStyle: { width: 2, color }, itemStyle: { color } }],
    });
    return () => c.dispose();
  }, [trend, width, height, color, model.showTrend, model.trendTransparency]);
  return (
    <div style={{ width, height, display: "flex", flexDirection: "column", overflow: "hidden" }} data-testid="kpi" role="group" aria-label={model.label}>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: model.verticalAlign }}>
        <div style={{ padding: "6px 10px 0", fontSize: 12, color: theme.muted }}>{model.label}</div>
        <div style={{ padding: "0 10px", ...model.valueStyle, fontSize: Math.min(model.valueStyle.fontSize as number, height * 0.28), textAlign: model.align }} data-testid="kpi-value">
          {model.showIcon && <span aria-hidden style={{ color, marginRight: 4, fontSize: model.iconSize }}>{model.status === "bad" ? "▼" : model.status === "good" ? "▲" : "●"}</span>}
          {model.value}
        </div>
        {model.goal !== null && model.showGoal && (
          <div style={{ padding: "0 10px", color }} data-testid="kpi-goal">
            {model.showDistance && model.distanceText && <span style={{ ...model.distanceStyle, color: model.distanceColor ?? color }}>{model.distanceText} </span>}
            <span style={{ ...model.titleStyle, color }}>{model.goalText}: </span>
            <span style={{ ...model.goalStyle, color: model.goalColor ?? color }}>{model.goal}</span>
          </div>
        )}
      </div>
      <div ref={ref} style={{ flex: "none", height: height * 0.4, display: model.showTrend ? undefined : "none" }} aria-hidden />
    </div>
  );
}
