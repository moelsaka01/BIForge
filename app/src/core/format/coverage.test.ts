// Which formatting properties a renderer really draws. For every visual type BIForge renders, every property of its
// formatting objects is set to a test value in turn, and the rendered result (the chart option, the table model, the
// container look, ...) is compared with the unformatted one: a property that never changes it is not drawn.
//
// The result is kept in rendered.json. The Format pane marks the properties that are not in it as "not drawn yet", and
// the inventory takes the status of the format cards from it. The test fails when the file is out of date; regenerate
// it with `UPDATE_RENDERED=1 npx vitest run src/core/format/coverage.test.ts` after adding renderer support.
import { describe, expect, it } from "vitest";
import rendered from "./rendered.json";
import { decodeCell, type Value } from "../report/cells";
import { buildChart } from "../report/chartOptions";
import { buildContainer } from "../report/containerModel";
import type { Loaded } from "../report/dataLoader";
import { agg, column, lit, type Lit } from "../report/fields";
import { FormatReader } from "../report/formatReader";
import { litExpr, queryRefOf } from "../report/pbir";
import { buildMatrixQuery, buildVisualQuery } from "../report/queryBuilder";
import { influencersStyle, treeStyle } from "../report/analysisStyle";
import { readSlicer } from "../report/slicerSettings";
import { buttonModel, imageModel, navigatorModel } from "../report/staticModels";
import { readShape, shapeSvg } from "../report/staticVisuals";
import { buildCard, buildKpi, buildMatrix, buildMultiRowCard, buildNewCard, buildTable } from "../report/tableModels";
import { fixtureModel, visualOf } from "../report/testFixture";
import { DEFAULT_THEME } from "../report/theme";
import { setFormat, setRawProp, type VisualModel } from "../report/visualDoc";
import { VISUAL_TYPES } from "../report/visualTypes";
import { qnaLook, savedQuestion } from "../report/qnaLook";
import { scriptSettings } from "../report/scriptVisual";
import { buildNarrative } from "../report/narrative";
import { loadGazetteer } from "../report/geo";
import caps from "./capabilities.json";
import { pageLook } from "../report/pageFormat";
import { CONTAINER_OBJECTS, visualObjects, type Kind } from "./capabilities";
import { analyticsCards } from "./engine";

const model = fixtureModel({ formats: { "Sales.Quantity": "#,0" } });
await loadGazetteer();
const Cat = column("Product", "Category");
const City = column("Customer", "City");
const Sub = column("Product", "Subcategory");
const Country = column("Customer", "Country");
const Prod = column("Product", "Product");
const Qty = agg("Sales", "Quantity", 0);
const Price = agg("Sales", "UnitPrice", 1);
const Cost = agg("Product", "ListPrice", 1);
const Ch = column("Sales", "Channel");

type Cell = [string, string];
const dec = (r: Cell[]): Value[] => r.map(([t, x]) => decodeCell({ t: t as never, v: x }));
const t = (s: string): Cell => ["text", s];
const n = (x: number): Cell => ["int", String(x)];
const d = (x: number): Cell => ["real", String(x)];

function grouped(v: VisualModel, rows: Cell[][]): Extract<Loaded, { kind: "grouped" }> {
  return { kind: "grouped", query: buildVisualQuery(v, model, { filters: [] })!, rows: rows.map(dec), highlightRows: null, totals: null, truncated: false, ms: 0 };
}

// ---- how a test value is chosen for a property --------------------------------------------------------------

