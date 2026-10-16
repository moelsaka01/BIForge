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
}

export const ReportContext = createContext<ReportCtx | null>(null);

export function useReport(): ReportCtx {
  const c = useContext(ReportContext);
  if (!c) throw new Error("useReport must be used inside a ReportContext.Provider.");
  return c;
}
