// Smart guides and snapping while a visual is dragged or resized: edges and centers snap to those of the other
// visuals and to the page edges and center, and to a grid when Snap to grid is on. Pure geometry; the canvas draws
// the guide lines it returns.
import type { Box } from "./arrange";

export interface GuideLine {
  /** "v": a vertical line at x = at; "h": a horizontal line at y = at. */
  axis: "v" | "h";
  at: number;
  /** Extent of the line along the other axis. */
  from: number;
  to: number;
}

export interface SnapOptions {
  /** Snap to other visuals and the page (smart guides). */
  guides: boolean;
  /** Distance, in page pixels, within which an edge snaps. */
  threshold: number;
  /** Grid cell size when Snap to grid is on, else null. */
  grid: number | null;
}

export interface PageSize {
  width: number;
  height: number;
}

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface Hit {
  delta: number;
  at: number;
  other: Box | "page";
}

/** The edge or center positions of a box along one axis. */
const marks = (b: Box, axis: "x" | "y"): number[] => (axis === "x" ? [b.x, b.x + b.width / 2, b.x + b.width] : [b.y, b.y + b.height / 2, b.y + b.height]);
const pageMarks = (p: PageSize, axis: "x" | "y"): number[] => (axis === "x" ? [0, p.width / 2, p.width] : [0, p.height / 2, p.height]);

/** The nearest alignment of any of `mine` with a target of another visual or the page, within the threshold. */
function nearest(mine: number[], others: Box[], page: PageSize, axis: "x" | "y", threshold: number): Hit | null {
  let best: Hit | null = null;
  const consider = (target: number, other: Box | "page") => {
    for (const m of mine) {
      const d = target - m;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: target, other };
    }
  };
  for (const t of pageMarks(page, axis)) consider(t, "page");
  for (const o of others) for (const t of marks(o, axis)) consider(t, o);
  return best;
}

/** The line a hit draws: along the other axis from the moving box to the box it aligned with (the whole page for the page). */
function lineFor(hit: Hit, moving: Box, axis: "x" | "y", page: PageSize): GuideLine {
  const vertical = axis === "x";
  const mFrom = vertical ? moving.y : moving.x;
  const mTo = vertical ? moving.y + moving.height : moving.x + moving.width;
  if (hit.other === "page") return { axis: vertical ? "v" : "h", at: hit.at, from: 0, to: vertical ? page.height : page.width };
  const o = hit.other;
  const oFrom = vertical ? o.y : o.x;
  const oTo = vertical ? o.y + o.height : o.x + o.width;
  return { axis: vertical ? "v" : "h", at: hit.at, from: Math.min(mFrom, oFrom), to: Math.max(mTo, oTo) };
}

const snapToGrid = (v: number, grid: number) => Math.round(v / grid) * grid;

export interface MoveResult {
  /** Shift to add to the dragged box (and everything that moves with it). */
  dx: number;
  dy: number;
  guides: GuideLine[];
}

/** Snaps a box being moved: returns the extra shift that makes its edges or center line up, and the guides to draw. */
export function snapMove(moving: Box, others: Box[], page: PageSize, opt: SnapOptions): MoveResult {
  let dx = 0;
  let dy = 0;
  const guides: GuideLine[] = [];
  if (opt.guides) {
    const hx = nearest(marks(moving, "x"), others, page, "x", opt.threshold);
    const hy = nearest(marks(moving, "y"), others, page, "y", opt.threshold);
    if (hx) dx = hx.delta;
    if (hy) dy = hy.delta;
    const after: Box = { ...moving, x: moving.x + dx, y: moving.y + dy };
    if (hx) guides.push(lineFor(hx, after, "x", page));
    if (hy) guides.push(lineFor(hy, after, "y", page));
    if (hx || hy) return { dx, dy, guides };
  }
  if (opt.grid) {
    dx = snapToGrid(moving.x, opt.grid) - moving.x;
    dy = snapToGrid(moving.y, opt.grid) - moving.y;
  }
  return { dx, dy, guides };
}

/** Snaps the edges that move while resizing with `handle`; returns the adjusted box. */
export function snapResize(box: Box, handle: Handle, others: Box[], page: PageSize, opt: SnapOptions): { box: Box; guides: GuideLine[] } {
  let { x, y, width, height } = box;
  const guides: GuideLine[] = [];
  const edge = (axis: "x" | "y", value: number): number => {
    if (opt.guides) {
      const hit = nearest([value], others, page, axis, opt.threshold);
      if (hit) {
        guides.push(lineFor(hit, box, axis, page));
        return value + hit.delta;
      }
    }
    return opt.grid ? snapToGrid(value, opt.grid) : value;
  };
  if (handle.includes("e")) width = edge("x", x + width) - x;
  if (handle.includes("w")) {
    const right = x + width;
    x = edge("x", x);
    width = right - x;
  }
  if (handle.includes("s")) height = edge("y", y + height) - y;
  if (handle.includes("n")) {
    const bottom = y + height;
    y = edge("y", y);
    height = bottom - y;
  }
  return { box: { ...box, x, y, width, height }, guides };
}

/** The bounding box of several boxes (a multi-selection moves as one). */
export function boundsOf(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { name: "selection", x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}