function testValues(prop: string, kind: Kind): Lit[] {
  switch (kind[0]) {
    case "b":
      return [lit.bool(true), lit.bool(false)];
    case "c":
      return [lit.str("#123456")];
    case "s":
      // a dash pattern must be one to be read
      if (prop === "name") return [lit.str("Zz")]; // the Style preset card: a preset of the theme used by the container scenario
      return [lit.str(/fontFamily/i.test(prop) ? "Courier New" : /dashArray/i.test(prop) ? "4 2" : /FormatString/i.test(prop) ? "0.000" : "Zz")];
    case "f":
      return [lit.num(Math.min(kind[2], Math.max(kind[1], 20)))];
    case "n": {
      const lo = kind[1] ?? 0;
      const hi = kind[2] ?? 100;
      const base = /transparency/i.test(prop) ? 60 : Math.min(hi, Math.max(lo, 7));
      return [lit.num(base), lit.num(Math.min(hi, Math.max(lo, base === 7 ? 3 : base - 1)))];
    }
    case "e":
      return kind[1].slice(0, 14).map((v) => (typeof v === "number" ? lit.num(v) : lit.str(v)));
    default:
      return [];
  }
}

/** Switches that make the other properties of an object matter (a card whose `show` is off draws nothing). */
const ENABLE: Record<string, Record<string, Lit>> = {
  // labelStyle matters for pies (a label with the value and the percentage), and is ignored elsewhere
  labels: { show: lit.bool(true), enableBackground: lit.bool(true), labelStyle: lit.str("Data value, percent of total") },
  legend: { show: lit.bool(true), showTitle: lit.bool(true) },
  categoryAxis: { show: lit.bool(true), showAxisTitle: lit.bool(true), gridlineShow: lit.bool(true) },
  valueAxis: { show: lit.bool(true), showAxisTitle: lit.bool(true), gridlineShow: lit.bool(true), secShowAxisTitle: lit.bool(true) },
  dataPoint: { borderShow: lit.bool(true) },
  lineStyles: { strokeShow: lit.bool(true), showMarker: lit.bool(true), areaShow: lit.bool(true) },
  markers: { borderShow: lit.bool(true) },
  title: { show: lit.bool(true), text: lit.str("T") },
  subTitle: { show: lit.bool(true), text: lit.str("S") },
  background: { show: lit.bool(true) },
  border: { show: lit.bool(true) },
  dropShadow: { show: lit.bool(true) },
  divider: { show: lit.bool(true) },
  spacing: { customizeSpacing: lit.bool(true) },
  // the link needs an action for its switch and tooltips to matter
  visualLink: { type: lit.str("WebUrl") },
  fill: { show: lit.bool(true) },
  outline: { show: lit.bool(true) },
  text: { show: lit.bool(true), text: lit.str("Go") },
  icon: { show: lit.bool(true), shapeType: lit.str("leftArrow") },
  shadow: { show: lit.bool(true) },
  glow: { show: lit.bool(true) },
  image: { strokeShow: lit.bool(true), backgroundEnabled: lit.bool(true), effects: lit.bool(true), cornerRadiusAdvanced: lit.bool(true), sourceUrl: lit.str("data:image/png;base64,AA") },
  grid: { gridHorizontal: lit.bool(true), gridVertical: lit.bool(true) },
  values: { backColorSecondary: lit.str("#654321") },
  header: { show: lit.bool(true) },
  categoryLabels: { show: lit.bool(true), enableBackground: lit.bool(true) },
  calloutValue: { show: lit.bool(true) },
  target: { show: lit.bool(true) },
  goals: { showGoal: lit.bool(true), showDistance: lit.bool(true) },
  trendline: { show: lit.bool(true) },
  trend: { show: lit.bool(true) },
  card: { barShow: lit.bool(true) },
  accentBar: { show: lit.bool(true) },
  subTotals: { rowSubtotals: lit.bool(true), columnSubtotals: lit.bool(true) },
  heatMap: { show: lit.bool(true) },
  zoom: { show: lit.bool(true) },
  plotArea: { url: lit.str("data:image/png;base64,AA"), color: lit.str("#abcdef") },
  smallMultiplesLayout: { backgroundColor: lit.str("#eeeeee") },
};

