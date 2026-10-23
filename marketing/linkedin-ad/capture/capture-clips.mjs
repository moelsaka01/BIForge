// Records the real app clips for the LinkedIn ad from the REAL window (WebView2 over the DevTools protocol).
//   node marketing/linkedin-ad/capture/capture-clips.mjs
// Needs: `cd app && npx tauri build --debug --no-bundle` first (the exe must embed the frontend), ffmpeg on PATH.
// Output: marketing/linkedin-ad/capture/frames/<clip>/0001.jpg ... at 30 fps (git-ignored raw captures) and clips.json.
// The script stops only the app process it started (exact PID). Interactions are deliberately slow and smooth: the mouse
// glides, a visible cursor and click ring are drawn into the page, and typing runs at a human pace.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, openSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const { chromium } = createRequire(join(root, "app/package.json"))("playwright-core");
const exe = resolve(process.env.BIFORGE_EXE ?? join(root, "target/debug/biforge-app.exe"));
const csv = join(here, "messy-orders.csv").replace(/\\/g, "/");
const framesRoot = join(here, "frames");
const only = process.argv.slice(2); // optional: names of clips to keep (all are recorded anyway, the flow is sequential)
const work = mkdtempSync(join(tmpdir(), "biforge-ad-"));
const parent = join(work, "projects");
mkdirSync(parent);
mkdirSync(framesRoot, { recursive: true });
const port = 9417;
let speed = 1; // 1 while a clip is being recorded; ONLY=report,share-p2p... makes every other segment run fast (no recording)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;

const child = spawn(exe, [], {
  env: { ...process.env, BIFORGE_TEST_DEBUG_PORT: String(port), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"), BIFORGE_ALLOW_MULTIPLE: "1", BIFORGE_TEST_PICKS: parent },
  stdio: ["ignore", openSync(join(work, "out.log"), "w"), openSync(join(work, "err.log"), "w")],
});
const pid = child.pid; // the only process this script stops

const W = 1280, H = 800, DPR = 1.5;
let page, cdp;
const clips = {};

// ---- recorder: CDP screencast frames with their timestamps, retimed to constant 30 fps by ffmpeg
let rec = null;
async function startRec(name) {
  if (ONLY && !ONLY.includes(name)) { speed = 0.12; return; }
  speed = 1;
  const dir = join(work, "raw-" + name);
  mkdirSync(dir);
  rec = { name, dir, frames: [] };
  cdp.on("Page.screencastFrame", rec.handler = async (f) => {
    if (!rec || rec.stopped) return;
    const i = rec.frames.length;
    writeFileSync(join(dir, `${String(i).padStart(5, "0")}.jpg`), Buffer.from(f.data, "base64"));
    rec.frames.push(f.metadata.timestamp);
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W * DPR, maxHeight: H * DPR, everyNthFrame: 1 });
  await sleep(250);
}
async function stopRec() {
  if (!rec) { speed = ONLY ? 0.12 : 1; return; }
  const r = rec;
  await sleep(350);
  await cdp.send("Page.stopScreencast");
  r.stopped = true;
  cdp.off("Page.screencastFrame", r.handler);
  rec = null;
  speed = ONLY ? 0.12 : 1;
  const list = [];
  for (let i = 0; i < r.frames.length; i++) {
    const dur = i + 1 < r.frames.length ? r.frames[i + 1] - r.frames[i] : 0.2;
    list.push(`file '${join(r.dir, `${String(i).padStart(5, "0")}.jpg`).replace(/\\/g, "/")}'`, `duration ${Math.max(dur, 0.001).toFixed(4)}`);
  }
  list.push(`file '${join(r.dir, `${String(r.frames.length - 1).padStart(5, "0")}.jpg`).replace(/\\/g, "/")}'`);
  writeFileSync(join(r.dir, "list.txt"), list.join("\n"));
  const out = join(framesRoot, r.name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const p = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(r.dir, "list.txt"), "-vf", "fps=30,scale=1600:-2:flags=lanczos", "-q:v", "3", join(out, "%04d.jpg")], { encoding: "utf8" });
  if (p.status !== 0) throw new Error("ffmpeg: " + p.stderr);
  const n = readdirSync(out).length;
  clips[r.name] = { frames: n, fps: 30, seconds: +(n / 30).toFixed(2), width: 1600, height: 1000 };
  console.log("clip", r.name, clips[r.name].seconds, "s", r.frames.length, "raw frames");
}

