import { createContext, useContext } from "react";
import type { Project } from "../../core/report/../model/types";
import type { ReportData, ViewState } from "../../core/report/dataLoader";
import type { ModelInfo } from "../../core/report/modelInfo";
import type { ViewSnapshot } from "../../core/report/runtime";
import type { Theme } from "../../core/report/theme";
import type { PageModel } from "../../core/report/visualDoc";

export type Dispatch = (id: string, args?: unknown) => void;

export interface ReportCtx {
  project: Project;
  pages: PageModel[];
  theme: Theme;
  model: ModelInfo;
  data: ReportData;
  view: ViewState;
  snap: ViewSnapshot;
  /** Modern interface with On-object interaction: a selected visual shows formatting handles. */
  onObject: boolean;
  /** A shared report opened for viewing: selecting and filtering work, moving, resizing, deleting and renaming do not. */
  readOnly: boolean;
  /** Canvas view options: smart guides, gridlines, snap to grid, lock objects. */
  canvas: import("../../core/report/canvasOptions").CanvasOptions;
  /** Opens a card of the Format pane for a visual (on-object formatting). */
  focusFormat(visual: string, card: string): void;
  dispatch: Dispatch;
  /** Hover over a data point of a visual whose tooltip is a report page. */
  onTooltip(page: PageModel, visual: string, point: import("../../core/report/interactions").SelectedPoint | null, x: number, y: number): void;
  /** Right-click menu request. */
  onMenu(items: MenuItem[], x: number, y: number): void;
}

export interface MenuItem {
  label: string;
  onClick(): void;
  disabled?: boolean;
  separator?: boolean;
  /** Also offered while a shared report is open for viewing (every other item changes the report). */
  viewOnly?: boolean;
}

export const ReportContext = createContext<ReportCtx | null>(null);

export function useReport(): ReportCtx {
  const c = useContext(ReportContext);
  if (!c) throw new Error("useReport must be used inside a ReportContext.Provider.");
  return c;
}
