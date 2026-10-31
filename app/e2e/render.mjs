// Real-window render check. A property counted as drawn (rendered.json) must change what the real window shows: for each case in
// render-cases.json (written by `WRITE_RENDER_CASES=1 UPDATE_RENDERED=1 npx vitest run src/core/format/coverage.test.ts`) two pages
// hold the visual without the property and with it, and the two are compared as pixels and as DOM.
// "must" = properties added in the latest batches; "random" = a seeded random sample of the others (the first RANDOM_N whose
// unformatted visual shows data). Run: node e2e/render.mjs   (needs `npx tauri build --debug --no-bundle` first)
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { dataFor } from "./render-data.mjs";
import { pictures } from "./render-pictures.mjs";
import { PREP } from "./render-prep.mjs";
import { hoverStep, surroundings } from "./render-hover.mjs";
import { skipReason } from "./render-skips.mjs";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
// RENDER_RANGE=a-b: audit mode, cases a..b-1 of _cases/all.json (every drawn property, see render-all.mjs); RENDER_OUT = a JSON-lines result file
const range = process.env.RENDER_RANGE?.split("-").map(Number);
const RANDOM_N = Number(process.env.RENDER_RANDOM ?? 20);
const ids = process.env.RENDER_IDS?.split(",").map(Number); // RENDER_IDS=3,17: exactly these cases; RENDER_IMG=dir keeps the images of the ones that did not change
const picked = range || ids
  ? (() => { const all = JSON.parse(readFileSync(new URL("./_cases/all.json", import.meta.url), "utf8")); return ids ? ids.map((i) => ({ ...all[i], group: "audit", idx: i })) : all.slice(range[0], range[1]).map((c, k) => ({ ...c, group: "audit", idx: range[0] + k })); })()
  : (() => { const cases = JSON.parse(readFileSync(new URL("./render-cases.json", import.meta.url), "utf8")); return [...cases.must.map((c) => ({ ...c, group: "must" })), ...cases.random.slice(0, RANDOM_N + 12).map((c) => ({ ...c, group: "random" }))]; })();
const PORT = Number(process.env.RENDER_PORT ?? 9396);
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-rn-"));
const parent = join(work, "projects");
mkdirSync(parent);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };

async function launch(port, picks) {
  const child = spawn(exe, [], {
    env: { ...process.env, BIFORGE_TEST_DEBUG_PORT: String(port), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview" + port), BIFORGE_ALLOW_MULTIPLE: "1", BIFORGE_TEST_PICKS: picks },
    stdio: "ignore",
  });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(1000); } }
  if (!browser) throw new Error("could not attach to the app window");
  let page;
  for (let i = 0; i < 60 && !page; i++) { page = browser.contexts()[0]?.pages()[0]; if (!page) await sleep(500); }
  page.setDefaultTimeout(30000);
  await page.waitForSelector("text=Recent");
  return { child, page };
}

