import { useRef, useState } from "react";
import { readLitProp } from "../../core/report/pbir";
import type { PageModel, Position } from "../../core/report/visualDoc";
import { useReport } from "./reportContext";
import { VisualFrame, type Handle } from "./VisualFrame";

export function pageBackground(page: PageModel, fallback: string): string {
  const l = readLitProp(page.json.objects?.background?.[0]?.properties?.color);
  return l && l.t === "string" ? l.v : fallback;
}

interface Drag {
  name: string;
  mode: "move" | Handle;
  startX: number;
  startY: number;
  orig: Position;
  cur: Position;
  moved: boolean;
}

const MIN = 40;

/** Applies a pointer movement of (dx, dy) page pixels to a position, keeping the visual on the page. */
export function dragPosition(orig: Position, mode: "move" | Handle, dx: number, dy: number, pageW: number, pageH: number): Position {
  let { x, y, width, height } = orig;
  if (mode === "move") {
    x = Math.min(Math.max(0, orig.x + dx), Math.max(0, pageW - width));
    y = Math.min(Math.max(0, orig.y + dy), Math.max(0, pageH - height));
  } else {
    if (mode.includes("e")) width = Math.max(MIN, Math.min(orig.width + dx, pageW - orig.x));
    if (mode.includes("s")) height = Math.max(MIN, Math.min(orig.height + dy, pageH - orig.y));
    if (mode.includes("w")) {
      const nx = Math.min(Math.max(0, orig.x + dx), orig.x + orig.width - MIN);
      width = orig.x + orig.width - nx;
      x = nx;
    }
    if (mode.includes("n")) {
      const ny = Math.min(Math.max(0, orig.y + dy), orig.y + orig.height - MIN);
      height = orig.y + orig.height - ny;
      y = ny;
    }
  }
  return { ...orig, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export interface PageCanvasProps {
  page: PageModel;
  scale: number;
  editing: boolean;
  selected: string | null;
  onSelect(name: string | null): void;
}

/** A report page: the visuals at their positions, with selection, moving and resizing when `editing`. */
export function PageCanvas(p: PageCanvasProps) {
  const c = useReport();
  const { page, scale } = p;
  const [drag, setDrag] = useState<Drag | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const start = (e: React.PointerEvent, name: string, mode: "move" | Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const v = page.visuals.find((x) => x.name === name)!;
    p.onSelect(name);
    root.current?.setPointerCapture?.(e.pointerId);
    setDrag({ name, mode, startX: e.clientX, startY: e.clientY, orig: v.position, cur: v.position, moved: false });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;
    const cur = dragPosition(drag.orig, drag.mode, dx, dy, page.width, page.height);
    setDrag({ ...drag, cur, moved: drag.moved || Math.abs(dx) >= 1 || Math.abs(dy) >= 1 });
  };
  const end = () => {
    if (!drag) return;
    if (drag.moved) c.dispatch("report.visual.setPosition", { page: page.name, visual: drag.name, position: { x: drag.cur.x, y: drag.cur.y, width: drag.cur.width, height: drag.cur.height } });
    setDrag(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!p.editing) return;
    if (e.key === "Escape") {
      if (c.snap.editInteractions) c.dispatch("report.interaction.edit", { source: null });
      else if (c.snap.selection) c.dispatch("report.view.clearSelection");
      else p.onSelect(null);
      return;
    }
    if (!p.selected) return;
    const v = page.visuals.find((x) => x.name === p.selected);
    if (!v) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      c.dispatch("report.visual.delete", { page: page.name, visual: v.name });
      p.onSelect(null);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key as "ArrowLeft"];
    if (d) {
      e.preventDefault();
      const pos = dragPosition(v.position, "move", d[0], d[1], page.width, page.height);
      c.dispatch("report.visual.setPosition", { page: page.name, visual: v.name, position: { x: pos.x, y: pos.y } });
    }
  };

  return (
    <div style={{ width: page.width * scale, height: page.height * scale, position: "relative", flex: "none" }}>
      <div
        ref={root}
        tabIndex={0}
        role="region"
        aria-label={`Page ${page.displayName}`}
        data-page={page.name}
        onKeyDown={onKey}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => setDrag(null)}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            p.onSelect(null);
            c.dispatch("report.view.clearSelection");
          }
        }}
        style={{ position: "absolute", left: 0, top: 0, width: page.width, height: page.height, transform: `scale(${scale})`, transformOrigin: "0 0", background: pageBackground(page, c.theme.pageBackground), boxShadow: "0 1px 6px rgba(0,0,0,.25)", outline: "none", overflow: "hidden" }}
      >
        {page.visuals
          .filter((v) => p.editing || !v.hidden)
          .map((v) => (
            <VisualFrame
              key={v.name}
              page={page}
              visual={v}
              position={drag?.name === v.name ? drag.cur : v.position}
              selected={p.selected === v.name}
              editing={p.editing}
              onPointerDownFrame={(e, mode) => start(e, v.name, mode)}
              onSelect={() => p.onSelect(v.name)}
            />
          ))}
        {page.visuals.length === 0 && p.editing && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: c.theme.muted, fontSize: 14, pointerEvents: "none" }}>
            This page is empty. Choose a visual type in the Visualizations pane, then add fields from the Data pane.
          </div>
        )}
      </div>
    </div>
  );
}
