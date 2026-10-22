// Real-window test of O6 (collaboration): TWO BIForge instances with their own data folders.
//  Part 1, over a server: the host publishes the sample report, an editor joins by invitation, both open the report for
//  editing together; a page one of them adds appears in the other window; comments with a mention are shared.
//  Part 2, over a direct session: the host accepts a guest with the edit role; both edit together and comment.
// Run: npm run e2e   (needs `npx tauri build --debug --no-bundle` first)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-o6-"));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };

const started = [];
async function launch(name, port, extraEnv = {}) {
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
      ...extraEnv,
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

async function sampleProject(page, name) {
  await page.getByRole("button", { name: /Learn with sample data/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Project name").fill(name);
  await dlg.getByRole("button", { name: "Browse…" }).click();
  await dlg.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Host and collaborate" }).first().waitFor();
  await page.waitForSelector("[data-testid=card-value]", { timeout: 60000 });
}

const pagesOf = async (page) => {
  const t = await page.getByTestId("status-text").innerText();
  const m = /Page (\d+) of (\d+)/.exec(t);
  return m ? Number(m[2]) : -1;
};

async function openComments(page) {
  await page.getByRole("tab", { name: "Home" }).click();
  await page.getByRole("button", { name: "Comments", exact: true }).first().click();
  const d = page.getByRole("dialog", { name: "Comments" });
  await d.waitFor();
  return d;
}

try {
  // ============================================================ part 1: a server
  const A = await launch("host", 9361);
  const a = A.page;
  await sampleProject(a, "Together Sample");
  await a.getByRole("button", { name: "Host and collaborate" }).first().click();
  const hostDlg = a.getByRole("dialog", { name: "Host and collaborate" });
  await hostDlg.getByRole("button", { name: "Turn on Host from this PC" }).click();
  await hostDlg.getByRole("status").filter({ hasText: /Hosting is on at/ }).waitFor();
  await hostDlg.getByLabel("New workspace name").fill("Team");
  await hostDlg.getByRole("button", { name: "Create workspace" }).click();
  await hostDlg.getByRole("tab", { name: "Team" }).waitFor();
  await hostDlg.getByRole("button", { name: "Close", exact: true }).click();

  await a.getByRole("button", { name: /Publish & Share/ }).first().click();
  const pub = a.getByRole("dialog", { name: "Publish and Share" });
  await pub.getByRole("combobox", { name: "Destination type" }).click();
  await a.getByRole("option", { name: /Host from this PC/ }).click();
  await pub.getByLabel("Destination name").fill("My PC");
  await pub.getByLabel("Report id on the server").fill("sales");
  await pub.getByRole("button", { name: "Add destination" }).click();
  await a.getByRole("button", { name: "Continue", exact: true }).click();
  await pub.getByRole("checkbox", { name: /I have checked this list/ }).check();
  await pub.getByLabel("Publisher name").fill("Host");
  await pub.getByRole("button", { name: "Publish", exact: true }).click();
  await pub.getByRole("status").filter({ hasText: /Published version/ }).waitFor({ timeout: 120000 });
  await pub.getByRole("button", { name: "Close", exact: true }).click();
  check(true, "the host published the report to its server");

  // an editor is invited
  await a.getByRole("button", { name: "Host and collaborate" }).first().click();
  await hostDlg.getByLabel("Invite identity").fill("eddie@x.com");
  await hostDlg.getByRole("combobox", { name: "Invite role" }).click();
  await a.getByRole("option", { name: "editor", exact: true }).click();
  await hostDlg.getByRole("button", { name: "Create invitation link" }).click();
  const link = await hostDlg.getByRole("status", { name: "Invitation" }).getByLabel("Invitation link").inputValue();
  check(/pin=[0-9a-f]{64}/.test(link), "the editor's invitation is an https link with the certificate pin");

  const B = await launch("editor", 9362);
  const b = B.page;
  await b.getByRole("button", { name: "Join a server" }).first().click();
  const join = b.getByRole("dialog", { name: "Join a server" });
  await join.getByLabel("Invitation link or server address").fill(link);
  await join.getByLabel("Your name").fill("Eddie");
  await join.getByRole("button", { name: "Join", exact: true }).click();
  await join.waitFor({ state: "detached" });

  // both open the server's report for editing together
  await b.getByRole("button", { name: "Host and collaborate" }).first().click();
  const bDlg = b.getByRole("dialog", { name: "Host and collaborate" });
  await bDlg.getByRole("button", { name: "Edit together" }).click();
  await b.getByRole("button", { name: "Comments", exact: true }).first().waitFor({ timeout: 60000 });
  await b.getByTestId("status-text").filter({ hasText: /Editing together/ }).waitFor({ timeout: 60000 });
  check(true, "the editor's window is editing together");
  try { await b.waitForSelector("[data-testid=card-value]", { timeout: 30000 }); } catch (e) { console.log("BODY", (await b.locator("body").innerText()).slice(0, 1500)); throw e; } // queries go to the server, which holds the data

  await hostDlg.getByRole("button", { name: "Edit together" }).click();
  await a.getByTestId("status-text").filter({ hasText: /Editing together/ }).waitFor({ timeout: 60000 });
  check(true, "the host's window is editing together");

  // the host adds a page; it appears in the editor's window by itself
  const before = await pagesOf(b);
  await a.getByRole("tab", { name: "Insert" }).click();
  await a.getByTestId("ribbon").getByRole("button", { name: "New page" }).click();
  await b.waitForFunction((n) => /Page \d+ of (\d+)/.test(document.querySelector("[data-testid=status-text]")?.textContent ?? "") && Number(/of (\d+)/.exec(document.querySelector("[data-testid=status-text]").textContent)[1]) > n, before, { timeout: 30000 });
  check((await pagesOf(b)) === before + 1, `a page the host added appears in the editor's window (${before} -> ${await pagesOf(b)})`);
  // the editor adds one too; it arrives in the host's window
  await b.getByRole("tab", { name: "Insert" }).click();
  await b.getByTestId("ribbon").getByRole("button", { name: "New page" }).click();
  await a.waitForFunction((n) => Number(/of (\d+)/.exec(document.querySelector("[data-testid=status-text]")?.textContent ?? "of 0")[1]) > n, before + 1, { timeout: 30000 });
  check((await pagesOf(a)) === before + 2, "a page the editor added appears in the host's window");

  // comments with a mention, shared through the server: the host writes, the editor is told he is mentioned
  const ac = await openComments(a);
  await ac.getByLabel("New comment").fill("Please check the new pages @eddie");
  await ac.getByRole("button", { name: "Add comment" }).click();
  await ac.getByRole("list", { name: "Comment threads" }).getByText(/Please check the new pages/).waitFor();
  check(/server admin/.test(await ac.getByRole("list", { name: "Comment threads" }).innerText()), "the server stamps the author (the administrator), not a name from the request");
  check((await ac.getByRole("list", { name: "Recent changes" }).innerText()).length > 0, "the dialog lists the changes made together");
  await ac.getByRole("button", { name: "Close", exact: true }).click();
  const bc = await openComments(b);
  await bc.getByRole("list", { name: "Comment threads" }).getByText(/Please check the new pages/).waitFor();
  await bc.getByText(/You are mentioned in 1 open comment/).waitFor();
  check(true, "the editor sees the host's comment and is told that he is mentioned");
  await bc.getByRole("button", { name: "Reply" }).first().click();
  await bc.getByLabel(/Reply to/).fill("Done");
  await bc.getByRole("button", { name: "Send" }).click();
  await bc.getByRole("list", { name: "Comment threads" }).getByText("Done").waitFor();
  await bc.getByRole("button", { name: "Resolve" }).first().click();
  await bc.getByText(/resolved/).first().waitFor();
  await bc.getByText(/You are mentioned/).waitFor({ state: "detached" });
  check(true, "the editor replied and resolved the thread; the mention is gone from his list");
  await bc.getByRole("button", { name: "Close", exact: true }).click();

  // stopping ends the exchange
  await a.getByRole("button", { name: "Stop editing together" }).first().click();
  await a.getByTestId("status-text").filter({ hasText: /Stopped editing together/ }).waitFor();
  check(true, "the host stopped editing together");
  B.browser.close().catch(() => {});

  // ============================================================ part 2: a direct session
  const P = { BIFORGE_P2P_LOCAL: "1" };
  const C = await launch("p2p-host", 9363, P);
  const c = C.page;
  await sampleProject(c, "Direct Together");
  await c.getByRole("button", { name: /Publish & Share/ }).first().click();
  const cpub = c.getByRole("dialog", { name: "Publish and Share" });
  await cpub.getByRole("combobox", { name: "Destination type" }).click();
  await c.getByRole("option", { name: /Direct connection/ }).click();
  await cpub.getByLabel("Destination name").fill("Direct");
  await cpub.getByRole("button", { name: "Add destination" }).click();
  await c.getByRole("button", { name: "Start session", exact: true }).click();
  await cpub.getByRole("checkbox", { name: /I have checked this list/ }).check();
  await cpub.getByLabel("Publisher name").fill("Host");
  await cpub.getByRole("button", { name: "Publish", exact: true }).click();
  const panel = cpub.getByRole("group", { name: "Direct session" });
  await panel.waitFor({ timeout: 60000 });
  await panel.getByText("Long code").click();
  const code = await panel.getByLabel("Long pairing code").inputValue();

  const D = await launch("p2p-guest", 9364, P);
  const d = D.page;
  await d.getByRole("button", { name: "Join a server" }).first().click();
  const dj = d.getByRole("dialog", { name: "Join a server" });
  await dj.getByLabel("Invitation link or server address").fill(code);
  await dj.getByLabel("Your name").fill("Gina");
  await dj.getByRole("button", { name: "Join", exact: true }).click();
  const req = panel.getByRole("region", { name: "Join requests" });
  await req.getByText(/Gina/).waitFor({ timeout: 30000 });
  await req.getByRole("button", { name: "Accept with edit role" }).click();
  // an edit-role guest edits together: no viewing bar, the status line says so
  await d.getByTestId("status-text").filter({ hasText: /Editing together/ }).waitFor({ timeout: 60000 });
  check((await d.locator(".viewing-bar").count()) === 0, "the guest with the edit role gets an editable report, not the viewing mode");
  await d.waitForSelector("[data-testid=card-value]", { timeout: 60000 });

  await panel.getByRole("button", { name: /Edit together with the guests/ }).click();
  await c.getByRole("button", { name: "Close", exact: true }).first().click().catch(() => {});
  await c.getByTestId("status-text").filter({ hasText: /Editing together/ }).waitFor({ timeout: 30000 });
  check(true, "the host's window is editing together with the guest");
  const n0 = await pagesOf(d);
  await c.getByRole("tab", { name: "Insert" }).click();
  await c.getByTestId("ribbon").getByRole("button", { name: "New page" }).click();
  await d.waitForFunction((n) => Number(/of (\d+)/.exec(document.querySelector("[data-testid=status-text]")?.textContent ?? "of 0")[1]) > n, n0, { timeout: 30000 });
  check((await pagesOf(d)) === n0 + 1, "a page the host added appears in the guest's window over the direct session");
  await d.getByRole("tab", { name: "Insert" }).click();
  await d.getByTestId("ribbon").getByRole("button", { name: "New page" }).click();
  await c.waitForFunction((n) => Number(/of (\d+)/.exec(document.querySelector("[data-testid=status-text]")?.textContent ?? "of 0")[1]) > n, n0 + 1, { timeout: 30000 });
  check((await pagesOf(c)) === n0 + 2, "a page the guest added appears in the host's window");

  const dc = await openComments(d);
  await dc.getByLabel("New comment").fill("Hello from Gina");
  await dc.getByRole("button", { name: "Add comment" }).click();
  await dc.getByRole("list", { name: "Comment threads" }).getByText(/Hello from Gina/).waitFor();
  await dc.getByRole("button", { name: "Close", exact: true }).click();
  const cc = await openComments(c);
  await cc.getByRole("list", { name: "Comment threads" }).getByText(/Hello from Gina/).waitFor();
  check(true, "the host sees the guest's comment, stamped with the guest's name");
  check(/Gina/.test(await cc.getByRole("list", { name: "Comment threads" }).innerText()), "the author is the name the host knows");
} catch (e) {
  failures++;
  console.log("ERROR", e);
} finally {
  for (const pid of started) { try { process.kill(pid); } catch {} }
}
console.log("work dir", work);
process.exit(failures ? 1 : 0);
