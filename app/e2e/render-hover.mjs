// Pointer steps of the render audit for properties that are drawn only while the pointer is on something (definition of done 5):
// the visual header (icons in a bar over the visual), the tooltip of a data point, the tooltip of the header icon. They run on the
// page of the visual after the usual preparation, on both sides of a comparison, and the comparison then also looks at the
// surroundings of the visual (a tooltip is drawn outside its element).
const probe = (page) => page.locator("[data-visual='probe']").first();

/** The centre of the first bar of the visual, in screen pixels (null when there is no chart or no bar). */
async function firstBar(page) {
  return probe(page).evaluate((root) => {
    const el = [...root.querySelectorAll("*")].find((e) => e.__chart);
    const c = el?.__chart;
    const bar = c?.getModel?.().getSeriesByIndex(0)?.getData()?.getItemGraphicEl(0);
    const s = bar?.shape;
    const r = el?.getBoundingClientRect();
    if (!s || !r) return null;
    // the page is scaled to fit the window: pixels of the chart are not pixels of the screen
    const k = r.width / c.getWidth();
    return [r.left + (s.x + s.width / 2) * k, r.top + (s.y + s.height / 2) * k];
  });
}

export const HOVER = {
  // the pointer rests on the visual: its header bar shows
  async visualHeader(page) {
    const b = await probe(page).boundingBox();
    if (!b) return;
    await page.mouse.move(b.x + 5, b.y + b.height - 5);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
    await page.waitForTimeout(400);
  },
  // the pointer rests on the information icon of the header
  async visualHeaderTooltip(page) {
    await HOVER.visualHeader(page);
    const icon = page.locator("[data-visual='probe'] [data-testid='header-tooltip-icon']").first();
    if (await icon.count()) { await icon.hover({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(500); }
  },
  // the pointer rests on the first bar: the tooltip of the data point
  async visualTooltip(page) {
    const at = await firstBar(page);
    if (!at) return;
    await page.mouse.move(at[0] - 4, at[1] - 4);
    await page.mouse.move(at[0], at[1], { steps: 4 });
    await page.waitForTimeout(600);
  },
  // a segment of the stack gets wider gaps while the pointer is on it
  async layout(page, c) {
    if (c.prop === "stackedGapExplodes") await HOVER.visualTooltip(page);
  },
};

/** The step for a case, or undefined. */
export const hoverStep = (c) => HOVER[c.object];

/** A screenshot of the visual and its surroundings (tooltips and popovers are drawn outside the element). */
export async function surroundings(page) {
  const b = await probe(page).boundingBox();
  if (!b) return null;
  const clip = { x: Math.max(0, b.x - 80), y: Math.max(0, b.y - 80), width: b.width + 240, height: b.height + 160 };
  return page.screenshot({ clip, animations: "disabled" });
}
