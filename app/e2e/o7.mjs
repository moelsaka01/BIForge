// Real-window test of O7 (scheduled refresh), one BIForge instance:
//  Part 1, on this PC: publish the sample report to a folder, turn on the schedule (a real Windows Task Scheduler task is
//  registered and removed again), change the source file, refresh now, refresh again with no change, then run the same job
//  the way Task Scheduler does (the app started without a window) and see it in the history with where it ran.
//  Part 2, on a server: Host from this PC, publish, turn on the refresh on the server, put a changed source file into the
//  report's source folder on the server, refresh now, read the history.
// Run: npm run e2e   (needs `npx tauri build --debug --no-bundle` first)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-o7-"));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };

const dir = join(work, "inst");
mkdirSync(join(dir, "app"), { recursive: true });
mkdirSync(join(dir, "projects"), { recursive: true });
const share = join(work, "share");
mkdirSync(share);
const port = 9371;
const appEnv = {
  ...process.env,
  BIFORGE_TEST_DEBUG_PORT: String(port),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview"),
  BIFORGE_APP_DIR: join(dir, "app"),
  BIFORGE_ALLOW_MULTIPLE: "1",
  BIFORGE_TEST_PICKS: join(dir, "projects"),
};

// the BIForge tasks that exist before the test, so only the ones it made are removed
const biforgeTasks = () => {
  const r = spawnSync("schtasks.exe", ["/Query", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return new Set((r.stdout ?? "").split(/\r?\n/).map((l) => l.split('","')[0]?.replace(/^"/, "")).filter((n) => n && n.startsWith("\\BIForge\\")));
};
const tasksBefore = biforgeTasks();

const child = spawn(exe, [], { env: appEnv, stdio: ["ignore", openSync(join(work, "out.log"), "w"), openSync(join(work, "err.log"), "w")] });
const pid = child.pid; // the only process this script ever stops
let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!browser) throw new Error("could not attach to the app window");
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts()[0]?.pages()[0];
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  page.setDefaultTimeout(30000);
  await page.waitForSelector("text=Recent");

  // ---- the project
  await page.getByRole("button", { name: /Learn with sample data/ }).click();
  const newDlg = page.getByRole("dialog");
  await newDlg.getByLabel("Project name").fill("Refresh Sample");
  await newDlg.getByRole("button", { name: "Browse…" }).click();
  await newDlg.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: /Publish & Share/ }).first().waitFor();
  await page.waitForSelector("[data-testid=card-value]", { timeout: 60000 });
  const root = join(dir, "projects", "Refresh Sample");
  const salesCsv = join(root, "data", "Sales.csv");
  check(readFileSync(salesCsv, "utf8").length > 100, "the sample project has its source files next to it");

  // ---- part 1: this PC
  await page.getByRole("button", { name: /Publish & Share/ }).first().click();
  const dlg = page.getByRole("dialog", { name: "Publish and Share" });
  await dlg.getByRole("combobox", { name: "Destination type" }).click();
  await page.getByRole("option", { name: /Folder on this PC/ }).click();
  await dlg.getByLabel("Destination name").fill("Refresh share");
  await dlg.getByLabel("Folder").fill(share);
  await dlg.getByRole("button", { name: "Add destination" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await dlg.getByRole("checkbox", { name: /I have checked this list/ }).check();
  await dlg.getByLabel("Publisher name").fill("Refresher");
  await dlg.getByRole("button", { name: "Publish", exact: true }).click();
  await dlg.getByRole("status").filter({ hasText: /Published version/ }).waitFor();

  const sec = dlg.getByRole("region", { name: "Refresh on this PC" });
  await sec.waitFor();
  check(/Where it runs: This PC \(Windows Task Scheduler\)/.test(await sec.innerText()), "the refresh section says where it runs: this PC, Windows Task Scheduler");
  check(/must be on and you must be signed in/.test(await sec.innerText()), "and what must stay on");
  await sec.getByRole("button", { name: "Turn on scheduled refresh on this PC" }).click();
  await sec.getByText(/Scheduled refresh on this PC is on \(daily at 03:00 local time, 2 retries\)/).waitFor();
  const created = [...biforgeTasks()].filter((t) => !tasksBefore.has(t));
  check(created.length === 1, `a task was registered with Windows Task Scheduler (${created.join(", ")})`);
  check(/Task Scheduler: (Ready|Running)/.test(await sec.innerText()), "the dialog shows the task's state from Task Scheduler");

  appendFileSync(salesCsv, readFileSync(salesCsv, "utf8").trim().split(/\r?\n/).pop() + "\n");
  await sec.getByRole("button", { name: "Refresh now on this PC" }).click();
  try { await sec.getByText(/published version 2/).waitFor({ timeout: 90000 }); } catch (e) { console.log("SECTION", await sec.innerText()); throw e; }
  let hist = await sec.getByRole("list", { name: "Refresh history" }).innerText();
  check(/New data/.test(hist) && /ran on: This PC \(Windows Task Scheduler\)/.test(hist), "the history shows the run, where it ran, and the new version");
  await sec.getByRole("button", { name: "Refresh now on this PC" }).click();
  await sec.getByText(/No change/).first().waitFor({ timeout: 120000 });
  check(true, "a second run with the same data publishes nothing");

  // the way Task Scheduler runs it: the app started without a window
  appendFileSync(salesCsv, readFileSync(salesCsv, "utf8").trim().split(/\r?\n/).pop() + "\n");
  const targets = JSON.parse(readFileSync(join(root, ".biforge", "publish", "targets.json"), "utf8"));
  const targetId = (Array.isArray(targets) ? targets : (targets.targets ?? Object.values(targets)))[0].id;
  const headless = spawnSync(exe, ["--run-scheduled", root, targetId], { env: { ...appEnv, BIFORGE_TEST_DEBUG_PORT: "" }, encoding: "utf8", timeout: 180000 });
  check(headless.status === 0, `the app started like Task Scheduler does it, without a window, finished with exit code ${headless.status}`);
  await dlg.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /Publish & Share/ }).first().click();
  const sec2 = page.getByRole("dialog", { name: "Publish and Share" }).getByRole("region", { name: "Refresh on this PC" });
  await page.waitForFunction(() => /published version 3/.test(document.querySelector("[aria-label=\"Refresh history\"]")?.textContent ?? ""), null, { timeout: 60000 });
  hist = await sec2.getByRole("list", { name: "Refresh history" }).innerText();
  if (!(/scheduled/.test(hist) && /published version 3/.test(hist))) console.log("HISTORY", hist);
  check(/scheduled/.test(hist) && /published version 3/.test(hist), "the scheduled run is in the history, with the version it published");

  await sec2.getByRole("button", { name: "Turn off on this PC" }).click();
  await sec2.getByRole("button", { name: "Turn on scheduled refresh on this PC" }).waitFor();
  check([...biforgeTasks()].filter((t) => !tasksBefore.has(t)).length === 0, "turning it off removes the task from Task Scheduler");
  await page.getByRole("dialog", { name: "Publish and Share" }).getByRole("button", { name: "Close", exact: true }).click();

  // ---- part 2: a server
  await page.getByRole("button", { name: "Host and collaborate" }).first().click();
  const hostDlg = page.getByRole("dialog", { name: "Host and collaborate" });
  await hostDlg.getByRole("button", { name: "Turn on Host from this PC" }).click();
  await hostDlg.getByRole("status").filter({ hasText: /Hosting is on at/ }).waitFor();
  await hostDlg.getByLabel("New workspace name").fill("Team");
  await hostDlg.getByRole("button", { name: "Create workspace" }).click();
  await hostDlg.getByRole("tab", { name: "Team" }).waitFor();
  await hostDlg.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: /Publish & Share/ }).first().click();
  const pub = page.getByRole("dialog", { name: "Publish and Share" });
  await pub.getByRole("button", { name: "Add a destination" }).click();
  await pub.getByRole("combobox", { name: "Destination type" }).click();
  await page.getByRole("option", { name: /Host from this PC/ }).click();
  await pub.getByLabel("Destination name").fill("My server");
  await pub.getByLabel("Report id on the server").fill("sales");
  await pub.getByRole("button", { name: "Add destination" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await pub.getByRole("checkbox", { name: /I have checked this list/ }).check();
  await pub.getByLabel("Publisher name").fill("Refresher");
  await pub.getByRole("button", { name: "Publish", exact: true }).click();
  await pub.getByRole("status").filter({ hasText: /Published version/ }).waitFor({ timeout: 120000 });

  const chooser = pub.getByRole("radiogroup", { name: "Where the refresh runs" });
  await chooser.getByRole("radio", { name: /BIForge server/ }).check();
  const ssec = pub.getByRole("region", { name: "Refresh on the server" });
  check(/Where it runs: BIForge server \(the server computer\)/.test(await ssec.innerText()) && /server must stay on/.test(await ssec.innerText()), "the server panel says where it runs and what must stay on");
  await ssec.getByRole("checkbox", { name: /these whole files are stored on the server/ }).check();
  await ssec.getByRole("button", { name: "Turn on scheduled refresh on the server" }).click();
  await ssec.getByText(/Scheduled refresh on the server is on \(daily at 03:00 UTC, 2 retries\)/).waitFor({ timeout: 60000 });
  check(true, "the refresh bundle reached the server and the schedule is on");
  const folderText = await ssec.getByText(/Source folder on the server:/).innerText();
  const srcFolder = /Source folder on the server: (.*?)( \(|$)/.exec(folderText)?.[1];
  check(!!srcFolder && /refresh[\\/]sources/.test(srcFolder), `the server names its source folder (${srcFolder})`);
  mkdirSync(srcFolder, { recursive: true });
  const changed = join(srcFolder, "Sales.csv");
  copyFileSync(salesCsv, changed);
  appendFileSync(changed, readFileSync(changed, "utf8").trim().split(/\r?\n/).pop() + "\n");
  await ssec.getByRole("button", { name: "Refresh now on the server" }).click();
  await ssec.getByText(/Reloaded \d+ tables; the report now answers with the new data/).waitFor({ timeout: 120000 });
  hist = await ssec.getByRole("list", { name: "Refresh history" }).innerText();
  check(/New data/.test(hist) && /ran on: BIForge server \(the server computer\)/.test(hist), "the server's history shows the run and that it ran on the server");
  await ssec.getByRole("button", { name: "Turn off on the server" }).click();
  await ssec.getByRole("button", { name: "Turn on scheduled refresh on the server" }).waitFor();
  check(true, "turning it off removes the bundle from the server");
} catch (e) {
  failures++;
  console.log("ERROR", e);
} finally {
  // remove any task this run left behind (only the ones that did not exist before)
  for (const t of [...biforgeTasks()].filter((x) => !tasksBefore.has(x))) {
    try { execFileSync("schtasks.exe", ["/Delete", "/TN", t.replace(/^\\/, ""), "/F"]); console.log("removed leftover task", t); } catch {}
  }
  try { process.kill(pid); } catch {}
}
console.log("work dir", work);
process.exit(failures ? 1 : 0);
