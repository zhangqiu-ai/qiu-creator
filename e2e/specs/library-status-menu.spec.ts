import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-073: with more works than one page (130), 改狀態 from the selection bar and
 * from the right-click menu stays open and changes every chosen work. The
 * menu used to close on any scroll, and a scroll that ended just before it
 * opened (Playwright scrolls a control into view before clicking it; for a
 * person, a trackpad's momentum) reached it a frame later. It still closes
 * when the area it was opened from really scrolls.
 */

const WORKS = 130;

/** Two frames: long enough for a scroll that happened before the menu opened to be delivered. */
const frames = (page: Page) =>
  page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

test('改狀態：作品超過一頁時選單不會自己關掉，選取的作品都改到；捲動來源區域時才關', async ({
  desktop,
}) => {
  test.setTimeout(120_000);
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  for (let i = 1; i <= WORKS; i += 1)
    await c.works.create({
      title: `作品 ${String(i).padStart(3, '0')}`,
      markdown: '',
      source: 'mac-app',
    });
  await page.reload();
  const grid = page.getByRole('region', { name: '作品', exact: true });
  const card = (title: string) =>
    grid.locator('.wcard', { has: page.locator('.wcard__title', { hasText: title }) });
  await expect(grid.locator('.wcard')).toHaveCount(60);
  const statusOf = async (title: string) =>
    (await c.works.list({ q: title, limit: 1 })).items[0]?.status;

  await test.step('選取工具列的「改狀態」', async () => {
    await card('作品 130').click({ modifiers: ['Meta'] });
    await card('作品 129').click({ modifiers: ['Meta'] });
    const bar = page.getByRole('toolbar', { name: '已選 2 個' });
    await bar.getByRole('button', { name: '改狀態' }).click();
    const menu = page.getByRole('menu', { name: '改狀態' });
    await expect(menu).toBeVisible();
    await frames(page);
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitemradio', { name: '待審核' }).click();
    await expect.poll(() => statusOf('作品 130')).toBe('in_review');
    await expect.poll(() => statusOf('作品 129')).toBe('in_review');
  });

  await test.step('右鍵選單裡的「改狀態」', async () => {
    await page.keyboard.press('Escape');
    await card('作品 128').click({ modifiers: ['Meta'] });
    await card('作品 127').click({ modifiers: ['Meta'] });
    await card('作品 127').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '已選 2 個作品的操作' });
    await expect(menu).toBeVisible();
    await frames(page);
    await menu.getByRole('menuitem', { name: '改狀態' }).hover();
    await page.getByRole('menuitemradio', { name: '待發布' }).click();
    await expect.poll(() => statusOf('作品 128')).toBe('ready');
    await expect.poll(() => statusOf('作品 127')).toBe('ready');
  });

  await test.step('來源區域真的捲動時，選單照樣關閉', async () => {
    await page.keyboard.press('Escape');
    await card('作品 126').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: /作品 126/ });
    await expect(menu).toBeVisible();
    await frames(page);
    await page.evaluate("document.querySelector('main.page').scrollTop += 300");
    await expect(menu).toHaveCount(0);
  });
});
