// Classic shell: layout only. A multi-line ribbon, and the Filters, Visualizations and Data panes side by side on
// the right of the canvas. Everything else (commands, views, ribbon contents) is shared with the Modern shell.
import type { ReportDockApi } from "../../views/report/ReportView";
import { SelectionPane } from "../../views/report/SelectionPane";
import { SyncSlicersPane } from "../../views/report/SyncSlicersPane";
import { BookmarksPane } from "../../views/report/BookmarksPane";
import { FiltersPane } from "../../views/report/FiltersPane";
import { VisualizationsPane } from "../../views/report/VisualizationsPane";
import { DataDock, Frame } from "../../views/shell/Frame";
import { PaneFrame } from "../../views/shell/PaneFrame";
import { useEnv, useSettings } from "../../views/shell/ShellContext";
import type { ShellSpec } from "../../views/shell/spec";

function ClassicDocks({ api }: { api: ReportDockApi }) {
  const env = useEnv();
  const panes = useSettings().layouts.classic.panes;
  const settings = env.session.shell.settings;
  const frame = (id: "bookmarks" | "filters" | "visualizations" | "selection" | "sync", title: string, body: React.ReactNode) => (
    <PaneFrame
      key={id}
      title={title}
      side="right"
      open={panes[id].open}
      width={panes[id].width}
      onOpenChange={(open) => settings.setPane("classic", id, { open })}
      onResize={(width) => settings.setPane("classic", id, { width })}
    >
      {body}
    </PaneFrame>
  );
  return (
    <>
      {panes.bookmarks.open && frame("bookmarks", "Bookmarks", <BookmarksPane />)}
      {panes.selection.open && frame("selection", "Selection", <SelectionPane />)}
      {panes.sync.open && frame("sync", "Sync slicers", <SyncSlicersPane />)}
      {frame("filters", "Filters", <FiltersPane page={api.page} visual={api.visual} />)}
      {frame("visualizations", "Visualizations", <VisualizationsPane page={api.page} visual={api.visual} onAdded={api.onAdded} />)}
      <DataDock spec={classicSpec} forReport />
    </>
  );
}

export const classicSpec: ShellSpec = {
  kind: "classic",
  dataSide: "right",
  reportDocks: (api) => ({ right: <ClassicDocks api={api} /> }),
};

export function ClassicShell() {
  return <Frame spec={classicSpec} />;
}
