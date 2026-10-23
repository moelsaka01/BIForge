// Captures the screenshots and the demo video of the README and the release page from the REAL app window.
// Run: node e2e/media.mjs <out-dir>   (needs `npx tauri build --debug --no-bundle` first; ffmpeg on PATH for the video)
// Frames are taken with Page.screenshot while the script drives the window, then ffmpeg joins them.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const out = resolve(process.argv[2] ?? "../docs/media");
mkdirSync(out, { recursive: true });
const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-media-"));
const parent = join(work, "projects");
mkdirSync(parent);
const frames = join(work, "frames");
mkdirSync(frames);
const port = 9391;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(exe, [], {
  env: {
    ...process.env,
    BIFORGE_TEST_DEBUG_PORT: String(port),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"),
    BIFORGE_ALLOW_MULTIPLE: "1",
    BIFORGE_TEST_PICKS: parent,
  },
  stdio: ["ignore", openSync(join(work, "out.log"), "w"), openSync(join(work, "err.log"), "w")],
});
const pid = child.pid; // the only process this script stops
let n = 0;
let page;
let recording = false;
const frame = async () => { await page.screenshot({ path: join(frames, `f${String(n++).padStart(5, "0")}.png`) }); };
// hold: how long the picture stays in the video (frames are played at 4 per second)
const hold = async (sec) => { for (let i = 0; i < sec * 4; i++) { if (recording) await frame(); await sleep(250); } };
const shot = async (name) => { await sleep(1200); await page.screenshot({ path: join(out, `${name}.png`) }); console.log("shot", name); };
const tryClick = async (loc, what) => { try { await loc.first().click({ timeout: 6000 }); } catch { console.log("could not click", what); } };

try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(1000); } }
  if (!browser) throw new Error("could not attach to the window");
  for (let i = 0; i < 60 && !page; i++) { page = browser.contexts()[0]?.pages()[0]; if (!page) await sleep(500); }
  page.setDefaultTimeout(30000);
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.waitForSelector("text=Recent");
  recording = true;
  await hold(3);
  await shot("start-screen");

  await page.getByRole("button", { name: /Learn with sample data/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Project name").fill("Retail demo");
  await dlg.getByRole("button", { name: "Browse…" }).click();
  await dlg.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: /Publish & Share/ }).first().waitFor();
  await sleep(4000);
  await hold(4);
  await shot("report-classic");

  // the view rail on the left (Report, Table, Model, DAX query, TMDL)
  const rail = { report: 214, table: 268, model: 322, dax: 375, tmdl: 430 };
  const go = async (k) => { await page.mouse.click(26, rail[k]); };
  for (const [k, name] of [["model", "model-view"], ["table", "table-view"], ["dax", "dax-query"], ["tmdl", "tmdl-view"]]) {
    await go(k);
    await hold(3);
    await shot(name);
  }
  await go("report");
  await hold(2);
  await tryClick(page.getByRole("button", { name: /Transform data/ }), "Transform data");
  await hold(4);
  await shot("power-query");
  await page.keyboard.press("Escape");
  await hold(1);
  recording = false;
  const r = spawnSync("ffmpeg", ["-y", "-framerate", "4", "-i", join(frames, "f%05d.png"), "-vf", "scale=1280:-2,format=yuv420p", "-c:v", "libx264", "-crf", "28", join(out, "demo.mp4")], { encoding: "utf8" });
  console.log("ffmpeg exit", r.status, r.stderr?.slice(-300));
} finally {
  try { process.kill(pid); } catch { /* already gone */ }
}
