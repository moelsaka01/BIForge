import { useEffect, useRef, useState } from "react";
import type { ChartBuild } from "../../core/report/chartOptions";
import type { SelectedPoint } from "../../core/report/interactions";
import { UNDERLINE_FAMILY } from "../../core/format/styles";
import { echarts, type EChartsInstance } from "./echartsSetup";

export interface ChartViewProps {
  build: ChartBuild;
  width: number;
  height: number;
  onPoint(point: SelectedPoint, additive: boolean): void;
  onContext(point: SelectedPoint, x: number, y: number): void;
  onHover?(point: SelectedPoint | null, x: number, y: number): void;
  /** The points inside a lasso (maps). */
  onLasso?(points: SelectedPoint[], additive: boolean): void;
  label: string;
}

/** ECharts has no text decoration: text whose font family carries the marker is underlined here, the text itself stays as it is. */
const UNDERLINE_CSS = `[data-testid="chart"] text[style*="${UNDERLINE_FAMILY}"] { text-decoration: underline; }`;

const toolButton = { width: 26, height: 26, border: "1px solid #888", background: "rgba(255,255,255,0.92)", color: "#222", cursor: "pointer", fontSize: 15, lineHeight: "20px", padding: 0, borderRadius: 3 } as const;

/**
 * Hides the data labels of the series marked `fitLabel` ("x": bars grow sideways, "y": upwards) that are larger than their bar:
 * Desktop draws no label that does not fit in the bar. Runs after every drawing, so a label comes back when the bar grows.
 */
export function hideLabelsThatDoNotFit(c: EChartsInstance, option: { series?: { fitLabel?: string }[] }): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = (c as any).getModel?.();
  if (!model) return;
  let changed = false;
  (option.series ?? []).forEach((s, si) => {
    if (!s.fitLabel) return;
    const data = model.getSeriesByIndex(si)?.getData();
    if (!data) return;
    for (let di = 0; di < data.count(); di++) {
      const bar = data.getItemGraphicEl(di);
      const text = bar?.getTextContent?.();
      if (!bar || !text) continue;
      const box = text.getBoundingRect();
      const fits = s.fitLabel === "x" ? box.width <= (bar.shape?.width ?? Infinity) : box.height <= (bar.shape?.height ?? Infinity);
      if (text.ignore === fits) {
        text.ignore = !fits;
        text.dirty();
        changed = true;
      }
    }
  });
  if (changed) c.getZr().refresh();
}

