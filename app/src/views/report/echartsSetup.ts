// Apache ECharts with only the chart types BIForge uses, rendered as SVG (crisp at any zoom, testable without a canvas).
import * as echarts from "echarts/core";
import { BarChart, FunnelChart, GaugeChart, LineChart, PieChart, ScatterChart, TreemapChart } from "echarts/charts";
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from "echarts/components";
import { LegacyGridContainLabel } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, PieChart, ScatterChart, TreemapChart, FunnelChart, GaugeChart, LegacyGridContainLabel, GridComponent, LegendComponent, TitleComponent, TooltipComponent, SVGRenderer]);

export { echarts };
export type EChartsInstance = ReturnType<typeof echarts.init>;
