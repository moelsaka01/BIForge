// The buttons of a visual's header (the bar that shows when the pointer is over a visual): which ones apply to a visual
// right now, from its situation (the roles it can drill, how many filters affect it, whether it is a table of data, what
// went wrong or is worth knowing when it was drawn). The Visual header card says which of them the author wants shown.
// Pure functions; the frame component draws what this says.
import type { FieldRef } from "./fields";
import type { VisualModel } from "./visualDoc";
import { visualType } from "./visualTypes";

/** The hierarchies a drill action can follow: the category axis of a chart, the rows and the columns of a matrix. */
export type DrillRole = "Category" | "Rows" | "Columns";

/** What went wrong or is worth knowing about a drawn visual; a text per kind, absent when there is nothing to say. */
export interface VisualStatus {
  information?: string;
  warning?: string;
  error?: string;
}

export interface HeaderContext {
  /** Roles that hold more than one field (a hierarchy to drill into). */
  drillRoles: DrillRole[];
  /** Number of filters that affect the visual: report, page, visual, slicers and the selection in other visuals. */
  filters: number;
  /** The visual can fill the page (focus mode). */
  focusable: boolean;
  /** The visual's data can be shown as a table. */
  tabular: boolean;
  status: VisualStatus;
}

/** A situation with nothing to offer: used where no visual is on screen. */
export const NO_HEADER: HeaderContext = { drillRoles: [], filters: 0, focusable: false, tabular: false, status: {} };

export interface HeaderButtons {
  drillUp: boolean;
  drillToggle: boolean;
  nextLevel: boolean;
  expandAll: boolean;
  options: boolean;
  personalize: boolean;
  /** Which hierarchy the drill buttons follow (only for a visual with a category hierarchy and a legend hierarchy). */
  roleSelector: boolean;
  /** The funnel that lists the filters affecting the visual. */
  filters: boolean;
  focus: boolean;
  /** Show the data as a table / back to the visual. */
  seeData: boolean;
  copyImage: boolean;
  /** The information icon of the Header tooltip card. */
  tooltip: boolean;
  information: boolean;
  warning: boolean;
  error: boolean;
}

/** The drill roles of a visual: the hierarchies it holds (a role with several fields). A matrix has two, rows and columns. */
export function drillRolesOf(v: VisualModel): DrillRole[] {
  const family = visualType(v.visualType)?.family;
  const several = (role: string) => (v.roles[role] ?? []).length > 1;
  if (family === "matrix") return ((["Rows", "Columns"] as const).filter(several) as DrillRole[]);
  return several("Category") ? ["Category"] : [];
}

/** A matrix shows every level until it is drilled; its drill state is then "all levels down to `level`". */
export const isMatrixRole = (role: DrillRole): boolean => role !== "Category";

/** Where the drill position of a role is kept: the category role (or the rows of a matrix) under the visual's name, the columns under `name#Columns`. */
export const drillKey = (visual: string, role: DrillRole): string => (role === "Columns" ? `${visual}#Columns` : visual);

/** The hierarchy the drill buttons follow: the chosen one when the visual still has it, else the first the visual has. */
export function activeDrillRole(v: VisualModel, chosen: DrillRole | undefined): DrillRole | null {
  const roles = drillRolesOf(v);
  return chosen && roles.includes(chosen) ? chosen : (roles[0] ?? null);
}

export const fieldsOfRole = (v: VisualModel, role: DrillRole): FieldRef[] => (v.roles[role] ?? []).map((p) => p.field);
