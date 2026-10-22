// Real-window test of O5 (Host from this PC): TWO BIForge instances on this machine, each with its own data folder.
// Instance A (host) turns hosting on, makes a workspace, publishes the sample report with two data roles, invites two
// guests. Instances B and C (guests) join with the invitation links and open the report: they must see different rows.
// Run: npm run e2e   (needs `npx tauri build --debug --no-bundle` first)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-o5-"));
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

async function joinAs(page, link, name) {
  await page.getByRole("button", { name: "Join a server" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Join a server" });
  await dlg.getByLabel("Invitation link or server address").fill(link);
  await dlg.getByLabel("Your name").fill(name);
  await dlg.getByRole("button", { name: "Join", exact: true }).click();
  await dlg.waitFor({ state: "detached" });
}

async function viewAs(page) {
  await page.getByRole("button", { name: "Host and collaborate" }).first().click();
  const host = page.getByRole("dialog", { name: "Host and collaborate" });
  await host.getByRole("button", { name: "Open for viewing" }).click();
  const bar = page.locator(".viewing-bar");
  await bar.waitFor();
  await page.waitForSelector("[data-testid=card-value]", { timeout: 60000 });
  await page.waitForTimeout(1500);
  const cards = await page.locator("[data-testid=card-value]").allInnerTexts();
  const text = await page.locator("body").innerText();
  return { bar: await bar.innerText(), cards, text };
}

try {
  // ---- the host ----
  const A = await launch("host", 9341);
  const a = A.page;
  await a.getByRole("button", { name: /Learn with sample data/ }).click();
  const newDlg = a.getByRole("dialog");
  await newDlg.getByLabel("Project name").fill("Host Sample");
  await newDlg.getByRole("button", { name: "Browse…" }).click();
  await newDlg.getByRole("button", { name: "Create" }).click();
  await a.getByRole("button", { name: "Host and collaborate" }).first().waitFor();
  await a.waitForSelector("[data-testid=card-value]", { timeout: 60000 });
  const hostCards = await a.locator("[data-testid=card-value]").allInnerTexts();

  await a.getByRole("button", { name: "Host and collaborate" }).first().click();
  const hostDlg = a.getByRole("dialog", { name: "Host and collaborate" });
  await hostDlg.getByRole("button", { name: "Turn on Host from this PC" }).click();
  const status = hostDlg.getByRole("status").filter({ hasText: /Hosting is on at/ });
  await status.waitFor();
  const serverUrl = /(https:\/\/127\.0\.0\.1:\d+)/.exec(await status.innerText())?.[1];
  check(!!serverUrl, `hosting is on (${serverUrl})`);
  await hostDlg.getByLabel("New workspace name").fill("Team");
  await hostDlg.getByRole("button", { name: "Create workspace" }).click();
  await hostDlg.getByRole("tab", { name: "Team" }).waitFor();
  check(true, "the host created the workspace Team");
  await hostDlg.getByRole("button", { name: "Close", exact: true }).click();

  // publish the report to the server (signed package, not encrypted; the server reads the data)
  await a.getByRole("button", { name: /Publish & Share/ }).first().click();
  const pub = a.getByRole("dialog", { name: "Publish and Share" });
  await pub.getByRole("combobox", { name: "Destination type" }).click();
  await a.getByRole("option", { name: /Host from this PC/ }).click();
  await pub.getByLabel("Destination name").fill("My PC");
  await pub.getByLabel("Report id on the server").fill("sales");
  await pub.getByRole("button", { name: "Add destination" }).click();
  await a.getByRole("button", { name: "Continue", exact: true }).click(); // the setup guide pop-up
  await pub.getByRole("checkbox", { name: /I have checked this list/ }).check();
  await pub.getByLabel("Publisher name").fill("Host");
  await pub.getByRole("button", { name: "Publish", exact: true }).click();
  await pub.getByRole("status").filter({ hasText: /Published version/ }).waitFor({ timeout: 120000 });
  check(true, "the report was published to Host from this PC");
  await pub.getByRole("button", { name: "Close", exact: true }).click();

  // data roles: ann sees the Nordic customers, everybody else the Iberia customers
  await a.getByRole("button", { name: "Host and collaborate" }).first().click();
  await hostDlg.getByRole("button", { name: "Data roles" }).click();
  await hostDlg.getByLabel("Data roles", { exact: true }).fill(
    'Mine\n  Customer: IF(USERPRINCIPALNAME() = "ann@x.com", [Region] = "Nordic", [Region] = "Iberia")',
  );
  await hostDlg.getByRole("button", { name: "Save data roles" }).click();
  await hostDlg.getByText(/has data roles/).waitFor();
  check(true, "the data role was accepted by the server");
  await hostDlg.getByRole("button", { name: "Versions" }).first().click();
  await hostDlg.getByRole("region", { name: "Version history" }).getByText(/\(current\)/).waitFor();
  check(true, "the version history lists the current version");
  check(/Encrypted with TLS/.test(await hostDlg.innerText()), "the host says it is encrypted with TLS and shows the fingerprint");

  let lastLink = "";
  const invite = async (identity) => {
    await hostDlg.getByLabel("Invite identity").fill(identity);
    await hostDlg.getByRole("group", { name: "Data roles for the invitation" }).getByRole("checkbox", { name: "Data role Mine" }).check();
    await hostDlg.getByRole("button", { name: "Create invitation link" }).click();
    const box = hostDlg.getByRole("status", { name: "Invitation" });
    await box.getByLabel("Invitation link").waitFor();
    await a.waitForFunction((prev) => { const el = document.querySelector("[aria-label=\"Invitation link\"]"); const v = el?.value ?? el?.querySelector?.("input")?.value ?? ""; return v && v !== prev; }, lastLink);
    lastLink = await box.getByLabel("Invitation link").inputValue();
    return lastLink;
  };
  // the role checkbox list comes from the roles the report defines: reopen the dialog state so it lists "Mine"
  const annLink = await invite("ann@x.com");
  const bobLink = await invite("bob@x.com");
  check(annLink.startsWith("biforge://open?src=server") && !annLink.includes("bfa_"), "invitation links are biforge:// links without the admin token");
  check(annLink.includes("https%3A%2F%2F") && /&pin=[0-9a-f]{64}/.test(annLink), "the links are https links that carry the certificate fingerprint");

  // ---- the guests (two more instances with their own data) ----
  const B = await launch("ann", 9342);
  await joinAs(B.page, annLink, "Ann");
  const annView = await (async () => { const r = await viewAs(B.page); return r; })();
  check(/ann@x\.com/.test(annView.bar) && /Read only/.test(annView.bar), "Ann's viewing bar shows her identity and read-only");

  const C = await launch("bob", 9343);
  await joinAs(C.page, bobLink, "Bob");
  const bobView = await viewAs(C.page);
  check(/bob@x\.com/.test(bobView.bar), "Bob's viewing bar shows his identity");

  check(annView.cards.join("|") !== bobView.cards.join("|"), `two guests see different numbers (Ann ${annView.cards.join(",")} | Bob ${bobView.cards.join(",")})`);
  check(annView.cards.join("|") !== hostCards.join("|") && bobView.cards.join("|") !== hostCards.join("|"), `both differ from the host's unrestricted numbers (${hostCards.join(",")})`);
  check(/Nordic/.test(annView.text) && !/Iberia/.test(annView.text), "Ann's slicer lists Nordic and no other region");
  check(/Iberia/.test(bobView.text) && !/Nordic/.test(bobView.text), "Bob's slicer lists Iberia and no other region");

  // revoke Bob on the host; his next refresh fails
  await hostDlg.getByRole("tab", { name: "Team" }).click(); // reloads members
  await hostDlg.getByRole("row", { name: /Bob/ }).getByRole("button", { name: "Remove" }).click();
  await hostDlg.getByText("removed").waitFor();
  await C.page.getByRole("button", { name: "Refresh visuals" }).click();
  await C.page.waitForTimeout(2000);
  const bobAfter = await C.page.locator("body").innerText();
  check(/revoked|not valid|401|Error|error/i.test(bobAfter) || (await C.page.locator("[data-testid=card-value]").count()) === 0, "after Bob was removed, his viewer can no longer load data");
  await hostDlg.getByText(/Activity log/).click();
  await hostDlg.getByText(/ join /).first().waitFor();
  check((await hostDlg.getByText(/ revoke /).count()) > 0, "the host activity log shows the joins and the revocation");
} catch (e) {
  failures++;
  console.log("ERROR", e);
} finally {
  for (const pid of started) { try { process.kill(pid); } catch {} }
}
console.log("work dir", work);
process.exit(failures ? 1 : 0);
