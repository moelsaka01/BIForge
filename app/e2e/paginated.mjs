// Real-window test of the Paginated report visual: Insert > Paginated report reads an .rdl file, the visual draws its table as pages
// over the sample model, the toolbar pages through them, a report parameter filters the data, and the export hands over CSV.
// Run: node e2e/paginated.mjs   (needs `npx tauri build --debug --no-bundle` first)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const rdl = resolve("e2e/fixtures/products.rdl");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-rdl-"));
const parent = join(work, "projects");
mkdirSync(parent);
const port = 9395;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };

const child = spawn(exe, [], {
  // the first pick is the folder of the new project, the second the report definition
  env: { ...process.env, BIFORGE_TEST_DEBUG_PORT: String(port), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"), BIFORGE_ALLOW_MULTIPLE: "1", BIFORGE_TEST_PICKS: `${parent}|${rdl}` },
  stdio: ["ignore", openSync(join(work, "out.log"), "w"), openSync(join(work, "err.log"), "w")],
});
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
  await dlg.getByLabel("Project name").fill("Paginated");
  await dlg.getByRole("button", { name: "Browse…" }).click();
  await dlg.getByRole("button", { name: "Create" }).click();
  await page.waitForTimeout(4000);

  await page.getByRole("tab", { name: "Insert", exact: true }).click();
  await page.getByRole("button", { name: "Paginated report", exact: true }).click();
  const view = page.locator("[data-testid=paginated]").first();
  await view.waitFor();
  const sheet = view.getByTestId("paginated-sheet");
  await sheet.getByText("Ridge Mountain Bike").waitFor();
  check((await sheet.getByRole("columnheader").allTextContents()).join("|") === "Product name|Category|List price", "the table's header row is the report's (Product name, Category, List price)");
  check((await sheet.getByRole("row").count()) === 8, "the first page holds 7 rows (a 70 mm page) and the header row");
  check((await view.getByTestId("paginated-page-number").textContent()) === "Page 1 of 2", "the toolbar says Page 1 of 2");
  await view.getByRole("button", { name: "Next page" }).click();
  check((await view.getByTestId("paginated-page-number").textContent()) === "Page 2 of 2" && (await sheet.getByRole("row").count()) === 2, "the next page holds the 8th row");
  await view.getByRole("button", { name: "Parameters" }).click();
  await view.getByLabel("Category").selectOption("Bikes");
  await view.getByTestId("paginated-page-number").getByText("Page 1 of 1").waitFor();
  check((await sheet.getByRole("row").count()) === 4 && (await sheet.innerText()).includes("Harbor Road Bike") && !(await sheet.innerText()).includes("Orbit Helmet"), "the Category parameter keeps the 3 bikes");
  await view.getByRole("button", { name: "Export" }).click();
  const items = await view.getByRole("menuitem").allTextContents();
  check(items.join("|") === "CSV (comma delimited)|XML|MHTML (web archive)|PDF (print)", "the Export menu lists the four formats BIForge writes");
  // the export hands the file over as a download: the app does not save it silently, so the click must not fail
  await view.getByRole("menuitem", { name: /CSV/ }).click();
  await view.getByText("Exported CSV").waitFor();
  check(true, "Export > CSV runs");
  // the Format pane has the cards of the visual
  await page.getByRole("tab", { name: /Format visual/ }).click();
  for (const card of ["Toolbar", "Export", "Auto filter", "Parameter mapping"]) check(await page.getByRole("button", { name: card, exact: true }).first().isVisible().catch(() => false), `Format pane has the ${card} card`);
} catch (e) {
  failures++;
  console.log("ERROR", e.message);
} finally {
  try { process.kill(child.pid); } catch { /* gone */ }
}
process.exit(failures ? 1 : 0);
