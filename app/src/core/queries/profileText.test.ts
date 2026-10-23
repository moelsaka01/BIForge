import { describe, expect, it } from "vitest";
import { basisLabel, distributionBars, distributionLabel, pct, qualityLabel, qualityOf, statsOf } from "./profileText";
import type { ColumnProfile } from "./types";

const p = (o: Partial<ColumnProfile> = {}): ColumnProfile => ({ name: "a", duckdbType: "BIGINT", rows: 200, valid: 150, empty: 50, error: 0, distinct: 12, unique: 3, min: "1", max: "9", average: 4.5, stdDev: null, top: [["x", 40], ["y", 10], [null, 5]], rowsLimited: false, ...o });

describe("profile text", () => {
  it("pct rounds, never shows a present share as 0%, and handles no rows", () => {
    expect(pct(150, 200)).toBe("75%");
    expect(pct(1, 1000)).toBe("<1%");
    expect(pct(0, 10)).toBe("0%");
    expect(pct(5, 0)).toBe("0%");
    expect(pct(199, 200)).toBe("100%");
  });
  it("the quality bar and its label", () => {
    const q = qualityOf(p());
    expect([q.validWidth, q.emptyWidth, q.errorWidth]).toEqual([75, 25, 0]);
    expect(qualityLabel(p())).toBe("Valid 75%, Error 0%, Empty 25%");
    expect(qualityOf(p({ rows: 0, valid: 0, empty: 0 })).validWidth).toBe(0);
  });
  it("distinct and unique", () => expect(distributionLabel(p({ distinct: 1234 }))).toBe("1,234 distinct, 3 unique"));
  it("the statistics table lists numeric statistics only when the column has them", () => {
    expect(statsOf(p()).map(([k]) => k)).toEqual(["Count", "Error", "Empty", "Distinct", "Unique", "Min", "Max", "Average"]);
    expect(statsOf(p({ min: null, max: null, average: null })).map(([k]) => k)).toEqual(["Count", "Error", "Empty", "Distinct", "Unique"]);
    expect(statsOf(p({ average: 2.25, stdDev: 1.2583057 })).slice(-2)).toEqual([["Average", "2.25"], ["Standard deviation", "1.258306"]]);
  });
  it("distribution bars are relative to the most frequent value and name null and empty text", () => {
    expect(distributionBars(p({ top: [["x", 40], ["", 10], [null, 5]] }))).toEqual([{ label: "x", count: 40, width: 1 }, { label: "(empty)", count: 10, width: 0.25 }, { label: "null", count: 5, width: 0.125 }]);
  });
  it("the basis line", () => {
    expect(basisLabel(p(), false)).toContain("top 1000 rows (all rows are shown)");
    expect(basisLabel(p({ rowsLimited: true }), false)).toBe("Column profiling based on top 1000 rows");
    expect(basisLabel(p(), true)).toContain("entire data set");
  });
});
