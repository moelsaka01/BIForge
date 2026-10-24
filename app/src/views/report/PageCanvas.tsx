import { useRef, useState } from "react";
import { boxesInRect } from "../../core/report/arrange";
import { boundsOf, snapMove, snapResize, type GuideLine } from "../../core/report/guides";
import { ancestorChain, descendantNames, effectivelyHidden, previewPosition, selectionTarget } from "../../core/report/groups";
import { readLitProp } from "../../core/report/pbir";
import type { GroupModel, PageModel, Position } from "../../core/report/visualDoc";
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
  /** What a click without a drag selects (a member of the selected group, one level deeper). */
  clickTarget: string;
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

/** Background lines of the grid, when Gridlines is on. */
export function gridStyle(on: boolean, size: number, dark: boolean): React.CSSProperties {
  if (!on) return {};
  const line = dark ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.08)";
  return { backgroundImage: `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`, backgroundSize: `${size}px ${size}px` };
}

export interface PageCanvasProps {
  page: PageModel;
  scale: number;
  editing: boolean;
  /** Selected visuals in the order they were selected; the last one is the primary selection. */
  selection: string[];
  onSelection(names: string[]): void;
  /** "mobile": the phone layout (positions are those of mobile.json; Delete removes a visual from the layout instead of the report). */
  layout?: "desktop" | "mobile";
}

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The frame of a group: its background, and when selected its outline and resize handles. */
function GroupFrame(p: { group: GroupModel; position: Position; selected: boolean; multi: boolean; editing: boolean; hidden: boolean; onPointerDownFrame(e: React.PointerEvent, mode: "move" | Handle): void }) {
  const bg = p.group.json.visualGroup?.objects?.background?.[0]?.properties;
  const color = readLitProp(bg?.color);
  const show = readLitProp(bg?.show);
  const transparency = readLitProp(bg?.transparency);
  const on = show?.t === "bool" ? show.v : false;
  const alpha = 1 - Math.min(100, Math.max(0, transparency?.t === "number" ? transparency.v : 0)) / 100;
  return (
    <div
      data-group={p.group.name}
      data-selected={p.selected}
      aria-label={`Group: ${p.group.displayName}`}
      role="group"
      style={{
        position: "absolute",
        left: p.position.x,
        top: p.position.y,
        width: p.position.width,
        height: p.position.height,
        zIndex: Math.round(p.group.position.z / 100) - 1,
        boxSizing: "border-box",
        pointerEvents: "none",
        background: on && color?.t === "string" ? `color-mix(in srgb, ${color.v} ${Math.round(alpha * 100)}%, transparent)` : undefined,
        outline: p.selected ? "1px dashed #0f6cbd" : undefined,
        opacity: p.hidden ? 0.4 : 1,
      }}
    >
      {p.selected && p.editing && !p.multi &&
        HANDLES.map((h) => (
          <div
            key={h}
            data-handle={h}
            onPointerDown={(e) => p.onPointerDownFrame(e, h)}
            style={{
              position: "absolute",
              pointerEvents: "auto",
              width: 9,
              height: 9,
              background: "#fff",
              border: "1px solid #0f6cbd",
              boxSizing: "border-box",
              zIndex: 6,
              left: h.includes("w") ? 0 : h.includes("e") ? undefined : "calc(50% - 4px)",
              right: h.includes("e") ? 0 : undefined,
              top: h.includes("n") ? 0 : h.includes("s") ? undefined : "calc(50% - 4px)",
              bottom: h.includes("s") ? 0 : undefined,
              cursor: h === "n" || h === "s" ? "ns-resize" : h === "e" || h === "w" ? "ew-resize" : h === "ne" || h === "sw" ? "nesw-resize" : "nwse-resize",
            }}
          />
        ))}
    </div>
  );
}

