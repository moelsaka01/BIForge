import { useState, type CSSProperties } from "react";
import { generalCards, visualCards } from "../../core/report/formatSchema";
import { fieldLabel } from "../../core/report/fields";
import { FormatReader } from "../../core/report/formatReader";
import { resolveInteraction, supportsHighlight } from "../../core/report/interactions";
import type { PageModel, Position, VisualModel } from "../../core/report/visualDoc";
import { visualType } from "../../core/report/visualTypes";
import { actionProblem, readAction, rotationOf } from "../../core/report/staticVisuals";
import { linkTooltip } from "../../core/report/linkModel";
import { listBookmarks } from "../../core/report/bookmarks";
import { effectivelyHidden } from "../../core/report/groups";
import { personalizeOn } from "../../core/report/reportOps";
import { PersonalizePanel } from "./PersonalizePanel";
import { buildContainer } from "../../core/report/containerModel";
import { drillPlan } from "../../core/report/queryBuilder";
import { useReport, type MenuItem } from "./reportContext";
import { VisualContent } from "./VisualContent";

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CURSOR: Record<Handle, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

/** The automatic title of a visual: "Sum of Quantity by Category". */
export function autoTitle(v: VisualModel): string {
  const fam = visualType(v.visualType)?.family;
  const label = (role: string) => (v.roles[role] ?? []).map((p) => p.displayName ?? fieldLabel(p.field));
  const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  switch (fam) {
    case "cartesian": {
      const vals = [...label("Y"), ...label("Y2")];
      const by = [...label("Category"), ...label("Series")];
      return vals.length && by.length ? `${join(vals)} by ${join(by)}` : join(vals);
    }
    case "pie":
    case "funnel":
      return label("Y").length ? `${join(label("Y"))} by ${join(label("Category"))}` : join(label("Category"));
    case "treemap":
      return `${join(label("Values"))} by ${join(label("Group"))}`;
    case "scatter":
      return [label("X")[0], label("Y")[0]].filter(Boolean).join(" and ") + (label("Category").length ? ` by ${join(label("Category"))}` : "");
    case "waterfall":
      return `${join(label("Y"))} by ${join(label("Category"))}`;
    case "gauge":
      return join(label("Y"));
    case "table":
    case "matrix":
      return "";
    default:
      return "";
  }
}

export interface FrameProps {
  page: PageModel;
  visual: VisualModel;
  position: Position;
  selected: boolean;
  /** The visual the panes show when several are selected. */
  primary?: boolean;
  /** More than one visual is selected: no resize handles and no on-visual toolbar. */
  multi?: boolean;
  /** The canvas is in editing mode: the frame can be dragged and resized. */
  editing: boolean;
  onPointerDownFrame?(e: React.PointerEvent, mode: "move" | Handle): void;
  onSelect?(additive: boolean): void;
}

