// Modern shell: layout only. A single-line ribbon with a Design tab, the Data pane on the left of the canvas, and one
// sidebar on the right whose tabs switch between Visualizations, Filters and Bookmarks. Everything else is shared
// with the Classic shell. (On-object formatting, which Desktop turns on with this layout, is not implemented.)
import type { ReportDockApi } from "../../views/report/ReportView";
import { SelectionPane } from "../../views/report/SelectionPane";
import { SyncSlicersPane } from "../../views/report/SyncSlicersPane";
import { BookmarksPane } from "../../views/report/BookmarksPane";
import { FiltersPane } from "../../views/report/FiltersPane";
import { VisualizationsPane } from "../../views/report/VisualizationsPane";
import { DataDock, Frame } from "../../views/shell/Frame";
import { PaneFrame } from "../../views/shell/PaneFrame";
import { useEnv, useSettings, useShellState } from "../../views/shell/ShellContext";
import type { ShellSpec } from "../../views/shell/spec";

const SIDE_TABS = [
  { id: "visualizations", label: "Visualizations" },
  { id: "filters", label: "Filters" },
  { id: "bookmarks", label: "Bookmarks" },
  { id: "selection", label: "Selection" },
  { id: "sync", label: "Sync slicers" },
] as const;

function ModernSidebar({ api }: { api: ReportDockApi }) {
  const env = useEnv();
  const { sideTab } = useShellState();
  const pane = useSettings().layouts.modern.panes.visualizations;
  const title = SIDE_TABS.find((t) => t.id === sideTab)!.label;
  return (
    <PaneFrame
      title={title}
      side="right"
      open={pane.open}
      width={pane.width}
      onOpenChange={(open) => env.session.shell.settings.setPane("modern", "visualizations", { open })}
      onResize={(width) => env.session.shell.settings.setPane("modern", "visualizations", { width })}
      heading={
        <div className="side-tabs" role="tablist" aria-label="Panes" style={{ border: "none", padding: 0 }}>
          {SIDE_TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={sideTab === t.id} onClick={() => env.session.shell.setSideTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {sideTab === "visualizations" && <VisualizationsPane page={api.page} visual={api.visual} onAdded={api.onAdded} />}
      {sideTab === "filters" && <FiltersPane page={api.page} visual={api.visual} />}
      {sideTab === "bookmarks" && <BookmarksPane />}
      {sideTab === "selection" && <SelectionPane />}
      {sideTab === "sync" && <SyncSlicersPane />}
    </PaneFrame>
  );
}

export const modernSpec: ShellSpec = {
  kind: "modern",
  dataSide: "left",
  reportDocks: (api) => ({ left: <DataDock spec={modernSpec} forReport />, right: <ModernSidebar api={api} /> }),
};

export function ModernShell() {
  return <Frame spec={modernSpec} />;
}
