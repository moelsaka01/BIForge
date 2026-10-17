import { describe, expect, it } from "vitest";
import { alignBoxes, boxesInRect, distributeBoxes, type Box } from "./arrange";

const b = (name: string, x: number, y: number, width: number, height: number): Box => ({ name, x, y, width, height });
const A = b("a", 10, 20, 100, 50);
const B = b("b", 200, 60, 40, 80);
const C = b("c", 120, 5, 60, 30);

describe("align", () => {
  it("lines up with the edges of the whole selection", () => {
    expect(alignBoxes([A, B, C], "left")).toEqual({ a: { x: 10 }, b: { x: 10 }, c: { x: 10 } });
    expect(alignBoxes([A, B, C], "right")).toEqual({ a: { x: 140 }, b: { x: 200 }, c: { x: 180 } });
    expect(alignBoxes([A, B, C], "top")).toEqual({ a: { y: 5 }, b: { y: 5 }, c: { y: 5 } });
    expect(alignBoxes([A, B, C], "bottom")).toEqual({ a: { y: 90 }, b: { y: 60 }, c: { y: 110 } });
  });
  it("centers horizontally and vertically on the selection", () => {
    // the selection spans x 10..240 (center 125) and y 5..140 (center 72.5)
    expect(alignBoxes([A, B, C], "center").a).toEqual({ x: 75 });
    expect(alignBoxes([A, B, C], "center").b).toEqual({ x: 105 });
    expect(alignBoxes([A, B, C], "middle").c).toEqual({ y: 57.5 });
  });
  it("needs two visuals", () => {
    expect(() => alignBoxes([A], "left")).toThrow(/at least two/);
  });
});

describe("distribute", () => {
  it("makes the gaps equal and keeps the outermost visuals in place", () => {
    const out = distributeBoxes([b("a", 0, 0, 10, 10), b("b", 15, 0, 20, 10), b("c", 90, 0, 10, 10)], "horizontal");
    // span 100, widths 40, two gaps of 30
    expect(out).toEqual({ a: { x: 0 }, b: { x: 40 }, c: { x: 90 } });
  });
  it("works vertically and ignores the order given", () => {
    const out = distributeBoxes([b("c", 0, 100, 10, 10), b("a", 0, 0, 10, 20), b("b", 0, 30, 10, 10)], "vertical");
    // span 110, heights 40, gaps 35
    expect(out).toEqual({ a: { y: 0 }, b: { y: 55 }, c: { y: 100 } });
  });
  it("needs three visuals", () => {
    expect(() => distributeBoxes([A, B], "horizontal")).toThrow(/at least three/);
  });
});

describe("rubber band", () => {
  it("selects visuals that touch the rectangle, dragged in any direction", () => {
    expect(boxesInRect([A, B, C], 0, 0, 130, 40)).toEqual(["a", "c"]);
    expect(boxesInRect([A, B, C], 130, 40, 0, 0)).toEqual(["a", "c"]);
    expect(boxesInRect([A, B, C], 300, 300, 400, 400)).toEqual([]);
    expect(boxesInRect([A, B, C], 110, 20, 120, 25)).toEqual([]); // touching edges do not count
  });
});
