import { useEffect, useMemo, useState } from "react";
import { buildChart } from "../../core/report/chartOptions";
import type { Loaded } from "../../core/report/dataLoader";
import { fieldKey, type FieldRef } from "../../core/report/fields";
import { FormatReader } from "../../core/report/formatReader";
import { drillthroughTargets, type SelectedPoint } from "../../core/report/interactions";
import { drillPlan } from "../../core/report/queryBuilder";
import { buildCard, buildKpi, buildMatrix, buildMultiRowCard, buildNewCard, buildTable } from "../../core/report/tableModels";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { listPageNames } from "../../core/report/visualDoc";
import { isStatic, visualType } from "../../core/report/visualTypes";
import { loadGazetteer } from "../../core/report/geo";
import { ChartView } from "./ChartView";
import { registerWorld } from "./echartsSetup";
import { DecompositionTreeView } from "./DecompositionTreeView";
import { KeyInfluencersView } from "./KeyInfluencersView";
import { CardView, KpiView, MatrixView, MultiRowCardView, NarrativeView, NewCardView, TableView } from "./DomVisuals";
import { buildNarrative } from "../../core/report/narrative";
import { useReport } from "./reportContext";
import { readSlicer } from "../../core/report/slicerSettings";
import { HierarchySlicerView } from "./HierarchySlicerView";
import { SlicerView, TextSlicerView } from "./SlicerView";
import { QnaView } from "./QnaView";
import { ScriptVisualView } from "./ScriptVisualView";
import { DataTableView } from "./DataTableView";
import { drillKey, fieldsOfRole, type VisualStatus } from "../../core/report/headerButtons";
import { BookmarkNavigatorView, ButtonView, ImageView, PageNavigatorView, ShapeView, TextboxView } from "./StaticVisuals";

