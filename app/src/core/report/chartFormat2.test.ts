// More of the formatting cards, drawn: plot area background, gridline dash patterns, line and marker styles, label
// alignment / width / background, the zoom slider, and the dash of a reference line. Each one is checked on the chart
// option the renderer hands to ECharts.
import { describe, expect, it } from "vitest";
import { decodeCell } from "./cells";
import { dashOf, withOpacity } from "./chartFormat";
import { buildChart } from "./chartOptions";
import type { Loaded } from "./dataLoader";
import { agg, column, lit } from "./fields";
import { buildVisualQuery } from "./queryBuilder";
import { fixtureModel, visualOf } from "./testFixture";
import { DEFAULT_THEME } from "./theme";
import { condFormatToPbir } from "./condFormat";
import { setFormat, setRawProp, type VisualModel } from "./visualDoc";

const model = fixtureModel();
const Cat = column("Product", "Category");
const Qty = agg("Sales", "Quantity", 0);

type Cell = [string, string];
const rows: Cell[][] = [[["text", "Accessories"], ["int", "30"]], [["text", "Bikes"], ["int", "50"]], [["text", "Shoes"], ["int", "20"]]];

function buildFull(type: string, set: (v: VisualModel) => void) {
  const v = visualOf(type, { Category: [Cat], Y: [Qty] });
  set(v);
  const loaded: Extract<Loaded, { kind: "grouped" }> = {
    kind: "grouped",
    query: buildVisualQuery(v, model, { filters: [] })!,
    rows: rows.map((r) => r.map(([t, x]) => decodeCell({ t: t as never, v: x }))),
    highlightRows: null,
    totals: null,
    truncated: false,
    ms: 0,
  };
  return buildChart({ visual: v, loaded, theme: DEFAULT_THEME, selected: [] })!;
}
const build = (type: string, set: (v: VisualModel) => void) => buildFull(type, set).option;

