// The look of a visual's container (title, subtitle, divider, spacing, padding, background, border, shadow, alt text,
// header, tooltip) computed from its formatting objects. Pure: the frame component only applies the result, and the
// rendered-coverage test compares models to see which properties change the picture.
import type { CSSProperties } from "react";
import { cssFont, opacityOf, readFont } from "../format/styles";
import type { FormatReader } from "./formatReader";
import type { Theme } from "./theme";
import { linkModel, type LinkModel } from "./linkModel";
import { headerTooltip, tooltipLook, type HeaderTooltip, type TooltipLook } from "./tooltipLook";
import { NO_HEADER, type HeaderButtons, type HeaderContext } from "./headerButtons";

export interface TextBlock {
  text: string;
  style: CSSProperties;
  /** Heading level for assistive technology (2 to 6), or null for plain text. */
  level: number | null;
  height: number;
}

export interface ContainerModel {
  /** Background, border, corner radius and shadow; position and stacking are the frame's. */
  look: CSSProperties;
  title: TextBlock | null;
  subTitle: TextBlock | null;
  /** The line under the title area. */
  divider: { top: number; style: CSSProperties; inset: number } | null;
  /** Where the visual's content sits inside the container. */
  body: { left: number; right: number; top: number; bottom: number };
  altText: string;
  /** The hover toolbar of the visual (drill, more options); false hides it. */
  headerShown: boolean;
  headerStyle: CSSProperties;
  /** Which buttons of the hover toolbar are on. */
  headerButtons: HeaderButtons;
  /** type: "Default" or "Canvas" (a report page is the tooltip). */
  tooltip: { show: boolean; type: string; section: string; look: TooltipLook };
  lockAspect: boolean;
  /** The Header tooltip card: an information icon next to the title with its own tooltip. */
  headerTooltip: HeaderTooltip;
  /** The Action card: what Ctrl+click on the visual does, and its tooltips. */
  link: LinkModel;
}

export interface ContainerInput {
  f: FormatReader;
  theme: Theme;
  /** The automatic title (fields of the visual) and whether this visual type shows one by default. */
  autoTitle: string;
  titleByDefault: boolean;
  /** Tables and matrices never get an automatic title text. */
  noAutoText: boolean;
  /** Whether the visual header shows when the visual does not say (Options > Report settings). */
  headerDefault?: boolean;
  /** The visual's situation, which decides which header buttons apply (without it none of the situational ones does). */
  header?: HeaderContext;
}

const ALIGN: Record<string, CSSProperties["textAlign"]> = { left: "left", center: "center", right: "right", Left: "left", Center: "center", Right: "right" };
/** Where the shadow falls for each preset of the Shadow card: the angle (degrees, counter-clockwise from the right) and the distance. */
const SHADOW_PRESETS: Record<string, { angle: number; distance: number }> = {
  BottomRight: { angle: 315, distance: 3 },
  Bottom: { angle: 270, distance: 3 },
  BottomLeft: { angle: 225, distance: 3 },
  CenterRight: { angle: 0, distance: 3 },
  Center: { angle: 0, distance: 0 },
  CenterLeft: { angle: 180, distance: 3 },
  TopRight: { angle: 45, distance: 3 },
  Top: { angle: 90, distance: 3 },
  TopLeft: { angle: 135, distance: 3 },
};
const DASH: Record<string, string> = { solid: "solid", dashed: "dashed", dotted: "dotted", custom: "dashed" };

