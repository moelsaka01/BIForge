// Real-window test of the Power Query editor's column quality, distribution and profile (View tab): the sample project's
// Date query (731 rows, Year 2023 and 2024) is profiled by the real engine in the real window.
// Run: node e2e/pq.mjs   (needs `npx tauri build --debug --no-bundle` first)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-pq-"));
const parent = join(work, "projects");
mkdirSync(parent);
const port = 9393;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };

const child = spawn(exe, [], {
  env: { ...process.env, BIFORGE_TEST_DEBUG_PORT: String(port), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"), BIFORGE_ALLOW_MULTIPLE: "1", BIFORGE_TEST_PICKS: parent },
  stdio: ["ignore", openSync(join(work, "out.log"), "w"), openSync(join(work, "err.log"), "w")],
});
const pid = child.pid; // the only process this script stops
try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(1000); } }
  if (!browser) throw new Error("could not attach to the app window");
  let page;
  for (let i = 0; i < 60 && !page; i++) { page = browser.contexts()[0]?.pages()[0]; if (!page) await sleep(500); }
  page.setDefaultTimeout(30000);
  await page.waitForSelector("text=Recent");
  await page.getByRole("button", { name: /Learn with sample data/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Project name").fill("PQ profile");
  await dlg.getByRole("button", { name: "Browse…" }).click();
  await dlg.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: /Transform data/ }).first().click();
  const editor = page.getByRole("dialog", { name: "Power Query Editor" });
  await editor.getByRole("columnheader", { name: /^Year Menu for/ }).waitFor();
  check(true, "the Power Query editor shows the Date query");

  await editor.getByRole("tab", { name: "View" }).click();
  await editor.getByRole("button", { name: "Column quality" }).click();
  const q = await editor.getByLabel(/^Quality of Year:/).getAttribute("aria-label");
  check(q === "Quality of Year: Valid 100%, Error 0%, Empty 0%", `column quality of Year reads "${q}"`);

  await editor.getByRole("button", { name: "Column distribution" }).click();
  const dist = await editor.getByLabel(/^Distribution of Year:/).getAttribute("aria-label");
  check(dist === "Distribution of Year: 2 distinct, 0 unique", `column distribution of Year reads "${dist}"`);

  await editor.getByRole("button", { name: "Column profile" }).click();
  await editor.getByRole("columnheader", { name: /^Year Menu for/ }).click();
  const stats = editor.getByLabel("Column statistics");
  await stats.waitFor();
  const text = await stats.innerText();
  check(/Count\s+731/.test(text) && /Distinct\s+2/.test(text) && /Min\s+2023/.test(text) && /Max\s+2024/.test(text), "the profile of Year lists 731 rows, 2 distinct values, min 2023, max 2024");
  const bars = await editor.getByLabel("Value distribution").innerText();
  check(/2023/.test(bars) && /2024/.test(bars), "the value distribution lists 2023 and 2024");
} catch (e) {
  failures++;
  console.log("ERROR", e.message);
} finally {
  try { process.kill(pid); } catch { /* gone */ }
}
process.exit(failures ? 1 : 0);
