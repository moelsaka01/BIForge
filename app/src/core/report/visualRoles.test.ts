// Every role name of every BIForge visual must be a data role of the same visual in Desktop's capability definitions
// (visualRoles.json, made with tools/re/data-roles.mjs). Role names are what the report files use as queryState keys.
import { describe, expect, it } from "vitest";
import verified from "./visualRoles.json";
import { VISUAL_TYPES } from "./visualTypes";

const CARTESIAN = ["clusteredBarChart", "barChart", "hundredPercentStackedBarChart", "clusteredColumnChart", "columnChart", "hundredPercentStackedColumnChart", "lineChart", "areaChart", "stackedAreaChart", "hundredPercentStackedAreaChart", "ribbonChart"];
// the stacked combo chart has the data roles of the clustered one (same Category, Series, Y, Y2 roles)
const KEY: Record<string, string> = { lineStackedColumnComboChart: "lineClusteredColumnComboChart", pieChart: "pie", donutChart: "pie", ...Object.fromEntries(CARTESIAN.map((id) => [id, "cartesian"])) };
// Types added after the capability dump: their role names are those of the PBIR files Desktop writes (a single Values well for the slicers).
// They are not checked against the dump, so the list stays short; rerun tools/re/data-roles.mjs to verify them.
const UNVERIFIED: Record<string, string[]> = { advancedSlicerVisual: ["Values"], listSlicer: ["Values"], textSlicer: ["Values"], cardVisual: ["Data"], aiNarratives: ["Category", "Values"], shapeMap: ["Category", "Size"], qnaVisual: [], scriptVisual: ["Values"], pythonVisual: ["Values"] };
const roles = { ...(verified as unknown as Record<string, string[]>), ...UNVERIFIED };

describe("visual role names against Desktop's capability definitions", () => {
  for (const t of VISUAL_TYPES.filter((x) => !x.static)) {
    it(`${t.id}`, () => {
      const allowed = roles[KEY[t.id] ?? t.id];
      expect(allowed, `no verified role list for ${t.id}`).toBeDefined();
      expect(t.roles.map((r) => r.name).filter((n) => !allowed.includes(n))).toEqual([]);
    });
  }
  it("the old guessed names are gone", () => {
    const names = (id: string) => VISUAL_TYPES.find((t) => t.id === id)!.roles.map((r) => r.name);
    expect(names("kpi")).toContain("TrendLine");
    expect(names("filledMap")).toContain("Size");
  });
});
