// How the Q&A visual looks: the input box and the suggestions, from the inputBox and suggestions cards. Pure.
import type { CSSProperties } from "react";
import { cssFont, readFont } from "../format/styles";
import { FormatReader } from "./formatReader";
import type { Theme } from "./theme";
import type { VisualModel } from "./visualDoc";

export interface QnaLook {
  input: CSSProperties;
  restatement: CSSProperties;
  /** Colors of the check mark (understood), the error text and the note that the answer made an assumption. */
  accepted: string;
  error: string;
  warning: string;
  commitBackground: string | undefined;
  hover: string | undefined;
  showSuggestions: boolean;
  suggestionHeader: CSSProperties;
  suggestionCard: CSSProperties;
}

export function qnaLook(visual: VisualModel, theme: Theme): QnaLook {
  const f = new FormatReader(visual.json, theme, visual.visualType);
  const lb = theme.textClasses.label;
  const q = readFont(f, "inputBox", { prefix: "question", color: "questionFontColor", size: "questionFontSize" });
  const r = readFont(f, "inputBox", { prefix: "restatement", color: "restatementFontColor", size: "restatementFontSize" });
  const h = readFont(f, "suggestions", { prefix: "header", color: "headerFontColor", size: "headerFontSize" });
  const c = readFont(f, "suggestions", { prefix: "card", color: "cardFontColor", size: "cardFontSize" });
  return {
    input: { ...cssFont(q, { family: lb.fontFace, size: lb.fontSize + 1, color: theme.foreground }), background: f.color("inputBox", "background") },
    restatement: cssFont(r, { family: lb.fontFace, size: lb.fontSize, color: theme.muted }),
    accepted: f.color("inputBox", "acceptedColor") ?? "#107c10",
    error: f.color("inputBox", "errorColor") ?? "#c50f1f",
    warning: f.color("inputBox", "warningColor") ?? "#b05a00",
    commitBackground: f.color("inputBox", "commitButtonBackgroundColor"),
    hover: f.color("inputBox", "hoverColor"),
    showSuggestions: f.bool("suggestions", "show", true),
    suggestionHeader: cssFont(h, { family: lb.fontFace, size: lb.fontSize, color: theme.muted }),
    suggestionCard: { ...cssFont(c, { family: lb.fontFace, size: lb.fontSize, color: theme.foreground }), background: f.color("suggestions", "cardBackground") },
  };
}

import { getFormat } from "./visualDoc";

/** The question stored with the visual (hiddenProperties > savedUtterance, where Desktop keeps it). */
export function savedQuestion(visual: VisualModel): string {
  const l = getFormat(visual.json, "hiddenProperties", "savedUtterance");
  return l && l.t === "string" ? l.v : "";
}
