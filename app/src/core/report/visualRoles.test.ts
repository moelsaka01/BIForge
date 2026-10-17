// Every role name of every BIForge visual must be a data role of the same visual in Desktop's capability definitions
// (visualRoles.json, made with tools/re/data-roles.mjs). Role names are what the report files use as queryState keys.
import { describe, expect, it } from "vitest";
import verified from "./visualRoles.json";
import { VISUAL_TYPES } from "./visualTypes";

const CARTESIAN = ["clusteredBarChart", "barChart", "hundredPercentStackedBarChart", "clusteredColumnChart", "columnChart", "hundredPercentStackedColumnChart", "lineChart", "areaChart", "stackedAreaChart", "hundredPercentStackedAreaChart", "ribbonChart"];
const KEY: Record<string, string> = { pieChart: "pie", donutChart: "pie", ...Object.fromEntries(CARTESIAN.map((id) => [id, "cartesian"])) };
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
