import type { CSSProperties } from "react";
import { FormatReader } from "../../core/report/formatReader";
import { navigatorPages, readAction, readShape, readTextbox, shapeSvg, type ShapeModel } from "../../core/report/staticVisuals";
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
  return <Shape model={readShape(f)} width={width} height={height} />;
}

export function ImageView({ visual, width, height }: Props) {
  const c = useReport();
  const f = new FormatReader(visual.json, c.theme, "image");
  const src = f.str("image", "imageUrl", "");
  const scaling = f.str("image", "scaling", "Normal");
  if (!src) {
    return (
      <div role="status" style={{ width, height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: c.theme.muted, textAlign: "center" }}>
        No image yet. Choose one in the Format pane.
      </div>
    );
  }
  const fit = scaling === "Fit" ? "fill" : scaling === "Fill" ? "cover" : "contain";
  return <img data-testid="image" src={src} alt={f.str("altText", "text", "")} style={{ width, height, objectFit: fit, display: "block" }} />;
}

export function ButtonView({ page, visual, width, height, runOnClick }: Props) {
  const c = useReport();
  const f = new FormatReader(visual.json, c.theme, "actionButton");
  const shape = readShape(f, { shape: "rectangle", fill: "#e6e6e6", outline: "#8a8a8a" });
  const action = readAction(visual.json);
  const text = f.bool("text", "show", true) ? f.str("text", "text", "Button") : "";
  const label = text || (action.type === "Back" ? "Back" : "Button");
  return (
    <button
      type="button"
      aria-label={label}
      data-testid="action-button"
      data-action={action.type}
      onClick={(e) => {
        if (runOnClick(e)) c.dispatch("report.button.run", { page: page.name, visual: visual.name });
      }}
      style={{
        width,
        height,
        boxSizing: "border-box",
        cursor: action.type === "None" ? "default" : "pointer",
        background: shape.fill.show ? `color-mix(in srgb, ${shape.fill.color} ${100 - shape.fill.transparency}%, transparent)` : "transparent",
        border: shape.outline.show ? `${shape.outline.weight}px solid ${shape.outline.color}` : "none",
        borderRadius: shape.shape === "oval" ? "50%" : shape.shape === "roundedRectangle" ? Math.min(width, height) / 4 : 0,
        color: f.color("text", "fontColor") ?? c.theme.foreground,
        fontSize: f.num("text", "fontSize", 12),
        fontFamily: c.theme.textClasses.label.fontFace,
        textAlign: f.str("text", "horizontalAlignment", "center") as CSSProperties["textAlign"],
        overflow: "hidden",
      }}
    >
      {text}
    </button>
  );
}

export function PageNavigatorView({ page, visual, width, height }: Props) {
  const c = useReport();
  const f = new FormatReader(visual.json, c.theme, "pageNavigator");
  const pages = navigatorPages(c.pages);
  const active = f.color("fill", "fillColor") ?? "#cfe3f8";
  return (
    <div role="navigation" aria-label="Page navigator" style={{ width, height, display: "flex", gap: 4, alignItems: "stretch", overflow: "hidden" }}>
      {pages.map((p) => {
        const current = p.name === page.name;
        return (
          <button
            key={p.name}
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => c.dispatch("report.page.go", { page: p.name })}
            style={{
              flex: "1 1 0",
              minWidth: 0,
              border: f.bool("outline", "show", true) ? `${f.num("outline", "weight", 1)}px solid ${f.color("outline", "lineColor") ?? "#8a8a8a"}` : "none",
              background: current ? active : "transparent",
              color: f.color("text", "fontColor") ?? c.theme.foreground,
              fontSize: f.num("text", "fontSize", 12),
              fontFamily: c.theme.textClasses.label.fontFace,
              cursor: "pointer",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {p.displayName}
          </button>
        );
      })}
    </div>
  );
}
