// Properties the pixel comparison cannot see by their nature. Each is listed in the audit report with its reason; a "semantic"
// property must still change the DOM (an attribute or heading level), the others are checked by unit tests of the behaviour.
const RULES = [
  [/\.decompositionTreeVisual\.tree\.defaultClickAction$/, "interaction", "a second click on a selected node deselects it (toggle) or keeps it (select): the state changes only on a click"],
  [/\.qnaVisual\.inputBox\.hoverColor$/, "interaction", "the input box takes this colour only while the pointer is over it"],
  [/\.visualLink\./, "interaction", "a Ctrl+click action and its hover tooltip: nothing is drawn until the pointer is on the visual"],
  [/\.zoom\.(showLabels|showTooltip)$/, "interaction", "the slider's value readout shows only while a handle is dragged"],
  [/\.trend\.useHighlightValues$/, "interaction", "applies only while another visual cross-highlights this one"],
  [/\.layout\.stackedGapExplodes$/, "interaction", "the gap widens when the pointer is on a segment"],
  [/\.lockAspect\.show$/, "interaction", "keeps the aspect ratio while the visual is resized"],
  [/\.(general\.altText|image\.altText|title\.heading|subTitle\.heading|label\.heading)$/, "semantic", "an accessibility text or heading level: no pixels, the DOM changes"],
];
export function skipReason(key) {
  for (const [re, kind, why] of RULES) if (re.test("." + key)) return { kind, why };
  return null;
}
