import { useRef, useState } from "react";
import { boxesInRect } from "../../core/report/arrange";
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
  /** Positions of everything that moves with the drag (several visuals when a selection is moved). */
  origs: Record<string, Position>;
  cur: Record<string, Position>;
  moved: boolean;
}

interface Band {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  additive: boolean;
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

/** A group of selected visuals moves as one: the same shift for all, limited by the member that reaches the page edge first. */
export function dragGroup(origs: Record<string, Position>, dx: number, dy: number, pageW: number, pageH: number): Record<string, Position> {
  const all = Object.values(origs);
  const minDx = Math.max(...all.map((o) => -o.x));
  const maxDx = Math.min(...all.map((o) => pageW - o.width - o.x));
  const minDy = Math.max(...all.map((o) => -o.y));
  const maxDy = Math.min(...all.map((o) => pageH - o.height - o.y));
  const sx = Math.round(Math.min(Math.max(dx, Math.min(minDx, maxDx)), Math.max(minDx, maxDx)));
  const sy = Math.round(Math.min(Math.max(dy, Math.min(minDy, maxDy)), Math.max(minDy, maxDy)));
  return Object.fromEntries(Object.entries(origs).map(([k, o]) => [k, { ...o, x: o.x + sx, y: o.y + sy }]));
}

export interface PageCanvasProps {
  page: PageModel;
  scale: number;
  editing: boolean;
  /** Selected visuals in the order they were selected; the last one is the primary selection. */
  selection: string[];
  onSelection(names: string[]): void;
}

/** A report page: the visuals at their positions, with selection, moving and resizing when `editing`. */
export function PageCanvas(p: PageCanvasProps) {
  const c = useReport();
  const { page, scale } = p;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [band, setBand] = useState<Band | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const selection = p.selection.filter((n) => page.visuals.some((v) => v.name === n));
  const primary = selection.at(-1) ?? null;

  const toPage = (e: { clientX: number; clientY: number }) => {
    const r = root.current?.getBoundingClientRect();
    return { x: (e.clientX - (r?.left ?? 0)) / scale, y: (e.clientY - (r?.top ?? 0)) / scale };
  };

  const start = (e: React.PointerEvent, name: string, mode: "move" | Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const inSelection = selection.includes(name);
    const names = mode === "move" && inSelection ? selection : [name];
    if (!inSelection) p.onSelection([name]);
    if (c.readOnly) return;
    const origs = Object.fromEntries(names.map((n) => [n, page.visuals.find((x) => x.name === n)!.position]));
    root.current?.setPointerCapture?.(e.pointerId);
    setDrag({ name, mode, startX: e.clientX, startY: e.clientY, origs, cur: origs, moved: false });
  };
  const move = (e: React.PointerEvent) => {
    if (band) {
      const pt = toPage(e);
      setBand({ ...band, x1: pt.x, y1: pt.y });
      return;
    }
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;
    const cur = drag.mode === "move" ? dragGroup(drag.origs, dx, dy, page.width, page.height) : { [drag.name]: dragPosition(drag.origs[drag.name], drag.mode, dx, dy, page.width, page.height) };
    setDrag({ ...drag, cur, moved: drag.moved || Math.abs(dx) >= 1 || Math.abs(dy) >= 1 });
  };
  const end = () => {
    if (band) {
      const hit = boxesInRect(
        page.visuals.filter((v) => p.editing && !v.hidden).map((v) => ({ name: v.name, ...v.position })),
        band.x0,
        band.y0,
        band.x1,
        band.y1,
      );
      if (Math.abs(band.x1 - band.x0) > 3 || Math.abs(band.y1 - band.y0) > 3) p.onSelection(band.additive ? [...selection.filter((n) => !hit.includes(n)), ...hit] : hit);
      setBand(null);
      return;
    }
    if (!drag) return;
    if (drag.moved) {
      const items = Object.entries(drag.cur).map(([visual, pos]) => ({ visual, position: { x: pos.x, y: pos.y, width: pos.width, height: pos.height } }));
      if (items.length === 1) c.dispatch("report.visual.setPosition", { page: page.name, visual: items[0].visual, position: items[0].position });
      else c.dispatch("report.visuals.setPositions", { page: page.name, items });
    }
    setDrag(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!p.editing) return;
    if (c.readOnly && e.key !== "Escape") return;
    if (e.key === "Escape") {
      if (c.snap.editInteractions) c.dispatch("report.interaction.edit", { source: null });
      else if (c.snap.selection) c.dispatch("report.view.clearSelection");
      else p.onSelection([]);
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      p.onSelection(page.visuals.filter((v) => !v.hidden).map((v) => v.name));
      return;
    }
    if (mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      c.dispatch("report.visuals.paste", { page: page.name });
      return;
    }
    if (selection.length === 0) return;
    if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
      e.preventDefault();
      c.dispatch(e.key.toLowerCase() === "c" ? "report.visuals.copy" : "report.visuals.cut", { page: page.name, visuals: selection });
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      c.dispatch("report.visuals.delete", { page: page.name, visuals: selection });
      p.onSelection([]);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key as "ArrowLeft"];
    if (d) {
      e.preventDefault();
      const origs = Object.fromEntries(selection.map((n) => [n, page.visuals.find((x) => x.name === n)!.position]));
      const moved = dragGroup(origs, d[0], d[1], page.width, page.height);
      const items = Object.entries(moved).map(([visual, pos]) => ({ visual, position: { x: pos.x, y: pos.y } }));
      if (items.length === 1) c.dispatch("report.visual.setPosition", { page: page.name, visual: items[0].visual, position: items[0].position });
      else c.dispatch("report.visuals.setPositions", { page: page.name, items });
    }
  };

  const select = (name: string, additive: boolean) => {
    if (additive) p.onSelection(selection.includes(name) ? selection.filter((n) => n !== name) : [...selection, name]);
    else p.onSelection([name]);
    // dragging a group starts on the title bar of a selected visual, which keeps the selection (see start)
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
        onPointerCancel={() => {
          setDrag(null);
          setBand(null);
        }}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (!p.editing || c.readOnly || e.button !== 0) {
            p.onSelection([]);
            c.dispatch("report.view.clearSelection");
            return;
          }
          const pt = toPage(e);
          const additive = e.shiftKey || e.ctrlKey || e.metaKey;
          if (!additive) p.onSelection([]);
          c.dispatch("report.view.clearSelection");
          root.current?.setPointerCapture?.(e.pointerId);
          setBand({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, additive });
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
              position={drag?.cur[v.name] ?? v.position}
              selected={selection.includes(v.name)}
              primary={primary === v.name}
              multi={selection.length > 1}
              editing={p.editing}
              onPointerDownFrame={(e, mode) => start(e, v.name, mode)}
              onSelect={(additive) => select(v.name, additive)}
            />
          ))}
        {band && (
          <div
            data-testid="rubber-band"
            style={{ position: "absolute", left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0), border: "1px solid #0f6cbd", background: "rgba(15,108,189,.12)", pointerEvents: "none", zIndex: 20000 }}
          />
        )}
        {page.visuals.length === 0 && p.editing && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: c.theme.muted, fontSize: 14, pointerEvents: "none" }}>
            This page is empty. Choose a visual type in the Visualizations pane, then add fields from the Data pane.
          </div>
        )}
      </div>
    </div>
  );
}