// ---- smooth input
let mx = 640, my = 400;
async function glide(x, y, ms = 450) {
  const steps = Math.max(8, Math.round(ms / 16));
  const sx = mx, sy = my;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
    await sleep(16);
  }
  mx = x; my = y;
}
async function center(loc) {
  await loc.first().scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.first().boundingBox();
  if (!b) throw new Error("no box for " + loc);
  return [b.x + b.width / 2, b.y + b.height / 2];
}
async function click(loc, opts = {}) {
  const [x, y] = await center(loc);
  await glide(x, y, Math.min(opts.ms ?? 260, 320));
  await sleep(40);
  await page.mouse.down();
  await sleep(50);
  await page.mouse.up();
  await sleep(opts.after ?? 140);
}
async function ctrlClick(loc) {
  const [x, y] = await center(loc);
  await glide(x, y, 260);
  await page.keyboard.down("Control");
  await page.mouse.down(); await sleep(50); await page.mouse.up();
  await page.keyboard.up("Control");
  await sleep(140);
}
async function typeSlow(text, delay = 80) { await page.keyboard.type(text, { delay: speed < 1 ? Math.max(delay * 0.9, 70) : delay }); }
async function installCursor() {
  await page.evaluate(() => {
    if (document.getElementById("ad-cursor")) return;
    const c = document.createElement("div");
    c.id = "ad-cursor";
    c.style.cssText = "position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(-200px,-200px);will-change:transform";
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.5 25 L17 23.4 L13.6 16.2 L20.5 16 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div id="ad-ring" style="position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:3px solid #0f6cbd;opacity:0;transform:scale(.3)"></div>';
    document.documentElement.appendChild(c);
    const ring = c.querySelector("#ad-ring");
    addEventListener("mousemove", (e) => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    addEventListener("mousedown", () => { ring.animate([{ opacity: 0.9, transform: "scale(.3)" }, { opacity: 0, transform: "scale(1.9)" }], { duration: 420, easing: "ease-out" }); }, true);
  });
}

// clips.json lists every clip directory with its frame count (also correct after a partial ONLY=... run)
function indexClips() {
  const all = {};
  for (const d of readdirSync(framesRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const n = readdirSync(join(framesRoot, d.name)).filter((f) => f.endsWith(".jpg")).length;
    all[d.name] = { frames: n, fps: 30, seconds: +(n / 30).toFixed(2), width: 1600, height: 1000 };
  }
  writeFileSync(join(framesRoot, "clips.json"), JSON.stringify(all, null, 2));
  return all;
}
if (process.env.INDEX_ONLY) { console.log(JSON.stringify(indexClips())); process.exit(0); }

try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(1000); } }
  if (!browser) throw new Error("could not attach to the window");
  for (let i = 0; i < 60 && !page; i++) { page = browser.contexts()[0]?.pages()[0]; if (!page) await sleep(500); }
  page.setDefaultTimeout(20000);
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
  await page.waitForSelector("text=Recent");

  // ---- setup (not recorded): project, the messy CSV, the Power Query editor open on it
  await page.getByRole("button", { name: /Blank report/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Project name").fill("Orders");
  await dlg.getByRole("button", { name: "Browse…" }).click();
  await dlg.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: /Transform data/ }).first().waitFor();
  await page.getByRole("button", { name: "Import data" }).click();
  const imp = page.getByRole("dialog", { name: "Import data" });
  await imp.getByLabel("Source type").selectOption({ label: "Text/CSV" });
  await imp.getByLabel("File path").fill(csv);
  await imp.getByLabel("File path").blur();
  await imp.getByLabel("Table name").fill("Orders");
  await imp.getByRole("button", { name: "Import", exact: true }).click();
  await imp.waitFor({ state: "detached" });
  await sleep(1500);
  await page.getByRole("button", { name: /Transform data/ }).first().click();
  const ed = page.getByRole("dialog", { name: "Power Query Editor" });
  await ed.waitFor();
  await ed.getByRole("columnheader", { name: /^order_id/ }).waitFor();
  await installCursor();
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e.stack ?? e).slice(0, 900)));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 300)); });
  if (ONLY) speed = 0.12;
  await page.mouse.move(640, 400);
  await sleep(1000);

  // ---- clip 1: Power Query cleans the data, the Applied Steps list grows
  await startRec("pq");
  await sleep(500);
  await click(ed.getByRole("button", { name: /Remove Rows/ }));
  await sleep(300);
  await click(page.getByRole("menuitem", { name: /Remove Blank Rows/ }));
  await sleep(450);
  await click(ed.getByRole("columnheader", { name: /^order_id/ }), { ms: 350 });
  await click(ed.getByRole("button", { name: /Remove Rows/ }), { ms: 350 });
  await click(page.getByRole("menuitem", { name: /Remove Duplicates/ }));
  await sleep(450);
  await click(ed.getByRole("tab", { name: "Transform" }), { ms: 300 });
  await click(ed.getByRole("columnheader", { name: /^region/ }), { ms: 350 });
  await click(ed.getByRole("button", { name: /Format/ }), { ms: 350 });
  await click(page.getByRole("menuitem", { name: "UPPERCASE" }));
  await sleep(450);
  await click(ed.getByRole("columnheader", { name: /^qty/ }), { ms: 400 });
  await click(ed.getByRole("button", { name: "Replace Values" }), { ms: 450 });
  const rv = page.getByRole("dialog", { name: "Replace Values" });
  if (!(await rv.getByRole("checkbox", { name: /qty/ }).isChecked())) await click(rv.getByRole("checkbox", { name: /qty/ }), { ms: 350 });
  await click(rv.getByRole("textbox", { name: "Value to find" }), { ms: 350 });
  await typeSlow("n/a", 90);
  await click(rv.getByRole("textbox", { name: "Replace with" }), { ms: 350 });
  await typeSlow("0", 90);
  await click(rv.getByRole("button", { name: "OK" }), { ms: 400 });
  await sleep(450);
  await click(ed.getByRole("columnheader", { name: /^qty/ }), { ms: 400 });
  await click(ed.getByRole("button", { name: "Data Type ▾" }), { ms: 350 });
  await click(page.getByRole("menuitem", { name: "Whole number" }));
  await sleep(1100);
  await stopRec();
  await click(ed.getByRole("tab", { name: "Home" }), { ms: 300 });
  await click(ed.getByRole("button", { name: "Close & Apply" }), { ms: 400 });
  await ed.waitFor({ state: "detached" });
  await sleep(2500);

  // ---- clip 2: a DAX measure typed out in the editor
  await startRec("dax");
  await sleep(300);
  await click(page.getByRole("button", { name: "New measure" }).first(), { ms: 600 });
  await sleep(450);
  await click(page.getByPlaceholder("Measure name"), { ms: 500 });
  await typeSlow("Revenue", 90);
  await click(page.locator(".monaco-editor").first(), { ms: 450 });
  await page.locator(".monaco-editor.focused").first().waitFor();
  await typeSlow("SUMX(Orders, Orders[qty] * Orders[unit price])", 80);
  await sleep(900);
  await click(page.getByRole("button", { name: "Evaluate" }), { ms: 500 });
  await sleep(1400);
  await click(page.getByRole("button", { name: "Add measure" }), { ms: 450 });
  await sleep(1000);
  await stopRec();

  // ---- clip 3: visuals snap onto the canvas, then a slicer click cross-filters them
  await click(page.getByRole("button", { name: "Report view" }), { ms: 400 });
  await sleep(1000);
  await page.getByRole("treeitem", { name: /^Orders/ }).first().click();
  await page.getByRole("button", { name: "Collapse Filters" }).click();
  await sleep(500);
  await page.getByRole("button", { name: "Fit to page" }).click();
  await sleep(800);
  const pageEl = page.locator("[data-page=page1]");
  const geo = async () => { const b = await pageEl.boundingBox(); const s = await pageEl.evaluate((e) => parseFloat(e.style.transform.replace(/scale\(([^)]+)\)/, "$1"))); return { b, s }; };
  const field = async (n) => { await click(page.getByRole("checkbox", { name: new RegExp(`Use ${n} in the selected visual`) }), { ms: 260, after: 280 }); };
  async function addVisual(typeName, fields, x, y, w, h) {
    { const { b } = await geo(); await page.mouse.click(b.x + 8, b.y + b.height - 8); await sleep(150); } // deselect, so the type button adds a new visual
    if (process.env.HOLD) { console.log("HOLDING pid", pid); await new Promise((r) => setTimeout(r, 240000)); }
    await click(page.getByRole("button", { name: typeName, exact: true }), { ms: 300, after: 380 });
    const v = page.locator("[role=group][aria-label^='Visual:']").last();
    // select it (the new visual starts selected in the model, but make sure)
    const vb = await v.boundingBox();
    await page.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2);
    await sleep(300);
    for (const f of fields) await field(f);
    // move with the title bar, resize with the south-east handle
    const { b, s } = await geo();
    const vb2 = await v.boundingBox();
    const bar = v.locator("[data-testid=visual-bar]");
    const bb = await bar.boundingBox();
    await glide(bb.x + 20, bb.y + 6, 220);
    await page.mouse.down();
    const dx = b.x + x * s - vb2.x, dy = b.y + y * s - vb2.y;
    await glide(mx + dx, my + dy, 380);
    await page.mouse.up();
    await sleep(300);
    const vb3 = await v.boundingBox();
    const se = v.locator("[data-handle=se]");
    const sb = await se.boundingBox();
    await glide(sb.x + sb.width / 2, sb.y + sb.height / 2, 220);
    await page.mouse.down();
    await glide(mx + (w * s - vb3.width), my + (h * s - vb3.height), 340);
    await page.mouse.up();
    await sleep(250);
  }
  await page.mouse.click(400, 600); // nothing selected
  await startRec("report");
  await sleep(300);
  await addVisual("Card", ["Revenue"], 40, 40, 260, 150);
  await addVisual("Clustered column chart", ["region", "Revenue"], 330, 40, 440, 310);
  await addVisual("Donut chart", ["product", "Revenue"], 800, 40, 440, 310);
  await addVisual("Slicer", ["region"], 40, 220, 260, 300);
  await addVisual("Clustered bar chart", ["customer", "Revenue"], 330, 380, 910, 300);
  await page.mouse.click(30, 600);
  await sleep(450);
  // cross-filter: click slicer values
  const slicer = page.locator("[role=group][aria-label^='Visual: Slicer']");
  for (const v of ["EAST", "NORTH"]) {
    await click(slicer.getByText(v, { exact: true }), { ms: 600, after: 1200 });
  }
  await click(slicer.getByText("NORTH", { exact: true }), { ms: 500, after: 1300 }); // clears the selection again
  await stopRec();

  // ---- clips 4..: the sharing destinations of Publish & Share
  await click(page.getByRole("button", { name: /Publish & Share/ }).first(), { ms: 400 });
  const ps = page.getByRole("dialog", { name: "Publish and Share" });
  await ps.waitFor();
  await sleep(800);
  const choose = async (label, clipName, nameText) => {
    await startRec(clipName);
    await sleep(200);
    for (const l of [].concat(label)) {
      await click(ps.getByRole("combobox").first(), { ms: 450 });
      await click(page.getByRole("option", { name: new RegExp(l) }), { ms: 350, after: 500 });
      if (nameText) { await click(ps.getByRole("textbox").first(), { ms: 300 }); await typeSlow(nameText, 70); nameText = null; }
      await sleep(1000);
    }
    await stopRec();
  };
  await choose("GitHub Pages", "share-hosting", "Team dashboard");
  await choose("Direct connection", "share-p2p");
  await choose(["BIForge server", "Host from this PC"], "share-server");
  await choose(["Google Drive", "OneDrive", "Dropbox"], "share-cloud");
  await page.keyboard.press("Escape");

  indexClips();
  console.log("done", JSON.stringify(clips));
} catch (e) {
  console.log("FAILED:", String(e.message).slice(0, 400));
  try { await page.screenshot({ path: join(here, "frames", "fail.png") }); } catch { /* no page */ }
  process.exitCode = 1;
} finally {
  try { process.kill(pid); } catch { /* already gone */ }
}
