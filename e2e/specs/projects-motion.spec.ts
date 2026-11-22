import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-065 groundwork, on the QC-062 project pages:
 * - the 56 px rail scrolls when there are many projects, and its tooltip floats beside it;
 * - e2e runs with motion off (`<html data-motion="off">`);
 * - project pages in dark, English and 简体 (screenshots with QC065_SHOTS=<dir>);
 * - with QC_E2E_MOTION=on (and QC_E2E_VIDEO=<dir>) the drags run at normal speed for
 *   the motion recording (area 6: the copy flies into the row, the count fades in,
 *   rows come in and fade away), and a Reduce Motion frame is captured mid-drag.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC065_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc065-${name}.png`) });
}

const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const nav = (page: Page): Locator => page.getByRole('navigation', { name: /主導航|主导航|Main/ });
const rows = (page: Page) => page.locator('[data-project-row]');
const row = (page: Page, name: string) => page.locator('[data-project-row]', { hasText: name });
const card = (page: Page, title: string) =>
  page.locator('.card-grid .wcard', { has: page.locator('.wcard__title', { hasText: title }) });

/** Press, pass dnd-kit's 4 px threshold, glide over the target in `steps`, release. */
async function drag(page: Page, from: Locator, to: Locator, steps: number): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error('drag target not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 6, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
  await page.mouse.up();
  // The floating copy is gone once its drop animation has played.
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
}

test('收起的側欄：項目很多時可以捲動，名稱浮在旁邊', async ({ desktop }) => {
  test.skip(motionOn, 'covered by the normal run');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1200, height: 700 });
  for (let i = 1; i <= 30; i += 1) {
    await backend.client.projects.create({ name: `項目 ${String(i)}`, color: i % 8 });
  }
  await page.reload();
  await expect(rows(page)).toHaveCount(30);
  // Test mode: nothing animates.
  expect(await page.evaluate<string | undefined>('document.documentElement.dataset.motion')).toBe(
    'off',
  );

  await page.keyboard.press('Control+Meta+s');
  // Page-side code as strings: the e2e project has no DOM types.
  await expect
    .poll(() =>
      page.evaluate<number>("document.querySelector('.sb').getBoundingClientRect().width"),
    )
    .toBe(56);
  const last = page.locator('[data-tip="項目 30"]');
  // The last project is below the fold until the rail scrolls; 設定 stays pinned below.
  expect(
    await page.evaluate<boolean>(
      "(() => { const el = document.querySelector('.sb--rail .sb__scroll'); return el.scrollHeight > el.clientHeight; })()",
    ),
  ).toBe(true);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(nav(page).getByRole('button', { name: '設定', exact: true })).toBeInViewport();
  await last.hover();
  await expect(nav(page).locator('.sb__railtip')).toHaveText('項目 30');
  const tip = await nav(page).locator('.sb__railtip').boundingBox();
  expect(tip?.x ?? 0).toBeGreaterThan(56);
  await shot(page, 'rail-scrolled');

  // Test mode: a deleted project's row goes at once, with no fading copy left behind.
  await page.keyboard.press('Control+Meta+s');
  await page.locator('[data-tip="項目 30"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '刪除項目…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '刪除項目' }).click();
  await expect(rows(page)).toHaveCount(29);
  await expect(page.locator('[aria-hidden="true"][inert]')).toHaveCount(0);
});

test('項目頁：深色、English、简体', async ({ desktop }) => {
  test.skip(motionOn, 'covered by the normal run');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  const spring = await c.projects.create({ name: '春季選題', color: 1 });
  const trip = await c.projects.create({ name: '旅行', color: 2 });
  await c.works.create({
    title: '京都散步路線',
    markdown: '# 京都\n',
    source: 'mac-app',
    project_ids: [spring.id, trip.id],
  });
  await c.works.create({
    title: '秋天的咖啡店',
    markdown: '',
    source: 'mac-app',
    project_ids: [spring.id],
  });
  await c.works.create({ title: '相機入門筆記', markdown: '', source: 'mac-app' });
  await page.reload();

  await row(page, '春季選題').click();
  await expect(page.getByRole('group', { name: '項目概覽' })).toContainText('2 個作品');
  // The other project shows as a dot on the card it shares.
  await expect(card(page, '京都散步路線').locator('.wcard__dot')).toHaveCount(1);

  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'project-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await page.evaluate("window.creatorhub.setLanguage('en')");
  await expect(page.getByRole('group', { name: 'Project overview' })).toContainText('2 works');
  await expect(nav(page).getByRole('button', { name: 'Unsorted' })).toBeVisible();
  await shot(page, 'project-en');

  await page.evaluate("window.creatorhub.setLanguage('zh-Hans')");
  await expect(page.getByRole('group', { name: '项目概览' })).toContainText('2 个作品');
  await expect(nav(page).getByRole('button', { name: '未分类' })).toBeVisible();
  await shot(page, 'project-zh-Hans');
  await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
});

test('動效錄影：拖進項目、排序、取消（正常速度）與減少動態效果', async ({ desktop }) => {
  test.skip(!motionOn, 'records motion only with QC_E2E_MOTION=on');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  await c.projects.create({ name: '春季選題', color: 1 });
  await c.projects.create({ name: '旅行', color: 4 });
  await c.works.create({ title: '京都散步路線', markdown: '', source: 'mac-app' });
  await c.works.create({ title: '秋天的咖啡店', markdown: '', source: 'mac-app' });
  await page.reload();
  // Full motion: the main process did not switch it off.
  expect(
    await page.evaluate<string | undefined>('document.documentElement.dataset.motion'),
  ).toBeUndefined();
  await expect(card(page, '京都散步路線')).toBeVisible();
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop =
    videoDir === '' ? null : await startScreencast(page, videoDir, 'qc065-area6-projects');

  // Drop into a project: lift, highlight the row, fly into it shrinking; the count fades in.
  await drag(page, card(page, '京都散步路線'), row(page, '旅行'), 30);
  await expect(row(page, '旅行')).toContainText('1');
  // Reorder: rows make room, the insertion line shows, the row settles.
  await drag(page, row(page, '旅行'), row(page, '春季選題'), 25);
  await expect.poll(() => rows(page).allTextContents()).toEqual(['旅行1', '春季選題0']);
  // Cancel: let go over nothing, the copy flies back and nothing changes.
  await drag(page, card(page, '秋天的咖啡店'), page.locator('.page__header'), 25);
  await expect(row(page, '春季選題')).toContainText('0');
  // A new project's row comes in; a deleted one fades away and the others close up.
  await nav(page).getByRole('button', { name: '新建項目', exact: true }).first().click();
  await page.keyboard.type('冬季');
  await page.keyboard.press('Enter');
  await expect(row(page, '冬季')).toBeVisible();
  await row(page, '冬季').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '刪除項目…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '刪除項目' }).click();
  await expect(row(page, '冬季')).toHaveCount(0);

  // A hover repaints the window, so the recording's last frame shows the settled state.
  await card(page, '京都散步路線').hover();
  if (stop !== null) test.info().annotations.push({ type: 'video', description: await stop() });

  // Reduce Motion: no lift scale, the copy only shows its shadow (screenshot mid-drag).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const from = await card(page, '秋天的咖啡店').boundingBox();
  const over = await row(page, '春季選題').boundingBox();
  if (from === null || over === null) throw new Error('not visible');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 10 });
  await expect(page.locator('.drag-ghost')).toBeVisible();
  expect(
    await page.evaluate<string>(
      "getComputedStyle(document.querySelector('.drag-ghost')).transform",
    ),
  ).toBe('none');
  await shot(page, 'reduced-motion-drag');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
