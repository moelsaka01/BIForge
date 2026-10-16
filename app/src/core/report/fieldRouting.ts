// Decides where a field goes when the user checks it in the Data pane or drops it on a visual.
import type { Project } from "../model/types";
import { allTables, textProp } from "../model/ops";
import type { FieldRef } from "./fields";
import { isDateField, isNumericColumn, type ModelInfo } from "./modelInfo";
import type { VisualModel } from "./visualDoc";
import { visualType } from "./visualTypes";

/** True for numeric columns that Power BI would sum by default (summarizeBy is not "none"). */
export function summarizesByDefault(project: Project, model: ModelInfo, f: FieldRef): boolean {
  if (f.kind !== "column" || !isNumericColumn(model, f)) return false;
  const col = allTables(project)
    .find((t) => t.name?.toLowerCase() === f.table.toLowerCase())
    ?.children.find((c) => c.kind === "column" && c.name?.toLowerCase() === f.name.toLowerCase());
  const s = col ? textProp(col, "summarizeBy") : null;
  return s === null || s.toLowerCase() !== "none";
}

/** The field as it should appear in a value well: numeric columns are summed, text is counted, dates take the earliest. */
export function asValueField(model: ModelInfo, f: FieldRef): FieldRef {
  if (f.kind !== "column") return f;
  if (isNumericColumn(model, f)) return { kind: "agg", table: f.table, name: f.name, fn: 0 };
  if (isDateField(model, f)) return { kind: "agg", table: f.table, name: f.name, fn: 3 };
  return { kind: "agg", table: f.table, name: f.name, fn: 2 };
}

export interface Route {
  role: string;
  field: FieldRef;
}

/**
 * The well for a field of the Data pane on a visual: measures and summarized numeric columns go to value wells,
 * everything else to grouping wells. Null when the visual has no suitable well left.
 */
export function routeField(project: Project, model: ModelInfo, visual: VisualModel, f: FieldRef): Route | null {
  const t = visualType(visual.visualType);
  if (!t) return null;
  const wantsValue = f.kind !== "column" || summarizesByDefault(project, model, f);
  const free = (r: (typeof t.roles)[number]) => (visual.roles[r.name]?.length ?? 0) < r.max;
  const pick = (kind: "value" | "column") => t.roles.find((r) => (r.accepts === kind || r.accepts === "any") && free(r));
  const primary = pick(wantsValue ? "value" : "column");
  if (primary) return { role: primary.name, field: primary.accepts === "column" ? f : wantsValue ? asValueField(model, f) : f };
  // single-field wells are replaced when nothing is free
  const replace = t.roles.find((r) => (r.accepts === (wantsValue ? "value" : "column") || r.accepts === "any") && r.max === 1);
  if (replace) return { role: replace.name, field: wantsValue ? asValueField(model, f) : f };
  // a value-like column can still group, and a grouping column can still be counted
  const other = pick(wantsValue ? "column" : "value");
  if (other) return { role: other.name, field: other.accepts === "value" ? asValueField(model, f) : f };
  return null;
}

/** Converts a field dropped on a specific well to what that well accepts. */
export function fieldForRole(model: ModelInfo, accepts: "column" | "value" | "any", f: FieldRef): FieldRef {
  if (accepts === "value") return asValueField(model, f);
  return f;
}

/** Where a Data-pane field is used in the visual (columns also match their aggregates), or null. */
export function usedIn(visual: VisualModel, f: FieldRef): { role: string; index: number } | null {
  for (const [role, list] of Object.entries(visual.roles)) {
    const index = list.findIndex((x) => x.field.table.toLowerCase() === f.table.toLowerCase() && x.field.name.toLowerCase() === f.name.toLowerCase() && (x.field.kind === f.kind || (f.kind === "column" && x.field.kind === "agg")));
    if (index >= 0) return { role, index };
  }
  return null;
}
