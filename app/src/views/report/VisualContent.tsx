import { useEffect, useMemo, useState } from "react";
import { buildChart } from "../../core/report/chartOptions";
import type { Loaded } from "../../core/report/dataLoader";
import { fieldKey, type FieldRef } from "../../core/report/fields";
import { FormatReader } from "../../core/report/formatReader";
import { drillthroughTargets, type SelectedPoint } from "../../core/report/interactions";
import { drillPlan } from "../../core/report/queryBuilder";
import { buildCard, buildKpi, buildMatrix, buildMultiRowCard, buildTable } from "../../core/report/tableModels";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { listPageNames } from "../../core/report/visualDoc";
import { visualType } from "../../core/report/visualTypes";
import { ChartView } from "./ChartView";
import { CardView, KpiView, MatrixView, MultiRowCardView, TableView } from "./DomVisuals";
import { useReport } from "./reportContext";
import { SlicerView, type SlicerMode } from "./SlicerView";

/** Loads the data of one visual and draws it according to its type. */
export function VisualContent({ page, visual, width, height }: { page: PageModel; visual: VisualModel; width: number; height: number }) {
  const c = useReport();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
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
    return buildChart({ visual, loaded, theme: c.theme, selected });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, visual, c.theme, selectedKey]);
  const cats = (visual.roles.Category ?? []).map((p) => p.field);
  const drill = c.snap.drill[visual.name];

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
        { label: "Clear selection", disabled: selected.length === 0, onClick: () => c.dispatch("report.view.clearSelection") },
      ],
      x,
      y,
    );
  };
  const tooltipPage = useMemo(() => {
    const f = new FormatReader(visual.json, c.theme, visual.visualType);
    if (f.str("visualTooltip", "type", "Default") !== "ReportPage") return null;
    const section = f.str("visualTooltip", "section", "");
    return c.pages.find((p) => p.name === section && p.type === "Tooltip") ?? null;
  }, [visual, c.pages, c.theme]);
  const onHover = tooltipPage ? (pt: SelectedPoint | null, x: number, y: number) => c.onTooltip(tooltipPage, visual.name, pt, x, y) : undefined;
  const onSort = (field: FieldRef) => {
    const cur = visual.sort && fieldKey(visual.sort.field) === fieldKey(field) ? visual.sort.dir : null;
    c.dispatch("report.visual.setSort", { page: page.name, visual: visual.name, sort: cur === null ? { field, dir: "asc" } : cur === "asc" ? { field, dir: "desc" } : null });
  };

  if (!type) return <Notice>Unknown visual type "{visual.visualType}".</Notice>;
  if (type.deferred) {
    return (
      <Notice>
        <strong>{type.label.replace(" (deferred)", "")}</strong>
        <div>Not yet implemented: map visuals are deferred (they need online map tiles).</div>
      </Notice>
    );
  }
  const bound = Object.values(visual.roles).some((l) => l.length > 0);
  if (!bound) return <Notice>Add fields to this visual from the Data pane.</Notice>;
  if (!loaded) return <Notice muted>Loading…</Notice>;
  if (loaded.kind === "error") return <Notice error>Cannot load this visual: {loaded.message}</Notice>;
  if (loaded.kind === "empty") return <Notice>Add fields to this visual from the Data pane.</Notice>;

  if (loaded.kind === "slicer") {
    const field = visual.roles.Values[0].field;
    const f = new FormatReader(visual.json, c.theme, "slicer");
    const dt = c.model.columnType(field.table, field.name);
    const isDate = dt === "dateTime";
    const numeric = dt === "int64" || dt === "double" || dt === "decimal";
    const mode = f.str("data", "mode", isDate || numeric ? "Between" : "Basic") as SlicerMode;
    const own = visual.filters.defs.find((d) => d.name === "slicer");
    return (
      <SlicerView
        loaded={loaded}
        mode={mode}
        cond={own?.cond ?? null}
        singleSelect={f.bool("selection", "singleSelect", false)}
        selectAll={f.bool("selection", "selectAllCheckbox", false)}
        search={f.bool("header", "search", false)}
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
      return visual.visualType === "multiRowCard" ? (
        <MultiRowCardView model={buildMultiRowCard(visual, loaded, c.theme)} theme={c.theme} width={width} height={height} />
      ) : (
        <CardView model={buildCard(visual, loaded, c.theme)} theme={c.theme} width={width} height={height} />
      );
    case "kpi":
      return <KpiView model={buildKpi(visual, loaded, c.theme)} theme={c.theme} width={width} height={height} />;
    default: {
      const build = chartBuild;
      if (!build || build.count === 0) return <Notice muted>No data</Notice>;
      return <ChartView build={build} width={width} height={height} onPoint={onPoint} onContext={onContext} onHover={onHover} label={`${type.label}`} />;
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
