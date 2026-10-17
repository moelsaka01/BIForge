import { describe, expect, it } from "vitest";
import { boundsOf, snapMove, snapResize } from "./guides";

const page = { width: 1000, height: 600 };
const box = (name: string, x: number, y: number, width: number, height: number) => ({ name, x, y, width, height });
const opt = { guides: true, threshold: 5, grid: null as number | null };

describe("smart guides while moving", () => {
  it("snaps a left edge to the left edge of another visual and draws a vertical guide between them", () => {
    const other = box("a", 100, 50, 200, 100);
    const r = snapMove(box("m", 103, 320, 150, 80), [other], page, opt);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([{ axis: "v", at: 100, from: 50, to: 400 }]);
  });

  it("aligns centers and right edges, on both axes at once", () => {
    const other = box("a", 100, 100, 200, 100); // center x 200, bottom 200
    const r = snapMove(box("m", 124, 220, 150, 80), [other], page, opt); // center x 199, top 220
    expect(r.dx).toBe(1);
    expect(r.guides.some((g) => g.axis === "v" && g.at === 200)).toBe(true);
    const r2 = snapMove(box("m", 160, 197, 140, 60), [other], page, opt); // right edge 300 = other right; top 197 vs bottom 200
    expect(r2.dx).toBe(0);
    expect(r2.dy).toBe(3);
    expect(r2.guides.map((g) => `${g.axis}${g.at}`).sort()).toEqual(["h200", "v300"]);
  });

  it("snaps to the page edges and its center, with a guide across the whole page", () => {
    const r = snapMove(box("m", 3, 2, 100, 100), [], page, opt);
    expect([r.dx, r.dy]).toEqual([-3, -2]);
    expect(r.guides).toEqual([
      { axis: "v", at: 0, from: 0, to: 600 },
      { axis: "h", at: 0, from: 0, to: 1000 },
    ]);
    const c = snapMove(box("m", 452, 100, 100, 100), [], page, opt); // center x 502 vs page center 500
    expect(c.dx).toBe(-2);
  });

  it("does nothing outside the threshold, and when guides are off", () => {
    const other = box("a", 100, 50, 200, 100);
    expect(snapMove(box("m", 110, 320, 150, 80), [other], page, opt)).toEqual({ dx: 0, dy: 0, guides: [] });
    expect(snapMove(box("m", 103, 320, 150, 80), [other], page, { ...opt, guides: false })).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("snaps to a grid when it is on and no guide applies", () => {
    expect(snapMove(box("m", 123, 247, 150, 80), [], page, { guides: false, threshold: 5, grid: 20 })).toEqual({ dx: -3, dy: -7, guides: [] });
    // a guide wins over the grid
    const r = snapMove(box("m", 103, 247, 150, 80), [box("a", 100, 400, 50, 50)], page, { guides: true, threshold: 5, grid: 20 });
    expect(r.dx).toBe(-3);
  });

  it("a multi-selection moves by the snap of its bounding box", () => {
    const b = boundsOf([box("a", 10, 10, 50, 50), box("b", 80, 40, 50, 100)]);
    expect(b).toEqual({ name: "selection", x: 10, y: 10, width: 120, height: 130 });
  });
});

describe("smart guides while resizing", () => {
  it("snaps only the edges the handle moves", () => {
    const other = box("a", 400, 50, 100, 100);
    const r = snapResize(box("m", 100, 300, 297, 120), "e", [other], page, opt); // right edge 397 -> 400
    expect(r.box).toMatchObject({ x: 100, y: 300, width: 300, height: 120 });
    expect(r.guides[0]).toMatchObject({ axis: "v", at: 400 });
    // the left handle keeps the right edge fixed
    const w = snapResize(box("m", 403, 300, 197, 120), "w", [other], page, opt);
    expect(w.box).toMatchObject({ x: 400, width: 200 });
  });

  it("north and south handles use the horizontal guides", () => {
    const other = box("a", 400, 50, 100, 100); // bottom 150
    const r = snapResize(box("m", 100, 153, 100, 147), "n", [other], page, opt);
    expect(r.box).toMatchObject({ y: 150, height: 150 });
    const s = snapResize(box("m", 100, 100, 100, 298), "s", [box("b", 0, 400, 50, 50)], page, opt);
    expect(s.box.height).toBe(300);
  });
});