/** Properties that only matter together with another one. */
const WITH: Record<string, Record<string, Record<string, Lit>>> = {
  // custom spacing only replaces the default gaps once the switch is on
  spacing: { customizeSpacing: { spaceBelowTitle: lit.num(9) } },
  valueAxis: { labelDisplayUnits: { labelPrecision: lit.num(2) } },
  // the picture of the plot area comes from the data address when the source says so
  plotArea: { imageData: { sourceType: lit.str("imageData") } },
  labels: { labelDisplayUnits: { labelPrecision: lit.num(2) } },
  mapControls: { zoomLevel: { autoZoom: lit.bool(false) } },
  smallMultiplesLayout: { columnCount: { layoutType: lit.str("custom") }, rowCount: { layoutType: lit.str("custom") } },
  visualLink: {
    webUrl: { type: lit.str("WebUrl") },
    bookmark: { type: lit.str("Bookmark") },
    navigationSection: { type: lit.str("PageNavigation") },
    drillthroughSection: { type: lit.str("Drillthrough") },
  },
};

// ---- what to render, per visual type -------------------------------------------------------------------------

const catRows: Cell[][] = [
  [t("Accessories"), t("France"), n(30)],
  [t("Bikes"), t("France"), n(50)],
  [t("Bikes"), t("Canada"), n(70)],
  [t("Accessories"), t("Canada"), n(10)],
];

interface Scenario {
  make(): VisualModel;
  /** Applies instance data (selector ids, type) before the property under test. */
  render(v: VisualModel): unknown;
}

const chart = (type: string, roles: Record<string, ReturnType<typeof column>[] | (typeof Qty)[]>, rows: Cell[][]): Scenario => ({
  make: () => visualOf(type, roles as never),
  render: (v) => buildChart({ visual: v, loaded: grouped(v, rows), theme: DEFAULT_THEME, selected: [] }),
});

const matrixParts: Cell[][][] = [
  [[n(100)]],
  [[t("Online"), n(70)], [t("Store"), n(30)]],
  [[t("Bikes"), n(60)], [t("Clothing"), n(40)]],
  [[t("Bikes"), t("Online"), n(40)], [t("Bikes"), t("Store"), n(20)], [t("Clothing"), t("Online"), n(30)], [t("Clothing"), t("Store"), n(10)]],
  [[t("Bikes"), t("France"), n(25)], [t("Bikes"), t("Canada"), n(35)], [t("Clothing"), t("France"), n(40)]],
  [[t("Bikes"), t("France"), t("Online"), n(15)], [t("Bikes"), t("France"), t("Store"), n(10)], [t("Bikes"), t("Canada"), t("Online"), n(25)], [t("Bikes"), t("Canada"), t("Store"), n(10)], [t("Clothing"), t("France"), t("Online"), n(30)], [t("Clothing"), t("France"), t("Store"), n(10)]],
];

