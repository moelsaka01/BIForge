import { describe, expect, it } from "vitest";
import { visibleRange } from "./gridMath";
import { PageCache } from "./pageCache";
import { FakeEngine, col } from "../core/testing/fakeEngine";

describe("visibleRange", () => {
  it("renders only the viewport plus overscan, never past the ends", () => {
    expect(visibleRange(0, 100, 20, 1_000_000, 2)).toEqual({ first: 0, end: 7 });
    expect(visibleRange(2000, 100, 20, 1_000_000, 2)).toEqual({ first: 98, end: 107 });
    expect(visibleRange(0, 100, 20, 3, 2)).toEqual({ first: 0, end: 3 });
    expect(visibleRange(0, 100, 20, 0)).toEqual({ first: 0, end: 0 });
    expect(visibleRange(99999, 100, 20, 10, 2)).toEqual({ first: 10, end: 10 });
  });
});

describe("PageCache", () => {
  function engineWith(n: number) {
    const e = new FakeEngine();
    e.tables.set("T", { columns: [col("k", "int64")], rows: Array.from({ length: n }, (_, i) => [String(i)]) });
    return e;
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("loads only the pages that are asked for, once", async () => {
    const e = engineWith(1000);
    const c = new PageCache(e, "T", null, 100);
    c.ensure(250, 260);
    c.ensure(250, 260);
    await settle();
    expect(e.calls.filter((x) => x.startsWith("page"))).toEqual(["page:T:200:100:"]);
    expect(c.row(255)).toEqual(["255"]);
    expect(c.row(5)).toBeUndefined();
    expect(c.total).toBe(1000);
    c.ensure(195, 205);
    await settle();
    expect(e.calls.filter((x) => x.startsWith("page"))).toHaveLength(2);
  });

  it("reset with a new sort drops old pages and ignores stale responses", async () => {
    const e = engineWith(300);
    const c = new PageCache(e, "T", null, 100);
    c.ensure(0, 10);
    c.reset({ column: "k", descending: true }); // before the first response arrives
    await settle();
    expect(c.row(0)).toBeUndefined();
    c.ensure(0, 10);
    await settle();
    expect(c.row(0)).toEqual(["299"]);
  });

  it("surfaces engine errors", async () => {
    const c = new PageCache(new FakeEngine(), "Missing", null, 100);
    c.ensure(0, 1);
    await settle();
    expect(c.error).toContain("Missing");
  });
});
