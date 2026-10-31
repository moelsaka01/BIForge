// Pointer steps of the render audit for properties that are drawn only while the pointer is on something (definition of done 5):
// the visual header (icons in a bar over the visual), the tooltip of a data point, the tooltip of the header icon. They run on the
// page of the visual after the usual preparation, on both sides of a comparison, and the comparison then also looks at the
// surroundings of the visual (a tooltip is drawn outside its element).
const probe = (page) => page.locator("[data-visual='probe']").first();

/** Two animation frames and an idle moment: everything the pointer set off has been drawn when this returns. */
const settle = (page) => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 50)))));

/** Waits for an element instead of a time; a visual that has no such element (no header buttons) is not an error. */
async function appears(loc, ms = 2500) {
  try { await loc.first().waitFor({ state: "visible", timeout: ms }); return true; } catch { return false; }
}

export const HOVER = {
  // the pointer rests on the visual: its header bar shows (the buttons are there, and the pointer stays)
  async visualHeader(page) {
    const b = await probe(page).boundingBox();
    if (!b) return;
    await page.mouse.move(b.x + 5, b.y + b.height - 5);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
    await appears(probe(page).locator("button, [data-testid='header-tooltip-icon']"));
    await settle(page);
  },
  // the pointer rests on the information icon of the header
  async visualHeaderTooltip(page) {
    await HOVER.visualHeader(page);
    const icon = page.locator("[data-visual='probe'] [data-testid='header-tooltip-icon']").first();
    if (await icon.count()) { await icon.hover({ timeout: 4000 }).catch(() => {}); await settle(page); await page.waitForTimeout(150); await settle(page); }
  },
  // the tooltip of the first data point: ECharts is told to show it (no pointer timing), then the tooltip element is awaited
  async visualTooltip(page) {
    const shown = await probe(page).evaluate((root) => {
      const el = [...root.querySelectorAll("*")].find((e) => e.__chart);
      const c = el?.__chart;
      if (!c) return false;
      const n = c.getModel().getSeriesByIndex(0)?.getData()?.count?.() ?? 0;
      if (!n) return false;
      c.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex: 0 });
      c.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: 0 });
      return true;
    });
    if (!shown) return;
    await probe(page).evaluate((root) => new Promise((res) => {
      const t0 = Date.now();
      const look = () => {
        const tip = [...root.querySelectorAll("div")].find((d) => d.style.whiteSpace === "nowrap" && d.textContent.trim() !== "" && d.style.display !== "none" && d.style.visibility !== "hidden");
        if (tip || Date.now() - t0 > 2500) res(!!tip); else setTimeout(look, 25);
      };
      look();
    }));
    await settle(page);
    // the tooltip fades in: wait until it stops changing
    await page.waitForTimeout(300);
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
