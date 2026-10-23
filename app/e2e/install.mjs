// Real-window check of an INSTALLED BIForge: launches the exe named by BIFORGE_EXE, opens the sample project and looks at
// the report. Used by the release workflow after it installed the MSI. Not part of `npm run e2e`.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "");
const work = mkdtempSync(join(tmpdir(), "biforge-install-"));
const parent = join(work, "projects");
mkdirSync(parent);
const port = 9392;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(exe, [], {
  env: { ...process.env, BIFORGE_TEST_DEBUG_PORT: String(port), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"), BIFORGE_ALLOW_MULTIPLE: "1", BIFORGE_TEST_PICKS: parent },
  stdio: ["ignore", openSync(join(work, "out.log"), "w"), openSync(join(work, "err.log"), "w")],
});
const pid = child.pid; // the only process this script stops
let ok = false;
try {
  let browser;
  for (let i = 0; i < 90 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(1000); } }
  if (!browser) throw new Error("could not attach to the installed app window");
  let page;
  for (let i = 0; i < 60 && !page; i++) { page = browser.contexts()[0]?.pages()[0]; if (!page) await sleep(500); }
  page.setDefaultTimeout(60000);
  await page.waitForSelector("text=Recent");
  console.log("PASS: the installed app shows the start screen");
  await page.getByRole("button", { name: /Learn with sample data/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Project name").fill("Installed sample");
  await dlg.getByRole("button", { name: "Browse…" }).click();
  await dlg.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: /Publish & Share/ }).first().waitFor();
  await page.waitForSelector("text=Sales Amount");
  console.log("PASS: the sample project opened and the report shows its visuals");
  ok = true;
} catch (e) {
  console.log("FAIL:", e.message);
} finally {
  try { process.kill(pid); } catch { /* gone */ }
}
process.exit(ok ? 0 : 1);