function block(f: FormatReader, theme: Theme, object: "title" | "subTitle", text: string, defaults: { size: number; color: string; family: string }, wrapDefault: boolean): TextBlock | null {
  const font = readFont(f, object, {});
  const style: CSSProperties = {
    ...cssFont(font, defaults),
    textAlign: ALIGN[f.str(object, "alignment", "left")] ?? "left",
    background: f.color(object, "background"),
    padding: "4px 8px 0",
    whiteSpace: f.bool(object, "titleWrap", wrapDefault) ? "normal" : "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
  const size = font.size ?? defaults.size;
  const heading = /^Heading([2-6])$/.exec(f.str(object, "heading", "Normal"));
  return { text, style, level: heading ? Number(heading[1]) : null, height: Math.round(size) + 12 };
}

/** The header's background: white at 85 % unless a color is set; the transparency setting lets more of the visual show through. */
function headerBackground(f: FormatReader): string {
  const color = f.color("visualHeader", "background");
  const transparency = f.num("visualHeader", "transparency", -1);
  if (transparency < 0) return color ?? "#ffffffd9";
  return `color-mix(in srgb, ${color ?? "#ffffff"} ${Math.round(100 - Math.min(100, transparency))}%, transparent)`;
}

export function buildContainer(inp: ContainerInput): ContainerModel {
  const { f, theme } = inp;
  const header = inp.header ?? NO_HEADER;
  const t = theme.textClasses.title;
  const customText = f.str("title", "text", "");
  const showTitleSetting = f.bool("title", "show", inp.titleByDefault);
  const titleText = customText || (showTitleSetting && !inp.noAutoText ? inp.autoTitle : "");
  const title = showTitleSetting && titleText !== "" ? block(f, theme, "title", titleText, { size: t.fontSize, color: t.color, family: t.fontFace }, false) : null;
  const l = theme.textClasses.label;
  const subText = f.str("subTitle", "text", "");
  const subTitle = f.bool("subTitle", "show", false) && subText !== "" ? block(f, theme, "subTitle", subText, { size: Math.max(8, l.fontSize + 1), color: l.color, family: l.fontFace }, false) : null;

  // vertical rhythm: title, subtitle, divider, then the content; custom spacing replaces the defaults
  const custom = f.bool("spacing", "customizeSpacing", false);
  const sp = (prop: string, dflt: number) => (custom ? f.num("spacing", prop, dflt) : dflt);
  let y = 0;
  if (title) y += title.height + sp("spaceBelowTitle", 0);
  if (subTitle) y += sp("spaceAboveSubtitle", 0) + subTitle.height + sp("spaceBelowSubTitle", 0);
  const dividerOn = f.bool("divider", "show", false) && (title !== null || subTitle !== null);
  let divider: ContainerModel["divider"] = null;
  if (dividerOn) {
    y += sp("spaceAboveDivider", 0);
    const w = Math.max(1, f.num("divider", "width", 1));
    divider = {
      top: y,
      inset: f.bool("divider", "ignorePadding", false) ? 0 : 8,
      style: { borderTop: `${w}px ${DASH[f.str("divider", "style", "solid")] ?? "solid"} ${f.color("divider", "color") ?? theme.muted}` },
    };
    y += w;
  }
  if (title || subTitle) y += sp("spaceBelowTitleArea", 0) + (custom ? sp("verticalSpacing", 0) : 0);

  const base = 4;
  const pad = (prop: string) => base + Math.max(0, f.num("padding", prop, 0));
  const body = { left: pad("left"), right: pad("right"), top: y + sp("spaceAbovePlotArea", 0) + pad("top"), bottom: pad("bottom") };

  // a style preset (see stylePresets.ts) comes through the reader: the settings it gives are read like the visual's own
  const bgOn = f.bool("background", "show", true);
  const bgAlpha = opacityOf(f.num("background", "transparency", 0));
  const bgColor = f.color("background", "color") ?? theme.background;
  const borderOn = f.bool("border", "show", false);
  const shadowOn = f.bool("dropShadow", "show", false);
  // a preset is a direction (and a default distance); Custom keeps the angle and distance of the card
  const preset = SHADOW_PRESETS[f.str("dropShadow", "preset", "Custom")];
  const angle = ((preset ? preset.angle : f.num("dropShadow", "angle", 45)) * Math.PI) / 180;
  const dist = preset ? preset.distance : f.num("dropShadow", "shadowDistance", 3);
  const blur = f.num("dropShadow", "shadowBlur", 4);
  const spread = f.num("dropShadow", "shadowSpread", 0);
  const shadowAlpha = opacityOf(f.num("dropShadow", "transparency", 70));
  const inner = f.str("dropShadow", "position", "Outer") === "Inner";
  const look: CSSProperties = {
    background: bgOn ? `color-mix(in srgb, ${bgColor} ${Math.round(bgAlpha * 100)}%, transparent)` : "transparent",
    border: borderOn ? `${f.num("border", "width", 1)}px solid ${f.color("border", "color") ?? theme.muted}` : "1px solid transparent",
    borderRadius: f.num("border", "radius", 0),
    boxShadow: shadowOn ? `${inner ? "inset " : ""}${(Math.cos(angle) * dist).toFixed(1)}px ${(-Math.sin(angle) * dist).toFixed(1)}px ${blur}px ${spread}px color-mix(in srgb, ${f.color("dropShadow", "color") ?? "#000000"} ${Math.round(shadowAlpha * 100)}%, transparent)` : undefined,
  };

  return {
    look,
    title,
    subTitle,
    divider,
    body,
    altText: f.str("general", "altText", ""),
    headerShown: f.bool("visualHeader", "show", inp.headerDefault ?? true),
    headerStyle: {
      background: headerBackground(f),
      color: f.color("visualHeader", "foreground") ?? "#222222",
      border: f.color("visualHeader", "border") ? `1px solid ${f.color("visualHeader", "border")}` : undefined,
    },
    headerButtons: {
      drillUp: f.bool("visualHeader", "showDrillUpButton", true),
      drillToggle: f.bool("visualHeader", "showDrillToggleButton", true),
      nextLevel: f.bool("visualHeader", "showDrillDownLevelButton", true),
      expandAll: f.bool("visualHeader", "showDrillDownExpandButton", true),
      options: f.bool("visualHeader", "showOptionsMenu", true),
      personalize: f.bool("visualHeader", "showPersonalizeVisualButton", true),
      roleSelector: f.bool("visualHeader", "showDrillRoleSelector", true) && header.drillRoles.length > 1,
      filters: f.bool("visualHeader", "showFilterRestatementButton", true) && header.filters > 0,
      focus: f.bool("visualHeader", "showFocusModeButton", true) && header.focusable,
      seeData: f.bool("visualHeader", "showSeeDataLayoutToggleButton", true) && header.tabular,
      copyImage: f.bool("visualHeader", "showCopyVisualImageButton", false) && inp.header !== undefined,
      tooltip: f.bool("visualHeader", "showTooltipButton", true),
      information: f.bool("visualHeader", "showVisualInformationButton", true) && !!header.status.information,
      warning: f.bool("visualHeader", "showVisualWarningButton", true) && !!header.status.warning,
      error: f.bool("visualHeader", "showVisualErrorButton", true) && !!header.status.error,
    },
    tooltip: { show: f.bool("visualTooltip", "show", true), type: f.str("visualTooltip", "type", "Default"), section: f.str("visualTooltip", "section", ""), look: tooltipLook(f) },
    lockAspect: f.bool("lockAspect", "show", false),
    link: linkModel(f),
    headerTooltip: headerTooltip(f),
  };
}
