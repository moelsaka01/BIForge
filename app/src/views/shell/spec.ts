import type { ShellKind } from "../../core/shell/settings";
import type { ReportDockApi } from "../report/ReportView";

/**
 * What differs between the Classic and the Modern shell besides the ribbon definition (core/shell/ribbon.ts):
 * where the panes sit. Both shells use the same Frame, the same commands and the same views.
 */
export interface ShellSpec {
  kind: ShellKind;
  /** Which side the Data pane docks to in the Table, Model and DAX query views. */
  dataSide: "left" | "right";
  /** The panes docked around the report canvas. */
  reportDocks(api: ReportDockApi): { left?: React.ReactNode; right?: React.ReactNode };
}