export function VisualFrame(p: FrameProps) {
  const c = useReport();
  const { visual, page, position: pos } = p;
  const [hover, setHover] = useState(false);
  const [headerTip, setHeaderTip] = useState(false);
  const [personalizing, setPersonalizing] = useState(false);
  const f = new FormatReader(visual.json, c.theme, visual.visualType);
  const type = visualType(visual.visualType);
  const fam = type?.family;
  const isCard = fam === "card" || fam === "kpi" || fam === "slicer";
  const model = buildContainer({ f, theme: c.theme, autoTitle: autoTitle(visual), titleByDefault: !isCard, noAutoText: fam === "table" || fam === "matrix" });
  const titleText = model.title?.text ?? "";
  // the Action card: Ctrl+click follows the link; the hover text says what it does (or why it cannot)
  const action = readAction(visual.json);
  const linked = action.type !== "None" && visual.visualType !== "actionButton";
  const linkProblem = linked ? actionProblem(action, c.pages.map((x) => x.name), listBookmarks(c.project).map((b) => b.id)) : null;
  const linkTitle = linked ? linkTooltip(model.link, linkProblem) : "";
  // the Header tooltip card: an information icon with a text tooltip (null) or a tooltip page; undefined = no icon
  const ht = model.headerTooltip;
  const headerTipPage = ht.type === "Canvas" ? (c.pages.find((x) => x.name === ht.section && x.type === "Tooltip") ?? undefined) : ht.text !== "" ? null : undefined;
  const headerTipStyle: CSSProperties = {
    background: `color-mix(in srgb, ${ht.background ?? "#ffffff"} ${Math.round(ht.opacity * 100)}%, transparent)`,
    color: ht.titleColor ?? "#222222",
    ...(ht.fontFamily ? { fontFamily: ht.fontFamily } : {}),
    ...(ht.fontSize !== null ? { fontSize: ht.fontSize } : {}),
    fontWeight: ht.bold ? "bold" : undefined,
    fontStyle: ht.italic ? "italic" : undefined,
    textDecoration: ht.underline ? "underline" : undefined,
  };
  const showTitle = model.title !== null;
  const cats = (visual.roles.Category ?? []).map((x) => x.field);
  const drill = c.snap.drill[visual.name];
  const drillable = cats.length > 1;
  const level = drill?.level ?? 0;
  const editingSource = c.snap.editInteractions;
  const sourceVisual = editingSource ? page.visuals.find((v) => v.name === editingSource) : undefined;
  const showBar = p.selected || hover;
  // On-object formatting: what a selected visual offers right on it (the cards it really has)
  const cardIds = new Set([...visualCards(visual.visualType), ...generalCards(visual.visualType)].map((x) => x.id));
  const handle = (card: string, label: string, def: boolean): { card: string; label: string; on: boolean } | null =>
    cardIds.has(card) ? { card, label, on: card === "title" ? showTitle : f.bool(card, "show", def) } : null;
  const handles = [handle("title", "Title", false), handle("legend", "Legend", true), handle("labels", "Data labels", false)].filter((x): x is NonNullable<typeof x> => x !== null);

  const menu = (e: React.MouseEvent) => {
    // a right-click on a data point has its own menu (the chart prevents the default before this runs)
    if (e.defaultPrevented) return;
    e.preventDefault();
    const all: MenuItem[] = [
        { label: "Duplicate", onClick: () => c.dispatch("report.visual.duplicate", { page: page.name, visual: visual.name }) },
        { label: "Bring to front", onClick: () => c.dispatch("report.visual.arrange", { page: page.name, visual: visual.name, where: "front" }) },
        { label: "Send to back", onClick: () => c.dispatch("report.visual.arrange", { page: page.name, visual: visual.name, where: "back" }) },
        { label: "Edit interactions", onClick: () => c.dispatch("report.interaction.edit", { source: visual.name }) },
        { separator: true, label: "", onClick: () => undefined },
        { label: "Delete", onClick: () => c.dispatch("report.visual.delete", { page: page.name, visual: visual.name }) },
    ];
    // a shared report is open for viewing: editing items are not shown at all (and no menu if none is left)
    const items = c.readOnly ? all.filter((i) => i.viewOnly === true) : all;
    if (items.length === 0) return;
    c.onMenu(items, e.clientX, e.clientY);
  };

  const outer: CSSProperties = {
    position: "absolute",
    left: pos.x,
    top: pos.y,
    width: pos.width,
    height: pos.height,
    zIndex: Math.round(pos.z / 100) + (p.selected ? 10000 : 0),
    boxSizing: "border-box",
    ...model.look,
    outline: p.selected ? "2px solid #0f6cbd" : hover && p.editing ? "1px solid #8ab4e6" : undefined,
    outlineOffset: -1,
    overflow: "hidden",
    color: c.theme.foreground,
    opacity: visual.hidden || effectivelyHidden(page, visual.name) ? 0.4 : 1,
  };

  const iconBtn = (label: string, glyph: string, onClick: () => void, opts: { pressed?: boolean; disabled?: boolean } = {}) => (
    <button
      key={label}
      aria-label={label}
      title={label}
      aria-pressed={opts.pressed}
      disabled={opts.disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ width: 22, height: 20, padding: 0, border: "none", borderRadius: 3, background: opts.pressed ? "#cfe3f8" : "transparent", color: "#222", cursor: opts.disabled ? "default" : "pointer", opacity: opts.disabled ? 0.35 : 1, fontSize: 13 }}
    >
      {glyph}
    </button>
  );

  const interactionControls = () => {
    if (!sourceVisual || sourceVisual.name === visual.name) return null;
    const explicit = page.interactions.find((i) => i.source === sourceVisual.name && i.target === visual.name)?.type ?? "Default";
    const effective = resolveInteraction(page, sourceVisual, visual);
    const set = (type: "DataFilter" | "HighlightFilter" | "NoFilter") => c.dispatch("report.interaction.set", { page: page.name, source: sourceVisual.name, target: visual.name, type });
    const canHl = supportsHighlight(visual.visualType);
    return (
      <div role="group" aria-label="Interaction from the selected visual" style={{ position: "absolute", right: 4, top: 4, display: "flex", gap: 2, background: "#fffffff0", border: "1px solid #aaa", borderRadius: 4, padding: 2, zIndex: 5 }}>
        {iconBtn("Filter", "▽", () => set("DataFilter"), { pressed: effective === "filter" })}
        {iconBtn("Highlight", "◧", () => set("HighlightFilter"), { pressed: effective === "highlight", disabled: !canHl })}
        {iconBtn("None", "⊘", () => set("NoFilter"), { pressed: effective === "none" })}
        <span hidden>{explicit}</span>
      </div>
    );
  };

  return (
    <div
      role="group"
      aria-label={`Visual: ${model.altText || titleText || type?.label || visual.visualType}`}
      data-visual={visual.name}
      data-selected={p.selected}
      data-link={linked ? action.type : undefined}
      title={linkTitle || undefined}
      style={outer}
      onClick={(e) => {
        if (linked && (e.ctrlKey || e.metaKey)) c.dispatch("report.button.run", { page: page.name, visual: visual.name });
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (editingSource) return;
        // Ctrl+click on a button follows it instead of changing the selection
        p.onSelect?.(e.shiftKey || ((e.ctrlKey || e.metaKey) && visual.visualType !== "actionButton"));
      }}
      onContextMenu={menu}
    >
      {model.title && (
        <div style={{ ...model.title.style, height: model.title.height }} role={model.title.level ? "heading" : undefined} aria-level={model.title.level ?? undefined} onDoubleClick={c.onObject && p.editing ? () => c.focusFormat(visual.name, "title") : undefined}>
          {model.title.text}
        </div>
      )}
      {model.subTitle && (
        <div style={{ ...model.subTitle.style, position: "absolute", left: 0, right: 0, top: model.title ? model.title.height : 0, height: model.subTitle.height }} role={model.subTitle.level ? "heading" : undefined} aria-level={model.subTitle.level ?? undefined}>
          {model.subTitle.text}
        </div>
      )}
      {headerTipPage !== undefined && (
        <>
          <span
            role="img"
            aria-label="Information"
            data-testid="header-tooltip-icon"
            onPointerEnter={(e) => {
              setHeaderTip(true);
              if (headerTipPage) c.onTooltip(headerTipPage, visual.name, { fields: [], values: [] }, e.clientX, e.clientY);
            }}
            onPointerLeave={() => {
              setHeaderTip(false);
              if (headerTipPage) c.onTooltip(headerTipPage, visual.name, null, 0, 0);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "absolute", right: 30, top: 3, width: 16, height: 16, lineHeight: "16px", textAlign: "center", fontSize: 12, borderRadius: "50%", border: "1px solid currentColor", cursor: "help", zIndex: 5, color: "#555", background: "#ffffffd9" }}
          >
            i
          </span>
          {headerTip && headerTipPage === null && (
            <div role="tooltip" data-testid="header-tooltip" style={{ position: "absolute", right: 6, top: 24, maxWidth: 260, padding: "6px 10px", borderRadius: 3, boxShadow: "0 2px 8px #0003", zIndex: 9, fontSize: 12, ...headerTipStyle }}>
              {model.headerTooltip.text}
            </div>
          )}
        </>
      )}
      {model.divider && <div data-testid="divider" style={{ position: "absolute", left: model.divider.inset, right: model.divider.inset, top: model.divider.top, ...model.divider.style }} />}
      <div style={{ position: "absolute", left: model.body.left, right: model.body.right, top: model.body.top, bottom: model.body.bottom, overflow: "hidden" }}>
        {pos.width > 20 && (
          <div style={{ width: "100%", height: "100%", transform: rotationOf(visual) ? `rotate(${rotationOf(visual)}deg)` : undefined }}>
            <VisualContent page={page} visual={visual} width={Math.max(20, pos.width - model.body.left - model.body.right)} height={Math.max(20, pos.height - model.body.top - model.body.bottom)} runOnClick={(e) => !p.editing || c.readOnly || e.ctrlKey || e.metaKey} />
          </div>
        )}
      </div>
      {c.readOnly && showBar && model.headerShown && model.headerButtons.personalize && !!type && !type.static && personalizeOn(c.project, page.name) && (
        <button
          aria-label="Personalize this visual"
          title="Personalize this visual"
          aria-pressed={personalizing}
          onClick={(e) => {
            e.stopPropagation();
            setPersonalizing((x) => !x);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ position: "absolute", right: 4, top: 2, height: 20, padding: "0 6px", border: "none", borderRadius: 3, cursor: "pointer", zIndex: 8, fontSize: 13, ...model.headerStyle }}
        >
          ✎
        </button>
      )}
      {c.readOnly && personalizing && <PersonalizePanel page={page} visual={visual} onClose={() => setPersonalizing(false)} />}
      {p.editing && !c.readOnly && showBar && !editingSource && model.headerShown && (
        <div
          data-testid="visual-bar"
          onPointerDown={(e) => p.onPointerDownFrame?.(e, "move")}
          style={{ position: "absolute", left: 0, right: 0, top: 0, height: 20, display: "flex", justifyContent: "flex-end", gap: 1, alignItems: "center", cursor: "move", paddingRight: 2, zIndex: 4, ...model.headerStyle }}
        >
          {drillable && model.headerButtons.drillUp && (
            <>
              {iconBtn("Drill up", "↑", () => c.dispatch("report.view.drillUp", { visual: visual.name }), { disabled: level === 0 })}
              {iconBtn("Drill down mode", "↓", () => c.dispatch("report.view.drillMode", { visual: visual.name }), { pressed: c.snap.drillMode === visual.name })}
              {iconBtn("Go to the next level", "⇊", () => c.dispatch("report.view.nextLevel", { visual: visual.name, levels: cats.length }), { disabled: level >= cats.length - 1 })}
              {iconBtn("Expand all down one level", "⇉", () => c.dispatch("report.view.expandAll", { visual: visual.name, levels: cats.length }), { disabled: level >= cats.length - 1 })}
              {drillPlan(cats, drill).fields.length > 0 && <span style={{ fontSize: 10, color: "#555", padding: "0 4px" }}>{fieldLabel(drillPlan(cats, drill).fields.at(-1)!)}</span>}
            </>
          )}
          <button
            aria-label="More options"
            title="More options"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              menu({ preventDefault: () => undefined, clientX: r.left, clientY: r.bottom } as React.MouseEvent);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ width: 22, height: 20, padding: 0, border: "none", borderRadius: 3, background: "transparent", color: "#222", cursor: "pointer", fontSize: 13 }}
          >
            …
          </button>
        </div>
      )}
      {interactionControls()}
      {c.onObject && p.editing && !c.readOnly && p.selected && !p.multi && !editingSource && (
        <div
          role="toolbar"
          aria-label="Format on the visual"
          data-testid="on-object"
          onPointerDown={(e) => e.stopPropagation()}
          style={{ position: "absolute", left: 4, bottom: 4, display: "flex", gap: 2, background: "#fffffff2", border: "1px solid #aaa", borderRadius: 4, padding: 2, zIndex: 7, color: "#222" }}
        >
          {handles.map((h) => (
            <button
              key={h.card}
              type="button"
              aria-pressed={h.on}
              aria-label={`${h.on ? "Hide" : "Show"} ${h.label.toLowerCase()}`}
              title={`${h.on ? "Hide" : "Show"} ${h.label.toLowerCase()}`}
              onClick={(e) => {
                e.stopPropagation();
                c.dispatch("report.format.set", { page: page.name, visual: visual.name, object: h.card, prop: "show", value: { t: "bool", v: !h.on } });
              }}
              style={{ border: "none", borderRadius: 3, padding: "1px 6px", fontSize: 11, cursor: "pointer", background: h.on ? "#cfe3f8" : "transparent", color: "#222" }}
            >
              {h.label}
            </button>
          ))}
          <button
            type="button"
            aria-label="Open the formatting options of this visual"
            title="Open the formatting options of this visual"
            onClick={(e) => {
              e.stopPropagation();
              c.focusFormat(visual.name, handles.find((h) => h.on)?.card ?? "title");
            }}
            style={{ border: "none", borderRadius: 3, padding: "1px 6px", fontSize: 11, cursor: "pointer", background: "transparent", color: "#222" }}
          >
            Format ▸
          </button>
        </div>
      )}
      {p.editing && !c.readOnly && p.selected && !p.multi && !editingSource &&
        HANDLES.map((h) => (
          <div
            key={h}
            data-handle={h}
            onPointerDown={(e) => p.onPointerDownFrame?.(e, h)}
            style={{
              position: "absolute",
              width: 9,
              height: 9,
              background: "#fff",
              border: "1px solid #0f6cbd",
              boxSizing: "border-box",
              cursor: CURSOR[h],
              zIndex: 6,
              left: h.includes("w") ? 0 : h.includes("e") ? undefined : "calc(50% - 4px)",
              right: h.includes("e") ? 0 : undefined,
              top: h.includes("n") ? 0 : h.includes("s") ? undefined : "calc(50% - 4px)",
              bottom: h.includes("s") ? 0 : undefined,
            }}
          />
        ))}
    </div>
  );
}
