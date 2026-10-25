import { describe, expect, it } from "vitest";
import { parseQuestion } from "./qna";
import { fixtureModel } from "./testFixture";
import { column, measure } from "./fields";

const model = fixtureModel({ formats: {} });
const ok = (q: string) => {
  const r = parseQuestion(q, model);
  if (!r.ok) throw new Error(r.message);
  return r.answer;
};

describe("Q&A questions", () => {
  it("<value> by <column> is a column chart with the value summed", () => {
    const a = ok("total quantity by category");
    expect(a.type).toBe("clusteredColumnChart");
    expect(a.roles.Category).toEqual([column("Product", "Category")]);
    expect(a.roles.Y).toEqual([{ kind: "agg", table: "Sales", name: "Quantity", fn: 0 }]);
    expect(a.restated).toBe("total Quantity by Category");
  });
  it("a plural and a missing 'total' are understood; the sum is noted as an assumption", () => {
    const a = ok("quantity per categories");
    expect(a.roles.Category[0]).toEqual(column("Product", "Category"));
    expect(a.assumed).toMatch(/added up/);
    expect(ok("total quantity by category").assumed).toBeUndefined();
  });
  it("average, count, several values and dates", () => {
    expect(ok("average unit price by country").roles.Y).toEqual([{ kind: "agg", table: "Sales", name: "UnitPrice", fn: 1 }]);
    expect(ok("count of customers by country").roles.Y[0]).toMatchObject({ kind: "agg", fn: 5 });
    expect(ok("quantity and unit price by category").roles.Y).toHaveLength(2);
    expect(ok("quantity by order date").type).toBe("lineChart");
  });
  it("top N <column> by <value> keeps the largest n", () => {
    const a = ok("top 3 products by quantity");
    expect(a.top).toMatchObject({ n: 3, dir: "top" });
    expect(a.type).toBe("clusteredBarChart");
    expect(ok("bottom product by quantity").top).toMatchObject({ n: 5, dir: "bottom" });
  });
  it("a single value is a card, a column on its own a table", () => {
    expect(ok("quantity").type).toBe("card");
    expect(ok("country").type).toBe("table");
  });
  it("says what it did not understand", () => {
    expect(parseQuestion("", model)).toMatchObject({ ok: false });
    expect(parseQuestion("quantity by planet", model)).toEqual({ ok: false, message: 'I did not find a column called "planet".' });
    expect(parseQuestion("banana by category", model)).toMatchObject({ ok: false, message: expect.stringContaining('"banana"') });
    expect(parseQuestion("hello world", model)).toMatchObject({ ok: false, message: expect.stringContaining("did not understand") });
  });
  it("a measure of the model is used as it is", () => {
    const m = fixtureModel({ formats: {}, measures: { Sales: ["Total Sales"] } } as never);
    const r = parseQuestion("total sales by category", m);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer.roles.Y[0]).toEqual(measure("Sales", "Total Sales"));
  });
});
