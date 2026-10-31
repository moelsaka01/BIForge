// Steps a visual needs before it shows what a property changes (a state that the report file does not hold). They run on the page of
// the visual, on both sides of a comparison.
const probe = (page) => page.locator("[data-visual='probe']").first();

export const PREP = {
  // the Export menu is opened (its entries are what the export properties change); the data has to be read first
  async rdlVisual(page) {
    await probe(page).getByTestId("paginated-sheet").waitFor({ timeout: 8000 }).catch(() => {});
    await probe(page).getByText("Loading…").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    const b = probe(page).getByRole("button", { name: "Export" });
    if (await b.count()) { await b.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(300); }
  },
  // two values of the tile slicer are clicked: a single-select slicer keeps the second only
  async advancedSlicerVisual(page) {
    const chips = probe(page).getByRole("option");
    const n = await chips.count();
    if (n > 2) {
      // dispatched, not clicked: a tile shape (arrow, heart) clips the chips out of the pointer's reach
      await chips.nth(n - 1).dispatchEvent("click"); await page.waitForTimeout(300); await chips.nth(n - 2).dispatchEvent("click"); await page.waitForTimeout(500);
    }
  },
  // the drop-down list is opened (its surface is drawn over the visual)
  async listSlicer(page) {
    const b = probe(page).getByRole("button", { name: "Open the list of values" });
    if (await b.count()) { await b.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(500); }
  },
  // the entry of the bookmark applied last is the selected one (the bookmarks do not change the page, see render.mjs)
  async bookmarkNavigator(page) {
    await probe(page).getByRole('button').first().click();
    await page.waitForTimeout(300);
  },
  // the decomposition tree starts with its root node: split it by the first field of Explain by, then by the second
  async decompositionTreeVisual(page) {
    const v = probe(page);
    for (const level of [1, 2]) {
      const b = v.getByRole("button", { name: `Split by (level ${level})` });
      if (!(await b.count()) || (await b.isDisabled())) return;
      await b.click();
      const items = page.getByRole("menuitem");
      await items.nth(2 + (level - 1)).click();
      await page.waitForTimeout(600);
    }
    // the first node of the first level is selected (its border takes the accent colour)
    const node = v.locator("[data-node]").first();
    if (await node.count()) { await node.click().catch(() => {}); await page.waitForTimeout(400); }
  },
  // the pointer rests on the first bubble: the tooltip (drawn on hover only) is part of what is compared
  async map(page) {
    const v = probe(page);
    const at = await v.evaluate((root) => {
      const el = [...root.querySelectorAll("*")].find((e) => e.__chart);
      const c = el?.__chart;
      const pt = c?.getOption().series?.find((s) => s.type === "scatter" || s.type === "effectScatter")?.data?.[0];
      const px = pt ? c.convertToPixel({ geoIndex: 0 }, [pt[0], pt[1]]) : null;
      const r = el?.getBoundingClientRect();
      // the page is scaled to fit the window: pixels of the chart are not pixels of the screen
      const k = r && c ? r.width / c.getWidth() : 1;
      return px && r ? [r.left + px[0] * k, r.top + px[1] * k] : null;
    });
    if (at) { await page.mouse.move(at[0] - 3, at[1] - 3); await page.mouse.move(at[0], at[1], { steps: 3 }); await page.waitForTimeout(500); }
  },
};
