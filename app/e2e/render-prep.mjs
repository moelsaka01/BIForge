// Steps a visual needs before it shows what a property changes (a state that the report file does not hold). They run on the page of
// the visual, on both sides of a comparison.
const probe = (page) => page.locator("[data-visual='probe']").first();

export const PREP = {
  // two values of the tile slicer are clicked: a single-select slicer keeps the second only
  async advancedSlicerVisual(page) {
    const chips = probe(page).getByRole("option");
    const n = await chips.count();
    if (n > 2) { await chips.nth(n - 1).click(); await page.waitForTimeout(300); await chips.nth(n - 2).click(); await page.waitForTimeout(500); }
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
};
