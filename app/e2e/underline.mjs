// Real-window test of chart text underline: legend, data labels, axes and small multiples headers get a real SVG text
// decoration (not extra characters), and the text content stays unchanged. Also checks the tile frame of a card and the total
// labels of a horizontal stacked bar. Run: node e2e/underline.mjs   (needs `npx tauri build --debug --no-bundle` first)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.env.BIFORGE_EXE ?? "../target/debug/biforge-app.exe");
const work = mkdtempSync(join(tmpdir(), "biforge-e2e-ul-"));
const parent = join(work, "projects");
mkdirSync(parent);
const port = 9394;
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
  await dlg.getByLabel("Project name").fill("Underline");
  await dlg.getByRole("button", { name: "Browse…" }).click();
  await dlg.getByRole("button", { name: "Create" }).click();
  await page.waitForTimeout(4000);
  await page.getByRole("tab", { name: "View", exact: true }).click();
  await page.getByRole("button", { name: "Selection", exact: true }).click();
  await page.getByRole("tree", { name: "Visuals and groups" }).waitFor();
  await page.getByRole("button", { name: `Select ${process.env.UL_VISUAL ?? "Clustered column chart"}`, exact: true }).click();
  await page.getByRole("tab", { name: /Format visual/ }).click();
  await page.waitForTimeout(800);
  const target = process.env.UL_VISUAL ?? "Clustered column chart";
  const chart = page.getByRole("img", { name: new RegExp(target.replace(" chart", ""), "i") }).first();
  const underlined = () => chart.evaluate((el) => [...el.querySelectorAll("text")].filter((t) => getComputedStyle(t).textDecorationLine.includes("underline")).map((t) => t.textContent));
  const allText = () => chart.evaluate((el) => [...el.querySelectorAll("text")].map((t) => t.textContent).join("|"));
  check((await underlined()).length === 0, "no chart text is underlined before any card asks for it");
  for (const card of ["X-axis", "Y-axis", "Data labels", "Legend"]) {
    const b = page.getByRole("button", { name: card, exact: true }).first();
    if ((await b.getAttribute("aria-expanded")) !== "true") await b.click();
  }
  const shows = page.getByRole("switch", { name: /^Show( title)?$/ });
  for (let i = 0; i < (await shows.count()); i++) await shows.nth(i).check();
  await page.waitForTimeout(1000);
  const textBefore = await allText();
  const sws = page.getByRole("switch", { name: "Underline" });
  const n = await sws.count();
  for (let i = 0; i < n; i++) await sws.nth(i).check();
  await page.waitForTimeout(1500);
  const ul = await underlined();
  const after = await allText();
  check(ul.length > 0, "text of the chart is drawn with a real text-decoration underline");
  check(after === textBefore && !after.includes("̲"), "the text content is unchanged (no inserted characters)");
  const plainLeft = await chart.evaluate((el) => [...el.querySelectorAll("text")].filter((t) => !getComputedStyle(t).textDecorationLine.includes("underline")).map((t) => t.textContent));
  console.log("not underlined:", JSON.stringify(plainLeft));
  const box = await chart.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 4 } });
  (await import("node:fs")).writeFileSync(join(work, "underlined.png"), Buffer.from(shot.data, "base64"));

  // total labels of a horizontal stacked bar chart
  await page.getByRole("tab", { name: "Home", exact: true }).click();
  await page.getByRole("tab", { name: "Build visual" }).click();
  await page.getByRole("button", { name: "Stacked bar chart", exact: true }).click();
  await page.getByRole("button", { name: "Select Stacked bar chart", exact: true }).click();
  const use = async (table, field) => {
    const box = page.getByRole("checkbox", { name: `Use ${field} in the selected visual` });
    if (!(await box.isVisible().catch(() => false))) await page.getByRole("treeitem", { name: new RegExp(`^${table}`) }).locator("svg").first().click();
    await box.evaluate((el) => !el.checked && el.click());
  };
  await use("Product", "Category");
  await use("Sales", "Sales Amount");
  await page.waitForTimeout(2000);
  await page.getByRole("tab", { name: /Format visual/ }).click();
  const bar = page.getByRole("img", { name: /Stacked bar/ }).first();
  const barText = () => bar.evaluate((el) => [...el.querySelectorAll("text")].map((t) => ({ t: t.textContent, ul: getComputedStyle(t).textDecorationLine.includes("underline"), x: t.getBoundingClientRect().x })));
  const withoutTotals = (await barText()).map((x) => x.t);
  await page.getByRole("button", { name: "Totals", exact: true }).click();
  await page.getByRole("switch", { name: "Show", exact: true }).last().evaluate((el) => !el.checked && el.click());
  await page.waitForTimeout(1500);
  const withTotals = await barText();
  // totals are the texts after the old ones
  const added = withTotals.filter((x) => x.t === "319.6K").map((x) => x.t);
  check(added.length >= 2 && withoutTotals.filter((t) => t === "319.6K").length === 1, `Totals show adds total labels to the horizontal bars (${added.join(", ")})`);
  const totalX = withTotals.filter((x) => x.t === "319.6K").map((x) => x.x);
  check(totalX.length > 0 && totalX.every((x) => x > 0), "the total labels sit inside the visible chart area");
  await page.getByRole("switch", { name: "Underline", exact: true }).last().evaluate((el) => !el.checked && el.click());
  await page.waitForTimeout(1000);
  const ul2 = await barText();
  check(ul2.filter((x) => x.t === "319.6K").length >= 2 && ul2.filter((x) => x.t === "319.6K").every((x) => x.ul), "the total labels of the bars are underlined with a real text decoration");
  {
    const box = await bar.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 4 } });
    (await import("node:fs")).writeFileSync(join(work, "bars.png"), Buffer.from(shot.data, "base64"));
  }
  // tile frame of the new card visual
  await page.getByRole("tab", { name: "Build visual" }).click();
  await page.getByRole("button", { name: "Card (new)", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("tab", { name: /Format visual/ }).click();
  await page.waitForTimeout(800);
  const frame = page.locator("[data-testid=tile-frame]").first();
  const style = () => frame.evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, border: c.borderTopWidth + " " + c.borderTopStyle, radius: c.borderTopLeftRadius, shadow: c.boxShadow }; });
  const s0 = await style();
  await page.getByRole("button", { name: /^Fill/ }).first().click();
  await page.getByRole("button", { name: /^Outline/ }).first().click();
  await page.getByRole("button", { name: /^Shadow/ }).first().click();
  await page.waitForTimeout(500);
  for (const card of ["Fill", "Outline", "Shadow"]) {
    const idx = await page.getByRole("switch", { name: "Show", exact: true }).evaluateAll((els, c) => els.findIndex((e) => (e.closest("section,[data-card],div[role=group]")?.textContent ?? "").startsWith(c)), card);
    // set it explicitly: a switch that already reads "on" by the pane's default is toggled off and on again so that the value is stored
    const sw = page.getByRole("switch", { name: "Show", exact: true }).nth(idx);
    if (idx >= 0 && (await sw.isChecked())) { await sw.evaluate((el) => el.click()); await page.waitForTimeout(300); }
    if (idx >= 0) await page.getByRole("switch", { name: "Show", exact: true }).nth(idx).evaluate((el) => !el.checked && el.click());
    else console.log("no Show switch found in", card);
  }
  await page.waitForTimeout(1000);
  const s1 = await style();
  check(s1.bg !== s0.bg, "tile frame: Fill > Show gives the card a background in the real window");
  check(/inset/.test(s1.shadow), "tile frame: Outline > Show draws the outline (an inset line)");
  check(/inset/.test(s1.shadow) && s1.shadow.includes("4px 0px"), "tile frame: Shadow > Show adds an outer shadow next to the outline");
  console.log("WORK", work);
} catch (e) {
  failures++;
  console.log("ERROR", e.message);
} finally {
  try { process.kill(pid); } catch { /* gone */ }
}
process.exit(failures ? 1 : 0);
