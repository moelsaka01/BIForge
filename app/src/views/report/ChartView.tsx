import { useEffect, useRef } from "react";
import type { ChartBuild } from "../../core/report/chartOptions";
import type { SelectedPoint } from "../../core/report/interactions";
import { echarts, type EChartsInstance } from "./echartsSetup";

export interface ChartViewProps {
  build: ChartBuild;
  width: number;
  height: number;
  onPoint(point: SelectedPoint, additive: boolean): void;
  onContext(point: SelectedPoint, x: number, y: number): void;
  onHover?(point: SelectedPoint | null, x: number, y: number): void;
  label: string;
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
    return () => {
      c.dispose();
      chart.current = null;
    };
    // the instance lives as long as the element
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.setOption(p.build.option, true);
  }, [p.build]);

  useEffect(() => {
    chart.current?.resize({ width: Math.max(10, p.width), height: Math.max(10, p.height) });
  }, [p.width, p.height]);

  return <div ref={host} role="img" aria-label={p.label} style={{ width: p.width, height: p.height }} data-testid="chart" />;
}