/** Loads the data of one visual and draws it according to its type. */
export function VisualContent({ page, visual, width, height, runOnClick, onInfo }: { page: PageModel; visual: VisualModel; width: number; height: number; runOnClick?: (e: React.MouseEvent) => boolean; onInfo?: (i: { status: VisualStatus; tabular: boolean }) => void }) {
  const c = useReport();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const isMap = visualType(visual.visualType)?.family === "map";
  const [geoReady, setGeoReady] = useState(false);
  useEffect(() => {
    if (!isMap) return;
    let off = false;
    void loadGazetteer().then((g) => {
      registerWorld(g.world);
      if (!off) setGeoReady(true);
    });
    return () => {
      off = true;
    };
  }, [isMap]);
  useEffect(() => {
    if (isStatic(visual.visualType)) return;
    let off = false;
    void c.data.load(c.project, page, visual, c.view, c.model).then((r) => {
      if (!off) setLoaded(r);
    });
    return () => {
      off = true;
    };
  }, [c.data, c.project, page, visual, c.view, c.model]);

  const type = visualType(visual.visualType);
  const selected = c.snap.selection && c.snap.selection.page === page.name && c.snap.selection.visual === visual.name ? c.snap.selection.points : [];
  const selectedKey = JSON.stringify(selected);
  // the chart option is rebuilt only when its inputs change, so that a click is not interrupted by a redraw
  const chartBuild = useMemo(() => {
    if (!loaded || loaded.kind !== "grouped") return null;
    const fam = visualType(visual.visualType)?.family;
    if (fam === "table" || fam === "card" || fam === "kpi") return null;
    if (fam === "map" && !geoReady) return null;
    return buildChart({ visual, loaded, theme: c.theme, selected });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, visual, c.theme, selectedKey, geoReady]);
  // what the header says about this visual: a failed query, a partial load, a note of the chart
  const info = useMemo(() => {
    const status: VisualStatus = {};
    if (loaded?.kind === "error") status.error = loaded.message;
    if ((loaded?.kind === "grouped" || loaded?.kind === "matrix") && loaded.truncated) status.warning = "Not all of the data is shown: this visual loads only the first rows.";
    if (chartBuild?.notice) status.information = chartBuild.notice;
    return { status, tabular: loaded?.kind === "grouped" && visualType(visual.visualType)?.family !== "table" };
  }, [loaded, chartBuild, visual.visualType]);
  const infoKey = JSON.stringify(info);
  useEffect(() => {
    onInfo?.(info);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoKey]);
  const asTable = c.snap.asTable.includes(visual.name);
  const cats = fieldsOfRole(visual, "Category");
  const drill = c.snap.drill[drillKey(visual.name, "Category")];

  const onPoint = (point: SelectedPoint, additive: boolean) => {
    if (c.snap.drillMode === visual.name && cats.length > 1) {
      const shown = drillPlan(cats, drill).fields.length;
      c.dispatch("report.view.drillDown", { visual: visual.name, levels: cats.length, value: point.values[Math.min(shown, point.values.length) - 1] });
      return;
    }
    c.dispatch("report.view.select", { page: page.name, visual: visual.name, point, additive });
  };
  const onContext = (point: SelectedPoint, x: number, y: number) => {
    const targets = drillthroughTargets(c.project, listPageNames(c.project), point);
    const level = drill?.level ?? 0;
    c.onMenu(
      [
        { label: "Drill down", disabled: cats.length < 2 || level >= cats.length - 1, onClick: () => c.dispatch("report.view.drillDown", { visual: visual.name, levels: cats.length, value: point.values[Math.min(drillPlan(cats, drill).fields.length, point.values.length) - 1] }) },
        { label: "Drill up", disabled: level === 0, onClick: () => c.dispatch("report.view.drillUp", { visual: visual.name }) },
        { separator: true, label: "", onClick: () => undefined },
        ...(targets.length
          ? targets.map((t) => ({ label: `Drill through to ${t.displayName}`, onClick: () => c.dispatch("report.view.drillthrough", { page: page.name, target: t.page, point }) }))
          : [{ label: "Drill through (no page accepts this data)", disabled: true, onClick: () => undefined }]),
        { separator: true, label: "", onClick: () => undefined },
        ...(c.readOnly ? [] : [
          { label: "Include", onClick: () => c.dispatch("report.visual.includeExclude", { page: page.name, visual: visual.name, mode: "include", point }) },
          { label: "Exclude", onClick: () => c.dispatch("report.visual.includeExclude", { page: page.name, visual: visual.name, mode: "exclude", point }) },
        ]),
        { separator: true, label: "", onClick: () => undefined },
        { label: "Clear selection", disabled: selected.length === 0, onClick: () => c.dispatch("report.view.clearSelection") },
      ],
      x,
      y,
    );
  };
  const tooltipPage = useMemo(() => {
    const f = new FormatReader(visual.json, c.theme, visual.visualType);
    if (f.str("visualTooltip", "type", "Default") !== "Canvas") return null;
    const section = f.str("visualTooltip", "section", "");
    return c.pages.find((p) => p.name === section && p.type === "Tooltip") ?? null;
  }, [visual, c.pages, c.theme]);
  const onHover = tooltipPage ? (pt: SelectedPoint | null, x: number, y: number) => c.onTooltip(tooltipPage, visual.name, pt, x, y) : undefined;
  const onSort = (field: FieldRef) => {
    const cur = visual.sort && fieldKey(visual.sort.field) === fieldKey(field) ? visual.sort.dir : null;
    c.dispatch("report.visual.setSort", { page: page.name, visual: visual.name, sort: cur === null ? { field, dir: "asc" } : cur === "asc" ? { field, dir: "desc" } : null });
  };

  if (type && isStatic(type.id)) {
    const sp = { page, visual, width, height, runOnClick: runOnClick ?? (() => true) };
    switch (type.family) {
      case "textbox":
        return <TextboxView {...sp} />;
      case "shape":
        return <ShapeView {...sp} />;
      case "image":
        return <ImageView {...sp} />;
      case "button":
        return <ButtonView {...sp} />;
      case "bookmarkNavigator":
        return <BookmarkNavigatorView {...sp} />;
      default:
        return <PageNavigatorView {...sp} />;
    }
  }
  if (!type) return <Notice>Unknown visual type "{visual.visualType}".</Notice>;
  if (type.family === "qna") return <QnaView page={page} visual={visual} width={width} height={height} render={(v, w, h) => <VisualContent page={page} visual={v} width={w} height={h} />} />;
  if (type.family === "decomposition") return <DecompositionTreeView page={page} visual={visual} width={width} height={height} />;
  if (type.family === "keyDrivers") return <KeyInfluencersView page={page} visual={visual} width={width} height={height} />;
  const bound = Object.values(visual.roles).some((l) => l.length > 0);
  if (!bound) return <Notice>Add fields to this visual from the Data pane.</Notice>;
  if (!loaded) return <Notice muted>Loading…</Notice>;
  if (loaded.kind === "error") return <Notice error>Cannot load this visual: {loaded.message}</Notice>;
  if (loaded.kind === "empty") return <Notice>Add fields to this visual from the Data pane.</Notice>;

  if (asTable && loaded.kind === "grouped") return <DataTableView loaded={loaded} width={width} height={height} />;

  if (loaded.kind === "hierarchy") {
    const fields = visual.roles.Values.map((v) => v.field);
    const look = readSlicer(new FormatReader(visual.json, c.theme, visual.visualType), false, c.canvas.slicerSearch, visual.visualType);
    const own = visual.filters.defs.find((d) => d.name === "slicer");
    return (
      <HierarchySlicerView
        fields={fields}
        rows={loaded.rows}
        cond={own?.cond ?? null}
        look={look}
        fieldName={fields.map((f) => f.name).join(" > ")}
        search={look.search}
        theme={c.theme}
        width={width}
        height={height}
        onChange={(cond) => c.dispatch("report.slicer.select", { page: page.name, visual: visual.name, field: fields[0], cond })}
      />
    );
  }

  if (loaded.kind === "slicer") {
    const field = visual.roles.Values[0].field;
    const f = new FormatReader(visual.json, c.theme, visual.visualType);
    const dt = c.model.columnType(field.table, field.name);
    const isDate = dt === "dateTime";
    const numeric = dt === "int64" || dt === "double" || dt === "decimal";
    const look = readSlicer(f, isDate || numeric, c.canvas.slicerSearch, visual.visualType);
    const own = visual.filters.defs.find((d) => d.name === "slicer");
    if (visual.visualType === "textSlicer") {
      return (
        <TextSlicerView
          cond={own?.cond ?? null}
          look={look}
          fieldName={field.name}
          theme={c.theme}
          width={width}
          height={height}
          onChange={(cond) => c.dispatch("report.slicer.select", { page: page.name, visual: visual.name, field, cond })}
        />
      );
    }
    return (
      <SlicerView
        loaded={loaded}
        mode={look.mode}
        look={look}
        fieldName={field.name}
        cond={own?.cond ?? null}
        singleSelect={look.singleSelect}
        selectAll={look.selectAll}
        search={look.search}
        isDate={isDate}
        theme={c.theme}
        width={width}
        height={height}
        onChange={(cond) => c.dispatch("report.slicer.select", { page: page.name, visual: visual.name, field, cond })}
      />
    );
  }

  if (loaded.kind === "matrix") {
    const model = buildMatrix(visual, loaded.parts, loaded.query, c.theme, new Set(c.snap.collapsed[visual.name] ?? []));
    return (
      <MatrixView
        model={model}
        rowFields={loaded.query.rows}
        theme={c.theme}
        width={width}
        height={height}
        selected={selected}
        onToggle={(key) => c.dispatch("report.view.toggleRow", { visual: visual.name, key })}
        onRow={(pt, add) => c.dispatch("report.view.select", { page: page.name, visual: visual.name, point: pt, additive: add })}
      />
    );
  }

  // grouped
  switch (type.family) {
    case "table": {
      const model = buildTable(visual, loaded, c.theme, loaded.totals);
      return <TableView model={model} theme={c.theme} width={width} height={height} selected={selected} onSort={onSort} onRow={onPoint} onContext={onContext} />;
    }
    case "card":
      if (visual.visualType === "cardVisual") return <NewCardView model={buildNewCard(visual, loaded, c.theme)} theme={c.theme} width={width} height={height} />;
      return visual.visualType === "multiRowCard" ? (
        <MultiRowCardView model={buildMultiRowCard(visual, loaded, c.theme)} theme={c.theme} width={width} height={height} />
      ) : (
        <CardView model={buildCard(visual, loaded, c.theme)} theme={c.theme} width={width} height={height} />
      );
    case "script":
      return <ScriptVisualView page={page} visual={visual} loaded={loaded} width={width} height={height} />;
    case "narrative":
      return <NarrativeView model={buildNarrative(visual, loaded, c.theme)} theme={c.theme} width={width} height={height} />;
    case "kpi":
      return <KpiView model={buildKpi(visual, loaded, c.theme)} theme={c.theme} width={width} height={height} />;
    default: {
      const build = chartBuild;
      if (type.family === "map" && !geoReady) return <Notice muted>Loading map…</Notice>;
      if (!build || build.count === 0) return <Notice muted>{build?.notice ?? "No data"}</Notice>;
      return (
        <div style={{ position: "relative", width, height }}>
          <ChartView build={build} width={width} height={height} onPoint={onPoint} onContext={onContext} onHover={onHover} onLasso={(points, additive) => c.dispatch("report.view.selectMany", { page: page.name, visual: visual.name, points, additive })} label={`${type.label}`} />
          {build.notice && (
            <div role="status" data-testid="chart-notice" style={{ position: "absolute", left: 4, right: 4, bottom: 2, fontSize: 11, padding: "1px 4px", background: "rgba(255,255,255,0.8)", color: "#a4262c" }}>
              {build.notice}
            </div>
          )}
        </div>
      );
    }
  }
}

function Notice({ children, error, muted }: { children: React.ReactNode; error?: boolean; muted?: boolean }) {
  return (
    <div role={error ? "alert" : "status"} style={{ height: "100%", boxSizing: "border-box", padding: 12, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: 12, color: error ? "#c50f1f" : muted ? "#888" : "inherit", gap: 4 }}>
      {children}
    </div>
  );
}
