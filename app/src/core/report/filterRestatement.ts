// "Filters on this visual": the filters that affect a visual, in words, by where they come from (the funnel button of
// the visual header). Pure functions.
import type { Project } from "../model/types";
import { fieldLabel, type Lit } from "./fields";
import { readFilters, type Cond, type FilterDef } from "./filters";
import { resolveInteraction, slicerFilters, type Selection } from "./interactions";
import type { PageModel, VisualModel } from "./visualDoc";
import { visualType } from "./visualTypes";

export type FilterScope = "Report" | "Page" | "Drillthrough" | "Visual" | "Slicer" | "Selection";

export interface RestatedFilter {
  scope: FilterScope;
  /** For example "Category is Bikes or Clothing". */
  text: string;
}

export const litText = (l: Lit): string => (l.t === "null" ? "(Blank)" : l.t === "string" ? l.v : l.t === "date" ? l.v.replace(/T00:00:00$/, "") : String(l.v));

const CMP: Record<string, string> = { eq: "is", ne: "is not", gt: "is greater than", ge: "is at least", lt: "is less than", le: "is at most" };
const TEXT: Record<string, string> = { contains: "contains", notContains: "does not contain", startsWith: "starts with", notStartsWith: "does not start with" };

/** The condition in words, without the field name ("is Bikes or Clothing"). */
export function condText(c: Cond): string {
  switch (c.kind) {
    case "in":
      return `is ${c.values.map(litText).join(" or ")}`;
    case "notIn":
      return `is not ${c.values.map(litText).join(" or ")}`;
    case "cmp":
      return `${CMP[c.op]} ${litText(c.value)}`;
    case "between":
      return `is between ${litText(c.lo)} and ${litText(c.hi)}`;
    case "text":
      return `${TEXT[c.op]} ${c.value}`;
    case "blank":
      return "is blank";
    case "notBlank":
      return "is not blank";
    case "tuples":
      return `is one of ${c.rows.length} selected ${c.rows.length === 1 ? "item" : "items"}`;
    case "compound":
      return `${condText(c.a)} ${c.op} ${condText(c.b)}`;
    case "topN":
      return `is in the ${c.dir === "top" ? "top" : "bottom"} ${c.n} by ${fieldLabel(c.by)}`;
    case "relativeDate":
      return `is in ${c.op === "this" ? "this" : c.op} ${c.op === "this" ? "" : `${c.n} `}${c.unit}`.replace(/\s+/g, " ").trim();
  }
}

const defText = (d: FilterDef) => `${fieldLabel(d.field)} ${condText(d.cond)}`;
const neutral = (d: FilterDef) => d.cond.kind === "in" && d.cond.values.length === 0;

/** Every filter that affects the visual: report, page and visual filters, drillthrough, slicers of the page and the selection in another visual. */
export function restateFilters(project: Project, page: PageModel, visual: VisualModel, rt: { drillthrough: FilterDef[]; selection: Selection | null; crossDefault?: "highlight" | "filter" | "none" }): RestatedFilter[] {
  const out: RestatedFilter[] = [];
  const add = (scope: FilterScope, defs: FilterDef[]) => {
    for (const d of defs) if (!neutral(d)) out.push({ scope, text: defText(d) });
  };
  const isSlicer = (v: VisualModel) => visualType(v.visualType)?.family === "slicer";
  add("Report", readFilters(project.report.files["report.json"] as never).defs);
  add("Page", page.filters.defs);
  add("Drillthrough", rt.drillthrough);
  if (!isSlicer(visual)) add("Visual", visual.filters.defs);
  for (const other of page.visuals) {
    if (!isSlicer(other) || other.name === visual.name) continue;
    if ((page.interactions.find((i) => i.source === other.name && i.target === visual.name)?.type ?? "Default") === "NoFilter") continue;
    add("Slicer", slicerFilters(other));
  }
  const sel = rt.selection;
  if (sel && sel.page === page.name && sel.visual !== visual.name && sel.points.length > 0) {
    const source = page.visuals.find((v) => v.name === sel.visual);
    if (source && resolveInteraction(page, source, visual, rt.crossDefault) !== "none") {
      const fields = sel.points[0].fields;
      const values = sel.points.map((p) => p.values.map(litText).join(" / "));
      out.push({ scope: "Selection", text: `${fields.map(fieldLabel).join(" / ")} is ${values.join(" or ")}` });
    }
  }
  return out;
}
