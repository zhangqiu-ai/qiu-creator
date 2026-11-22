import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';
import { settleAfterDrop } from '../fixtures/dnd.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-065 area 1, the shell (DESIGN.md 動效 · 頁面切換、側欄收合、編輯分頁):
 * - switching pages from the sidebar fades the new page in and puts focus on its title;
 * - collapsing or expanding the sidebar slides the content to its new place;
 * - opening and closing tabs lets the others slide into place; tabs reorder with
 *   dnd-kit (the others move aside), and Esc during a drag changes nothing.
 * With QC_E2E_MOTION=on QC_E2E_VIDEO=<dir> it records all of it at normal speed;
 * QC065_SHOTS=<dir> saves the Reduce Motion frame.
 */

const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const tabs = (page: Page) => page.getByRole('tablist', { name: '已開啟的作品' }).getByRole('tab');
const tab = (page: Page, title: string) =>
  page.getByRole('tablist', { name: '已開啟的作品' }).getByRole('tab', { name: new RegExp(title) });
const order = (page: Page) =>
  page.locator('.tabbar__strip [role="tab"] .tab__title').allTextContents();

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC065_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc065-${name}.png`) });
}

/** Press on a tab, pass dnd-kit's 4 px threshold, glide along the bar. */
async function pickUp(page: Page, from: Locator, toX: number, steps: number): Promise<void> {
  const a = await from.boundingBox();
  if (a === null) throw new Error('tab not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 - 10, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(toX, a.y + a.height / 2, { steps });
}

async function openWorks(page: Page, titles: readonly string[]): Promise<void> {
  for (const title of titles) {
    await nav(page).getByRole('button', { name: '作品庫', exact: true }).click();
    await page.locator('.card-grid .wcard', { hasText: title }).click();
    await expect(tab(page, title)).toBeVisible();
  }
}

test('殼層：換頁焦點到標題、側欄收合後內容到位、分頁拖曳排序與取消', async ({ desktop }) => {
  test.skip(motionOn, 'the recording run below covers it at normal speed');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const title of ['甲篇長文', '乙篇草稿', '丙篇筆記'])
    await backend.client.works.create({ title, markdown: `# ${title}\n`, source: 'mac-app' });
  await page.reload();

  await test.step('從側欄換頁：焦點到新頁標題', async () => {
    await nav(page).getByRole('button', { name: '素材庫', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: '素材庫' })).toBeFocused();
    await nav(page).getByRole('button', { name: '作品庫', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: '作品庫' })).toBeFocused();
  });

  await test.step('收起與展開側欄：內容直接到最終位置', async () => {
    const left = () =>
      page.evaluate<number>("document.querySelector('.shell__main').getBoundingClientRect().left");
    await page.keyboard.press('Control+Meta+s');
    await expect.poll(left).toBe(56);
    await page.keyboard.press('Control+Meta+s');
    await expect.poll(left).toBe(232);
  });

  await test.step('分頁：拖曳排序，Esc 取消不變', async () => {
    await openWorks(page, ['甲篇長文', '乙篇草稿', '丙篇筆記']);
    await expect(tabs(page)).toHaveCount(3);
    expect(await order(page)).toEqual(['甲篇長文', '乙篇草稿', '丙篇筆記']);
    const first = await tab(page, '甲篇長文').boundingBox();
    // Esc while dragging puts the tab back.
    await pickUp(page, tab(page, '丙篇筆記'), (first?.x ?? 0) + 8, 10);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settleAfterDrop(page);
    expect(await order(page)).toEqual(['甲篇長文', '乙篇草稿', '丙篇筆記']);
    // A drop moves it.
    await pickUp(page, tab(page, '丙篇筆記'), (first?.x ?? 0) + 8, 10);
    await page.mouse.up();
    await settleAfterDrop(page);
    await expect.poll(() => order(page)).toEqual(['丙篇筆記', '甲篇長文', '乙篇草稿']);
    // A click on a tab still switches to it (the 4 px threshold).
    await tab(page, '乙篇草稿').click();
    await expect(tab(page, '乙篇草稿')).toHaveAttribute('aria-selected', 'true');
  });
});

test('殼層動效錄影（正常速度）與減少動態效果', async ({ desktop }) => {
  test.skip(!motionOn, 'records motion only with QC_E2E_MOTION=on');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const title of ['甲篇長文', '乙篇草稿', '丙篇筆記'])
    await backend.client.works.create({ title, markdown: `# ${title}\n`, source: 'mac-app' });
  await page.reload();
  await expect(page.locator('.card-grid .wcard')).toHaveCount(3);
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop = videoDir === '' ? null : await startScreencast(page, videoDir, 'qc065-area1-shell');

  // Page switches: the new page fades in, nothing slides.
  for (const name of ['素材庫', 'AI 工作台', '作品庫']) {
    await nav(page).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  }
  // The sidebar collapses and expands; the content slides to its new place.
  const left = () =>
    page.evaluate<number>("document.querySelector('.shell__main').getBoundingClientRect().left");
  await page.keyboard.press('Control+Meta+s');
  await expect.poll(left).toBe(56);
  await page.keyboard.press('Control+Meta+s');
  await expect.poll(left).toBe(232);

  // Tabs open (the others slide), reorder (they move aside), cancel, close (they fill in).
  await openWorks(page, ['甲篇長文', '乙篇草稿', '丙篇筆記']);
  const first = await tab(page, '甲篇長文').boundingBox();
  await pickUp(page, tab(page, '丙篇筆記'), (first?.x ?? 0) + 8, 30);
  await page.mouse.up();
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  await settleAfterDrop(page);
  await expect.poll(() => order(page)).toEqual(['丙篇筆記', '甲篇長文', '乙篇草稿']);
  await pickUp(page, tab(page, '乙篇草稿'), (first?.x ?? 0) + 8, 30);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  await settleAfterDrop(page);
  expect(await order(page)).toEqual(['丙篇筆記', '甲篇長文', '乙篇草稿']);
  await tab(page, '甲篇長文').getByRole('button', { name: /關閉/ }).click();
  await expect(tabs(page)).toHaveCount(2);
  await tab(page, '乙篇草稿').hover();
  if (stop !== null) test.info().annotations.push({ type: 'video', description: await stop() });

  // Reduce Motion: a tab being dragged has no lift scale; the others still make room.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pickUp(page, tab(page, '乙篇草稿'), (first?.x ?? 0) + 8, 10);
  await expect(page.locator('.drag-ghost--tab')).toBeVisible();
  expect(
    await page.evaluate<string>(
      "getComputedStyle(document.querySelector('.drag-ghost--tab')).transform",
    ),
  ).toBe('none');
  await shot(page, 'area1-reduced-tab-drag');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
