import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-065 area 3, 作品庫 (DESIGN.md 動效 · 列表新增／刪除、重排與篩選、卡片懸停與選取、載入骨架):
 * cards fade and scale in when added, fade out when deleted while the others
 * close the gap, and slide to new places when the filter changes (40 or fewer;
 * more cross-fade as a whole). A selected card's check mark settles in, the
 * batch bar rises in. After deleting, focus moves to the next card.
 * QC_E2E_MOTION=on QC_E2E_VIDEO=<dir> records it at normal speed; QC065_SHOTS=<dir>
 * saves the Reduce Motion frame.
 */

const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const grid = (page: Page) => page.getByRole('region', { name: '作品', exact: true });
const card = (page: Page, title: string) =>
  grid(page).locator('.wcard', { has: page.locator('.wcard__title', { hasText: title }) });
const titles = (page: Page) => grid(page).locator('.wcard__title').allTextContents();
const typeFilter = (page: Page, name: RegExp) =>
  page.getByRole('group', { name: '類型' }).getByRole('button', { name });

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC065_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc065-${name}.png`) });
}

const ARTICLES = ['京都散步路線', '秋天的咖啡店', '相機入門筆記', '早晨寫作習慣', '旅行打包清單'];
const POSTS = ['秋日紅葉', '湖邊散步', '城市夜景'];

test('作品庫：刪除後焦點到下一張、篩選切換（少量與大量）', async ({ desktop }) => {
  test.skip(motionOn, 'the recording run below covers it at normal speed');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  for (const title of ARTICLES) await c.works.create({ title, markdown: '', source: 'mac-app' });
  for (const title of POSTS) await c.works.create({ title, type: 'image', source: 'mac-app' });
  await page.reload();
  await expect(grid(page).locator('.wcard')).toHaveCount(8);

  await test.step('篩選切換：卡片換成符合的那幾張', async () => {
    await typeFilter(page, /貼圖/).click();
    await expect(grid(page).locator('.wcard')).toHaveCount(3);
    expect((await titles(page)).sort()).toEqual([...POSTS].sort());
    await typeFilter(page, /全部/).click();
    await expect(grid(page).locator('.wcard')).toHaveCount(8);
  });

  let articlesLeft = ARTICLES.length;
  await test.step('刪除一張：焦點到下一張', async () => {
    const before = await titles(page);
    const target = before[2] ?? '';
    const next = before[3] ?? '';
    await card(page, target).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^刪除…/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /移到最近刪除|刪除/ })
      .last()
      .click();
    await expect(card(page, target)).toHaveCount(0);
    if (ARTICLES.includes(target)) articlesLeft -= 1;
    await expect(card(page, next)).toBeFocused();
  });

  await test.step('超過 40 張：篩選整片換上，不逐張移動', async () => {
    for (let i = 1; i <= 40; i += 1)
      await c.works.create({ title: `大量 ${String(i)}`, markdown: '', source: 'mac-app' });
    await expect(grid(page).locator('.wcard')).toHaveCount(47);
    await typeFilter(page, /文章/).click();
    await expect(grid(page).locator('.wcard')).toHaveCount(articlesLeft + 40);
    await typeFilter(page, /全部/).click();
    await expect(grid(page).locator('.wcard')).toHaveCount(47);
  });
});

test('作品庫動效錄影（正常速度）與減少動態效果', async ({ desktop }) => {
  test.skip(!motionOn, 'records motion only with QC_E2E_MOTION=on');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  for (const title of ARTICLES) await c.works.create({ title, markdown: '', source: 'mac-app' });
  for (const title of POSTS) await c.works.create({ title, type: 'image', source: 'mac-app' });
  await page.reload();
  await expect(grid(page).locator('.wcard')).toHaveCount(8);
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop =
    videoDir === '' ? null : await startScreencast(page, videoDir, 'qc065-area3-library');

  // Hover: only the shadow and border change.
  await card(page, '秋天的咖啡店').hover();
  // Select two: the check marks settle in, the batch bar rises.
  await card(page, '秋天的咖啡店').click({ modifiers: ['Meta'] });
  await card(page, '相機入門筆記').click({ modifiers: ['Meta'] });
  await expect(page.getByRole('toolbar', { name: '已選 2 個' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: '已選 2 個' })).toHaveCount(0);
  // Filter: the cards that stay slide to their new places, the others fade.
  await typeFilter(page, /貼圖/).click();
  await expect(grid(page).locator('.wcard')).toHaveCount(3);
  await typeFilter(page, /全部/).click();
  await expect(grid(page).locator('.wcard')).toHaveCount(8);
  // Delete two: they fade out and the others close the gap; 復原 brings them back.
  await card(page, '秋天的咖啡店').click({ modifiers: ['Meta'] });
  await card(page, '相機入門筆記').click({ modifiers: ['Meta'] });
  await page.keyboard.press('Meta+Backspace');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /移到最近刪除|刪除/ })
    .last()
    .click();
  await expect(grid(page).locator('.wcard')).toHaveCount(6);
  await page
    .locator('.toast', { hasText: '2 個作品' })
    .getByRole('button', { name: '復原' })
    .click();
  await expect(grid(page).locator('.wcard')).toHaveCount(8);
  // Many cards: a filter change cross-fades the grid instead of moving 47 cards.
  for (let i = 1; i <= 40; i += 1)
    await c.works.create({ title: `大量 ${String(i)}`, markdown: '', source: 'mac-app' });
  await expect(grid(page).locator('.wcard')).toHaveCount(48);
  await typeFilter(page, /貼圖/).click();
  await expect(grid(page).locator('.wcard')).toHaveCount(3);
  await typeFilter(page, /全部/).click();
  await expect(grid(page).locator('.wcard')).toHaveCount(48);
  // A hover repaints the window, so the recording's last frame shows the settled grid.
  await card(page, '京都散步路線').hover();
  if (stop !== null) test.info().annotations.push({ type: 'video', description: await stop() });

  // Reduce Motion: the check mark only fades in, no scale.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await card(page, '湖邊散步').click({ modifiers: ['Meta'] });
  await expect(card(page, '湖邊散步').locator('.wcard__check')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate<string>("getComputedStyle(document.querySelector('.wcard__check')).transform"),
    )
    .toBe('none');
  await shot(page, 'area3-reduced-selected');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
