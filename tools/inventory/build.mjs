// Builds docs/INVENTORY.md from the hand-written lists (manual-*.txt) and three derived data files, and
// writes the status table between the markers in docs/COVERAGE.md.
//   node tools/inventory/build.mjs
// Derived inputs (names only, committed): visual-cards.json, dax-functions.tsv, m-names.txt.
// visual-cards.json is regenerated from research/_raw/theme-visuals.txt when that file exists.
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..", "..");
const rd = (f) => fs.readFileSync(path.join(here, f), "utf8");

// ---- derived: visual cards ----
const rawCards = path.join(root, "research", "_raw", "theme-visuals.txt");
if (fs.existsSync(rawCards)) {
  const cards = {}; let cur = null;
  for (const line of fs.readFileSync(rawCards, "utf8").split("\n")) {
    if (/^\S/.test(line)) { cur = line.replace(":", "").trim(); cards[cur] = {}; }
    else if (cur && line.trim()) { const i = line.indexOf(":"); cards[cur][line.slice(0, i).trim()] = line.slice(i + 1).split(",").map((s) => s.trim()).filter(Boolean); }
  }
  fs.writeFileSync(path.join(here, "visual-cards.json"), JSON.stringify(cards));
}
const visualCards = JSON.parse(rd("visual-cards.json"));

