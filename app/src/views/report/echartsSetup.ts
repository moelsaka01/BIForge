// Apache ECharts with only the chart types BIForge uses, rendered as SVG (crisp at any zoom, testable without a canvas).
import * as echarts from "echarts/core";
import { BarChart, CustomChart, FunnelChart, GaugeChart, HeatmapChart, LineChart, MapChart, PieChart, ScatterChart, TreemapChart } from "echarts/charts";
import { DataZoomComponent, GeoComponent, GraphicComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TitleComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { LabelLayout, LegacyGridContainLabel } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";
import type { WorldData } from "../../core/report/geo";

// reference lines and shading (markLine, markArea), the zoom slider (dataZoom), the ribbon (custom series) and the donut centre (graphic)
// and the label layout (hide overlapping labels) are options BIForge builds: a component that is not registered here is silently not drawn, which jsdom tests of the option cannot see.
echarts.use([LabelLayout, CustomChart, DataZoomComponent, GraphicComponent, MarkAreaComponent, MarkLineComponent, BarChart, LineChart, PieChart, ScatterChart, TreemapChart, FunnelChart, GaugeChart, HeatmapChart, MapChart, GeoComponent, VisualMapComponent, LegacyGridContainLabel, GridComponent, LegendComponent, TitleComponent, TooltipComponent, SVGRenderer]);

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
