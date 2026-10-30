// Lists the properties of the Format pane cards that no renderer draws yet, grouped by card.property, with the visuals they occur in and
// how many cards would become Done-tested if that one property were drawn (cards with exactly one missing property).
// Run: node tools/inventory/undrawn.mjs [minVisuals]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const caps = JSON.parse(fs.readFileSync(path.join(root, "app/src/core/format/capabilities.json"), "utf8"));
const drawnMap = JSON.parse(fs.readFileSync(path.join(root, "app/src/core/format/rendered.json"), "utf8"));
const CLOUD_ONLY = new Set(JSON.parse(fs.readFileSync(path.join(root, "app/src/core/format/cloudOnly.json"), "utf8")));
const CONTAINER = new Set(["title", "subTitle", "divider", "spacing", "background", "padding", "lockAspect", "border", "dropShadow", "visualLink", "visualTooltip", "stylePreset", "visualHeader", "visualHeaderTooltip"]);
const by = new Map();
for (const [vis, cards] of Object.entries(caps.visuals)) {
  for (const [card, id] of Object.entries(cards)) {
    const allowed = CONTAINER.has(card) ? new Set(caps.container[card] ?? []) : null;
    const props = Object.entries(caps.cards[id]).filter(([p, k]) => k[0] !== "x" && (!allowed || allowed.has(p)) && !CLOUD_ONLY.has(`${card}.${p}`)).map(([p]) => p);
    if (card === "general" && !props.includes("altText")) props.push("altText");
    const d = new Set([...(drawnMap["*"]?.[card] ?? []), ...(drawnMap[vis]?.[card] ?? [])]);
    const missing = props.filter((p) => !d.has(p));
    if (!missing.length || missing.length === props.length) continue;
    for (const p of missing) {
      const k = `${card}.${p}`;
      const e = by.get(k) ?? { visuals: [], last: 0 };
      e.visuals.push(vis);
      if (missing.length === 1) e.last++;
      by.set(k, e);
    }
  }
}
const min = Number(process.argv[2] ?? 1);
for (const [k, e] of [...by].sort((a, b) => b[1].last - a[1].last || b[1].visuals.length - a[1].visuals.length)) if (e.visuals.length >= min) console.log(`${String(e.last).padStart(3)} cards done by it, ${String(e.visuals.length).padStart(3)} visuals  ${k}  [${e.visuals.slice(0, 4).join(",")}]`);
