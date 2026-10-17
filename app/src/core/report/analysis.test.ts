import { describe, expect, it } from "vitest";
import { decodeCell } from "./cells";
import { categoricalInfluences, influenceText, numericInfluences, pickAutoSplit, readGroups, stepFilters, tableVisual, type Group } from "./analysis";
import { agg, column, lit } from "./fields";
import { buildVisualQuery } from "./queryBuilder";
import { fixtureModel } from "./testFixture";

const Cat = column("Product", "Category");
const Country = column("Customer", "Country");
const Qty = agg("Sales", "Quantity", 0);

const g = (label: string, amount: number | null): Group => ({ key: label, label, lit: lit.str(label), amount });

describe("decomposition tree", () => {
  it("a node is a table query of the field and the measure, under the filters of the nodes above it", () => {
    const m = fixtureModel();
    expect(buildVisualQuery(tableVisual([Qty]), m, { filters: [] })!.dax).toBe('EVALUATE SUMMARIZECOLUMNS("m0", SUM(Sales[Quantity]))');
    const q = buildVisualQuery(tableVisual([Cat, Qty]), m, { filters: stepFilters([{ field: Country, value: lit.str("France") }]) })!;
    expect(q.dax).toContain('FILTER(ALL(Customer[Country]), Customer[Country] IN {"France"})');
    expect(q.dax).toContain("SUM(Sales[Quantity])");
    expect(q.columns.filter((c) => c.kind === "group").map((c) => c.field)).toEqual([Cat]);
  });

  it("reads groups largest first, blank amounts last, at most the limit", () => {
    const row = (t: string, v: string | null) => [decodeCell({ t: "text", v: t }), v === null ? decodeCell({ t: "blank", v: "" }) : decodeCell({ t: "int", v })];
    const gs = readGroups([row("a", "5"), row("b", null), row("c", "30"), row("d", "12")], null, 3);
    expect(gs.map((x) => [x.label, x.amount])).toEqual([["c", 30], ["d", 12], ["a", 5]]);
    expect(gs[0].lit).toEqual(lit.str("c"));
  });

  it("the high value split picks the field whose largest group stands out most; the low value split the opposite", () => {
    const cands = [
      { field: Cat, groups: [g("Bikes", 100), g("Shoes", 90), g("Hats", 95)] }, // flat
      { field: Country, groups: [g("FR", 200), g("CA", 10), g("DE", 20)] }, // one group far above the mean (76.7)
    ];
    const high = pickAutoSplit(cands, "high")!;
    expect(high.field).toBe(Country);
    expect(high.group.label).toBe("FR");
    const low = pickAutoSplit(cands, "low")!;
    expect(low.field).toBe(Country);
    expect(low.group.label).toBe("CA");
    expect(pickAutoSplit([{ field: Cat, groups: [g("only", 5)] }], "high")).toBeNull();
    expect(pickAutoSplit([], "low")).toBeNull();
  });
});

describe("key influencers", () => {
  const grp = (label: string, n: number, pos: number) => ({ lit: lit.str(label), label, n, pos });
  const opt = { minShare: 0.02, limit: 10, sort: "impact" as const };

  it("categorical: the likelihood ratio inside the group against outside it, only where more likely, with enough cases", () => {
    const cands = [{ field: Country, groups: [grp("FR", 30, 15), grp("CA", 69, 5), grp("XX", 1, 1)] }];
    const out = categoricalInfluences(cands, 100, 21, opt);
    // FR: 15/30 = 50% inside, (21-15)/70 = 8.57% outside -> 5.83x; CA is less likely; XX has 1% of the cases
    expect(out.map((i) => i.label)).toEqual(["FR"]);
    expect(out[0].lift).toBeCloseTo(0.5 / (6 / 70), 10);
    expect(out[0]).toMatchObject({ count: 30, inside: 0.5 });
    expect(influenceText(out[0], "Churn", "Yes")).toBe("When Country is FR, Churn is 5.83× more likely to be Yes");
  });

  it("an outcome that never happens outside the group is capped, and the list can be ranked by count", () => {
    const cands = [{ field: Country, groups: [grp("FR", 10, 10), grp("CA", 40, 6)] }];
    const byImpact = categoricalInfluences(cands, 50, 16, opt);
    expect(byImpact[0].label).toBe("FR"); // 100% inside, 6/40 outside
    const never = categoricalInfluences([{ field: Country, groups: [grp("FR", 10, 10)] }], 50, 10, opt);
    expect(never[0].lift).toBe(99);
    expect(influenceText(never[0], "Churn", "Yes")).toContain("far more likely");
    const byCount = categoricalInfluences(cands, 50, 16, { ...opt, sort: "count" });
    expect(byCount.map((i) => i.label)).toEqual(["CA", "FR"].filter((l) => byCount.some((i) => i.label === l)));
    expect(byCount[0].count).toBeGreaterThanOrEqual(byCount[byCount.length - 1].count);
  });

  it("numeric: groups whose average is above the average of everyone else", () => {
    // 100 cases with a total of 1000 (average 10); the first group has 20 cases averaging 20
    const cands = [{ field: Cat, groups: [grp("Bikes", 20, 20), grp("Shoes", 80, 7.5)] }];
    const out = numericInfluences(cands, 100, 1000, opt);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: "Bikes", inside: 20, outside: 7.5 });
    expect(out[0].lift).toBeCloseTo(20 / 7.5, 10);
    expect(influenceText(out[0], "Price", null)).toBe("When Category is Bikes, the average of Price is 2.67× higher");
  });
});
