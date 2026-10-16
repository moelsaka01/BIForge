import { useRef, useState } from "react";
import { MAX_PANE_WIDTH, MIN_PANE_WIDTH } from "../../core/shell/settings";
import { UI_ICONS } from "./icons";

export interface PaneFrameProps {
  title: string;
  /** Which edge of the window the pane is docked to (decides the arrows and the resize edge). */
  side: "left" | "right";
  open: boolean;
  width: number;
  onOpenChange(open: boolean): void;
  onResize(width: number): void;
  headerExtra?: React.ReactNode;
  /** Replaces the title text (the modern shell shows pane tabs there). */
  heading?: React.ReactNode;
  children: React.ReactNode;
}

/** A dockable pane: title with a collapse arrow, a drag handle to resize it, and a slim rail when collapsed. */
export function PaneFrame(p: PaneFrameProps) {
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef({ x: 0, w: 0 });
  const dir = p.side === "right" ? -1 : 1; // moving the pointer toward the canvas makes a right pane wider

  if (!p.open) {
    return (
      <div className={`pane-rail ${p.side}`} data-pane={p.title} data-collapsed="true">
        <button type="button" aria-label={`Expand ${p.title}`} title={`Expand ${p.title}`} onClick={() => p.onOpenChange(true)}>
          {p.side === "right" ? <UI_ICONS.dblLeft aria-hidden /> : <UI_ICONS.dblRight aria-hidden />}
          <span className="vtext">{p.title}</span>
        </button>
      </div>
    );
  }
  const width = drag ?? p.width;
  const clamp = (w: number) => Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, Math.round(w)));
  return (
    <aside className={`pane ${p.side}`} style={{ width }} aria-label={p.title} data-pane={p.title} data-collapsed="false">
      <div
        className={`pane-resizer ${p.side === "right" ? "edge-left" : "edge-right"}${drag !== null ? " dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${p.title}`}
        aria-valuemin={MIN_PANE_WIDTH}
        aria-valuemax={MAX_PANE_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          start.current = { x: e.clientX, w: p.width };
          setDrag(p.width);
        }}
        onPointerMove={(e) => {
          if (drag === null) return;
          setDrag(clamp(start.current.w + dir * (e.clientX - start.current.x)));
        }}
        onPointerUp={() => {
          if (drag !== null) p.onResize(drag);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 16;
          if (e.key === "ArrowLeft") p.onResize(clamp(p.width + (p.side === "right" ? step : -step)));
          else if (e.key === "ArrowRight") p.onResize(clamp(p.width + (p.side === "right" ? -step : step)));
          else return;
          e.preventDefault();
        }}
      />
      <div className="pane-head">
        <div className="pane-title">{p.heading ?? p.title}</div>
        {p.headerExtra}
        <button type="button" className="tb-btn" style={{ color: "inherit" }} aria-label={`Collapse ${p.title}`} title={`Collapse ${p.title}`} onClick={() => p.onOpenChange(false)}>
          {p.side === "right" ? <UI_ICONS.dblRight aria-hidden /> : <UI_ICONS.dblLeft aria-hidden />}
        </button>
      </div>
      <div className="pane-body">{p.children}</div>
    </aside>
  );
}
