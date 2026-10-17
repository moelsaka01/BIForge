// Arranging several visuals on a page: align to the selection's edges or center, distribute with equal gaps.
// Pure geometry; the operations in reportOps apply the result to the document.

export interface Box {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";
export type Moves = Record<string, { x?: number; y?: number }>;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Moves every box so that it lines up with the bounding box of the whole selection. */
export function alignBoxes(boxes: Box[], mode: AlignMode): Moves {
  if (boxes.length < 2) throw new Error("Select at least two visuals to align them.");
  const left = Math.min(...boxes.map((b) => b.x));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const out: Moves = {};
  for (const b of boxes) {
    switch (mode) {
      case "left":
        out[b.name] = { x: left };
        break;
      case "right":
        out[b.name] = { x: r2(right - b.width) };
        break;
      case "center":
        out[b.name] = { x: r2((left + right) / 2 - b.width / 2) };
        break;
      case "top":
        out[b.name] = { y: top };
        break;
      case "bottom":
        out[b.name] = { y: r2(bottom - b.height) };
        break;
      case "middle":
        out[b.name] = { y: r2((top + bottom) / 2 - b.height / 2) };
        break;
    }
  }
  return out;
}

/** Spreads three or more boxes so that the gaps between neighbours are equal; the outermost boxes stay where they are. */
export function distributeBoxes(boxes: Box[], axis: DistributeAxis): Moves {
  if (boxes.length < 3) throw new Error("Select at least three visuals to distribute them.");
  const horizontal = axis === "horizontal";
  const pos = (b: Box) => (horizontal ? b.x : b.y);
  const size = (b: Box) => (horizontal ? b.width : b.height);
  const sorted = [...boxes].sort((a, b) => pos(a) - pos(b) || a.name.localeCompare(b.name));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = pos(last) + size(last) - pos(first);
  const gap = (span - sorted.reduce((a, b) => a + size(b), 0)) / (sorted.length - 1);
  const out: Moves = {};
  let at = pos(first);
  for (const b of sorted) {
    out[b.name] = horizontal ? { x: r2(at) } : { y: r2(at) };
    at += size(b) + gap;
  }
  return out;
}

/** The boxes of a rubber band that touch the rectangle (x1,y1)-(x2,y2), in any drag direction. */
export function boxesInRect(boxes: Box[], x1: number, y1: number, x2: number, y2: number): string[] {
  const l = Math.min(x1, x2);
  const r = Math.max(x1, x2);
  const t = Math.min(y1, y2);
  const b = Math.max(y1, y2);
  return boxes.filter((k) => k.x < r && k.x + k.width > l && k.y < b && k.y + k.height > t).map((k) => k.name);
}