// ---- status of formatting cards: a card is Partial when the visual exists and the card is in formatSchema.ts ----
const fmt = fs.readFileSync(path.join(root, "app/src/core/report/formatSchema.ts"), "utf8");
const implCards = new Set([...fmt.matchAll(/object: "([A-Za-z0-9]+)"/g)].map((m) => m[1]));
const vt = fs.readFileSync(path.join(root, "app/src/core/report/visualTypes.ts"), "utf8");
const implVisuals = new Set([...vt.matchAll(/cartesian\("([A-Za-z]+)"/g), ...vt.matchAll(/\bid: "([A-Za-z]+)"/g)].map((m) => m[1]));
const alias = { barChart: "stackedBarChart", columnChart: "stackedColumnChart", funnel: "funnel", cardVisual: "card" };
const friendly = {
  report: "Report (filter pane)", page: "Page", filter: "Filter card", group: "Visual group", actionButton: "Button", bookmarkNavigator: "Bookmark navigator", textbox: "Text box", pageNavigator: "Page navigator", shape: "Shape",
  barChart: "Stacked bar chart", columnChart: "Stacked column chart", clusteredBarChart: "Clustered bar chart", clusteredColumnChart: "Clustered column chart", hundredPercentStackedBarChart: "100% stacked bar chart", hundredPercentStackedColumnChart: "100% stacked column chart",
  lineChart: "Line chart", areaChart: "Area chart", stackedAreaChart: "Stacked area chart", hundredPercentStackedAreaChart: "100% stacked area chart", lineStackedColumnComboChart: "Line and stacked column chart", lineClusteredColumnComboChart: "Line and clustered column chart",
  ribbonChart: "Ribbon chart", waterfallChart: "Waterfall chart", funnel: "Funnel chart", scatterChart: "Scatter chart", pieChart: "Pie chart", donutChart: "Donut chart", treemap: "Treemap", map: "Map", filledMap: "Filled map", shapeMap: "Shape map", azureMap: "Azure map",
  gauge: "Gauge", cardVisual: "Card (new)", card: "Card", multiRowCard: "Multi-row card", kpi: "KPI", slicer: "Slicer", tableEx: "Table", pivotTable: "Matrix", scriptVisual: "R script visual", pythonVisual: "Python visual", keyDriversVisual: "Key influencers",
  decompositionTreeVisual: "Decomposition tree", qnaVisual: "Q&A", aiNarratives: "Smart narrative", scorecard: "Scorecard", rdlVisual: "Paginated report", advancedSlicerVisual: "Slicer (new)", textSlicer: "Text slicer", listSlicer: "List slicer", image: "Image",
};
const EXCLUDED_VISUALS = new Set(["scorecard", "azureMap"]); // cloud-only (Fabric metrics, Azure Maps online tiles)

// ---- parse manual lists ----
const areas = []; let area = null, group = null;
for (const file of ["manual-1.txt", "manual-2.txt"]) {
  for (const raw of rd(file).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#  ") || line.startsWith("# ")) continue;
    if (line.startsWith("### ")) { group = line.slice(4); area.groups.push({ name: group, items: [] }); continue; }
    if (line.startsWith("## ")) { area = { name: line.slice(3), groups: [] }; areas.push(area); group = null; continue; }
    const m = /^([DPN]) \| (.*)$/.exec(line);
    if (!m) throw new Error("bad line: " + line);
    if (!group) { group = "General"; area.groups.push({ name: group, items: [] }); }
    area.groups[area.groups.length - 1].items.push({ s: m[1], t: m[2] });
  }
}

// ---- generated areas ----
const num = areas.length;
{
  const a = { name: `${num + 1}. Format pane cards per visual (generated from the visual styles of Desktop 2.158; status: Partial = card exists in formatSchema.ts, not every property)`, groups: [] };
  for (const [vis, cards] of Object.entries(visualCards)) {
    if (EXCLUDED_VISUALS.has(vis)) continue;
    const exists = implVisuals.has(alias[vis] ?? vis);
    const items = Object.entries(cards).filter(([c]) => c !== "*").map(([c, props]) => ({ s: exists && implCards.has(c) ? "P" : "N", t: `${c} (${props.length} properties)` }));
    if (cards["*"]) items.unshift({ s: "N", t: `Theme default style "*" (${cards["*"].length} properties)` });
    a.groups.push({ name: friendly[vis] ?? vis, items });
  }
  areas.push(a);
}
{
  const a = { name: `${areas.length + 1}. DAX functions (generated from the catalog; Done-tested = implemented in the evaluator and covered by tranche tests)`, groups: [] };
  const by = {};
  for (const l of rd("dax-functions.tsv").split("\n").filter(Boolean)) { const [c, n, i] = l.split("\t"); (by[c] ||= []).push({ s: i === "true" ? "D" : "N", t: n }); }
  for (const [c, items] of Object.entries(by)) a.groups.push({ name: c, items });
  areas.push(a);
}
{
  const a = { name: `${areas.length + 1}. M standard library (names found in Desktop 2.158's engine; Done-tested = folded or evaluated by BIForge and listed in mFunctions.json)`, groups: [] };
  const supported = new Set(JSON.parse(fs.readFileSync(path.join(root, "app/src/core/queries/mFunctions.json"), "utf8")).supported.map((x) => (typeof x === "string" ? x : x.name)));
  const by = {};
  for (const n of rd("m-names.txt").split("\n").filter(Boolean)) (by[n.split(".")[0]] ||= []).push({ s: supported.has(n) ? "D" : "N", t: n });
  for (const [c, items] of Object.entries(by)) a.groups.push({ name: c, items });
  areas.push(a);
}

// ---- render ----
const mark = { D: "x", P: "~", N: " " };
const counts = { D: 0, P: 0, N: 0 };
const rows = [];
let out = "";
for (const [ai, a] of areas.entries()) {
  const c = { D: 0, P: 0, N: 0 };
  out += `\n## ${a.name.startsWith(String(ai + 1)) || /^\d+\./.test(a.name) ? a.name : `${ai + 1}. ${a.name}`}\n`;
  let n = 0;
  for (const g of a.groups) {
    out += `\n### ${g.name}\n`;
    for (const it of g.items) { n++; c[it.s]++; counts[it.s]++; out += `- [${mark[it.s]}] ${ai + 1}.${n} ${it.t}\n`; }
  }
  rows.push({ area: a.name.replace(/^\d+\.\s*/, "").replace(/ \(.*$/, ""), ...c, total: c.D + c.P + c.N });
}
const total = counts.D + counts.P + counts.N;
const head = `# BIForge feature inventory (Power BI Desktop 2.158 parity, without cloud features)

This is the definition of "everything". Status per item: \`[x]\` Done-tested, \`[~]\` Partial, \`[ ]\` Not started. Cloud features are not listed here; they are recorded once under "Excluded (cloud)" in COVERAGE.md.
Generated by \`node tools/inventory/build.mjs\` from tools/inventory/manual-*.txt (hand-written lists) plus names derived from the product (formatting cards, DAX catalog, M library). Edit the lists, not this file. Sources and method: research/inventory-sources.md.

**Total ${total} items: ${counts.D} Done-tested, ${counts.P} Partial, ${counts.N} Not started.**
`;
fs.writeFileSync(path.join(root, "docs", "INVENTORY.md"), head + out);

// ---- COVERAGE.md table ----
const table = ["| Inventory area | Items | Done-tested | Partial | Not started |", "| --- | ---: | ---: | ---: | ---: |",
  ...rows.map((r) => `| ${r.area} | ${r.total} | ${r.D} | ${r.P} | ${r.N} |`),
  `| **Total** | **${total}** | **${counts.D}** | **${counts.P}** | **${counts.N}** |`].join("\n");
const cov = path.join(root, "docs", "COVERAGE.md");
let txt = fs.readFileSync(cov, "utf8");
const A = "<!-- inventory-status:begin -->", B = "<!-- inventory-status:end -->";
if (txt.includes(A)) txt = txt.replace(new RegExp(A + "[\\s\\S]*?" + B), `${A}\n${table}\n${B}`);
fs.writeFileSync(cov, txt);
console.log(JSON.stringify({ total, ...counts }));
