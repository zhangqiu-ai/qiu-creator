import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-071: the save chip says nothing while everything is saved. 未儲存 shows
 * faintly while typing, 已儲存 for about 2 s after a save and then goes; a
 * conflict stays on screen and can be clicked. The words beside the chip
 * never move. QC071_SHOTS=<dir> saves the screenshots.
 */

const pane = (page: Page) => page.locator('.tab-pane:not([hidden])');
const chip = (page: Page) => pane(page).locator('.save-status .save-chip');
const words = (page: Page) => pane(page).locator('.editor__words');

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC071_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc071-${name}.png`) });
}

test('平常不顯示；存好後短暫「已儲存」再消失；字數不跳動', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await backend.client.works.create({ title: '京都散步', markdown: '# 京都\n', source: 'mac-app' });
  await page.reload();
  await page.locator('.card-grid .wcard', { hasText: '京都散步' }).click();
  await expect(words(page)).toBeVisible();
  // Opening a saved work: nothing about saving.
  await expect(chip(page)).toHaveCount(0);
  await shot(page, '01-idle');

  await pane(page).locator('[contenteditable="true"]').first().click();
  await page.keyboard.type('早晨的竹林。');
  await expect(chip(page)).toHaveText('已儲存', { timeout: 10_000 });
  await shot(page, '02-saved');
  const withChip = await words(page).boundingBox();

  // About 2 s later it is gone, and the words are still where they were.
  await expect(chip(page)).toHaveCount(0, { timeout: 6_000 });
  await shot(page, '03-gone');
  expect((await words(page).boundingBox())?.x).toBe(withChip?.x);
});

test('衝突時持續顯示，點擊可開啟處理', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const created = await backend.client.works.create({
    title: '衝突作品',
    markdown: '# 衝突\n',
    source: 'mac-app',
  });
  await page.reload();
  await page.locator('.card-grid .wcard', { hasText: '衝突作品' }).click();
  await expect(words(page)).toBeVisible();
  // Another writer changes the work while unsaved edits are waiting, so the autosave gets a 409.
  await pane(page).locator('[contenteditable="true"]').first().click();
  await page.keyboard.type('我的修改');
  await backend.client.works.patch(created.id, {
    base_revision: created.current_revision_id,
    markdown: '# 衝突\n別處的修改\n',
  });
  // Unsaved edits plus a newer revision: autosave pauses; 比對並合併 starts the conflict flow.
  await pane(page).getByRole('button', { name: '比對並合併' }).click();
  await expect(chip(page)).toHaveText('衝突');
  await expect(chip(page)).toHaveClass(/save-chip--alert/);
  await shot(page, '04-conflict');
  // It does not go away by itself, and it is a button the user can press.
  await page.waitForTimeout(2_500);
  await expect(chip(page)).toHaveText('衝突');
  await expect(chip(page)).toHaveAttribute('role', 'button');
});
