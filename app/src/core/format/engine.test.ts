import { describe, expect, it } from "vitest";
import { VISUAL_TYPES } from "../report/visualTypes";
import { CONTAINER_OBJECTS, isContainerProp, knownVisualTypes, propKind, visualObjects } from "./capabilities";
import { analyticsCards, generalCards, visualCards } from "./engine";
import { humanize, optionLabel, propLabel } from "./labels";

describe("capabilities", () => {
  it("has a style for every visual type BIForge can author", () => {
    const missing = VISUAL_TYPES.map((t) => t.id).filter((id) => !knownVisualTypes().includes(id));
    expect(missing).toEqual([]);
  });

  it("knows the kinds of properties", () => {
    expect(propKind("lineChart", "legend", "show")).toEqual(["b"]);
    expect(propKind("lineChart", "legend", "labelColor")).toEqual(["c"]);
    expect(propKind("lineChart", "legend", "fontSize")?.[0]).toBe("f");
    expect(propKind("lineChart", "valueAxis", "labelDisplayUnits")?.[0]).toBe("e");
    expect(propKind("lineChart", "valueAxis", "invented")).toBeNull();
    expect(propKind("lineChart", "referenceLine", "type")?.[0]).toBe("e"); // an instance's statistic
    expect(propKind("lineChart", "general", "altText")).toEqual(["s"]);
  });

  it("puts container objects and the container half of `general` in visualContainerObjects", () => {
    for (const o of ["title", "subTitle", "background", "border", "dropShadow", "padding", "spacing", "divider", "lockAspect", "visualHeader", "visualTooltip", "visualLink"]) expect(CONTAINER_OBJECTS.has(o), o).toBe(true);
    expect(CONTAINER_OBJECTS.has("legend")).toBe(false);
    expect(isContainerProp("general", "altText")).toBe(true);
    expect(isContainerProp("general", "formatString")).toBe(false);
    expect(isContainerProp("legend", "show")).toBe(false);
  });
});

describe("generated cards", () => {
  it("a chart gets its own cards, container cards go to the General tab, analytics lines to the Analytics tab", () => {
    const visual = visualCards("lineChart").map((c) => c.id);
    expect(visual).toEqual(expect.arrayContaining(["legend", "categoryAxis", "valueAxis", "labels", "lineStyles", "dataPoint"]));
    expect(visual).not.toContain("title");
    expect(visual).not.toContain("trend");
    const general = generalCards("lineChart").map((c) => c.id);
    expect(general).toEqual(expect.arrayContaining(["title", "background", "border", "dropShadow", "altText"]));
    const analytics = analyticsCards("lineChart").map((c) => c.id);
    expect(analytics).toEqual(expect.arrayContaining(["y1AxisReferenceLine#constant", "referenceLine#min", "referenceLine#percentile", "trend"]));
  });

  it("every card of every authored visual type has unique ids and typed, labelled controls", () => {
    for (const t of VISUAL_TYPES) {
      for (const cards of [visualCards(t.id), generalCards(t.id), analyticsCards(t.id)]) {
        expect(new Set(cards.map((c) => c.id)).size, t.id).toBe(cards.length);
        for (const c of cards) {
          expect(c.props.length, `${t.id}.${c.id}`).toBeGreaterThan(0);
          expect(new Set(c.props.map((p) => p.key)).size, `${t.id}.${c.id}`).toBe(c.props.length);
          for (const p of c.props) {
            expect(p.label, `${t.id}.${c.id}.${p.key}`).toBeTruthy();
            if (p.type === "enum") expect(p.options?.length ?? 0, `${t.id}.${c.id}.${p.key}`).toBeGreaterThan(0);
            // the schema must really list the property for the type
            expect(propKind(t.id, c.object, p.key), `${t.id}.${c.object}.${p.key}`).not.toBeNull();
          }
        }
      }
    }
  });

  it("display units are numeric choices with readable names", () => {
    const axis = visualCards("clusteredColumnChart").find((c) => c.id === "valueAxis")!;
    const units = axis.props.find((p) => p.key === "labelDisplayUnits")!;
    expect(units.numeric).toBe(true);
    expect(units.options?.map((o) => o.label)).toEqual(["Auto", "None", "Thousands", "Millions", "Billions", "Trillions"]);
  });

  it("a statistic line is an instance of the reference line object that carries its type", () => {
    const card = analyticsCards("lineChart").find((c) => c.id === "referenceLine#median")!;
    expect(card.object).toBe("referenceLine");
    expect(card.instance).toBe("median");
    expect(card.fixed).toEqual({ type: "Median" });
    expect(card.props.map((p) => p.key)).not.toContain("type");
    expect(analyticsCards("lineChart").find((c) => c.id === "referenceLine#percentile")!.props.map((p) => p.key)).toContain("percentile");
  });

  it("visuals without analytics have none; objects without a style give no cards", () => {
    expect(analyticsCards("pieChart")).toEqual([]);
    expect(visualCards("unknownVisual")).toEqual([]);
    expect(visualObjects("unknownVisual")).toBeNull();
  });

  it("buttons offer an Action card; charts do not", () => {
    expect(visualCards("actionButton").some((c) => c.id === "visualLink")).toBe(true);
    expect(visualCards("lineChart").some((c) => c.id === "visualLink")).toBe(false);
  });
});

describe("labels", () => {
  it("humanizes names", () => {
    expect(humanize("gridlineThickness")).toBe("Gridline thickness");
    expect(propLabel("labelDisplayUnits")).toBe("Display units");
    expect(optionLabel("labelDisplayUnits", 1000000)).toBe("Millions");
    expect(optionLabel("position", "TopCenter")).toBe("Top center");
  });
});
