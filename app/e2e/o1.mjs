// Real-window test of the O1 flow: drives the built Tauri app (WebView2) over the DevTools protocol.
// Run: npm run e2e   (needs `npx tauri build --debug --no-bundle` first; see docs/PROGRESS.md)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-"));
const parent = join(work, "projects");
const share = join(work, "share");
const port = 9333;
mkdirSync(parent); mkdirSync(share);

let failures = 0;
const hiddenRoots = (page) => page.evaluate(() => document.getElementById("root").getAttribute("aria-hidden"));
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };

const child = spawn(exe, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"),
    BIFORGE_TEST_PICKS: [parent].join("|"),
  },
  stdio: "ignore",
});
const pid = child.pid; // the only process this script ever stops
let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!browser) throw new Error("could not attach to the app window");
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30000);
  await page.waitForSelector("text=Recent");
  check(true, "the real window shows the start screen");

  // 1. sample project
  await page.getByRole("button", { name: /Learn with sample data/ }).click();
  const newDlg = page.getByRole("dialog");
  await newDlg.getByLabel("Project name").fill("E2E Sample");
  await newDlg.getByRole("button", { name: "Browse…" }).click();
  await newDlg.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: /Publish & Share/ }).first().waitFor();
  check(true, "sample project opened; Publish & Share is in the ribbon");

  // 2. Publish & Share to the folder adapter
  await page.getByRole("button", { name: /Publish & Share/ }).first().click();
  const dlg = page.getByRole("dialog", { name: "Publish and Share" });
  await dlg.waitFor();
  await dlg.getByLabel("Destination name").fill("E2E share");
  await dlg.getByLabel("Folder").fill(`${share}`);
  await dlg.getByRole("button", { name: "Add destination" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click(); // the setup guide pop-up
  await dlg.getByRole("checkbox", { name: /I have checked this list/ }).check();
  await dlg.getByLabel("Publisher name").fill("E2E Tester");
  await dlg.getByRole("button", { name: "Publish", exact: true }).click();
  const status = dlg.getByRole("status").filter({ hasText: /Published version/ });
  await status.waitFor();
  const text = await status.innerText();
  const key = /(AGE-SECRET-KEY-[A-Z0-9]+)/.exec(text)?.[1];
  check(!!key, "publish to the folder adapter shows an access key once");
  const files = readdirSync(share);
  console.log("files in share:", files);
  check(files.some((f) => f.endsWith(".biforge")), "a .biforge file was written to the shared folder");

  // 3. Open shared report: read-only viewing mode
  await dlg.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(800);
  await page.locator("button", { hasText: /Open shared/ }).first().click();
  const open = page.getByRole("dialog", { name: /shared report/i });
  await open.getByLabel("Report file").fill(join(share, files.find((f) => f.endsWith(".biforge"))));
  await open.getByLabel("Access key").fill(key);
  await open.getByRole("button", { name: "Open for viewing" }).click();
  const bar = page.locator(".viewing-bar");
  await bar.waitFor();
  await page.waitForTimeout(500);
  check((await hiddenRoots(page)) === null, "the app is not left hidden from assistive technology after the dialog closes");
  await bar.waitFor();
  const barText = await bar.innerText();
  console.log(barText.split(/\s*\n+\s*/).join(" | "));
  check(/E2E Tester/.test(barText) && /private/.test(barText) && /Read only/.test(barText), "viewing bar shows publisher, private access and read-only");
  check((await page.locator("button", { hasText: /Publish/ }).count()) === 0, "editing ribbon is replaced (no Publish & Share button)");
  await page.waitForSelector("canvas, [data-testid=card-value]");
  await page.waitForTimeout(1500);
  // right-click on a visual: no editing items offered
  const visual = page.locator("[data-testid=card-value]").first();
  const box = await (await visual.elementHandle())?.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  check(!!box, "a visual with data is rendered in viewing mode");
  check((await page.getByRole("menuitem", { name: /Delete|Duplicate|Bring to front|Send to back|Edit interactions/ }).count()) === 0, "right-click on a visual offers no editing items");
  await page.screenshot({ path: join(work, "viewing.png") });
  // leave viewing mode
  await bar.locator("button", { hasText: /^Close$/ }).click();
  await page.waitForSelector("text=Recent");
  check(true, "Close leaves viewing mode and returns to the start screen");

} catch (e) {
  failures++;
  console.log("ERROR", e);
  try { const pg = browser?.contexts()[0].pages()[0]; await pg?.screenshot({ path: join(work, "err.png") }); console.log("screenshot", join(work, "err.png")); } catch {}
} finally {
  try { await browser?.close(); } catch {}
  try { process.kill(pid); } catch {}
}
console.log("work dir", work);
process.exit(failures ? 1 : 0);
