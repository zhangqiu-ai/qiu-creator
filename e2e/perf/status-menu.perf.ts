import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-073 retest of the QC-070 finding: with more works than one page (60), the
 * selection toolbar's 改狀態 menu closed by itself about 0.2 s after opening.
 * 14 trials with 125–130 works: ⌘-click 2 or ⌘A, opened at once or after the page
 * settled; then the right-click menu's 改狀態 ▸ submenu. Each trial keeps the menu
 * open for 2.5 s (sampled every 100 ms), then picks 待審核 and checks the service.
 * Run with the perf config (not part of the e2e suite).
 */

const grid = (page: Page): Locator => page.getByRole('region', { name: '作品', exact: true });
const cards = (page: Page): Locator => grid(page).locator('.wcard');
const scrollTop = (page: Page) =>
  page.evaluate<number>('document.querySelector("main.page").scrollTop');

interface Trial {
  works: number;
  select: 'two' | 'all';
  settleMs: number;
}

const TRIALS: Trial[] = Array.from({ length: 14 }, (_, i) => ({
  works: 125 + (i % 6),
  select: i % 2 === 0 ? 'two' : 'all',
  settleMs: i % 4 < 2 ? 0 : 4000,
}));

async function seed(
  page: Page,
  c: {
    works: { create: (w: { title: string; markdown: string; source: string }) => Promise<unknown> };
  },
  n: number,
) {
  for (let i = 0; i < n; i += 1)
    await c.works.create({
      title: `選單 ${String(i)}`,
      markdown: `# 選單 ${String(i)}\n\nx`,
      source: 'mac-app',
    });
  await page.reload();
  await expect(cards(page).first()).toBeVisible();
  await expect(page.locator('main .page__sub')).toHaveText(`${String(n)} 個作品`);
}

/** Menu items present every 100 ms for 2.5 s, as a string of counts ("4444…"). */
async function sample(page: Page, menu: Locator): Promise<string> {
  let out = '';
  for (let k = 0; k < 25; k += 1) {
    out += String(await menu.getByRole('menuitemradio').count());
    await page.waitForTimeout(100);
  }
  return out;
}

for (const [i, trial] of TRIALS.entries()) {
  test(`工具列「改狀態」不自己關掉 #${String(i + 1)}（${String(trial.works)} 件，${trial.select === 'two' ? '⌘ 點 2 張' : '⌘A'}，等 ${String(trial.settleMs)} ms）`, async ({
    desktop,
  }) => {
    test.setTimeout(3 * 60_000);
    const { page, backend } = desktop;
    await page.setViewportSize({ width: 1440, height: 900 });
    const c = backend.client;
    await seed(page, c, trial.works);
    await page.waitForTimeout(trial.settleMs);
    await cards(page)
      .nth(0)
      .click({ modifiers: ['Meta'] });
    const picked = trial.select === 'two' ? 2 : trial.works;
    if (trial.select === 'two')
      await cards(page)
        .nth(1)
        .click({ modifiers: ['Meta'] });
    else await page.keyboard.press('Meta+a');
    await expect(page.getByRole('toolbar', { name: `已選 ${String(picked)} 個` })).toBeVisible();
    const before = await scrollTop(page);
    await page.getByRole('toolbar').getByRole('button', { name: '改狀態' }).click();
    const menu = page.getByRole('menu', { name: '改狀態' });
    const seen = await sample(page, menu);
    const after = await scrollTop(page);
    console.log(
      `TRIAL ${String(i + 1)} ${JSON.stringify(trial)} MENU ${seen} scroll ${String(before)}→${String(after)}`,
    );
    expect(seen).toBe('4'.repeat(25));
    await menu.getByRole('menuitemradio', { name: '待審核' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `${String(picked)} 個作品已改為「待審核」` }),
    ).toBeVisible();
    await expect
      .poll(async () => (await c.works.list({ status: 'in_review', limit: 1 })).total)
      .toBe(picked);
  });
}

for (const select of ['one', 'two'] as const) {
  test(`右鍵選單「改狀態 ▸」（130 件，${select === 'one' ? '單張' : '已選 2 張'}）`, async ({
    desktop,
  }) => {
    test.setTimeout(3 * 60_000);
    const { page, backend } = desktop;
    await page.setViewportSize({ width: 1440, height: 900 });
    const c = backend.client;
    await seed(page, c, 130);
    let picked = 1;
    if (select === 'two') {
      await cards(page)
        .nth(0)
        .click({ modifiers: ['Meta'] });
      await cards(page)
        .nth(1)
        .click({ modifiers: ['Meta'] });
      picked = 2;
    }
    const before = await scrollTop(page);
    await cards(page)
      .nth(select === 'two' ? 1 : 3)
      .click({ button: 'right' });
    const ctx = page.getByRole('menu').first();
    await expect(ctx).toBeVisible();
    await ctx.getByRole('menuitem', { name: /改狀態/ }).hover();
    const sub = page.getByRole('menu', { name: '改狀態' });
    await expect(sub).toBeVisible();
    const seen = await sample(page, sub);
    const after = await scrollTop(page);
    console.log(`CONTEXT ${select} MENU ${seen} scroll ${String(before)}→${String(after)}`);
    expect(seen).toBe('4'.repeat(25));
    await sub.getByRole('menuitemradio', { name: '待審核' }).click();
    await expect
      .poll(async () => (await c.works.list({ status: 'in_review', limit: 1 })).total)
      .toBe(picked);
  });
}
