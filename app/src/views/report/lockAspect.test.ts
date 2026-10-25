import { describe, expect, it } from "vitest";
import { dragPosition } from "./PageCanvas";

const orig = { x: 100, y: 100, z: 0, width: 200, height: 100 };

describe("lock aspect while resizing", () => {
  it("without the lock a handle changes only its own side", () => {
    expect(dragPosition(orig, "e", 50, 0, 1000, 800)).toMatchObject({ width: 250, height: 100 });
  });
  it("with the lock an edge handle keeps the ratio (2:1)", () => {
    expect(dragPosition(orig, "e", 50, 0, 1000, 800, true)).toMatchObject({ x: 100, width: 250, height: 125 });
    expect(dragPosition(orig, "s", 0, 50, 1000, 800, true)).toMatchObject({ width: 300, height: 150 });
  });
  it("a corner handle follows the larger movement, and the opposite corner stays put", () => {
    expect(dragPosition(orig, "se", 100, 10, 1000, 800, true)).toMatchObject({ x: 100, y: 100, width: 300, height: 150 });
    const nw = dragPosition(orig, "nw", -40, -10, 1000, 800, true);
    expect(nw.width / nw.height).toBeCloseTo(2, 1);
    expect(nw.x + nw.width).toBe(300);
    expect(nw.y + nw.height).toBe(200);
  });
  it("stays on the page with the same ratio", () => {
    const p = dragPosition(orig, "se", 2000, 0, 500, 800, true);
    expect(p.x + p.width).toBeLessThanOrEqual(500);
    expect(p.width / p.height).toBeCloseTo(2, 1);
  });
});