const SCENARIOS: Record<string, Scenario> = {
  clusteredColumnChart: chart("clusteredColumnChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  clusteredBarChart: chart("clusteredBarChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  columnChart: chart("columnChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  barChart: chart("barChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  hundredPercentStackedColumnChart: chart("hundredPercentStackedColumnChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  hundredPercentStackedBarChart: chart("hundredPercentStackedBarChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  lineChart: chart("lineChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  areaChart: chart("areaChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  stackedAreaChart: chart("stackedAreaChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  hundredPercentStackedAreaChart: chart("hundredPercentStackedAreaChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  ribbonChart: chart("ribbonChart", { Category: [Cat], Series: [Country], Y: [Qty] }, catRows),
  lineClusteredColumnComboChart: chart("lineClusteredColumnComboChart", { Category: [Cat], Y: [Qty], Y2: [Price] }, [[t("Accessories"), n(30), d(2.5)], [t("Bikes"), n(50), d(3.5)], [t("Shoes"), n(20), d(1.5)]]),
  lineStackedColumnComboChart: chart("lineStackedColumnComboChart", { Category: [Cat], Y: [Qty], Y2: [Price] }, [[t("Accessories"), n(30), d(2.5)], [t("Bikes"), n(50), d(3.5)], [t("Shoes"), n(20), d(1.5)]]),
  pieChart: chart("pieChart", { Category: [Cat], Y: [Qty] }, [[t("Accessories"), n(30)], [t("Bikes"), n(50)], [t("Shoes"), n(20)]]),
  donutChart: chart("donutChart", { Category: [Cat], Y: [Qty] }, [[t("Accessories"), n(30)], [t("Bikes"), n(50)], [t("Shoes"), n(20)]]),
  funnel: chart("funnel", { Category: [Cat], Y: [Qty] }, [[t("Accessories"), n(30)], [t("Bikes"), n(50)], [t("Shoes"), n(20)]]),
  treemap: chart("treemap", { Group: [Cat, Sub], Values: [Qty] }, [[t("Bikes"), t("Road"), n(30)], [t("Bikes"), t("Mountain"), n(50)], [t("Shoes"), t("Run"), n(20)]]),
  scatterChart: chart("scatterChart", { Category: [Prod], Series: [Country], X: [Cost], Y: [Price], Size: [Qty] }, [[t("A"), t("France"), d(3), d(4), n(5)], [t("B"), t("Canada"), d(6), d(1), n(9)], [t("C"), t("France"), d(8), d(7), n(2)]]),
  map: chart("map", { Category: [City], Series: [Country], Size: [Qty] }, [[t("Seattle"), t("United States"), n(30)], [t("Lyon"), t("France"), n(50)], [t("Paris"), t("France"), n(70)], [t("Toronto"), t("Canada"), n(10)]]),
  shapeMap: chart("shapeMap", { Category: [Country], Size: [Qty] }, [[t("France"), n(30)], [t("Canada"), n(50)], [t("Germany"), n(20)]]),
  filledMap: chart("filledMap", { Category: [Country], Size: [Qty] }, [[t("France"), n(30)], [t("Canada"), n(50)], [t("Germany"), n(20)]]),
  waterfallChart: chart("waterfallChart", { Category: [Cat], Y: [Qty] }, [[t("Accessories"), n(30)], [t("Bikes"), n(-50)], [t("Shoes"), n(20)]]),
  gauge: chart("gauge", { Y: [Qty], TargetValue: [Price] }, [[n(60), d(80)]]),
  tableEx: {
    make: () => visualOf("tableEx", { Values: [Cat, Qty, Country] }),
    render: (v) => buildTable(v, grouped(v, [[t("Bikes"), n(1234), t("France")], [t("Clothing"), n(5), t("Canada")], [t("Shoes"), n(77), t("France")]]), DEFAULT_THEME, dec([n(1316)])),
  },
  pivotTable: {
    make: () => visualOf("pivotTable", { Rows: [Cat, Country], Columns: [Ch], Values: [Qty] }),
    render: (v) => buildMatrix(v, matrixParts.map((p) => p.map(dec)), buildMatrixQuery(v, model, { filters: [] })!, DEFAULT_THEME, new Set()),
  },
  card: { make: () => visualOf("card", { Values: [Qty] }), render: (v) => buildCard(v, grouped(v, [[n(1234567)]]), DEFAULT_THEME) },
  cardVisual: { make: () => visualOf("cardVisual", { Data: [Qty, Price] }), render: (v) => buildNewCard(v, grouped(v, [[n(1234567), d(3.5)]]), DEFAULT_THEME) },
  aiNarratives: { make: () => visualOf("aiNarratives", { Category: [Cat], Values: [Qty] }), render: (v) => buildNarrative(v, grouped(v, [[t("Bikes"), n(60)], [t("Clothing"), n(40)]]), DEFAULT_THEME) },
  qnaVisual: { make: () => visualOf("qnaVisual", {}), render: (v) => [qnaLook(v, DEFAULT_THEME), savedQuestion(v)] },
  scriptVisual: { make: () => visualOf("scriptVisual", { Values: [Cat, Qty] }), render: (v) => scriptSettings(v) },
  pythonVisual: { make: () => visualOf("pythonVisual", { Values: [Cat, Qty] }), render: (v) => scriptSettings(v) },
  multiRowCard: { make: () => visualOf("multiRowCard", { Values: [Cat, Qty] }), render: (v) => buildMultiRowCard(v, grouped(v, [[t("Bikes"), n(5)], [t("Clothing"), n(7)]]), DEFAULT_THEME) },
  kpi: {
    make: () => visualOf("kpi", { Indicator: [Qty], TrendLine: [column("Date", "YearMonth")], Goal: [agg("Sales", "Quantity", 4)] }),
    render: (v) => buildKpi(v, grouped(v, [[n(202401), n(80), n(100)], [n(202402), n(120), n(100)]]), DEFAULT_THEME),
  },
  decompositionTreeVisual: { make: () => visualOf("decompositionTreeVisual", { Analyze: [Qty], ExplainBy: [Cat] }), render: (v) => treeStyle(new FormatReader(v.json, DEFAULT_THEME, "decompositionTreeVisual"), DEFAULT_THEME) },
  keyDriversVisual: { make: () => visualOf("keyDriversVisual", { Target: [Ch], ExplainBy: [Cat] }), render: (v) => influencersStyle(new FormatReader(v.json, DEFAULT_THEME, "keyDriversVisual")) },
  slicer: { make: () => visualOf("slicer", { Values: [Country] }), render: (v) => readSlicer(new FormatReader(v.json, DEFAULT_THEME, "slicer"), false) },
  advancedSlicerVisual: { make: () => visualOf("advancedSlicerVisual", { Values: [Country] }), render: (v) => readSlicer(new FormatReader(v.json, DEFAULT_THEME, v.visualType), false, false, v.visualType) },
  listSlicer: { make: () => visualOf("listSlicer", { Values: [Country] }), render: (v) => readSlicer(new FormatReader(v.json, DEFAULT_THEME, v.visualType), false, false, v.visualType) },
  textSlicer: { make: () => visualOf("textSlicer", { Values: [Country] }), render: (v) => readSlicer(new FormatReader(v.json, DEFAULT_THEME, v.visualType), false, false, v.visualType) },
  shape: {
    make: () => visualOf("shape", {}),
    render: (v) => {
      const f = new FormatReader(v.json, DEFAULT_THEME, "shape");
      return shapeSvg(readShape(f), 200, 100);
    },
  },
  actionButton: { make: () => visualOf("actionButton", {}), render: (v) => buttonModel(new FormatReader(v.json, DEFAULT_THEME, "actionButton"), DEFAULT_THEME, 160, 40, false, true) },
  pageNavigator: {
    make: () => visualOf("pageNavigator", {}),
    render: (v) => {
      const m = navigatorModel(new FormatReader(v.json, DEFAULT_THEME, "pageNavigator"), DEFAULT_THEME, 400, 40);
      return { c: m.container, on: m.entry(true), off: m.entry(false), h: m.showHidden };
    },
  },
  bookmarkNavigator: {
    make: () => visualOf("bookmarkNavigator", {}),
    render: (v) => {
      const m = navigatorModel(new FormatReader(v.json, DEFAULT_THEME, "bookmarkNavigator"), DEFAULT_THEME, 400, 40);
      return { c: m.container, on: m.entry(true), off: m.entry(false) };
    },
  },
  image: { make: () => visualOf("image", {}), render: (v) => imageModel(new FormatReader(v.json, DEFAULT_THEME, "image"), 200, 100) },
};

/** The chart types that can be split into small multiples, measured with a small multiples field bound. */
const SM_TYPES = ["clusteredColumnChart", "clusteredBarChart", "columnChart", "barChart", "hundredPercentStackedColumnChart", "hundredPercentStackedBarChart", "lineChart", "areaChart", "stackedAreaChart", "hundredPercentStackedAreaChart"];
const smScenario = (type: string): Scenario => ({
  make: () => visualOf(type, { Category: [Cat], Series: [Country], Rows: [Ch], Y: [Qty] }),
  render: (v) =>
    buildChart({
      visual: v,
      loaded: grouped(v, [[t("A"), t("France"), t("Online"), n(30)], [t("B"), t("France"), t("Online"), n(10)], [t("A"), t("Canada"), t("Store"), n(50)], [t("B"), t("Canada"), t("Store"), n(70)], [t("A"), t("France"), t("Phone"), n(5)]]),
      theme: DEFAULT_THEME,
      selected: [],
    }),
});

/** A theme that defines a preset (named like the test value of the Style preset card) for every visual, so that choosing it changes the look. */
const PRESET_THEME = { ...DEFAULT_THEME, visualStyles: { "*": { Zz: { background: [{ show: false }] } } } };

/** Same function for every visual type: the look of the container. */
const containerScenario: Scenario = {
  // a title, a subtitle and a divider are on, so that the spacing between them can be seen
  make: () => {
    const v = visualOf("clusteredColumnChart", { Category: [Cat], Y: [Qty] });
    setFormat(v.json, "subTitle", "show", lit.bool(true));
    setFormat(v.json, "subTitle", "text", lit.str("Sub"));
    setFormat(v.json, "divider", "show", lit.bool(true));
    return v;
  },
  render: (v) =>
    buildContainer({
      f: new FormatReader(v.json, PRESET_THEME, v.visualType),
      theme: PRESET_THEME,
      autoTitle: "Auto",
      titleByDefault: true,
      noAutoText: false,
      // a visual in a situation where every header button applies: two drill hierarchies, filters, something to say
      header: { drillRoles: ["Rows", "Columns"], filters: 2, focusable: true, tabular: true, status: { information: "i", warning: "w", error: "e" } },
    }),
};

// ---- probing a result ---------------------------------------------------------------------------------------------

const SAMPLE_ARGS: unknown[] = [
  1234567.891,
  { value: 1234567.891, name: "N", data: { raw: 1234567.891, value: 1234567.891 }, seriesName: "S", marker: "", dataIndex: 1 },
  [{ value: 5, name: "N", data: { raw: 5, value: 5 }, seriesName: "S", seriesIndex: 0, marker: "" }],
  [10, 20, 50, "L"], // a point of a scatter or bubble series: x, y, size, label
];

/** A comparable text of a result: functions are replaced by what they return for sample arguments. */
function probe(x: unknown, depth = 0): unknown {
  if (depth > 12) return "…";
  if (typeof x === "function") {
    return SAMPLE_ARGS.map((a) => {
      try {
        const r = (x as (a: unknown) => unknown)(a);
        return typeof r === "object" ? JSON.stringify(r) : String(r);
      } catch {
        return "err";
      }
    });
  }
  if (Array.isArray(x)) return x.map((y) => probe(y, depth + 1));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, probe(v, depth + 1)]));
  return x;
}
const same = (a: unknown, b: unknown) => JSON.stringify(probe(a)) === JSON.stringify(probe(b));

// ---- the measurement --------------------------------------------------------------------------------------------

type Coverage = Record<string, Record<string, string[]>>;

/** Applies instance data for analytics objects (selector id and type) so the card has something to draw. */
function setProp(v: VisualModel, object: string, prop: string, value: Lit, selector?: string): void {
  setFormat(v.json, object, prop, value, selector);
}

function measure(scenarioOf: Scenario, visualType: string, objects: string[]): Record<string, string[]> {
  const caps = visualObjects(visualType)!;
  const out: Record<string, string[]> = {};
  for (const object of objects) {
    const props = caps[object];
    if (!props) continue;
    const instances: { selector?: string; extra: [string, Lit][] }[] =
      object === "y1AxisReferenceLine"
        ? [{ selector: "id:constant", extra: [["show", lit.bool(true)], ["value", lit.num(25)], ["shadeShow", lit.bool(true)], ["shadeRegion", lit.str("before")], ["dataLabelShow", lit.bool(true)]] }]
        : object === "referenceLine"
          ? [{ selector: "id:average", extra: [["show", lit.bool(true)], ["type", lit.str("Average")], ["shadeShow", lit.bool(true)], ["shadeRegion", lit.str("after")], ["dataLabelShow", lit.bool(true)]] }]
          : [{ extra: [] }];
    for (const inst of instances) {
      const prepare = (v: VisualModel, skip: string) => {
        for (const [k, val] of Object.entries(ENABLE[object] ?? {})) if (k !== skip) setProp(v, object, k, val, inst.selector);
        for (const [k, val] of inst.extra) if (k !== skip) setProp(v, object, k, val, inst.selector);
      };
      for (const [prop, kind] of Object.entries(props)) {
        if (kind[0] === "x") continue;
        const base = scenarioOf.make();
        prepare(base, prop);
        const baseline = scenarioOf.render(base);
        let drawn = false;
        for (const value of testValues(prop, kind)) {
          const v = scenarioOf.make();
          prepare(v, prop);
          for (const [k, val] of Object.entries(WITH[object]?.[prop] ?? {})) setProp(v, object, k, val, inst.selector);
          setProp(v, object, prop, value, inst.selector);
          if (WITH[object]?.[prop]) {
            const b2 = scenarioOf.make();
            prepare(b2, prop);
            for (const [k, val] of Object.entries(WITH[object][prop])) setProp(b2, object, k, val, inst.selector);
            if (!same(scenarioOf.render(v), scenarioOf.render(b2))) drawn = true;
          } else if (!same(scenarioOf.render(v), baseline)) drawn = true;
          if (drawn) break;
        }
        if (drawn) (out[object] ??= []).push(prop);
      }
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

/** The page cards (background, wallpaper, page alignment): each property is set on page.json and the page look compared. */
function measurePage(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const cardIds = (caps as unknown as { visuals: Record<string, Record<string, string>>; cards: Record<string, Record<string, Kind>> });
  for (const [object, id] of Object.entries(cardIds.visuals.page)) {
    if (!["background", "outspace", "displayArea"].includes(object)) continue;
    for (const [prop, kind] of Object.entries(cardIds.cards[id])) {
      if (kind[0] === "x") continue;
      const baseline = JSON.stringify(pageLook({ name: "p" }));
      for (const value of testValues(prop, kind)) {
        const json: Record<string, unknown> = { name: "p", objects: { [object]: [{ properties: { [prop]: litExpr(value) } }] } };
        if (JSON.stringify(pageLook(json)) !== baseline) {
          (out[object] ??= []).push(prop);
          break;
        }
      }
    }
  }
  // a picture is stored as an image object (name, url, scaling), which the capability list marks as not editable in the generic pane
  for (const object of ["background", "outspace"]) {
    const json = { name: "p", objects: { [object]: [{ properties: { image: { image: { name: litExpr(lit.str("a")), url: litExpr(lit.str("data:image/png;base64,AA")), scaling: litExpr(lit.str("Fit")) } } } }] } };
    if (JSON.stringify(pageLook(json)) !== JSON.stringify(pageLook({ name: "p" }))) (out[object] ??= []).push("image");
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

function computeAll(): Coverage {
  const result: Coverage = {};
  const containerNames = [...CONTAINER_OBJECTS, "general"];
  // container objects: drawn for every visual type, so the intersection over the types counts
  let common: Record<string, string[]> | null = null;
  for (const vt of VISUAL_TYPES) {
    if (!visualObjects(vt.id)) continue;
    const m = measure(containerScenario, vt.id, containerNames);
    if (!common) common = m;
    else for (const o of Object.keys(common)) common[o] = (common[o] ?? []).filter((p) => m[o]?.includes(p));
    if (vt.id === "clusteredColumnChart") break; // the container model does not depend on the type
  }
  if (common) result["*"] = Object.fromEntries(Object.entries(common).filter(([, ps]) => ps.length > 0));
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    const objs = Object.keys(visualObjects(id) ?? {}).filter((o) => !CONTAINER_OBJECTS.has(o) && o !== "actionButtonSection");
    const own = measure(sc, id, objs);
    if (SM_TYPES.includes(id)) Object.assign(own, measure(smScenario(id), id, ["smallMultiplesLayout", "subheader"]));
    if (Object.keys(own).length) result[id] = own;
  }
  result.page = measurePage();
  return result;
}

const UPDATE = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.UPDATE_RENDERED === "1";

describe("rendered coverage", () => {
  const computed = computeAll();

  it("every authored visual type is measured", () => {
    const measured = new Set(Object.keys(SCENARIOS));
    const missing = VISUAL_TYPES.map((t) => t.id).filter((id) => !measured.has(id) && id !== "textbox");
    expect(missing).toEqual([]);
  });

  it.skipIf(!UPDATE)("writes rendered.json", async () => {
    const fsName = "node:fs";
    const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync(path: string, data: string): void };
    fs.writeFileSync("src/core/format/rendered.json", JSON.stringify(computed, null, 1) + "\n");
  });

  it.skipIf(UPDATE)("rendered.json is up to date", () => {
    expect(JSON.parse(JSON.stringify(computed))).toEqual(rendered);
  });

  it("the container look is drawn for the usual properties", () => {
    const star = (computed["*"] ?? {}) as Record<string, string[]>;
    expect(star.title).toEqual(expect.arrayContaining(["show", "text", "fontSize", "fontColor", "bold", "alignment", "background"]));
    expect(star.border).toEqual(expect.arrayContaining(["show", "color", "radius", "width"]));
    expect(star.general).toContain("altText");
  });

  // The inventory counts "Theme default style" as done for every authored visual type (tools/inventory/build.mjs): this is the test.
  it("the theme's default style of a visual type (visualStyles.<type>.*) and the one for every type (visualStyles.*.*) are used by every authored visual type", () => {
    for (const vt of VISUAL_TYPES) {
      for (const key of [vt.id, "*"]) {
        const theme = { ...DEFAULT_THEME, visualStyles: { [key]: { "*": { title: [{ show: true, text: "From the theme" }], border: [{ show: true, radius: 7 }] } } } };
        const v = visualOf(vt.id, {});
        const m = buildContainer({ f: new FormatReader(v.json, theme, vt.id), theme, autoTitle: "Auto", titleByDefault: false, noAutoText: false });
        expect(m.title?.text, `${vt.id} / ${key}`).toBe("From the theme");
        expect(m.look.borderRadius, `${vt.id} / ${key}`).toBe(7);
        // the visual's own setting wins
        const own = visualOf(vt.id, {});
        setFormat(own.json, "title", "text", lit.str("Own"));
        expect(buildContainer({ f: new FormatReader(own.json, theme, vt.id), theme, autoTitle: "", titleByDefault: false, noAutoText: true }).title?.text).toBe("Own");
      }
    }
  });

  it("charts draw their legend, axes and labels", () => {
    const col = computed.clusteredColumnChart as Record<string, string[]>;
    expect(col.legend).toEqual(expect.arrayContaining(["show", "position", "labelColor", "fontSize"]));
    expect(col.valueAxis).toEqual(expect.arrayContaining(["start", "end", "labelDisplayUnits", "titleText"]));
    expect(col.labels).toEqual(expect.arrayContaining(["show", "color", "labelPosition"]));
  });
});

// keep the unused helpers referenced (used by scenario definitions in some branches)
void queryRefOf;
void litExpr;
void setRawProp;
void analyticsCards;
