import { asValueField, routeField, usedIn } from "../../core/report/fieldRouting";
import type { FieldRef } from "../../core/report/fields";
import { modelInfo } from "../../core/report/modelInfo";
import { parseVisual, visualKey } from "../../core/report/visualDoc";
import { DataPane, type DataPaneProps } from "../DataPane";
import { useDoc, useEnv, useSession, useShellState } from "./ShellContext";

/**
 * The Data pane wired to the document: in the Report view a tick adds the field to the selected visual (or starts a
 * table), in the other views it only lists tables and selects one. All edits go through commands.
 */
export function DataPaneHost({ forReport }: { forReport: boolean }) {
  const env = useEnv();
  const doc = useDoc();
  const sess = useSession();
  const st = useShellState();
  const project = doc.project;
  if (!project) return null;

  let fieldUse: DataPaneProps["fieldUse"];
  if (forReport) {
    const sel = st.selectedVisual;
    const visual = sel ? parseVisual(sel.page, project.report.files[visualKey(sel.page, sel.visual)]) : null;
    fieldUse = {
      isUsed: (f: FieldRef) => !!visual && usedIn(visual, f) !== null,
      onToggle: (f: FieldRef) => {
        const m = modelInfo(project);
        if (visual) {
          const used = usedIn(visual, f);
          if (used) return void env.run("report.field.remove", { page: visual.pageName, visual: visual.name, role: used.role, index: used.index });
          const route = routeField(project, m, visual, f);
          if (!route) return env.setError("This visual has no field well for that field.");
          return void env.run("report.field.add", { page: visual.pageName, visual: visual.name, role: route.role, field: route.field });
        }
        // nothing selected: start a table with the field
        void env.run("report.visual.add", { type: "tableEx", fields: [{ role: "Values", field: f.kind === "agg" ? asValueField(m, f) : f }] });
      },
    };
  }

  return (
    <DataPane
      project={project}
      fieldUse={fieldUse}
      dataTables={sess.dataTables}
      selected={st.selectedTable}
      canImport={env.registry.isEnabled("data.getData")}
      onSelect={(t) => env.session.shell.selectTable(t)}
      onRefresh={(t) => void env.run("data.refreshTable", { name: t })}
      onRefreshAll={() => void env.run("data.refreshAll")}
      onImport={() => void env.run("data.getData")}
      onQuickQuery={(text) => void env.run("dax.quickQuery", { text })}
    />
  );
}
