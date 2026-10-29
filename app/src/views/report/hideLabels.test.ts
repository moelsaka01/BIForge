import { describe, expect, it } from "vitest";
import { hideLabelsThatDoNotFit } from "./ChartView";
import type { EChartsInstance as _I } from "./echartsSetup";

type Fake = { ignore: boolean; dirty(): void; getBoundingRect(): { width: number; height: number } };
// a chart with one series of bars: shape extents as ECharts reports them (a column grows upwards: its height is negative)
const chartWith = (shape: { width: number; height: number }, label: { width: number; height: number }) => {
  const text: Fake = { ignore: false, dirty() {}, getBoundingRect: () => label };
  const bar = { shape, getTextContent: () => text };
  const chart = { getModel: () => ({ getSeriesByIndex: () => ({ getData: () => ({ count: () => 1, getItemGraphicEl: () => bar }) }) }), getZr: () => ({ refresh() {} }) };
  return { chart: chart as unknown as _I, text };
};

describe("labels that do not fit in their bar", () => {
  it("a label taller than a column is hidden, one that fits stays (the height of a column is negative)", () => {
    const small = chartWith({ width: 50, height: -10 }, { width: 20, height: 14 });
    hideLabelsThatDoNotFit(small.chart, { series: [{ fitLabel: "y" }] });
    expect(small.text.ignore).toBe(true);
    const big = chartWith({ width: 50, height: -300 }, { width: 20, height: 14 });
    hideLabelsThatDoNotFit(big.chart, { series: [{ fitLabel: "y" }] });
    expect(big.text.ignore).toBe(false);
  });
  it("a label wider than a bar is hidden", () => {
    const c = chartWith({ width: 10, height: 20 }, { width: 24, height: 14 });
    hideLabelsThatDoNotFit(c.chart, { series: [{ fitLabel: "x" }] });
    expect(c.text.ignore).toBe(true);
  });
});