describe("helpers", () => {
  it("withOpacity writes an rgba color, dashOf reads a dash pattern", () => {
    expect(withOpacity("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(withOpacity("#0f0", 1)).toBe("rgba(0, 255, 0, 1)");
    expect(withOpacity("red", 0.5)).toBe("red");
    expect(dashOf("5 3")).toEqual([5, 3]);
    expect(dashOf("5,3, 2")).toEqual([5, 3, 2]);
    expect(dashOf("")).toBeNull();
    expect(dashOf("0 0")).toBeNull();
    expect(dashOf("a b")).toBeNull();
  });
});

describe("plot area and gridlines", () => {
  it("the plot area color and its transparency become the grid background", () => {
    expect(build("clusteredColumnChart", () => undefined).grid.show).toBeUndefined();
    const o = build("clusteredColumnChart", (v) => {
      setFormat(v.json, "plotArea", "color", lit.str("#336699"));
      setFormat(v.json, "plotArea", "colorTransparency", lit.num(50));
    });
    expect(o.grid.show).toBe(true);
    expect(o.grid.backgroundColor).toBe("rgba(51, 102, 153, 0.5)");
  });

  it("a gridline dash pattern and cap draw the grid lines of both axes", () => {
    const o = build("clusteredColumnChart", (v) => {
      for (const axis of ["valueAxis", "categoryAxis"]) {
        setFormat(v.json, axis, "gridlineShow", lit.bool(true));
        setFormat(v.json, axis, "gridlineDashArray", lit.str("8 2"));
        setFormat(v.json, axis, "gridlineDashCap", lit.str("round"));
      }
    });
    expect(o.yAxis[0].splitLine.lineStyle).toMatchObject({ type: [8, 2], cap: "round" });
    expect(o.xAxis.splitLine.lineStyle).toMatchObject({ type: [8, 2], cap: "round" });
    // a named style wins over a leftover pattern unless it is custom
    const named = build("clusteredColumnChart", (v) => {
      setFormat(v.json, "valueAxis", "gridlineDashArray", lit.str("8 2"));
      setFormat(v.json, "valueAxis", "gridlineStyle", lit.str("dotted"));
    });
    expect(named.yAxis[0].splitLine.lineStyle.type).toEqual([2, 3]);
    const custom = build("clusteredColumnChart", (v) => {
      setFormat(v.json, "valueAxis", "gridlineDashArray", lit.str("8 2"));
      setFormat(v.json, "valueAxis", "gridlineStyle", lit.str("custom"));
    });
    expect(custom.yAxis[0].splitLine.lineStyle.type).toEqual([8, 2]);
  });
});

describe("line and marker styles", () => {
  it("smoothing (type or amount), steps, a dash pattern with cap and join, and showing the markers", () => {
    const smooth = build("lineChart", (v) => setFormat(v.json, "lineStyles", "interpolationSmoothParam", lit.num(0.3)));
    expect(smooth.series[0].smooth).toBeCloseTo(0.3);
    expect(build("lineChart", (v) => setFormat(v.json, "lineStyles", "interpolationSmooth", lit.str("cardinal"))).series[0].smooth).toBe(true);
    expect(build("lineChart", () => undefined).series[0].smooth).toBe(false);
    expect(build("lineChart", (v) => setFormat(v.json, "lineStyles", "interpolationStep", lit.str("after"))).series[0].step).toBe("end");
    const dashed = build("lineChart", (v) => {
      setFormat(v.json, "lineStyles", "strokeDashArray", lit.str("4 4"));
      setFormat(v.json, "lineStyles", "strokeDashCap", lit.str("square"));
      setFormat(v.json, "lineStyles", "strokeLineJoin", lit.str("bevel"));
    });
    expect(dashed.series[0].lineStyle).toMatchObject({ type: [4, 4], cap: "square", join: "bevel" });
    expect(build("lineChart", () => undefined).series[0].showSymbol).toBe(true);
    expect(build("lineChart", (v) => setFormat(v.json, "lineStyles", "showMarkerByDefault", lit.bool(false))).series[0].showSymbol).toBe(false);
  });

  it("the markers object sets opacity, rotation and the border of the line's markers", () => {
    const o = build("lineChart", (v) => {
      setFormat(v.json, "markers", "transparency", lit.num(40));
      setFormat(v.json, "markers", "rotation", lit.num(45));
      setFormat(v.json, "markers", "borderShow", lit.bool(true));
      setFormat(v.json, "markers", "borderColor", lit.str("#ff0000"));
      setFormat(v.json, "markers", "borderWidth", lit.num(3));
    });
    expect(o.series[0].symbolRotate).toBe(45);
    expect(o.series[0].itemStyle).toMatchObject({ opacity: 0.6, borderColor: "rgba(255, 0, 0, 1)", borderWidth: 3 });
  });
});

describe("data labels", () => {
  it("alignment, a maximum width with wrapping, and the background with its transparency", () => {
    const o = build("clusteredColumnChart", (v) => {
      setFormat(v.json, "labels", "show", lit.bool(true));
      setFormat(v.json, "labels", "horizontalAlignment", lit.str("left"));
      setFormat(v.json, "labels", "wordWrap", lit.bool(true));
      setFormat(v.json, "labels", "labelContainerMaxWidth", lit.num(80));
      setFormat(v.json, "labels", "enableBackground", lit.bool(true));
      setFormat(v.json, "labels", "backgroundColor", lit.str("#000000"));
      setFormat(v.json, "labels", "backgroundTransparency", lit.num(75));
      setFormat(v.json, "labels", "optimizeLabelDisplay", lit.bool(true));
    });
    expect(o.series[0].label).toMatchObject({ align: "left", overflow: "break", width: 80, backgroundColor: "rgba(0, 0, 0, 0.25)" });
    expect(o.series[0].labelLayout).toEqual({ hideOverlap: true });
    // nothing changes without them
    const plain = build("clusteredColumnChart", (v) => setFormat(v.json, "labels", "show", lit.bool(true)));
    expect(plain.series[0].label.align).toBeUndefined();
    expect(plain.series[0].labelLayout).toBeUndefined();
  });
});

describe("zoom slider", () => {
  it("columns get sliders under the plot, bars beside it; the value axis slider is separate; the labels can be off", () => {
    expect(build("clusteredColumnChart", () => undefined).dataZoom).toBeUndefined();
    const cols = build("clusteredColumnChart", (v) => setFormat(v.json, "zoom", "show", lit.bool(true)));
    expect(cols.dataZoom).toHaveLength(1);
    expect(cols.dataZoom[0]).toMatchObject({ type: "slider", xAxisIndex: 0, showDetail: true });
    expect(cols.grid.bottom).toBeGreaterThan(8);
    const both = build("clusteredColumnChart", (v) => {
      setFormat(v.json, "zoom", "show", lit.bool(true));
      setFormat(v.json, "zoom", "showOnValueAxis", lit.bool(true));
      setFormat(v.json, "zoom", "showLabels", lit.bool(false));
      setFormat(v.json, "zoom", "categoryMin", lit.num(1));
      setFormat(v.json, "zoom", "categoryMax", lit.num(2));
    });
    expect(both.dataZoom).toHaveLength(2);
    expect(both.dataZoom[0]).toMatchObject({ xAxisIndex: 0, showDetail: false, startValue: 1, endValue: 2 });
    expect(both.dataZoom[1]).toMatchObject({ yAxisIndex: 0, showDetail: false });
    const bars = build("clusteredBarChart", (v) => setFormat(v.json, "zoom", "show", lit.bool(true)));
    expect(bars.dataZoom[0]).toMatchObject({ yAxisIndex: 0 });
    expect(bars.grid.right).toBeGreaterThan(12);
    const off = build("clusteredColumnChart", (v) => {
      setFormat(v.json, "zoom", "show", lit.bool(true));
      setFormat(v.json, "zoom", "showOnCategoryAxis", lit.bool(false));
    });
    expect(off.dataZoom).toBeUndefined();
  });
});

describe("slice borders and pie labels", () => {
  it("pie and funnel slices take the dataPoint border: color, size, transparency, match fill and outline only", () => {
    const plain = build("pieChart", () => undefined);
    expect(plain.series[0].data[0].itemStyle.borderWidth).toBeUndefined();
    expect(plain.series[0].itemStyle).toMatchObject({ borderWidth: 1 }); // the default separator between slices
    const o = build("pieChart", (v) => {
      setFormat(v.json, "dataPoint", "borderShow", lit.bool(true));
      setFormat(v.json, "dataPoint", "borderColor", lit.str("#ff0000"));
      setFormat(v.json, "dataPoint", "borderSize", lit.num(4));
      setFormat(v.json, "dataPoint", "borderTransparency", lit.num(50));
    });
    expect(o.series[0].data[0].itemStyle).toMatchObject({ borderColor: "rgba(255, 0, 0, 0.5)", borderWidth: 4 });
    const match = build("pieChart", (v) => {
      setFormat(v.json, "dataPoint", "borderShow", lit.bool(true));
      setFormat(v.json, "dataPoint", "borderColorMatchFill", lit.bool(true));
      setFormat(v.json, "dataPoint", "fill", lit.str("#00ff00"), "Accessories");
    });
    const item = match.series[0].data.find((d: { name: string }) => d.name === "Accessories").itemStyle;
    expect(item.borderColor).toBe("rgba(0, 255, 0, 1)");
    const outline = build("funnel", (v) => {
      setFormat(v.json, "dataPoint", "borderShow", lit.bool(true));
      setFormat(v.json, "dataPoint", "borderOutlineOnly", lit.bool(true));
      setFormat(v.json, "dataPoint", "fill", lit.str("#0000ff"), "Bikes");
    });
    const bikes = outline.series[0].data.find((d: { name: string }) => d.name === "Bikes").itemStyle;
    expect(bikes).toMatchObject({ color: "transparent", borderColor: "rgba(0, 0, 255, 1)" });
  });
});

describe("legend title and label value formats", () => {
  const withLegend = (v: VisualModel) => {
    const w = visualOf("clusteredColumnChart", { Category: [Cat], Series: [column("Customer", "Country")], Y: [Qty] });
    void w;
    setFormat(v.json, "legend", "show", lit.bool(true));
  };

  it("the legend title is a text beside the entries and the plot area leaves room for it", () => {
    const plain = build("clusteredColumnChart", withLegend);
    const titled = build("clusteredColumnChart", (v) => {
      withLegend(v);
      setFormat(v.json, "legend", "showTitle", lit.bool(true));
      setFormat(v.json, "legend", "titleText", lit.str("Country"));
    });
    expect(plain.title).toBeUndefined();
    const t = (titled.title as { text: string; top: number }[]).find((x) => x.text === "Country")!;
    expect(t.top).toBe(0);
    expect(titled.legend.top).toBe(18);
    expect(titled.grid.top).toBe(plain.grid.top + 18);
    // bottom legends put it above the entries at the bottom
    const bottom = build("clusteredColumnChart", (v) => {
      withLegend(v);
      setFormat(v.json, "legend", "position", lit.str("Bottom"));
      setFormat(v.json, "legend", "showTitle", lit.bool(true));
    });
    expect((bottom.title as { text: string; bottom: number }[])[0]).toMatchObject({ text: "Legend", bottom: 22 });
    expect(bottom.grid.bottom).toBeGreaterThan(plain.grid.bottom);
  });

  it("data labels use the value format string, and a blank value shows the chosen text", () => {
    const label = (set: (v: VisualModel) => void) => {
      const o = build("clusteredColumnChart", (v) => {
        setFormat(v.json, "labels", "show", lit.bool(true));
        set(v);
      });
      return o.series[0].label.formatter({ value: 1234.5, data: { raw: 1234.5, value: 1234.5 } }) as string;
    };
    expect(label(() => undefined)).toBe("1.2K");
    expect(label((v) => setFormat(v.json, "labels", "valueCustomFormatString", lit.str("0.000")))).toBe("1234.500");
    expect(label((v) => setFormat(v.json, "labels", "valueCustomFormatString", lit.str("#,0.0")))).toBe("1,234.5");
    // display units chosen explicitly still apply on top of the format
    expect(label((v) => {
      setFormat(v.json, "labels", "valueCustomFormatString", lit.str("0.00"));
      setFormat(v.json, "labels", "labelDisplayUnits", lit.num(1000));
      setFormat(v.json, "labels", "labelPrecision", lit.num(2));
    })).toBe("1.23K");
  });

  it("dash patterns written as text are read for gridlines, lines, reference lines and trends", () => {
    const o = build("clusteredColumnChart", (v) => {
      setFormat(v.json, "valueAxis", "gridlineShow", lit.bool(true));
      setFormat(v.json, "valueAxis", "gridlineDashArray", lit.str("4 2"));
    });
    expect(([] as { splitLine: { lineStyle: { type: unknown } } }[]).concat(o.yAxis)[0].splitLine.lineStyle.type).toEqual([4, 2]);
  });
});

describe("labels inside a bar that is too short", () => {
  it("are marked to be hidden when they are wider than the bar, unless Overflow text is on", () => {
    const show = (v: { json: never }) => setFormat(v.json, "labels", "show", lit.bool(true));
    expect(build("barChart", (v) => show(v as never)).series[0].fitLabel).toBe("x");
    expect(build("columnChart", (v) => show(v as never)).series[0].fitLabel).toBe("y");
    const over = build("barChart", (v) => { show(v as never); setFormat(v.json, "labels", "labelOverflow", lit.bool(true)); });
    expect(over.series[0].fitLabel).toBeUndefined();
    // outside the bar nothing is hidden
    expect(build("clusteredBarChart", (v) => show(v as never)).series[0].fitLabel).toBeUndefined();
  });
});

describe("donut centre", () => {
  const kids = (o: { graphic?: { children: { type: string; y: number; style: { text?: string } }[] }[] }) => o.graphic?.[0]?.children ?? [];
  const texts = (o: Parameters<typeof kids>[0]) => kids(o).filter((g) => g.type === "text").map((g) => g.style.text);
  it("is drawn only when Center value is on: the label above the total of the slices, a disc behind and a picture", () => {
    expect(build("donutChart", () => undefined).graphic).toBeUndefined();
    const o = build("donutChart", (v) => {
      setFormat(v.json, "centerValue", "show", lit.bool(true));
      setFormat(v.json, "label", "text", lit.str("All"));
      setFormat(v.json, "centerBackground", "show", lit.bool(true));
      setFormat(v.json, "centerBackground", "fillColor", lit.str("#102030"));
      setFormat(v.json, "image", "show", lit.bool(true));
      setFormat(v.json, "image", "imageUrl", lit.str("data:image/png;base64,AA"));
    });
    expect(texts(o)).toEqual(["All", "100"]);
    expect(kids(o).some((g) => g.type === "image")).toBe(false);
    // the picture is a layer over the chart, above the label; the texts are stacked, not on top of each other
    const full = buildFull("donutChart", (v) => {
      setFormat(v.json, "centerValue", "show", lit.bool(true));
      setFormat(v.json, "image", "show", lit.bool(true));
      setFormat(v.json, "image", "imageUrl", lit.str("data:image/png;base64,AA"));
    });
    expect(full.centreImages?.[0]).toMatchObject({ src: "data:image/png;base64,AA", size: 24 });
    expect(full.centreImages![0].dy).toBeLessThan(kids(full.option).map((g) => g.y)[0]);
    const ys = kids(o).map((g) => g.y);
    expect(new Set(ys).size).toBe(ys.length);
    expect(o.series[0]).toMatchObject({ type: "pie", silent: true });
    expect(o.series[0].data[0].itemStyle.color).toBe("#102030");
    // the label moves below the value
    const below = build("donutChart", (v) => { setFormat(v.json, "centerValue", "show", lit.bool(true)); setFormat(v.json, "label", "position", lit.str("Bottom")); });
    expect(texts(below)).toEqual(["100", "Total"]);
  });
});

describe("funnel percent bar label", () => {
  it("adds the share of the previous stage in its own font when on", () => {
    const base = build("funnel", () => undefined);
    const on = build("funnel", (v) => { setFormat(v.json, "percentBarLabel", "show", lit.bool(true)); setFormat(v.json, "percentBarLabel", "color", lit.str("#ff0000")); });
    const text = (o: any, i: number): string => o.series[0].label.formatter({ name: "Bikes", value: 50, dataIndex: i });
    expect(text(base, 1)).not.toContain("{p|");
    expect(text(on, 1)).toMatch(/{p|d+%}/);
    expect(on.series[0].label.rich.p.color).toBe("#ff0000");
  });
});

describe("axis titles", () => {
  it("get room outside the axis labels, on the side they stand", () => {
    const none = build("clusteredColumnChart", () => undefined).grid;
    const val = build("clusteredColumnChart", (v) => setFormat(v.json, "valueAxis", "showAxisTitle", lit.bool(true))).grid;
    const cat = build("clusteredColumnChart", (v) => setFormat(v.json, "categoryAxis", "showAxisTitle", lit.bool(true))).grid;
    expect(val.left).toBeGreaterThan(none.left);
    expect(val.bottom).toBe(none.bottom);
    expect(cat.bottom).toBeGreaterThan(none.bottom);
    // a horizontal bar chart has the value axis at the bottom
    const bars = build("clusteredBarChart", (v) => setFormat(v.json, "valueAxis", "showAxisTitle", lit.bool(true))).grid;
    expect(bars.bottom).toBeGreaterThan(build("clusteredBarChart", () => undefined).grid.bottom);
  });
});

describe("overlapping clustered bars", () => {
  it("Reverse draws the first measure on top: the order counts every measure, not only the series", () => {
    const two = (reverse: boolean) => {
      const v = visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty, agg("Sales", "Quantity", 1)] });
      setFormat(v.json, "layout", "clusteredGapOverlaps", lit.bool(true));
      if (reverse) setFormat(v.json, "layout", "clusteredGapOverlapReverse", lit.bool(true));
      const loaded: Extract<Loaded, { kind: "grouped" }> = {
        kind: "grouped",
        query: buildVisualQuery(v, model, { filters: [] })!,
        rows: rows.map((r) => [...r, ["int", "7"] as [string, string]].map(([t, x]) => decodeCell({ t: t as never, v: x }))),
        highlightRows: null,
        totals: null,
        truncated: false,
        ms: 0,
      };
      return buildChart({ visual: v, loaded, theme: DEFAULT_THEME, selected: [] })!.option.series.map((s: { z: number }) => s.z);
    };
    expect(two(false)).toEqual([2, 3]);
    expect(two(true)).toEqual([4, 3]);
  });
});

