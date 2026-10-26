// Every role name of every BIForge visual must be a data role of the same visual in Desktop's capability definitions
// (visualRoles.json, made with tools/re/data-roles.mjs). Role names are what the report files use as queryState keys.
import { describe, expect, it } from "vitest";
import verified from "./visualRoles.json";
import { VISUAL_TYPES } from "./visualTypes";

const CARTESIAN = ["clusteredBarChart", "barChart", "hundredPercentStackedBarChart", "clusteredColumnChart", "columnChart", "hundredPercentStackedColumnChart", "lineChart", "areaChart", "stackedAreaChart", "hundredPercentStackedAreaChart", "ribbonChart"];
// the stacked combo chart has the data roles of the clustered one (same Category, Series, Y, Y2 roles)
const KEY: Record<string, string> = { lineStackedColumnComboChart: "lineClusteredColumnComboChart", pieChart: "pie", donutChart: "pie", ...Object.fromEntries(CARTESIAN.map((id) => [id, "cartesian"])) };
// The roles of the types added later were read from the same bundle (dataRoles of the capability functions of Shape map, the
// narrative, the script visuals and the card with a trend). The three new slicers share the one-well capability {Values};
// that assignment is by reading the bundle, not by a type name next to the list.
const roles = verified as unknown as Record<string, string[]>;

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
