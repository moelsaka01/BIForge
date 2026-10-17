// Real-window test of the O1 and O2 flows: drives the built Tauri app (WebView2) over the DevTools protocol.
// Run: npm run e2e   (needs `npx tauri build --debug --no-bundle` first; see docs/PROGRESS.md)
//
// With BIFORGE_TEST_GITHUB_TOKEN set (a token of the account that owns the test repository; the debug build of the app
// reads it as its GitHub token, nothing is typed anywhere) the test also publishes the report to GitHub Pages in a
// dedicated repository, opens it again from the share link, and stops sharing. Without the token those steps are
// skipped and reported as skipped.
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-"));
const parent = join(work, "projects");
const share = join(work, "share");
const ghToken = process.env.BIFORGE_TEST_GITHUB_TOKEN ?? "";
const ghRepo = `biforge-e2e-${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ghApi = (path, init = {}) => fetch(`https://api.github.com${path}`, { ...init, headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "User-Agent": "biforge-e2e", ...(init.headers ?? {}) } });
let ghLink = null, ghKey = null, ghLogin = null;
const port = 9333;
mkdirSync(parent); mkdirSync(share);

let failures = 0;
const hiddenRoots = (page) => page.evaluate(() => document.getElementById("root").getAttribute("aria-hidden"));
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };

