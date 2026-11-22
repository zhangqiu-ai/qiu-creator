import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-065 area 2, overlays (DESIGN.md 動效 · 選單、右鍵選單、對話框、側面板、Toast):
 * dropdowns grow from their trigger, right-click menus appear at once, dialogs
 * grow from 0.97 over a fading scrim, side panels and the asset drawer come in
 * 24 px from the right; each leaves as a still, inert copy that fades away while
 * the real element is already gone. Toasts rise in, at most three, and the others
 * slide. In test mode nothing is copied or animated.
 * QC_E2E_MOTION=on QC_E2E_VIDEO=<dir> records it at normal speed; QC065_SHOTS=<dir>
 * saves the Reduce Motion frame.
 */

const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const nav = (page: Page) => page.getByRole('navigation', { name: '主導航' });
const card = (page: Page, title: string) =>
  page.locator('.card-grid .wcard', { has: page.locator('.wcard__title', { hasText: title }) });

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC065_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc065-${name}.png`) });
}

test('浮層：測試模式下關閉就消失，不留副本', async ({ desktop }) => {
  test.skip(motionOn, 'the recording run below covers it at normal speed');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const title of ['京都散步路線', '秋天的咖啡店', '相機入門筆記'])
    await backend.client.works.create({ title, markdown: `# ${title}\n`, source: 'mac-app' });
  await page.reload();
  await expect(page.locator('.card-grid .wcard')).toHaveCount(3);

  await card(page, '京都散步路線').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toHaveCount(0);

  await card(page, '京都散步路線').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^刪除…/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.scrim')).toHaveCount(0);

  await page.getByRole('main').getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByRole('menu', { name: '新建作品' })).toBeVisible();
  // The menu takes focus a frame after it opens; esc is read from there.
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.new-menu__pop')).toHaveCount(0);
  // No still copies were left anywhere.
  await expect(page.locator('[aria-hidden="true"][inert]')).toHaveCount(0);
});

test('浮層動效錄影（正常速度）與減少動態效果', async ({ desktop }) => {
  test.skip(!motionOn, 'records motion only with QC_E2E_MOTION=on');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const title of ['京都散步路線', '秋天的咖啡店', '相機入門筆記'])
    await backend.client.works.create({ title, markdown: `# ${title}\n`, source: 'mac-app' });
  await page.reload();
  await expect(page.locator('.card-grid .wcard')).toHaveCount(3);
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop =
    videoDir === '' ? null : await startScreencast(page, videoDir, 'qc065-area2-overlays');

  // A dropdown grows from its button and fades out when closed.
  await page.getByRole('main').getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByRole('menu', { name: '新建作品' })).toBeVisible();
  // The menu takes focus a frame after it opens; esc is read from there.
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  // The real menu is gone at once; its still copy fades and goes.
  await expect(page.getByRole('menu', { name: '新建作品' })).toHaveCount(0);
  await expect(page.locator('.new-menu__pop')).toHaveCount(0);

  // A right-click menu appears at once and fades out.
  await card(page, '秋天的咖啡店').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('.ctx-menu')).toHaveCount(0);

  // A dialog grows over its scrim, then fades.
  await card(page, '秋天的咖啡店').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^刪除…/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.scrim')).toHaveCount(0);

  // Three toasts stack, the newest lowest; the older ones slide up.
  await nav(page).getByRole('button', { name: '新建項目', exact: true }).first().click();
  await page.keyboard.type('春季選題');
  await page.keyboard.press('Enter');
  await nav(page).getByRole('button', { name: '作品庫', exact: true }).click();
  await card(page, '京都散步路線').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '項目' }).hover();
  await page.getByRole('menuitemcheckbox', { name: '春季選題' }).click();
  await card(page, '相機入門筆記').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '改狀態' }).hover();
  await page.getByRole('menuitemradio', { name: '待審核' }).click();
  await expect(page.locator('[data-toast]')).toHaveCount(3);

  // Side panels: the history panel and the asset drawer come in from the right.
  await card(page, '京都散步路線').click();
  await page.getByRole('button', { name: '歷史', exact: true }).click();
  await expect(page.locator('#history-panel')).toBeVisible();
  await page.getByRole('button', { name: '歷史', exact: true }).click();
  await expect(page.locator('#history-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '插入', exact: true }).click();
  await page.getByRole('menuitem', { name: /從素材庫/ }).click();
  const drawer = page.getByRole('complementary', { name: '素材抽屜' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await page.locator('.editor').first().hover();
  if (stop !== null) test.info().annotations.push({ type: 'video', description: await stop() });

  // Reduce Motion: overlays only fade (no scale, no slide).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await nav(page).getByRole('button', { name: '作品庫', exact: true }).click();
  await card(page, '秋天的咖啡店').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^刪除…/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page.evaluate<string>(
      "getComputedStyle(document.querySelector('.scrim > .dialog')).animationName",
    ),
  ).toBe('qc-fade-in');
  await shot(page, 'area2-reduced-dialog');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
