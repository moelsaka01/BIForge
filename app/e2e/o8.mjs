// Real-window test of O8 (integration): BIForge is a single instance per user. Opening a .biforge file or a biforge://
// link while it runs (what Windows does after a double click or a click on a link) starts a second process that hands the
// argument to the running window and exits. The window shows the confirmation first; nothing opens by itself.
// Run: npm run e2e   (needs `npx tauri build --debug --no-bundle` first)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-o8-"));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };

const dir = join(work, "inst");
mkdirSync(join(dir, "app"), { recursive: true });
mkdirSync(join(dir, "projects"), { recursive: true });
const share = join(work, "share");
mkdirSync(share);
const port = 9381;
const env = {
  ...process.env,
  BIFORGE_TEST_DEBUG_PORT: String(port),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview"),
  BIFORGE_APP_DIR: join(dir, "app"),
  BIFORGE_TEST_PICKS: join(dir, "projects"),
};
delete env.BIFORGE_ALLOW_MULTIPLE; // this test needs the single-instance behavior

const child = spawn(exe, [], { env, stdio: ["ignore", openSync(join(work, "out.log"), "w"), openSync(join(work, "err.log"), "w")] });
const pid = child.pid; // the only process this script ever stops
try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!browser) throw new Error("could not attach to the app window (is another BIForge running? it would have taken this start over)");
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts()[0]?.pages()[0];
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  page.setDefaultTimeout(30000);
  await page.waitForSelector("text=Recent");

  await page.getByRole("button", { name: /Learn with sample data/ }).click();
  const newDlg = page.getByRole("dialog");
  await newDlg.getByLabel("Project name").fill("Open Sample");
  await newDlg.getByRole("button", { name: "Browse…" }).click();
  await newDlg.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: /Publish & Share/ }).first().waitFor();
  await page.getByRole("button", { name: /Publish & Share/ }).first().click();
  const dlg = page.getByRole("dialog", { name: "Publish and Share" });
  await dlg.getByRole("combobox", { name: "Destination type" }).click();
  await page.getByRole("option", { name: /Folder on this PC/ }).click();
  await dlg.getByLabel("Destination name").fill("Share");
  await dlg.getByLabel("Folder").fill(share);
  await dlg.getByRole("button", { name: "Add destination" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await dlg.getByRole("checkbox", { name: /I have checked this list/ }).check();
  await dlg.getByLabel("Publisher name").fill("Opener");
  await dlg.getByRole("button", { name: "Publish", exact: true }).click();
  await dlg.getByRole("status").filter({ hasText: /Published version/ }).waitFor();
  await dlg.getByRole("button", { name: "Close", exact: true }).click();
  const file = join(share, readdirSync(share).find((f) => f.endsWith(".biforge")));
  check(file.endsWith(".biforge"), "a .biforge file exists to open");

  // a second start with the file: it hands the file over and exits
  const second = spawnSync(exe, [file], { env: { ...env, BIFORGE_TEST_DEBUG_PORT: "" }, encoding: "utf8", timeout: 30000 });
  check(second.status === 0 && !second.error, `the second start with a .biforge file exited by itself (code ${second.status})`);
  const open = page.getByRole("dialog", { name: /shared report/i });
  await open.waitFor({ timeout: 30000 });
  check((await open.getByLabel("Report file").inputValue()) === file, "the running window shows the confirmation with that file");
  await open.getByRole("button", { name: "Cancel" }).click();
  await open.waitFor({ state: "detached" });

  // and the same for a biforge:// link
  const link = `biforge://open?src=file&path=${encodeURIComponent(file)}`;
  const third = spawnSync(exe, [link], { env: { ...env, BIFORGE_TEST_DEBUG_PORT: "" }, encoding: "utf8", timeout: 30000 });
  check(third.status === 0 && !third.error, `the second start with a biforge:// link exited by itself (code ${third.status})`);
  const open2 = page.getByRole("dialog", { name: /shared report/i });
  await open2.waitFor({ timeout: 30000 });
  check((await open2.getByLabel("Report file").inputValue()) === file || (await open2.innerText()).includes(file), "the link opens the same confirmation (nothing opens by itself)");
} catch (e) {
  failures++;
  console.log("ERROR", e);
} finally {
  try { process.kill(pid); } catch {}
}
console.log("work dir", work);
process.exit(failures ? 1 : 0);