const child = spawn(exe, [], {
  env: {
    ...process.env,
    BIFORGE_TEST_DEBUG_PORT: String(port), // the app opens its windows with this DevTools port (inert when unset)
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"),
    BIFORGE_TEST_PICKS: [parent].join("|"),
  },
  stdio: ["ignore", openSync(join(work, "app.out.log"), "w"), openSync(join(work, "app.err.log"), "w")],
});
let exited = null;
child.on("exit", (code, sig) => { exited = `exit code ${code} signal ${sig}`; });
child.on("error", (e) => { exited = `spawn error ${e}`; });
const pid = child.pid; // the only process this script ever stops
let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!browser) {
    const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8", timeout: 20000 }).slice(0, 3000); } catch (e) { return `(failed: ${e.message.slice(0, 200)})`; } };
    console.log("--- WebView2 runtime\n" + sh('reg query "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv'));
    console.log("--- processes\n" + sh('powershell -NoProfile -Command "Get-Process | Where-Object { $_.Name -match \'biforge|webview|msedge\' } | Select-Object Id,Name,MainWindowTitle | Format-Table | Out-String"'));
    console.log("--- webview command lines\n" + sh(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedgewebview2.exe'\\" | Select-Object -First 2 -ExpandProperty CommandLine"`));
    console.log("--- listening\n" + sh('powershell -NoProfile -Command "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 9000 -and $_.LocalPort -le 9999 } | Format-Table | Out-String"'));
  }
  if (!browser) throw new Error(`could not attach to the app window (exe ${exe} exists: ${existsSync(exe)}; ${exited ?? "process still running"})`);
  // the window's page may appear a moment after the debugging port answers (slower machines)
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts()[0]?.pages()[0];
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error("the app window has no page to drive");
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

  // 1a. Get data connectors in the real window: Web (local HTTP server), XML file, Access through ODBC (when the driver exists),
  // MySQL (when BIFORGE_TEST_MYSQL names a server). Every import goes through the Import data dialog and the Rust engine.
  const importDlg = page.getByRole("dialog", { name: "Import data" });
  const openImport = async (sourceLabel) => {
    await page.getByRole("button", { name: "Excel workbook", exact: true }).first().click();
    await importDlg.waitFor();
    await importDlg.getByLabel("Source type").selectOption({ label: sourceLabel });
  };
  const hasTable = async (name) => { try { await page.getByRole("treeitem", { name: new RegExp(`^${name}`) }).first().waitFor({ timeout: 15000 }); return true; } catch { return false; } };
  const pageServer = http.createServer((req, res) => {
    if (req.url.startsWith("/t.html")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><table><caption>E2E Web</caption><tr><th>Region</th><th>Units</th></tr><tr><td>North</td><td>10</td></tr><tr><td>South</td><td>12</td></tr></table></html>");
    } else { res.writeHead(404); res.end("no"); }
  });
  await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
  try {
    await openImport("Web");
    await importDlg.getByLabel("Web address").fill(`http://127.0.0.1:${pageServer.address().port}/t.html`);
    await importDlg.getByRole("button", { name: "Show tables" }).click();
    const nav = importDlg.getByRole("group", { name: "Navigator" });
    await nav.waitFor();
    await nav.getByRole("button", { name: "E2E Web", exact: true }).click();
    await nav.getByLabel("Preview").getByText("North").waitFor();
    check(true, "Web: the navigator lists the page's table and previews its rows");
    await nav.getByRole("checkbox", { name: "Select E2E Web" }).check();
    await importDlg.getByRole("button", { name: "Import", exact: true }).click();
    await importDlg.waitFor({ state: "detached" });
    await page.waitForFunction(() => [...document.querySelectorAll("[role=treeitem]")].some((e) => /^E2E Web/.test(e.textContent ?? "")));
    check(await hasTable("E2E Web"), "Web: the table is in the Data pane");
  } finally {
    pageServer.close();
  }

  const xmlFile = join(work, "e2e-shop.xml");
  writeFileSync(xmlFile, `<shop><item id="1"><title>Pen</title><price>1.5</price></item><item id="2"><title>Ink</title><price>2</price></item></shop>`);
  await openImport("XML");
  await importDlg.getByLabel("File path").fill(xmlFile);
  await importDlg.getByLabel("File path").blur();
  const xnav = importDlg.getByRole("group", { name: "Navigator" });
  await xnav.waitFor();
  await xnav.getByRole("checkbox", { name: "Select item" }).check();
  await importDlg.getByRole("button", { name: "Import", exact: true }).click();
  await importDlg.waitFor({ state: "detached" });
  await page.waitForFunction(() => [...document.querySelectorAll("[role=treeitem]")].some((e) => /^item/.test(e.textContent ?? "")));
  check(await hasTable("item"), "XML: the repeating element became a table");

  // Access database through the machine's ODBC driver
  const accdb = join(work, "e2e-shop.accdb");
  let accessReady = false;
  try {
    execSync(`powershell -NoProfile -Command "$c = New-Object -ComObject ADOX.Catalog; $null = $c.Create('Provider=Microsoft.ACE.OLEDB.12.0;Data Source=${accdb};')"`, { timeout: 60000 });
    const sql = "$c = New-Object -ComObject ADODB.Connection; $c.Open('Provider=Microsoft.ACE.OLEDB.12.0;Data Source=" + accdb + ";'); $null = $c.Execute('CREATE TABLE Parts (Id LONG, PartName TEXT(40))'); $null = $c.Execute(\\\"INSERT INTO Parts VALUES (1, 'Bolt')\\\"); $null = $c.Execute(\\\"INSERT INTO Parts VALUES (2, 'Nut')\\\"); $c.Close()";
    execSync(`powershell -NoProfile -Command "${sql}"`, { timeout: 60000 });
    accessReady = existsSync(accdb);
  } catch { /* no ACE provider on this machine */ }
  if (accessReady) {
    await openImport("Access database");
    await importDlg.getByLabel("File path").fill(accdb);
    await importDlg.getByLabel("File path").blur();
    const anav = importDlg.getByRole("group", { name: "Navigator" });
    await anav.waitFor();
    await anav.getByRole("button", { name: "Parts", exact: true }).click();
    await anav.getByLabel("Preview").getByText("Bolt").waitFor();
    await anav.getByRole("checkbox", { name: "Select Parts" }).check();
    await importDlg.getByRole("button", { name: "Import", exact: true }).click();
    await importDlg.waitFor({ state: "detached" });
    await page.waitForFunction(() => [...document.querySelectorAll("[role=treeitem]")].some((e) => /^Parts/.test(e.textContent ?? "")));
    const okA = await hasTable("Parts");
    if (!okA) console.log("treeitems:", await page.getByRole("treeitem").allInnerTexts());
    check(okA, "Access: the table was read through the ODBC driver");
  } else {
    console.log("SKIPPED: Access (no Access ODBC driver / ACE provider on this machine)");
  }

  // MySQL (CI starts a server and sets BIFORGE_TEST_MYSQL=host:port:database:user:password:table)
  if (process.env.BIFORGE_TEST_MYSQL) {
    const [mh, mp, md, mu, mpw, mt] = process.env.BIFORGE_TEST_MYSQL.split(":");
    await openImport("MySQL database");
    await importDlg.getByLabel("Server").fill(mh);
    await importDlg.getByLabel("Port").fill(mp);
    await importDlg.getByLabel("Database").fill(md);
    await importDlg.getByLabel("User", { exact: true }).fill(mu);
    await importDlg.getByLabel("Password").fill(mpw);
    await importDlg.getByRole("button", { name: "List tables" }).click();
    const mnav = importDlg.getByRole("group", { name: "Navigator" });
    await mnav.waitFor();
    await mnav.getByRole("checkbox", { name: `Select ${mt}` }).check();
    await importDlg.getByRole("button", { name: "Import", exact: true }).click();
    await importDlg.waitFor({ state: "detached" });
    await page.waitForFunction((t) => [...document.querySelectorAll("[role=treeitem]")].some((e) => (e.textContent ?? "").startsWith(t)), mt);
    check(await hasTable(mt), "MySQL: the table was imported in the real window");
  } else {
    console.log("SKIPPED: MySQL (set BIFORGE_TEST_MYSQL to run it)");
  }

  // 1b. the Phase 7 objects and panes in the real window: text box, map from the bundled outlines, Format pane, group, Selection pane.
  // Everything is selected through the Selection pane, not by canvas coordinates, so that the test does not depend on the window size.
  const frames = () => page.locator("[data-visual]");
  await page.waitForTimeout(1500);
  const before = await frames().count();
  await page.getByRole("button", { name: "Text box", exact: true }).click();
  check((await frames().count()) === before + 1, "Text box adds an object to the page");
  await page.getByRole("button", { name: "Map", exact: true }).click();
  check((await frames().count()) === before + 2, "the Map gallery button adds a map visual");
  await page.getByRole("tab", { name: "View", exact: true }).click();
  await page.getByRole("button", { name: "Selection", exact: true }).click();
  await page.getByRole("tree", { name: "Visuals and groups" }).waitFor();
  await page.getByRole("button", { name: "Select Map", exact: true }).click();
  await page.getByRole("treeitem", { name: /^Customer/ }).locator("svg").first().click();
  await page.getByRole("checkbox", { name: "Use City in the selected visual" }).check();
  await page.getByRole("treeitem", { name: /^Sales/ }).locator("svg").first().click();
  await page.getByRole("checkbox", { name: "Use Quantity in the selected visual" }).check();
  const mapImg = page.getByRole("img", { name: "Map" });
  await mapImg.waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[role=img][aria-label=Map] path").length > 100);
  check((await mapImg.locator("path").count()) > 100, "the map is drawn from the bundled Natural Earth outlines (country paths, no tiles)");
  const notice = await page.locator("[data-testid=chart-notice]").first().innerText();
  check(/not drawn/.test(notice), `places the data does not know are reported under the map (${notice.slice(-40)})`);
  // the Format pane is generated from the schema: cards, typed controls, and an honest marker for what is not drawn yet
  await page.getByRole("tab", { name: /Format visual/ }).click();
  await page.getByText("Bubbles", { exact: true }).first().waitFor();
  check((await page.getByText(/not drawn yet/).count()) > 0, "Format pane marks properties that are not drawn yet");
  const bubble = page.getByLabel("Bubble size").first();
  await bubble.fill("40");
  await bubble.press("Tab");
  await page.waitForTimeout(500);
  check((await bubble.inputValue()) === "40", "a typed Format pane control keeps its value");
  // group the two cards: select both in the Selection pane (Ctrl+click), then Group in the Format tab
  const cardButtons = page.getByRole("button", { name: "Select Card", exact: true });
  await cardButtons.nth(0).click();
  await cardButtons.nth(1).click({ modifiers: ["Control"] });
  await page.getByRole("tab", { name: "Format", exact: true }).click();
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Group \(Ctrl\+G\)/ }).click();
  await page.getByRole("treeitem", { name: /Group 1/ }).first().waitFor();
  check((await page.getByRole("treeitem", { name: /Group/ }).count()) > 0, "Group creates a group that the Selection pane lists");
  await page.screenshot({ path: join(work, "editing.png") });
  await page.getByRole("tab", { name: "Home", exact: true }).click();

  // 2. Publish & Share to the folder adapter
  await page.getByRole("button", { name: /Publish & Share/ }).first().click();
  const dlg = page.getByRole("dialog", { name: "Publish and Share" });
  await dlg.waitFor();
  check((await dlg.getByText("Add a destination", { exact: true }).count()) === 1, "'Add a destination' appears once in the empty Publish & Share form");
  await dlg.getByRole("combobox", { name: "Destination type" }).click();
  await page.getByRole("option", { name: /Cloudflare/ }).click();
  const cf = dlg.getByRole("group", { name: "Cloudflare account" });
  check(/Not connected/.test(await cf.innerText()), "the Cloudflare form shows 'Not connected'");
  await cf.getByRole("button", { name: "Connect Cloudflare account" }).click();
  check((await cf.getByRole("textbox", { name: "Cloudflare token" }).getAttribute("type")) === "password", "the Cloudflare token entry is a password field next to the status");
  check((await dlg.getByLabel("Cloudflare account ID").count()) === 1, "the Cloudflare account ID is asked once");
  check(/Credential Manager/.test(await cf.innerText()), "the form says the token goes to Windows Credential Manager");
  await dlg.getByRole("combobox", { name: "Destination type" }).click();
  await page.getByRole("option", { name: /Folder on this PC/ }).click();
  check(/none needed/.test(await dlg.getByRole("status", { name: "Account" }).innerText()), "the folder form says no account is needed");
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

  // 2b. Publish & Share to GitHub Pages (real GitHub, a dedicated repository)
  if (ghToken) {
    ghLogin = (await (await ghApi("/user")).json()).login;
    await dlg.getByRole("button", { name: "Add a destination" }).click();
    await dlg.getByRole("combobox", { name: "Destination type" }).click();
    await page.getByRole("option", { name: /GitHub Pages/ }).click();
    await dlg.getByLabel("Destination name").fill("E2E site");
    await dlg.getByLabel("Repository name").fill(ghRepo);
    await dlg.getByRole("button", { name: "Add destination" }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click(); // the GitHub setup guide
    const sec = dlg.getByRole("region", { name: "Destination E2E site" });
    await sec.waitFor();
    check(/GitHub account: Connected as/.test(await sec.innerText()) || (await sec.innerText()).includes(ghLogin), "the GitHub destination shows the connected account");
    await sec.getByRole("checkbox", { name: /public web address/ }).check();
    await sec.getByLabel("Publisher name").fill("E2E Tester");
    await sec.getByRole("button", { name: "Publish", exact: true }).click();
    const gstatus = sec.getByRole("status").filter({ hasText: /Published version/ });
    await gstatus.waitFor({ timeout: 120000 });
    ghKey = /(AGE-SECRET-KEY-[A-Z0-9]+)/.exec(await gstatus.innerText())?.[1] ?? null;
    check(!!ghKey, "publish to GitHub Pages shows an access key once");
    await sec.getByRole("button", { name: "Create share link" }).click();
    const linkBox = sec.getByRole("status").filter({ hasText: /Share link/ });
    await linkBox.waitFor();
    ghLink = /(biforge:\/\/open\?src=url&url=\S+)/.exec(await linkBox.innerText())?.[1] ?? null;
    check(!!ghLink && !(ghLink.includes("AGE-SECRET")), "the share link points at the site's feed and holds no key");
    const feedUrl = decodeURIComponent(ghLink.split("url=")[1]);
    let live = false;
    for (let i = 0; i < 90 && !live; i++) { live = (await fetch(feedUrl).catch(() => ({ ok: false }))).ok; if (!live) await sleep(5000); }
    check(live, `GitHub Pages serves the feed (${feedUrl})`);
  } else {
    console.log("SKIPPED: GitHub publishing (set BIFORGE_TEST_GITHUB_TOKEN to run it)");
  }

  // 3. Open shared report: read-only viewing mode
  await dlg.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(800);
  await page.locator("button", { hasText: /Open shared/ }).first().click();
  const open = page.getByRole("dialog", { name: /shared report/i });
  await open.getByLabel("Report file").fill(join(share, files.find((f) => f.endsWith(".biforge"))));
  await open.getByLabel("Access key").fill(key);
  await open.getByRole("button", { name: "Open for viewing" }).click();
  // the editing session above left unsaved changes: the app asks before it swaps the document
  const dontSave = page.getByRole("button", { name: "Don't save" });
  check(await dontSave.waitFor({ timeout: 5000 }).then(() => true, () => false), "opening a shared report asks about the unsaved edits first");
  await dontSave.click();
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

  // 4. Open the GitHub report by its share link (the link carries no key; the dialog asks for it)
  if (ghLink) {
    await page.locator("button", { hasText: /Open shared/ }).first().click();
    const odlg = page.getByRole("dialog", { name: /shared report/i });
    await odlg.getByLabel("Link").fill(ghLink);
    await odlg.getByRole("button", { name: "Use link" }).click();
    const details = page.getByRole("region", { name: "Package details" });
    await details.waitFor({ timeout: 120000 });
    const dtext = await details.innerText();
    check(/First time: BIForge will remember this publisher key/.test(await page.getByRole("dialog").innerText()) && /private/.test(dtext), "the link downloads the package and shows publisher key and access level before anything opens");
    await page.getByRole("dialog").getByRole("textbox", { name: "Access key" }).fill(ghKey);
    await page.getByRole("dialog").getByRole("button", { name: "Open for viewing" }).click();
    const lbar = page.locator(".viewing-bar");
    await lbar.waitFor();
    const lbarText = await lbar.innerText();
    check(/E2E Tester/.test(lbarText) && /private/.test(lbarText) && /Check for updates/.test(lbarText), "the report opened from the link is in viewing mode with a Check for updates button");
    await page.waitForSelector("[data-testid=card-value]");
    check(true, "the report opened from GitHub renders its visuals from the downloaded data");
    await lbar.getByRole("button", { name: "Check for updates" }).click();
    await page.getByText(/is up to date \(version 1\)/).first().waitFor({ timeout: 60000 });
    check(true, "Check for updates reaches GitHub and says the report is up to date");
    await lbar.locator("button", { hasText: /^Close$/ }).click();
    await page.waitForSelector("text=Recent");

    // 5. stop sharing from the project (the target was stored with the project), then delete the test repository
    await page.getByText("E2E Sample").first().click();
    await page.getByRole("button", { name: /Publish & Share/ }).first().waitFor();
    await page.getByRole("button", { name: /Publish & Share/ }).first().click();
    const d2 = page.getByRole("dialog", { name: "Publish and Share" });
    await d2.getByRole("tab", { name: "E2E site" }).click();
    await d2.getByRole("button", { name: "Stop sharing" }).click();
    let gone = false;
    for (let i = 0; i < 24 && !gone; i++) { gone = (await ghApi(`/repos/${ghLogin}/${ghRepo}/contents/feed.json`)).status === 404; if (!gone) await sleep(2500); }
    check(gone, "Stop sharing removed the feed from the repository");
    await d2.getByRole("button", { name: "Close", exact: true }).click();
  }

} catch (e) {
  failures++;
  console.log("ERROR", e);
  try { const pg = browser?.contexts()[0].pages()[0]; await pg?.screenshot({ path: join(work, "err.png") }); console.log("screenshot", join(work, "err.png")); } catch {}
} finally {
  try { await browser?.close(); } catch {}
  try { process.kill(pid); } catch {}
  if (ghToken && ghLogin) {
    const del = await ghApi(`/repos/${ghLogin}/${ghRepo}`, { method: "DELETE" }).catch(() => null);
    console.log(del?.status === 204 ? `deleted test repository ${ghLogin}/${ghRepo}` : `COULD NOT DELETE ${ghLogin}/${ghRepo} (HTTP ${del?.status}); delete it by hand`);
  }
}
for (const f of ["app.out.log", "app.err.log"]) {
  try { const t = readFileSync(join(work, f), "utf8"); if (t.trim()) console.log(`--- ${f}\n${t.slice(-2000)}`); } catch {}
}
console.log("work dir", work);
process.exit(failures ? 1 : 0);
