// The bubble map and the filled map as ECharts options, drawn from the bundled Natural Earth outlines (no online tiles).
// Locations are found in the gazetteer by name (Category) or taken from longitude and latitude values (X and Y of the
// bubble map). A label the data does not know is not drawn and is listed in `notice`.
import { labelOf, columnsOf, num as valueNum, valueToLit } from "./chartData";
import { legendBlock, valueText, labelDefaults } from "./chartFormat";
import type { ChartBuild, ChartInput } from "./chartOptions";
import { FormatReader } from "./formatReader";
import type { Gazetteer, Place } from "./geo";
import { echartsText, opacityOf, readFont } from "../format/styles";
import { seriesColor } from "./theme";
import type { O } from "./chartFormat";
import type { Value } from "./cells";

interface MapTheme {
  sea: string;
  land: string;
  border: string;
  text: string;
}

/** The map styles of the format pane drawn as flat colors: there is no tile service to ask for imagery. */
const MAP_THEMES: Record<string, MapTheme> = {
  canvasLight: { sea: "#f4f6f8", land: "#e1e5e9", border: "#ffffff", text: "#444444" },
  canvasDark: { sea: "#1b232c", land: "#2c3844", border: "#1b232c", text: "#c8d0d8" },
  grayscale: { sea: "#ffffff", land: "#d6d6d6", border: "#ffffff", text: "#444444" },
  aerial: { sea: "#1d4e7a", land: "#587a49", border: "#3d5a33", text: "#ffffff" },
  road: { sea: "#cfe2f3", land: "#f1eee6", border: "#d9d4c7", text: "#555555" },
};

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `t` of the way from `from` to `to` (0: from). Colors that are not #rgb or #rrggbb stay `to`. */
export function mixColor(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return to;
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** The zoom that fits the points on the world map (1: the whole world), and the center to put them in the middle. */
export function fitView(points: { lon: number; lat: number }[]): { center: [number, number]; zoom: number } {
  if (points.length === 0) return { center: [0, 20], zoom: 1 };
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  const [w, e, s, n] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const span = Math.max((e - w) * 1.5, (n - s) * 2.2, 8);
  return { center: [(w + e) / 2, (s + n) / 2], zoom: Math.min(12, Math.max(1, 360 / span)) };
}

interface Located {
  place: Place | null;
  lon: number;
  lat: number;
  label: string;
  row: Value[];
}

function summary(missing: string[]): string | undefined {
  if (missing.length === 0) return undefined;
  const shown = missing.slice(0, 5).join(", ");
  return `${missing.length} location${missing.length === 1 ? "" : "s"} not drawn (unknown place, or another kind of region than the map shows): ${shown}${missing.length > 5 ? ", …" : ""}`;
}

export function mapGeo(f: FormatReader, themeKey: string, points: { lon: number; lat: number }[], showNames: boolean, region: string): O {
  const mt = MAP_THEMES[themeKey] ?? MAP_THEMES.canvasLight;
  const fit = fitView(points);
  const auto = f.bool("mapControls", "autoZoom", true);
  const hasCenter = f.has("mapControls", "centerLongitude") || f.has("mapControls", "centerLatitude");
  const center: [number, number] = hasCenter || !auto ? [f.num("mapControls", "centerLongitude", fit.center[0]), f.num("mapControls", "centerLatitude", fit.center[1])] : fit.center;
  const zoom = f.has("mapControls", "zoomLevel") && !auto ? f.num("mapControls", "zoomLevel", 1) : auto ? fit.zoom : 1;
  return {
    map: region,
    roam: true,
    center,
    zoom: Math.min(f.num("mapControls", "maxZoom", 20), Math.max(f.num("mapControls", "minZoom", 1), zoom)),
    scaleLimit: { min: f.num("mapControls", "minZoom", 1), max: f.num("mapControls", "maxZoom", 20) },
    itemStyle: { areaColor: mt.land, borderColor: mt.border, borderWidth: 0.5 },
    emphasis: { disabled: true },
    label: { show: showNames, color: mt.text, fontSize: 9 },
    select: { disabled: true },
  };
}

function locate(inp: ChartInput, gaz: Gazetteer, regions: ("country" | "state" | "city")[]): { rows: Located[]; missing: string[]; q: ChartInput["loaded"]["query"] } {
  const q = inp.loaded.query;
  const cat = columnsOf(q, "Category", "group")[0];
  const xc = columnsOf(q, "X", "value")[0];
  const yc = columnsOf(q, "Y", "value")[0];
  const rows: Located[] = [];
  const missing = new Set<string>();
  for (const row of inp.loaded.rows) {
    const label = cat ? labelOf(row[cat.index], cat.format) : "";
    const lonLat = inp.visual.visualType === "map" && xc && yc ? [valueNum(row[xc.index]), valueNum(row[yc.index])] : null;
    if (lonLat && lonLat[0] !== null && lonLat[1] !== null && Math.abs(lonLat[0]) <= 180 && Math.abs(lonLat[1]) <= 90) {
      rows.push({ place: null, lon: lonLat[0], lat: lonLat[1], label, row });
      continue;
    }
    const place = label ? gaz.resolve(label, regions) : null;
    if (place) rows.push({ place, lon: place.lon, lat: place.lat, label, row });
    else if (label) missing.add(label);
  }
  return { rows, missing: [...missing], q };
}

/** The zoom and lasso buttons the Format pane asks for (off by default, like Desktop's). */
function mapTools(f: FormatReader, points: NonNullable<ChartBuild["mapTools"]>["points"]): ChartBuild["mapTools"] {
  const zoom = f.bool("mapControls", "showZoomButtons", false);
  const lasso = f.bool("mapControls", "showLassoButton", false);
  return zoom || lasso ? { zoom, lasso, points } : undefined;
}

/** Meters on the ground per screen pixel of the world map drawn about 800 pixels wide at zoom 1. */
const METERS_PER_PIXEL = 40075016 / 800;

function heatLayer(f: FormatReader, data: number[][], vmin: number, vmax: number, hasSize: boolean): { series: O; visualMap: O } {
  const unit = f.str("heatMap", "unit", "pixels");
  const radius = Math.max(2, f.num("heatMap", "filterRadius", 20));
  const zoom = Math.max(1, f.num("mapControls", "zoomLevel", 1));
  const px = unit === "meters" ? Math.max(2, radius / (METERS_PER_PIXEL / zoom)) : radius;
  const c0 = f.color("heatMap", "color0") ?? "#2b83ba";
  const c50 = f.color("heatMap", "color50") ?? "#ffffbf";
  const c100 = f.color("heatMap", "color100") ?? "#d7191c";
  return {
    series: { type: "heatmap", coordinateSystem: "geo", data, pointSize: px, blurSize: px, itemStyle: { opacity: opacityOf(f.num("heatMap", "transparency", 0)) } },
    visualMap: { show: false, min: hasSize ? vmin : 0, max: hasSize ? Math.max(vmax, vmin + 1e-9) : 1, calculable: false, inRange: { color: [c0, c50, c100] } },
  };
}

// ---- bubble map ----------------------------------------------------------------------------------------------

export function bubbleMap(inp: ChartInput, gaz: Gazetteer): ChartBuild {
  const { visual, theme } = inp;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const { rows, missing, q } = locate(inp, gaz, ["country", "state", "city"]);
  const cat = columnsOf(q, "Category", "group")[0];
  const ser = columnsOf(q, "Series", "group")[0];
  const sc = columnsOf(q, "Size", "value")[0];
  const sizes = rows.map((r) => (sc ? (valueNum(r.row[sc.index]) ?? 0) : 0));
  const [smin, smax] = sizes.length ? [Math.min(...sizes), Math.max(...sizes)] : [0, 0];
  const range = f.str("bubbles", "markerRangeType", "auto");
  const scale = f.num("bubbles", "bubbleSize", 10) / 10;
  const radius = (v: number): number => {
    if (!sc) return 10 * scale;
    const t = smax === smin ? 0.5 : range === "magnitude" ? Math.sqrt(Math.max(0, v) / Math.max(1e-9, smax)) : (v - smin) / (smax - smin);
    return (6 + t * 30) * scale;
  };
  const bySeries = new Map<string, { name: string; items: { r: Located; i: number }[] }>();
  rows.forEach((r, i) => {
    const key = ser ? r.row[ser.index].text : "";
    const s = bySeries.get(key) ?? { name: ser ? labelOf(r.row[ser.index], ser.format) : (sc?.label ?? cat?.label ?? ""), items: [] };
    s.items.push({ r, i });
    bySeries.set(key, s);
  });
  const list = [...bySeries.values()];
  const alpha = opacityOf(f.num("dataPoint", "transparency", 20));
  const labelFont = readFont(f, "categoryLabels", { color: "color" });
  const showLabels = f.bool("categoryLabels", "show", false);
  const themeKey = f.str("mapStyles", "mapTheme", "canvasLight");
  const series = list.map((s, si) => {
    const color = f.color("dataPoint", "fill", s.name) ?? f.color("dataPoint", "defaultColor") ?? seriesColor(theme, si);
    return {
      name: s.name,
      type: "scatter",
      coordinateSystem: "geo",
      itemStyle: { color, opacity: alpha, borderColor: color, borderWidth: 1 },
      symbolSize: (d: number[]) => radius(d[2]),
      label: { show: showLabels, formatter: (pa: O) => String(pa.data[3] ?? ""), position: "right", ...echartsText(labelFont, labelDefaults(theme)) },
      data: s.items.map(({ r }) => [r.lon, r.lat, sc ? (valueNum(r.row[sc.index]) ?? 0) : 0, r.label]),
    };
  });
  const hasSeries = !!ser;
  // the heat map layer replaces the bubbles: the density of the size values (or of the places when there is no size)
  const heatOn = f.bool("heatMap", "show", false);
  const heat = heatOn ? heatLayer(f, rows.map((r, i) => [r.lon, r.lat, sizes[i] || (sc ? 0 : 1)]), smin, smax, !!sc) : null;
  const option: O = {
    animation: false,
    legend: heat ? { show: false } : legendBlock(f, theme, hasSeries),
    tooltip: { trigger: "item", confine: true, formatter: (pa: O) => `${pa.marker}${pa.data[3] || pa.seriesName}${sc ? `<br/>${sc.label}: <b>${valueText(pa.data[2], sc.format ?? null, f, "labels")}</b>` : ""}` },
    geo: mapGeo(f, themeKey, rows, f.bool("mapStyles", "showLabels", false), "world"),
    backgroundColor: (MAP_THEMES[themeKey] ?? MAP_THEMES.canvasLight).sea,
    series: heat ? [heat.series] : series,
    ...(heat ? { visualMap: heat.visualMap } : {}),
  };
  const points: NonNullable<ChartBuild["mapTools"]>["points"] = [];
  list.forEach((s, si) => s.items.forEach(({ r }, di) => points.push({ series: si, index: di, lon: r.lon, lat: r.lat })));
  return {
    option,
    count: rows.length,
    notice: summary(missing),
    mapTools: mapTools(f, heat ? [] : points),
    pointAt: (si, di) => {
      const it = list[si]?.items[di]?.r;
      if (!it || !cat) return null;
      const fields = [cat.field];
      const values = [valueToLit(it.row[cat.index])];
      if (ser) (fields.push(ser.field), values.push(valueToLit(it.row[ser.index])));
      return { fields, values };
    },
  };
}

// ---- filled map ----------------------------------------------------------------------------------------------

export function filledMap(inp: ChartInput, gaz: Gazetteer): ChartBuild {
  const { visual, theme } = inp;
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const { rows, missing, q } = locate(inp, gaz, ["country", "state"]);
  const cat = columnsOf(q, "Category", "group")[0];
  const vc = columnsOf(q, visual.visualType === "shapeMap" ? "Y" : "Size", "value")[0];
  // one kind of region per map: the kind most of the locations are
  const nStates = rows.filter((r) => r.place?.kind === "state").length;
  const kind = nStates > rows.length - nStates ? "state" : "country";
  const used = rows.filter((r) => r.place?.kind === kind);
  const dropped = rows.filter((r) => r.place?.kind !== kind).map((r) => r.label);
  const values = used.map((r) => (vc ? valueNum(r.row[vc.index]) : null));
  const nums = values.filter((v): v is number => v !== null);
  const [vmin, vmax] = nums.length ? [Math.min(...nums), Math.max(...nums)] : [0, 0];
  const themeKey = f.str("mapStyles", "mapTheme", "canvasLight");
  const mt = MAP_THEMES[themeKey] ?? MAP_THEMES.canvasLight;
  const base = f.color("dataPoint", "defaultColor") ?? seriesColor(theme, 0);
  const alpha = opacityOf(f.num("dataPoint", "transparency", 0));
  const strokeOn = f.bool("stroke", "show", true);
  const strokeColor = f.color("stroke", "strokeColor") ?? mt.border;
  const strokeWidth = f.num("stroke", "strokeWidth", 1);
  const showLabels = f.bool("labels", "show", false) || f.bool("categoryLabels", "show", false);
  const labelFont = readFont(f, f.bool("labels", "show", false) ? "labels" : "categoryLabels", { color: "color" });
  const data = used.map((r, i) => {
    const v = values[i];
    const t = v === null || vmax === vmin ? 1 : 0.2 + 0.8 * ((v - vmin) / (vmax - vmin));
    const own = f.color("dataPoint", "fill", r.label);
    return { name: r.place!.region!, value: v ?? 0, label: r.label, itemStyle: { areaColor: own ?? mixColor(mt.land, base, vc ? t : 1), opacity: alpha, borderColor: strokeOn ? strokeColor : "transparent", borderWidth: strokeOn ? strokeWidth : 0 } };
  });
  const option: O = {
    animation: false,
    tooltip: { trigger: "item", confine: true, formatter: (pa: O) => `${pa.data?.label ?? pa.name}${vc && pa.data ? `<br/>${vc.label}: <b>${valueText(pa.data.value, vc.format ?? null, f, "labels")}</b>` : ""}` },
    backgroundColor: mt.sea,
    series: [
      {
        type: "map",
        map: kind === "state" ? "states" : "world",
        ...mapGeo(f, themeKey, used, false, kind === "state" ? "states" : "world"),
        label: { show: showLabels, formatter: (pa: O) => (vc && pa.data ? `${pa.data.label}: ${valueText(pa.data.value, vc.format ?? null, f, "labels")}` : String(pa.data?.label ?? pa.name)), ...echartsText(labelFont, { ...labelDefaults(theme), color: theme.foreground }) },
        itemStyle: { areaColor: mt.land, borderColor: strokeOn ? strokeColor : mt.border, borderWidth: strokeOn ? strokeWidth : 0.5 },
        data,
      },
    ],
  };
  return {
    option,
    count: used.length,
    notice: summary([...missing, ...dropped]),
    pointAt: (_s, di) => {
      const r = used[di];
      return r && cat ? { fields: [cat.field], values: [valueToLit(r.row[cat.index])] } : null;
    },
  };
}