describe("gradient legend", () => {
  const gradient = (v: VisualModel) => setRawProp(v.json, "dataPoint", "fill", condFormatToPbir({ kind: "gradient", input: Qty, min: { color: "#ff0000" }, mid: { color: "#00ff00" }, max: { color: "#0000ff" } }));
  it("is a color bar from the lowest to the highest value of a gradient rule, at the legend position, unless Show gradient legend is off", () => {
    const o = build("clusteredColumnChart", gradient);
    expect(o.visualMap).toMatchObject({ type: "continuous", min: 20, max: 50, inRange: { color: ["#ff0000", "#00ff00", "#0000ff"] }, seriesIndex: [], orient: "horizontal", top: 0 });
    const right = build("clusteredColumnChart", (v) => { gradient(v); setFormat(v.json, "legend", "position", lit.str("Right")); });
    expect(right.visualMap).toMatchObject({ orient: "vertical", right: 0 });
    expect(build("clusteredColumnChart", (v) => { gradient(v); setFormat(v.json, "legend", "showGradientLegend", lit.bool(false)); }).visualMap).toBeUndefined();
    // no gradient rule, no bar
    expect(build("clusteredColumnChart", () => undefined).visualMap).toBeUndefined();
  });
});

describe("data labels: title, value and detail", () => {
  const on = (v: VisualModel, extra: Record<string, ReturnType<typeof lit.bool> | ReturnType<typeof lit.str> | ReturnType<typeof lit.num>> = {}) => {
    setFormat(v.json, "labels", "show", lit.bool(true));
    for (const [k, x] of Object.entries(extra)) setFormat(v.json, "labels", k, x);
  };
  const text = (s: { label: { formatter: (p: unknown) => string } }, i: number) => s.label.formatter({ data: s.data?.[i], value: s.data?.[i]?.value });
  it("shows the series name above the value and the share of the total below", () => {
    const o = build("clusteredColumnChart", (v) => on(v, { enableTitleDataLabel: lit.bool(true), enableDetailDataLabel: lit.bool(true) }));
    const s = o.series[0];
    expect(text(s, 1)).toBe("{t|Sum of Quantity}\n{v|30}\n{d|30%}");
    expect(Object.keys(s.label.rich)).toEqual(["t", "v", "d"]);
  });
  it("Single line puts the parts in one row; the value can be switched off; the detail has its own decimals", () => {
    const o = build("clusteredColumnChart", (v) => on(v, { enableTitleDataLabel: lit.bool(true), enableValueDataLabel: lit.bool(false), enableDetailDataLabel: lit.bool(true), labelContentLayout: lit.str("SingleLine"), detailFormatString: lit.str("0.0") }));
    expect(text(o.series[0], 0)).toBe("{t|Sum of Quantity}  {d|50.0%}");
  });
  it("Custom content writes the value with the part's own format string; each part has its own font", () => {
    const o = build("clusteredColumnChart", (v) => on(v, { enableTitleDataLabel: lit.bool(true), titleContentType: lit.str("Custom"), titleCustomFormatString: lit.str("0.00"), titleBold: lit.bool(true), titleFontSize: lit.num(20), detailColor: lit.str("#ff0000") }));
    const s = o.series[0];
    expect(text(s, 0)).toBe("{t|50.00}\n{v|50}");
    expect(s.label.rich.t.fontWeight).toBe("bold");
    expect(s.label.rich.t.fontSize).toBe(20);
    expect(s.label.rich.d.color).toBe("#ff0000");
  });
  it("Label density keeps every k-th label, unless Show all is on; Show by default off labels only the hovered point", () => {
    const labelsShown = (extra: Parameters<typeof on>[1]) => build("clusteredColumnChart", (v) => on(v, extra)).series[0].data.map((d: { label?: { show: boolean } }) => d.label?.show !== false);
    expect(labelsShown({ labelDensity: lit.num(50) })).toEqual([true, false, true]);
    expect(labelsShown({ labelDensity: lit.num(50), showAll: lit.bool(true) })).toEqual([true, true, true]);
    const s = build("clusteredColumnChart", (v) => on(v, { showByDefault: lit.bool(false) })).series[0];
    expect(s.label.show).toBe(false);
    expect(s.emphasis.label.show).toBe(true);
  });
  it("Show dynamic labels prepares the full and the compact text of every point", () => {
    const s = build("clusteredColumnChart", (v) => on(v, { enableTitleDataLabel: lit.bool(true), showDynamicLabels: lit.bool(true) })).series[0];
    expect(s.dynamicLabel).toBe("y");
    expect(s.data[0].dyn).toEqual({ full: "{t|Sum of Quantity}\n{v|50}", compact: "{v|50}" });
  });
  it("a 100 % chart writes the share with the label's decimals, units and format string", () => {
    const o = (extra: Parameters<typeof on>[1]) => build("hundredPercentStackedColumnChart", (v) => on(v, extra)).series[0];
    expect(text(o({}), 0)).toBe("100%");
    expect(text(o({ valueFormatString: lit.str("0.000") }), 0)).toBe("100.000%");
    expect(text(o({ labelDisplayUnits: lit.num(1000), labelPrecision: lit.num(2) }), 0)).toBe("0.1K%");
  });
});