// 1. a sample project, created by the app itself
let session;
if (process.env.RENDER_BASE) cpSync(join(process.env.RENDER_BASE, "Rn"), join(parent, "Rn"), { recursive: true });
else {
  session = await launch(PORT, parent);
  try {
    const { page } = session;
    await page.getByRole("button", { name: /Learn with sample data/ }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Project name").fill("Rn");
    await dlg.getByRole("button", { name: "Browse…" }).click();
    await dlg.getByRole("button", { name: "Create" }).click();
    await page.waitForTimeout(5000);
  } finally { try { process.kill(session.child.pid); } catch { /* gone */ } }
  await sleep(2000);
}
if (process.env.RENDER_MAKE_BASE) { cpSync(join(parent, "Rn"), join(process.env.RENDER_MAKE_BASE, "Rn"), { recursive: true }); console.log("BASE READY"); process.exit(0); }

// the sample model gets a measure with negative values (render-data.mjs: negatives)
// measures with negative values (Variance), with blanks (Sparse: blank where the quantity is small) and only blank (Empty); see render-data.mjs
const MEASURES = [
  ["Variance", "SUM(Sales[Quantity]) - AVERAGEX(ALL(Product[Category]), CALCULATE(SUM(Sales[Quantity])))", "0b6f2a5e-1c3d-4e7a-9a11-5d2c8f3e7b01"],
  ["Sparse", "IF(SUM(Sales[Quantity]) > 60, SUM(Sales[Quantity]), BLANK())", "0b6f2a5e-1c3d-4e7a-9a11-5d2c8f3e7b02"],
  ["Empty", "BLANK()", "0b6f2a5e-1c3d-4e7a-9a11-5d2c8f3e7b03"],
  // a measure that is zero everywhere: its total is zero, so a point has no percent of total
  ["Zero", "SUM(Sales[Quantity]) * 0", "0b6f2a5e-1c3d-4e7a-9a11-5d2c8f3e7b04"],
];
// a series column with a blank name (the online orders): Title > Show blank as
const BLANK_COLUMN = ["", "\tcolumn StoreOnly = IF(Sales[Channel] = \"Online\", BLANK(), Sales[Channel])", "\t\tdataType: string", "\t\tlineageTag: 0b6f2a5e-1c3d-4e7a-9a11-5d2c8f3e7b05", "\t\tsummarizeBy: none"].join("\n") + "\n";
const MEASURE_TEXT = MEASURES.map(([n, e, g]) => ["", `\tmeasure ${n} = ${e}`, `\t\tlineageTag: ${g}`].join("\n")).join("\n") + "\n";
const salesTable = join(parent, "Rn", "Rn.SemanticModel", "definition", "tables", "Sales.tmdl");
if (existsSync(salesTable) && !readFileSync(salesTable, "utf8").includes("measure Variance")) appendFileSync(salesTable, MEASURE_TEXT + BLANK_COLUMN);
const def = join(parent, "Rn", "Rn.Report", "definition");
// a custom theme with a style preset named Zz (a yellow background), so that Style preset > name changes something
{
  const res = join(parent, 'Rn', 'Rn.Report', 'StaticResources', 'RegisteredResources');
  mkdirSync(res, { recursive: true });
  writeFileSync(join(res, 'AuditTheme.json'), JSON.stringify({ name: 'AuditTheme', dataColors: ['#118DFF', '#12239E', '#E66C37', '#6B007B', '#E044A7', '#744EC2', '#D9B300', '#D64550'], visualStyles: { '*': { Zz: { background: [{ show: true, color: { solid: { color: '#ffcc00' } } }] } } } }, null, 2));
  const rj = join(def, 'report.json');
  const report = JSON.parse(readFileSync(rj, 'utf8'));
  report.themeCollection.customTheme = { name: 'AuditTheme', reportVersionAtImport: { visual: '2.13.0', page: '2.1.0', report: '3.3.0' }, type: 'RegisteredResources' };
  report.resourcePackages = [{ name: 'RegisteredResources', type: 'RegisteredResources', items: [{ name: 'AuditTheme.json', path: 'AuditTheme.json', type: 'CustomTheme' }] }];
  writeFileSync(rj, JSON.stringify(report, null, 2));
}
// three bookmarks, so that a bookmark navigator has buttons to draw
{
  const dir = join(def, "bookmarks");
  mkdirSync(dir, { recursive: true });
  const first = JSON.parse(readFileSync(join(def, "pages", "pages.json"), "utf8")).pageOrder[0];
  const names = ["b1", "b2", "b3"];
  writeFileSync(join(dir, "bookmarks.json"), JSON.stringify({ $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/bookmarksMetadata/1.0.0/schema.json", items: names.map((name) => ({ name })) }, null, 2));
  names.forEach((name, i) => writeFileSync(join(dir, name + ".bookmark.json"), JSON.stringify({ $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/bookmark/2.1.0/schema.json", displayName: ["First view", "Second view", "Third view"][i], name, options: { suppressActiveSection: true, suppressData: true, suppressDisplay: true }, explorationState: { version: "1.3", activeSection: first } }, null, 2)));
}
const pages = JSON.parse(readFileSync(join(def, "pages", "pages.json"), "utf8"));
// the unit-test fixtures have a few columns the sample project does not (Customer.Country is Customer.Region here)
const forSample = (json) => json; // the sample has Customer.Country (src-tauri/sample), like the fixtures
// a value written into the first entry without a selector (or the one with the given selector id) of an object, as the app writes literals
const setLit = (json, object, prop, value, id) => {
  const bag = (json.visual.objects ??= {});
  const list = (bag[object] ??= []);
  let e = list.find((x) => (id ? x.selector?.id === id : !x.selector));
  if (!e) list.push((e = { ...(id ? { selector: { id } } : {}), properties: {} }));
  e.properties[prop] = { expr: { Literal: { Value: value } } };
};
// cases whose data would hide the effect are given a setting that makes it visible in both visuals of the pair
const TWEAKS = {
  // a label larger than the short bars does not fit inside them
  // (bars are 280 to 450 px long in the 600 px wide probe: a label that does not fit needs a very large font)
  ...Object.fromEntries(["barChart", "columnChart", "hundredPercentStackedBarChart", "hundredPercentStackedColumnChart"].map((t) => [t + ".labels.labelOverflow", (json) => { setLit(json, "labels", "show", "true"); setLit(json, "labels", "fontSize", "200D"); }])),
};
const tweak = (c, json) => {
  const out = JSON.parse(JSON.stringify(json));
  TWEAKS[`${c.visualType}.${c.object}.${c.prop}`]?.(out);
  pictures(out, c);
  dataFor(out, c);
  // small multiples: the sample has two channels only; the months give twelve panels, so that columns, rows and padding have something to arrange
  const rows = out.visual?.query?.queryState?.Rows?.projections;
  if (rows && out.visual.visualType !== "pivotTable") for (const p of rows) if (p.field?.Column?.Property === "Channel") { p.field.Column.Expression.SourceRef.Entity = "Date"; p.field.Column.Property = "Month"; p.queryRef = "Date.Month"; p.nativeQueryRef = "Month"; }
  // a constant reference line at a value outside the axis is not drawn: let the axis grow to it
  if (c.prop !== "autoScale" && !/ComboChart$/.test(c.visualType)) for (const e of out.visual?.objects?.y1AxisReferenceLine ?? []) if (e.selector?.id === "constant") e.properties.autoScale = { expr: { Literal: { Value: "true" } } };
  return out;
};
let tiny = false;
const put = (pageName, name, json) => {
  const x = 10;
  // tables and matrices are given the whole page, so that their last rows (the totals) are not scrolled out of sight
  const big = /^(pivotTable|tableEx)$/.test(json.visual?.visualType);
  // General > Responsive acts in a small visual
  const v = { ...forSample(json), name, position: { x, y: 10, z: 1, width: tiny ? 60 : big ? 1200 : 600, height: tiny ? 60 : big ? 700 : 420, tabOrder: 1 } };
  const dir = join(def, "pages", pageName, "visuals", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "visual.json"), JSON.stringify(v, null, 2));
};
const addPage = (id, json0, c) => {
  const json = tweak(c, json0);
  tiny = c.object === "general" && /^responsive/.test(c.prop);
  mkdirSync(join(def, "pages", id), { recursive: true });
  writeFileSync(join(def, "pages", id, "page.json"), JSON.stringify({ $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/1.0.0/schema.json", name: id, displayName: id, displayOption: "FitToPage", height: 720, width: 1280 }, null, 2));
  put(id, "probe", json);
  pages.pageOrder.push(id);
};
// one visual per page at the same place, so that both are drawn at the same pixel positions
addPage("ctla", picked[0].base, picked[0]);
addPage("ctlv0", picked[0].base, picked[0]);
picked.forEach((c, i) => { addPage("c" + i + "a", c.base, c); c.variants.forEach((v, j) => addPage(`c${i}v${j}`, v, c)); });
// a Tooltip page named Zz: Visual header tooltip > Page (section) names it
mkdirSync(join(def, "pages", "Zz"), { recursive: true });
writeFileSync(join(def, "pages", "Zz", "page.json"), JSON.stringify({ $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/1.0.0/schema.json", name: "Zz", displayName: "Zz", displayOption: "FitToPage", height: 240, width: 320, pageBinding: { name: "zzb", type: "Tooltip", referenceScope: "Default" } }, null, 2));
pages.pageOrder.push("Zz");
writeFileSync(join(def, "pages", "pages.json"), JSON.stringify(pages, null, 2));

// 3. open it in the real window and compare
session = await launch(PORT + 1, join(parent, "Rn", "Rn.pbip"));
const norm = (h) => h.replace(/ data-visual="[^"]*"/g, "").replace(/\b(zr\d+-[\w-]+|clip-?[\w-]*\d+|_echarts_instance_="[^"]*")/g, "").replace(/\s+/g, " ");
const grab = async (page, name) => {
  const f = page.locator(`[data-visual="${name}"]`).first();
  await f.waitFor();
  return { html: norm(await f.evaluate((el) => el.outerHTML)), text: await f.evaluate((el) => el.innerText), png: await f.screenshot({ animations: "disabled" }) };
};
const AUDIT = !!(range || ids);
const logResult = (obj) => { if (process.env.RENDER_OUT) appendFileSync(process.env.RENDER_OUT, JSON.stringify(obj) + "\n"); };
let counted = 0;
let unchanged = 0;
const rows = [];
try {
  const { page } = session;
  if (process.env.RENDER_CONSOLE) page.on("console", (m) => { if (/error|warn/.test(m.type())) console.log("CONSOLE", m.type(), m.text().slice(0, 300)); });
  await page.getByRole("button", { name: /^Open/ }).first().click();
  await page.getByRole("tab", { name: "ctla", exact: true }).waitFor({ timeout: 60000 });
  let current = null;
  const shot = async (name) => {
    // an open drop-down list (a popover) keeps the tabs from being clicked
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name, exact: true }).click();
    // wait until two shots of the visual are identical (animations done, data loaded)
    await page.waitForTimeout(AUDIT ? 700 : 2500);
    if (current && PREP[current.visualType]) await PREP[current.visualType](page);
    // pointer steps (header, tooltips): the pointer is moved away first so that both sides of a pair start alike
    const hover = current && !process.env.RENDER_NO_HOVER ? hoverStep(current) : undefined;
    if (hover) { await page.mouse.move(2, 2); await hover(page, current); }
    let g = await grab(page, "probe");
    for (let t = 0; AUDIT && t < 5; t++) { await page.waitForTimeout(400); const h = await grab(page, "probe"); if (h.png.equals(g.png)) break; g = h; }
    if (hover) g.around = await surroundings(page);
    return g;
  };
  // the page with the property is tried with up to four values; one that looks different is enough
  const compare = async (id, variants) => {
    const a = await shot(id + "a");
    let b = a;
    let pixels = false;
    let dom = false;
    for (let j = 0; j < variants && !pixels; j++) {
      b = await shot(`${id}v${j}`);
      pixels = !a.png.equals(b.png) || (!!a.around && !!b.around && !a.around.equals(b.around));
      dom ||= a.html !== b.html;
    }
    return { a, b, pixels, dom };
  };
  const ctl = await compare("ctl", 1);
  if (ctl.pixels || ctl.dom) { writeFileSync(join(work, "ctl-a.html"), ctl.a.html); writeFileSync(join(work, "ctl-b.html"), ctl.b.html); writeFileSync(join(work, "ctl-left.png"), ctl.a.png); writeFileSync(join(work, "ctl-right.png"), ctl.b.png); }
  check(!ctl.pixels && !ctl.dom, "control: the same visual twice gives identical pixels and DOM (the comparison has no noise)");
  for (let i = 0; i < picked.length; i++) {
    const c = picked[i];
    if (c.group === "random" && counted >= RANDOM_N) break;
    const key = `${c.visualType}.${c.object}.${c.prop}`;
    current = c;
    const r = await compare("c" + i, c.variants.length);
    if (process.env.RENDER_EVAL) console.log("EVAL", c.idx, JSON.stringify(await page.evaluate(process.env.RENDER_EVAL)));
    // a 100 % axis ends at 100: a constant line at 250 has no place on it
    const offAxis = false; // 100 % charts get their constant line inside the axis (render-data.mjs)
    // the tooltip and the visual header are drawn on hover only: not compared here
    const hoverOnly = /^(visualTooltip|visualHeaderTooltip|visualHeader)$/.test(c.object) && !!process.env.RENDER_NO_HOVER;
    const empty = offAxis || hoverOnly || (r.a.text.trim() === "" && r.a.html.length < 600) || /Cannot load this visual|No data to show/.test(r.a.text + r.b.text);
    if (c.group === "audit") {
      const why = skipReason(key);
      const status = hoverOnly ? "SKIP-hover" : why?.kind === "interaction" ? "SKIP-interaction" : offAxis ? "SKIP-offaxis" : empty ? "NODATA" : r.pixels ? "ok" : why?.kind === "semantic" && r.dom ? "SEMANTIC" : r.dom ? "DOM-ONLY" : "FAIL";
      logResult({ idx: c.idx, key, status, pixels: r.pixels, dom: r.dom, ...(why ? { why: why.why } : {}) });
      rows.push(`${status} ${key}`);
      if ((status !== "ok" || process.env.RENDER_IMG_ALL) && !status.startsWith("SKIP") && process.env.RENDER_IMG) { mkdirSync(process.env.RENDER_IMG, { recursive: true }); writeFileSync(join(process.env.RENDER_IMG, c.idx + "-a.png"), r.a.png); writeFileSync(join(process.env.RENDER_IMG, c.idx + "-b.png"), r.b.png); }
      continue;
    }
    if (c.group === "random" && empty) { rows.push(`SKIP (not compared: no data here, off the axis or drawn on hover only): ${c.visualType}.${c.object}.${c.prop}`); continue; }
    if (c.group === "random") counted++;
    const ok = r.pixels; // a change only in the DOM is not something a person sees
    rows.push(`${ok ? "ok  " : r.dom ? "DOM-ONLY" : "FAIL"} [${c.group}] ${c.visualType}.${c.object}.${c.prop}  pixels:${r.pixels} dom:${r.dom}`);
    if (!ok && c.group === "must") failures++;
    if (!ok && c.group === "random") unchanged++;
    if (!ok) { writeFileSync(join(work, `fail-${i}-a.png`), r.a.png); writeFileSync(join(work, `fail-${i}-b.png`), r.b.png); }
  }
  console.log(rows.join("\n"));
  // a random property may not show with the sample data (a KPI that is not neutral, one small-multiples panel): up to 4 of 20 are tolerated and listed
  if (!AUDIT) check(unchanged <= 4, `${unchanged} of ${counted} random properties looked the same with and without the property`);
  if (!AUDIT) check(counted >= RANDOM_N, `${counted} random Done-tested properties compared in the real window`);
  console.log(`WORK ${work}`);
} catch (e) {
  failures++;
  console.log("ERROR", e.message);
  console.log(rows.join("\n"));
} finally { try { process.kill(session.child.pid); } catch { /* gone */ } }
process.exit(failures ? 1 : 0);
