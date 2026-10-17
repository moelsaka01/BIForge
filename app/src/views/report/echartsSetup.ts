// Apache ECharts with only the chart types BIForge uses, rendered as SVG (crisp at any zoom, testable without a canvas).
import * as echarts from "echarts/core";
import { BarChart, FunnelChart, GaugeChart, LineChart, MapChart, PieChart, ScatterChart, TreemapChart } from "echarts/charts";
import { GeoComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from "echarts/components";
import { LegacyGridContainLabel } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";
import type { WorldData } from "../../core/report/geo";

echarts.use([BarChart, LineChart, PieChart, ScatterChart, TreemapChart, FunnelChart, GaugeChart, MapChart, GeoComponent, LegacyGridContainLabel, GridComponent, LegendComponent, TitleComponent, TooltipComponent, SVGRenderer]);

let registered = false;
/** Registers the outlines of the countries (map "world") and of the US states (map "states") once. */
export function registerWorld(world: WorldData): void {
  if (registered) return;
  registered = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  echarts.registerMap("world", world.countries as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  echarts.registerMap("states", world.states as any);
}

export { echarts };
export type EChartsInstance = ReturnType<typeof echarts.init>;
