import { useState, type CSSProperties } from "react";
import { FormatReader } from "../../core/report/formatReader";
import { listBookmarks } from "../../core/report/bookmarks";
import { navigatorPages, readAction, readShape, readTextbox, shapeSvg, type ShapeModel } from "../../core/report/staticVisuals";
import { buttonModel, imageModel, navigatorModel, shapeLook } from "../../core/report/staticModels";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { useReport } from "./reportContext";

interface Props {
  page: PageModel;
  visual: VisualModel;
  width: number;
  height: number;
  /** Clicking runs the action (reading view, or Ctrl+click while editing). */
  runOnClick: (e: React.MouseEvent) => boolean;
}

export function TextboxView({ visual, width, height }: Props) {
  const c = useReport();
  const m = readTextbox(visual.json);
  const style: CSSProperties = {
    width,
    height,
    boxSizing: "border-box",
    padding: 4,
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontFamily: c.theme.textClasses.label.fontFace,
    fontSize: m.fontSize,
    fontWeight: m.bold ? 700 : 400,
    fontStyle: m.italic ? "italic" : "normal",
    textDecoration: m.underline ? "underline" : "none",
    color: m.color ?? c.theme.foreground,
    textAlign: m.align,
  };
  return (
    <div data-testid="textbox" style={style}>
      {m.text}
    </div>
  );
}

function Shape({ model, width, height }: { model: ShapeModel; width: number; height: number }) {
  const s = shapeSvg(model, width, height);
  const Tag = s.tag as "rect";
  return (
    <svg width={width} height={height} role="img" aria-label={model.shape} data-shape={model.shape} style={{ display: "block" }}>
      <Tag {...(s.attrs as Record<string, string | number>)} />
    </svg>
  );
}

export function ShapeView({ visual, width, height }: Props) {
  const c = useReport();
  const f = new FormatReader(visual.json, c.theme, "shape");
  const look = shapeLook(f, c.theme);
  return (
    <div style={{ position: "relative", width, height }}>
      <div data-testid="shape-layer" style={{ width, height, filter: look.filter, transform: look.shapeTransform }}>
        <Shape model={readShape(f)} width={width} height={height} />
      </div>
      {look.text && (
        <div data-testid="shape-text" style={look.text.box}>
          <span style={look.text.style}>{look.text.content}</span>
        </div>
      )}
    </div>
  );
}

export function ImageView({ visual, width, height }: Props) {
  const c = useReport();
  const f = new FormatReader(visual.json, c.theme, "image");
  const m = imageModel(f, width, height);
  if (!m.src) {
    return (
      <div role="status" style={{ width, height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: c.theme.muted, textAlign: "center" }}>
        No image yet. Choose one in the Format pane.
      </div>
    );
  }
  return <img data-testid="image" src={m.src} alt={m.alt} style={m.style} />;
}

export function ButtonView({ page, visual, width, height, runOnClick }: Props) {
  const c = useReport();
  const f = new FormatReader(visual.json, c.theme, "actionButton");
  const action = readAction(visual.json);
  const m = buttonModel(f, c.theme, width, height, action.type === "Back", action.type !== "None");
  const text = f.bool("text", "show", true) ? f.str("text", "text", "Button") : "";
  return (
    <button
      type="button"
      aria-label={m.label}
      data-testid="action-button"
      data-action={action.type}
      data-shape={m.shape}
      onClick={(e) => {
        if (runOnClick(e)) c.dispatch("report.button.run", { page: page.name, visual: visual.name });
      }}
      style={m.style}
    >
      {m.icon && (
        <span aria-hidden data-testid="button-icon" style={{ fontSize: m.icon.size, color: m.icon.color, order: m.icon.placement === "right" || m.icon.placement === "below" ? 2 : 0 }}>
          {m.icon.glyph}
        </span>
      )}
      <span data-testid="button-text" style={m.textStyle}>{text}</span>
    </button>
  );
}

/** A row of buttons, one per bookmark of the report; a click applies the bookmark. */
export function BookmarkNavigatorView({ visual, width, height }: Props) {
  const c = useReport();
  const f = new FormatReader(visual.json, c.theme, "bookmarkNavigator");
  const nav = navigatorModel(f, c.theme, width, height);
  const bookmarks = listBookmarks(c.project);
  // the bookmark applied last is the selected entry (the fill of the Fill card is that of the selected one)
  const [applied, setApplied] = useState<string | null>(null);
  return (
    <div role="navigation" aria-label="Bookmark navigator" style={nav.container}>
      {bookmarks.length === 0 && <span style={{ padding: 6, opacity: 0.7, fontSize: 12 }}>No bookmarks yet. Add some in the Bookmarks pane.</span>}
      {bookmarks.map((b) => (
        <button key={b.id} type="button" aria-current={applied === b.id ? "true" : undefined} onClick={() => { setApplied(b.id); c.dispatch("report.bookmark.apply", { id: b.id }); }} style={nav.entry(applied === b.id)}>
          <span style={nav.textStyle}>{nav.showText ? b.name : ""}</span>
        </button>
      ))}
    </div>
  );
}

export function PageNavigatorView({ page, visual, width, height }: Props) {
  const c = useReport();
  const f = new FormatReader(visual.json, c.theme, "pageNavigator");
  const nav = navigatorModel(f, c.theme, width, height);
  const pages = navigatorPages(c.pages, nav.showHidden);
  return (
    <div role="navigation" aria-label="Page navigator" style={nav.container}>
      {pages.map((p) => {
        const current = p.name === page.name;
        return (
          <button key={p.name} type="button" aria-current={current ? "page" : undefined} onClick={() => c.dispatch("report.page.go", { page: p.name })} style={nav.entry(current)}>
            <span style={nav.textStyle}>{nav.showText ? p.displayName : ""}</span>
          </button>
        );
      })}
    </div>
  );
}