/** A report page: the visuals at their positions, with selection, moving and resizing when `editing`. */
export function PageCanvas(p: PageCanvasProps) {
  const c = useReport();
  const { page, scale } = p;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [band, setBand] = useState<Band | null>(null);
  const [guides, setGuides] = useState<GuideLine[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const itemOf = (n: string) => page.visuals.find((v) => v.name === n) ?? page.groups.find((g) => g.name === n);
  const selection = p.selection.filter((n) => itemOf(n) !== undefined);
  const primary = selection.at(-1) ?? null;
  const topItems = [...page.visuals, ...page.groups].filter((i) => !i.parent);

  const toPage = (e: { clientX: number; clientY: number }) => {
    const r = root.current?.getBoundingClientRect();
    return { x: (e.clientX - (r?.left ?? 0)) / scale, y: (e.clientY - (r?.top ?? 0)) / scale };
  };

  const start = (e: React.PointerEvent, name: string, mode: "move" | Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    // pressing on a member of a selected group drags the group; a click that does not drag then selects the member
    const clickTarget = mode === "move" ? selectionTarget(page, name, selection) : name;
    const selectedAbove = mode === "move" ? [...ancestorChain(page, name), name].reverse().find((n) => selection.includes(n)) : undefined;
    name = selectedAbove ?? clickTarget;
    const inSelection = selection.includes(name);
    // a group moves with its members: they are not dragged one by one
    const chosen = mode === "move" && inSelection ? selection : [name];
    const names = chosen.filter((n) => !chosen.some((g) => g !== n && descendantNames(page, g).includes(n)));
    if (!inSelection) p.onSelection([name]);
    if (c.readOnly || c.canvas.lockObjects) return;
    const origs = Object.fromEntries(names.map((n) => [n, itemOf(n)!.position]));
    root.current?.setPointerCapture?.(e.pointerId);
    setDrag({ name, mode, startX: e.clientX, startY: e.clientY, origs, cur: origs, moved: false, clickTarget });
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
    let cur = drag.mode === "move" ? dragGroup(drag.origs, dx, dy, page.width, page.height) : { [drag.name]: dragPosition(drag.origs[drag.name], drag.mode, dx, dy, page.width, page.height) };
    // smart guides and the grid: Alt held down turns snapping off for this move
    const snapOpt = { guides: c.canvas.smartGuides, threshold: 6 / scale, grid: c.canvas.snapToGrid ? c.canvas.gridSize : null };
    let lines: GuideLine[] = [];
    if (!e.altKey && (snapOpt.guides || snapOpt.grid)) {
      const others = topItems.filter((v) => !(v.name in cur) && !v.hidden).map((v) => ({ name: v.name, ...v.position }));
      if (drag.mode === "move") {
        const bounds = boundsOf(Object.entries(cur).map(([name, pos]) => ({ name, ...pos })));
        const r = snapMove(bounds, others, page, snapOpt);
        if (r.dx !== 0 || r.dy !== 0) cur = dragGroup(Object.fromEntries(Object.entries(cur).map(([k, o]) => [k, { ...o, x: o.x, y: o.y }])), r.dx, r.dy, page.width, page.height);
        lines = r.guides;
      } else {
        const only = cur[drag.name];
        const r = snapResize({ name: drag.name, ...only }, drag.mode, others, page, snapOpt);
        cur = { [drag.name]: { ...only, x: Math.round(r.box.x), y: Math.round(r.box.y), width: Math.max(MIN, Math.round(r.box.width)), height: Math.max(MIN, Math.round(r.box.height)) } };
        lines = r.guides;
      }
    }
    setGuides(lines);
    setDrag({ ...drag, cur, moved: drag.moved || Math.abs(dx) >= 1 || Math.abs(dy) >= 1 });
  };
  const end = () => {
    setGuides([]);
    if (band) {
      const hit = boxesInRect(
        topItems.filter((v) => p.editing && !v.hidden).map((v) => ({ name: v.name, ...v.position })),
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
    if (!drag.moved && drag.mode === "move" && drag.clickTarget !== drag.name) p.onSelection([drag.clickTarget]);
    if (drag.moved) {
      const items = Object.entries(drag.cur).map(([visual, pos]) => ({ visual, position: { x: pos.x, y: pos.y, width: pos.width, height: pos.height } }));
      if (p.layout === "mobile") c.dispatch("report.mobile.setPositions", { page: page.name, items });
      else if (items.length === 1) c.dispatch("report.visual.setPosition", { page: page.name, visual: items[0].visual, position: items[0].position });
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
      p.onSelection(topItems.filter((v) => !v.hidden).map((v) => v.name));
      return;
    }
    if (mod && e.key.toLowerCase() === "g") {
      e.preventDefault();
      if (e.shiftKey) c.dispatch("report.group.ungroup", { page: page.name, visuals: selection.filter((n) => page.groups.some((g) => g.name === n)) });
      else if (selection.length > 1) c.dispatch("report.visuals.group", { page: page.name, visuals: selection });
      return;
    }
    if (mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      c.dispatch("report.visuals.paste", { page: page.name });
      return;
    }
    // Ctrl+Shift+C clears the selection of data points (cross-highlighting) made by clicking inside visuals
    if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      c.dispatch("report.view.clearSelection");
      return;
    }
    // Tab / Shift+Tab select the next / previous visual of the page (front to back)
    if (e.key === "Tab" && !mod && !e.altKey) {
      const shown = topItems.filter((v) => !v.hidden);
      if (shown.length === 0) return;
      e.preventDefault();
      const at = shown.findIndex((v) => v.name === selection[0]);
      const next = at < 0 ? (e.shiftKey ? shown.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + shown.length) % shown.length;
      p.onSelection([shown[next].name]);
      return;
    }
    if (selection.length === 0) return;
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      for (const name of selection) if (!page.groups.some((g) => g.name === name)) c.dispatch("report.visual.duplicate", { page: page.name, visual: name });
      return;
    }
    if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
      e.preventDefault();
      c.dispatch(e.key.toLowerCase() === "c" ? "report.visuals.copy" : "report.visuals.cut", { page: page.name, visuals: selection });
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      c.dispatch(p.layout === "mobile" ? "report.mobile.remove" : "report.visuals.delete", { page: page.name, visuals: selection });
      p.onSelection([]);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key as "ArrowLeft"];
    if (d) {
      e.preventDefault();
      const movable = selection.filter((n) => !selection.some((g) => g !== n && descendantNames(page, g).includes(n)));
      const origs = Object.fromEntries(movable.map((n) => [n, itemOf(n)!.position]));
      const moved = dragGroup(origs, d[0], d[1], page.width, page.height);
      const items = Object.entries(moved).map(([visual, pos]) => ({ visual, position: { x: pos.x, y: pos.y } }));
      if (p.layout === "mobile") c.dispatch("report.mobile.setPositions", { page: page.name, items });
      else if (items.length === 1) c.dispatch("report.visual.setPosition", { page: page.name, visual: items[0].visual, position: items[0].position });
      else c.dispatch("report.visuals.setPositions", { page: page.name, items });
    }
  };

  const select = (clicked: string, additive: boolean) => {
    const name = selectionTarget(page, clicked, selection);
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
          setGuides([]);
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
        style={{ position: "absolute", left: 0, top: 0, width: page.width, height: page.height, transform: `scale(${scale})`, transformOrigin: "0 0", background: pageBackground(page, c.theme.pageBackground), boxShadow: "0 1px 6px rgba(0,0,0,.25)", outline: "none", overflow: "hidden", ...gridStyle(c.canvas.gridlines, c.canvas.gridSize, c.theme.dark) }}
      >
        {page.groups
          .filter((g) => p.editing || !effectivelyHidden(page, g.name))
          .map((g) => (
            <GroupFrame
              key={g.name}
              group={g}
              position={previewPosition(page, g.name, drag?.cur ?? {}) ?? g.position}
              selected={selection.includes(g.name)}
              multi={selection.length > 1}
              editing={p.editing && !c.readOnly && !c.canvas.lockObjects}
              hidden={effectivelyHidden(page, g.name)}
              onPointerDownFrame={(e, mode) => start(e, g.name, mode)}
            />
          ))}
        {page.visuals
          .filter((v) => p.editing || !effectivelyHidden(page, v.name))
          .map((v) => (
            <VisualFrame
              key={v.name}
              page={page}
              visual={v}
              position={previewPosition(page, v.name, drag?.cur ?? {}) ?? v.position}
              selected={selection.includes(v.name)}
              primary={primary === v.name}
              multi={selection.length > 1}
              editing={p.editing}
              onPointerDownFrame={(e, mode) => start(e, v.name, mode)}
              onSelect={(additive) => select(v.name, additive)}
            />
          ))}
        {guides.map((g, i) => (
          <div
            key={i}
            data-testid="smart-guide"
            data-axis={g.axis}
            style={{
              position: "absolute",
              background: "#e5005f",
              pointerEvents: "none",
              zIndex: 20000,
              ...(g.axis === "v" ? { left: g.at, top: g.from, width: 1 / scale, height: g.to - g.from } : { left: g.from, top: g.at, width: g.to - g.from, height: 1 / scale }),
            }}
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
