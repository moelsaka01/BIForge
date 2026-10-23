// The Action (visualLink) card of any visual: what a Ctrl+click on the visual does and what its tooltip says. One function
// for the container model (which the Format pane's "drawn" measurement compares) and for the frame and charts that apply it.
import type { FormatReader } from "./formatReader";

export type LinkType = "None" | "Back" | "Bookmark" | "PageNavigation" | "WebUrl" | "Drillthrough";
const TYPES: readonly LinkType[] = ["Back", "Bookmark", "PageNavigation", "WebUrl", "Drillthrough"];

export interface LinkModel {
  type: LinkType;
  /** The page, bookmark, drillthrough page or web address the action goes to ("" for Back and None). */
  target: string;
  /** The custom tooltips of the card: for a working action, for one that cannot run, and the general one. */
  tooltips: { enabled: string; disabled: string; general: string; placeholder: string };
  /** Show the built-in hint ("Ctrl+click to follow link") when no custom tooltip applies. */
  showDefaultTooltip: boolean;
  /** A linked visual hides the visual's own hover tooltip. */
  suppressVisualTooltip: boolean;
}

export function linkModel(f: FormatReader): LinkModel {
  const t = f.str("visualLink", "type", "None") as LinkType;
  const type: LinkType = f.bool("visualLink", "show", true) && TYPES.includes(t) ? t : "None";
  const target =
    type === "PageNavigation" ? f.str("visualLink", "navigationSection", "") : type === "Bookmark" ? f.str("visualLink", "bookmark", "") : type === "WebUrl" ? f.str("visualLink", "webUrl", "") : type === "Drillthrough" ? f.str("visualLink", "drillthroughSection", "") : "";
  return {
    type,
    target,
    tooltips: {
      enabled: f.str("visualLink", "enabledTooltip", ""),
      disabled: f.str("visualLink", "disabledTooltip", ""),
      general: f.str("visualLink", "tooltip", ""),
      placeholder: f.str("visualLink", "tooltipPlaceholderText", ""),
    },
    showDefaultTooltip: f.bool("visualLink", "showDefaultTooltip", true),
    suppressVisualTooltip: f.bool("visualLink", "suppressDefaultTooltip", false),
  };
}

const DEFAULT_HINT: Record<Exclude<LinkType, "None">, string> = {
  Back: "Ctrl+click to go back",
  Bookmark: "Ctrl+click to apply the bookmark",
  PageNavigation: "Ctrl+click to go to the page",
  WebUrl: "Ctrl+click to open the link",
  Drillthrough: "Ctrl+click to drill through",
};

/** The hover text of a linked visual: the custom tooltip for the state (`problem` = why the action cannot run now), else the general one, the placeholder, or the built-in hint. */
export function linkTooltip(l: LinkModel, problem: string | null): string {
  if (l.type === "None") return "";
  const custom = (problem ? l.tooltips.disabled : l.tooltips.enabled) || l.tooltips.general || l.tooltips.placeholder;
  if (custom) return custom;
  if (problem) return problem;
  return l.showDefaultTooltip ? DEFAULT_HINT[l.type] : "";
}
