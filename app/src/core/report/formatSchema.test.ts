import { describe, expect, it } from "vitest";
import chartOptions from "./chartOptions.ts?raw";
import tableModels from "./tableModels.ts?raw";
import staticVisuals from "./staticVisuals.ts?raw";
import analyticsSrc from "./analytics.ts?raw";
import staticViews from "../../views/report/StaticVisuals.tsx?raw";
import visualFrame from "../../views/report/VisualFrame.tsx?raw";
import visualContent from "../../views/report/VisualContent.tsx?raw";
import { analyticsCards, generalCards, visualCards, type CardDef } from "./formatSchema";
import { VISUAL_TYPES } from "./visualTypes";

const sources = [chartOptions, tableModels, visualFrame, visualContent, staticVisuals, staticViews, analyticsSrc].join("\n");

function check(card: CardDef, where: string): string[] {
  const missing: string[] = [];
  if (!sources.includes(`"${card.object}"`)) missing.push(`${where}: object "${card.object}" is never read`);
  for (const p of card.props) if (!sources.includes(`"${p.key}"`)) missing.push(`${where}: ${card.object}.${p.key} is never read`);
  return missing;
}

describe("the Format pane lists only settings that a renderer reads", () => {
  it("visual cards", () => {
    const problems = VISUAL_TYPES.flatMap((t) => visualCards(t.id).flatMap((c) => check(c, t.id)));
    expect([...new Set(problems)]).toEqual([]);
  });

  it("analytics cards", () => {
    const problems = VISUAL_TYPES.flatMap((t) => analyticsCards(t.id).flatMap((c) => check(c, `analytics ${t.id}`)));
    expect([...new Set(problems)]).toEqual([]);
    expect(analyticsCards("lineChart").map((c) => c.id)).toContain("trendLine");
    expect(analyticsCards("stackedColumnChart").map((c) => c.id)).not.toContain("trendLine");
    expect(analyticsCards("hundredPercentStackedColumnChart")).toEqual([]);
    expect(analyticsCards("pieChart")).toEqual([]);
  });

  it("general cards", () => {
    const problems = generalCards([{ name: "p", displayName: "P" }]).flatMap((c) => check(c, "general"));
    expect(problems).toEqual([]);
  });

  it("card and property ids are unique within a visual type, and enums have options", () => {
    for (const t of VISUAL_TYPES) {
      const cards = visualCards(t.id);
      expect(new Set(cards.map((c) => c.id)).size, t.id).toBe(cards.length);
      for (const c of cards) {
        expect(new Set(c.props.map((p) => p.key)).size, `${t.id}.${c.id}`).toBe(c.props.length);
        for (const p of c.props) if (p.type === "enum") expect(p.options?.length ?? 0, `${t.id}.${c.id}.${p.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("line settings only for line-like charts; combo charts get a secondary axis", () => {
    expect(visualCards("lineChart").some((c) => c.id === "lineStyles")).toBe(true);
    expect(visualCards("clusteredColumnChart").some((c) => c.id === "lineStyles")).toBe(false);
    expect(visualCards("lineClusteredColumnComboChart").some((c) => c.id === "secondaryValueAxis")).toBe(true);
    expect(visualCards("map")).toEqual([]);
  });
});