/** One ECharts instance for one visual. The chart is drawn from `build.option`; events map back to data points. */
export function ChartView(p: ChartViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsInstance | null>(null);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    const el = host.current!;
    const c = echarts.init(el, null, { renderer: "svg", width: Math.max(10, p.width), height: Math.max(10, p.height) });
    chart.current = c;
    c.on("click", (e) => {
      const pt = latest.current.build.pointAt(e.seriesIndex ?? 0, e.dataIndex ?? 0);
      const ev = (e.event as { event?: MouseEvent } | undefined)?.event;
      if (pt) latest.current.onPoint(pt, !!(ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)));
    });
    c.on("contextmenu", (e) => {
      const ev = (e.event as { event?: MouseEvent } | undefined)?.event;
      ev?.preventDefault();
      const pt = latest.current.build.pointAt(e.seriesIndex ?? 0, e.dataIndex ?? 0);
      if (pt && ev) latest.current.onContext(pt, ev.clientX, ev.clientY);
    });
    c.on("mouseover", (e) => {
      const ev = (e.event as { event?: MouseEvent } | undefined)?.event;
      const pt = latest.current.build.pointAt(e.seriesIndex ?? 0, e.dataIndex ?? 0);
      if (ev) latest.current.onHover?.(pt, ev.clientX, ev.clientY);
    });
    c.on("globalout", () => latest.current.onHover?.(null, 0, 0));
    c.on("finished", () => hideLabelsThatDoNotFit(c, latest.current.build.option));
    return () => {
      c.dispose();
      chart.current = null;
    };
    // the instance lives as long as the element
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.setOption(p.build.option, true);
    if (chart.current) hideLabelsThatDoNotFit(chart.current, p.build.option);
  }, [p.build]);

  useEffect(() => {
    chart.current?.resize({ width: Math.max(10, p.width), height: Math.max(10, p.height) });
  }, [p.width, p.height]);

  const tools = p.build.mapTools;
  const [lasso, setLasso] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const zoomBy = (factor: number) => chart.current?.dispatchAction({ type: "geoRoam", componentType: "geo", zoom: factor });
  const finishLasso = (box: { x0: number; y0: number; x1: number; y1: number }, additive: boolean) => {
    const c = chart.current;
    if (!c || !tools) return;
    const [xa, xb] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
    const [ya, yb] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
    const picked: SelectedPoint[] = [];
    for (const pt of tools.points) {
      const px = c.convertToPixel({ geoIndex: 0 }, [pt.lon, pt.lat]) as number[] | null;
      if (px && px[0] >= xa && px[0] <= xb && px[1] >= ya && px[1] <= yb) {
        const sp = p.build.pointAt(pt.series, pt.index);
        if (sp) picked.push(sp);
      }
    }
    p.onLasso?.(picked, additive);
  };

  return (
    <div style={{ position: "relative", width: p.width, height: p.height }}>
      {p.build.plotImage && (
        <div
          data-testid="plot-image"
          aria-hidden
          style={{ position: "absolute", left: p.build.plotImage.margins.left, right: p.build.plotImage.margins.right, top: p.build.plotImage.margins.top, bottom: p.build.plotImage.margins.bottom, pointerEvents: "none", backgroundImage: `url("${p.build.plotImage.url.replace(/"/g, "%22")}")`, backgroundRepeat: "no-repeat", backgroundPosition: "center", backgroundSize: p.build.plotImage.size, opacity: p.build.plotImage.opacity }}
        />
      )}
      {p.build.centreImages?.map((im, i) => (
        <img key={i} data-testid="centre-image" src={im.src} alt={im.alt} style={{ position: "absolute", left: "50%", top: `calc(50% + ${im.dy - im.size / 2}px)`, width: im.size, height: im.size, marginLeft: -im.size / 2, objectFit: "contain", opacity: im.opacity, pointerEvents: "none" }} />
      ))}
      <style>{UNDERLINE_CSS}</style>
      <div ref={host} role="img" aria-label={p.label} style={{ width: p.width, height: p.height }} data-testid="chart" />
      {tools && (
        <div role="toolbar" aria-label="Map tools" style={{ position: "absolute", top: 6, right: 6, display: "flex", flexDirection: "column", gap: 4 }} onPointerDown={(e) => e.stopPropagation()}>
          {tools.zoom && (
            <>
              <button type="button" aria-label="Zoom in" style={toolButton} onClick={() => zoomBy(1.5)}>
                +
              </button>
              <button type="button" aria-label="Zoom out" style={toolButton} onClick={() => zoomBy(1 / 1.5)}>
                −
              </button>
            </>
          )}
          {tools.lasso && (
            <button type="button" aria-label="Lasso select" aria-pressed={lasso} style={{ ...toolButton, background: lasso ? "#cfe3f7" : toolButton.background }} onClick={() => setLasso(!lasso)}>
              ▢
            </button>
          )}
        </div>
      )}
      {tools?.lasso && lasso && (
        <div
          data-testid="lasso-layer"
          style={{ position: "absolute", inset: 0, cursor: "crosshair", touchAction: "none" }}
          onPointerDown={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - r.left;
            const y = e.clientY - r.top;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            setDrag({ x0: x, y0: y, x1: x, y1: y });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            const r = e.currentTarget.getBoundingClientRect();
            setDrag({ ...drag, x1: e.clientX - r.left, y1: e.clientY - r.top });
          }}
          onPointerUp={(e) => {
            if (!drag) return;
            finishLasso(drag, e.ctrlKey || e.metaKey || e.shiftKey);
            setDrag(null);
            setLasso(false);
          }}
        >
          {drag && <div style={{ position: "absolute", left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0), border: "1px dashed #0f6cbd", background: "rgba(15,108,189,0.12)" }} />}
        </div>
      )}
    </div>
  );
}
