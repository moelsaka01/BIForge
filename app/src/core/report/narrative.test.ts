import { describe, expect, it } from "vitest";
import { decodeCell } from "./cells";
import type { Loaded } from "./dataLoader";
import { agg, column, lit } from "./fields";
import { buildNarrative, describeMeasure, type Seg } from "./narrative";
import { buildVisualQuery } from "./queryBuilder";
import { fixtureModel, visualOf } from "./testFixture";
import { DEFAULT_THEME } from "./theme";
import { setFormat } from "./visualDoc";

const model = fixtureModel({ formats: {} });
const text = (sent: Seg[]) => sent.map((x) => x.text).join("");
const fmt = (x: number) => String(x);

describe("describeMeasure", () => {
  it("names the highest and the lowest category, the share of the highest and the average", () => {
    const out = describeMeasure("Quantity", "Category", ["Bikes", "Clothing", "Parts"], [60, 30, 10], fmt, false).map(text);
    expect(out[0]).toBe("Bikes has the highest Quantity (60), 60% of the total.");
    expect(out[1]).toBe("Parts has the lowest (10).");
    expect(out[2]).toBe("Across 3 category, the average Quantity is 33.333333333333336.");
  });
  it("over dates it describes the change from the first to the last point", () => {
    const out = describeMeasure("Sales", "Month", ["Jan", "Feb", "Mar"], [100, 150, 200], fmt, true).map(text);
    expect(out[2]).toBe("Sales went from 100 in Jan to 200 in Mar (+100.0%).");
  });
  it("one row is one sentence, an empty result says so, and the numbers are marked", () => {
    expect(describeMeasure("Quantity", "", [""], [5], fmt, false).map(text)).toEqual(["Quantity is 5."]);
    expect(describeMeasure("Quantity", "Category", ["a"], [null], fmt, false).map(text)).toEqual(["There is no value of Quantity."]);
    const [first] = describeMeasure("Q", "C", ["a", "b"], [1, 2], fmt, false);
    expect(first.filter((x) => x.strong).map((x) => x.text)).toEqual(["b", "Q", "2", "67%"]);
  });
});

describe("buildNarrative", () => {
  it("writes sentences from the result of the visual and styles them from the Text card", () => {
    const v = visualOf("aiNarratives", { Values: [column("Product", "Category"), agg("Sales", "Quantity", 0)] });
    const query = buildVisualQuery(v, model, { filters: [] })!;
    const loaded: Extract<Loaded, { kind: "grouped" }> = { kind: "grouped", query, rows: [[decodeCell({ t: "text", v: "Bikes" }), decodeCell({ t: "int", v: "70" })], [decodeCell({ t: "text", v: "Clothing" }), decodeCell({ t: "int", v: "30" })]], highlightRows: null, totals: null, truncated: false, ms: 0 };
    setFormat(v.json, "text", "fontSize", lit.num(20));
    setFormat(v.json, "text", "textAlignment", lit.str("Center"));
    const m = buildNarrative(v, loaded, DEFAULT_THEME);
    expect(text(m.sentences[0])).toBe("Bikes has the highest Sum of Quantity (70), 70% of the total.");
    expect(m.style.fontSize).toBe(20);
    expect(m.align).toBe("center");
  });
});
