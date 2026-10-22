// Real-window test of O4 (direct sharing, iroh): TWO BIForge instances on this machine, each with its own data folder.
// The host publishes the sample report to a direct session and gets a pairing code; the guest joins with it, waits,
// the host accepts read-only, the report opens in the guest's window, a second version arrives live, and ending the
// guest's access is shown in the guest's window. BIFORGE_P2P_LOCAL=1 makes both sides use direct addresses only
// (no relay servers, no internet needed): the long code carries the host's addresses.
// Run: npm run e2e   (needs `npx tauri build --debug --no-bundle` first)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-o4-"));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };

const started = [];
async function launch(name, port) {
  const dir = join(work, name);
  mkdirSync(join(dir, "app"), { recursive: true });
  mkdirSync(join(dir, "projects"), { recursive: true });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      BIFORGE_TEST_DEBUG_PORT: String(port),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview"),
      BIFORGE_APP_DIR: join(dir, "app"),
      BIFORGE_ALLOW_MULTIPLE: "1",
      BIFORGE_TEST_PICKS: join(dir, "projects"),
      BIFORGE_P2P_LOCAL: "1",
    },
    stdio: ["ignore", openSync(join(dir, "out.log"), "w"), openSync(join(dir, "err.log"), "w")],
  });
  started.push(child.pid); // the only processes this script ever stops
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!browser) throw new Error(`could not attach to instance ${name}`);
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts()[0]?.pages()[0];
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  page.setDefaultTimeout(30000);
  await page.waitForSelector("text=Recent");
  return { page, browser, pid: child.pid };
}

try {
  // ---- the host ----
  const A = await launch("host", 9351);
  const a = A.page;
  await a.getByRole("button", { name: /Learn with sample data/ }).click();
  const newDlg = a.getByRole("dialog");
  await newDlg.getByLabel("Project name").fill("Direct Sample");
  await newDlg.getByRole("button", { name: "Browse…" }).click();
  await newDlg.getByRole("button", { name: "Create" }).click();
  await a.getByRole("button", { name: /Publish & Share/ }).first().waitFor();
  await a.waitForSelector("[data-testid=card-value]", { timeout: 60000 });

  await a.getByRole("button", { name: /Publish & Share/ }).first().click();
  const pub = a.getByRole("dialog", { name: "Publish and Share" });
  await pub.getByRole("combobox", { name: "Destination type" }).click();
  await a.getByRole("option", { name: /Direct connection/ }).click();
  await pub.getByLabel("Destination name").fill("Direct");
  await pub.getByRole("button", { name: "Add destination" }).click();
  await a.getByRole("button", { name: "Start session", exact: true }).click(); // the setup guide pop-up
  await pub.getByRole("checkbox", { name: /I have checked this list/ }).check();
  await pub.getByLabel("Publisher name").fill("Host");
  await pub.getByRole("button", { name: "Publish", exact: true }).click();
  const panel = pub.getByRole("group", { name: "Direct session" });
  await panel.waitFor({ timeout: 60000 });
  await panel.getByText("Long code").click();
  const code = await panel.getByLabel("Long pairing code").inputValue();
  check(/^BF1T-/.test(code) && !/AGE-SECRET/.test(code), "the host gets a pairing code (long form, with the host's addresses)");

  // ---- the guest ----
  const B = await launch("guest", 9352);
  const b = B.page;
  await b.getByRole("button", { name: "Join a server" }).first().click();
  const join = b.getByRole("dialog", { name: "Join a server" });
  await join.getByLabel("Invitation link or server address").fill(code);
  await join.getByLabel("Your name").fill("Gina");
  await join.getByRole("button", { name: "Join", exact: true }).click();
  await join.getByText(/Waiting for the host to approve/).waitFor();
  check(true, "the guest connects and waits: nothing is shared before the host approves");
  check((await b.locator("[data-testid=card-value]").count()) === 0, "the guest sees no report yet");

  // the host sees the request and accepts it read-only
  const req = panel.getByRole("region", { name: "Join requests" });
  await req.getByText(/Gina/).waitFor({ timeout: 30000 });
  check(true, "the host sees Gina's request with her name");
  await req.getByRole("button", { name: "Accept read-only" }).click();

  const bar = b.locator(".viewing-bar");
  await bar.waitFor({ timeout: 60000 });
  await b.waitForSelector("[data-testid=card-value]", { timeout: 60000 });
  const first = await bar.innerText();
  check(/direct session/.test(first) && /read only/.test(first) && /version 1/.test(first), "the report opens in the guest's window in viewing mode over the direct session");
  const cards1 = await b.locator("[data-testid=card-value]").allInnerTexts();
  check(cards1.length > 0, `the guest's visuals show data (${cards1.join(",")})`);

  // a second version arrives live
  await pub.getByRole("button", { name: "Publish update" }).waitFor();
  await pub.getByRole("button", { name: "Publish update" }).click();
  await b.waitForFunction(() => /version 2/.test(document.querySelector(".viewing-bar")?.textContent ?? ""), null, { timeout: 60000 });
  check(true, "the second version the host published arrived in the guest's window by itself");

  // the host ends the guest's access
  await panel.getByRole("region", { name: "Guests" }).getByRole("button", { name: "End access" }).click();
  await b.getByText(/The direct session ended/).first().waitFor({ timeout: 30000 });
  check(true, "ending the guest's access is shown in the guest's window");
  await panel.getByText(/access ended/).waitFor();
  check(true, "the host's list shows the access as ended");
} catch (e) {
  failures++;
  console.log("ERROR", e);
} finally {
  for (const pid of started) { try { process.kill(pid); } catch {} }
}
console.log("work dir", work);
process.exit(failures ? 1 : 0);
