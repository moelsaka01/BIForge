// Real-window render check. A property counted as drawn (rendered.json) must change what the real window shows: for each case in
// render-cases.json (written by `WRITE_RENDER_CASES=1 UPDATE_RENDERED=1 npx vitest run src/core/format/coverage.test.ts`) two pages
// hold the visual without the property and with it, and the two are compared as pixels and as DOM.
// "must" = properties added in the latest batches; "random" = a seeded random sample of the others (the first RANDOM_N whose
// unformatted visual shows data). Run: node e2e/render.mjs   (needs `npx tauri build --debug --no-bundle` first)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const cases = JSON.parse(readFileSync(new URL("./render-cases.json", import.meta.url), "utf8"));
const RANDOM_N = Number(process.env.RENDER_RANDOM ?? 20);
const picked = [...cases.must.map((c) => ({ ...c, group: "must" })), ...cases.random.slice(0, RANDOM_N + 12).map((c) => ({ ...c, group: "random" }))];
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
let session = await launch(9396, parent);
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

// 2. one page per case: page "cNa" has it without the property, "cNb" with it (pages "ctla" and "ctlb" hold the unformatted visual twice, as a control)
const def = join(parent, "Rn", "Rn.Report", "definition");
const pages = JSON.parse(readFileSync(join(def, "pages", "pages.json"), "utf8"));
// the unit-test fixtures have a few columns the sample project does not (Customer.Country is Customer.Region here)
const forSample = (json) => JSON.parse(JSON.stringify(json).replaceAll("Customer.Country", "Customer.Region").replaceAll('"Country"', '"Region"'));
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
  "barChart.labels.labelOverflow": (json) => { setLit(json, "labels", "show", "true"); setLit(json, "labels", "fontSize", "36D"); },
};
const tweak = (c, json) => {
  const out = JSON.parse(JSON.stringify(json));
  TWEAKS[`${c.visualType}.${c.object}.${c.prop}`]?.(out);
  // a constant reference line at a value outside the axis is not drawn: let the axis grow to it
  for (const e of out.visual?.objects?.y1AxisReferenceLine ?? []) if (e.selector?.id === "constant") e.properties.autoScale = { expr: { Literal: { Value: "true" } } };
  return out;
};
const put = (pageName, name, json) => {
  const x = 10;
  const v = { ...forSample(json), name, position: { x, y: 10, z: 1, width: 600, height: 420, tabOrder: 1 } };
  const dir = join(def, "pages", pageName, "visuals", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "visual.json"), JSON.stringify(v, null, 2));
};
const addPage = (id, json0, c) => {
  const json = tweak(c, json0);
  mkdirSync(join(def, "pages", id), { recursive: true });
  writeFileSync(join(def, "pages", id, "page.json"), JSON.stringify({ $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/1.0.0/schema.json", name: id, displayName: id, displayOption: "FitToPage", height: 720, width: 1280 }, null, 2));
  put(id, "probe", json);
  pages.pageOrder.push(id);
};
// one visual per page at the same place, so that both are drawn at the same pixel positions
addPage("ctla", picked[0].base, picked[0]);
addPage("ctlb", picked[0].base, picked[0]);
picked.forEach((c, i) => { addPage("c" + i + "a", c.base, c); addPage("c" + i + "b", c.variant, c); });
writeFileSync(join(def, "pages", "pages.json"), JSON.stringify(pages, null, 2));

// 3. open it in the real window and compare
session = await launch(9397, join(parent, "Rn", "Rn.pbip"));
const norm = (h) => h.replace(/ data-visual="[^"]*"/g, "").replace(/\b(zr\d+-[\w-]+|clip-?[\w-]*\d+|_echarts_instance_="[^"]*")/g, "").replace(/\s+/g, " ");
const grab = async (page, name) => {
  const f = page.locator(`[data-visual="${name}"]`).first();
  await f.waitFor();
  return { html: norm(await f.evaluate((el) => el.outerHTML)), text: await f.evaluate((el) => el.innerText), png: await f.screenshot({ animations: "disabled" }) };
};
let counted = 0;
const rows = [];
try {
  const { page } = session;
  await page.getByRole("button", { name: /^Open/ }).first().click();
  await page.getByRole("tab", { name: "ctla", exact: true }).waitFor({ timeout: 60000 });
  const compare = async (id) => {
    const shot = async (suffix) => {
      await page.getByRole("tab", { name: id + suffix, exact: true }).click();
      await page.waitForTimeout(2500);
      return grab(page, "probe");
    };
    const a = await shot("a");
    const b = await shot("b");
    return { a, b, pixels: !a.png.equals(b.png), dom: a.html !== b.html };
  };
  const ctl = await compare("ctl");
  if (ctl.pixels || ctl.dom) { writeFileSync(join(work, "ctl-a.html"), ctl.a.html); writeFileSync(join(work, "ctl-b.html"), ctl.b.html); writeFileSync(join(work, "ctl-left.png"), ctl.a.png); writeFileSync(join(work, "ctl-right.png"), ctl.b.png); }
  check(!ctl.pixels && !ctl.dom, "control: the same visual twice gives identical pixels and DOM (the comparison has no noise)");
  for (let i = 0; i < picked.length; i++) {
    const c = picked[i];
    if (c.group === "random" && counted >= RANDOM_N) break;
    const r = await compare("c" + i);
    // a 100 % axis ends at 100: a constant line at 250 has no place on it
    const offAxis = /^hundredPercent/.test(c.visualType) && /ReferenceLine/.test(c.object);
    const empty = offAxis || (r.a.text.trim() === "" && r.a.html.length < 600) || /Cannot load this visual|No data to show/.test(r.a.text + r.b.text);
    if (c.group === "random" && empty) { rows.push(`SKIP (nothing to compare): ${c.visualType}.${c.object}.${c.prop}`); continue; }
    if (c.group === "random") counted++;
    const ok = r.pixels; // a change only in the DOM is not something a person sees
    rows.push(`${ok ? "ok  " : r.dom ? "DOM-ONLY" : "FAIL"} [${c.group}] ${c.visualType}.${c.object}.${c.prop}  pixels:${r.pixels} dom:${r.dom}`);
    if (!ok) failures++;
    if (!ok) writeFileSync(join(work, `fail-${i}.png`), r.a.png);
  }
  console.log(rows.join("\n"));
  check(counted >= RANDOM_N, `${counted} random Done-tested properties compared in the real window`);
  console.log(`WORK ${work}`);
} catch (e) {
  failures++;
  console.log("ERROR", e.message);
  console.log(rows.join("\n"));
} finally { try { process.kill(session.child.pid); } catch { /* gone */ } }
process.exit(failures ? 1 : 0);
