import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { videoResult } from '../../services/mac-server/test/fake-gemini-video.js';
import { test } from '../fixtures/desktop.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-065 area 6 (added): the save label and AI task completion
 * (DESIGN.md 動效 · 儲存狀態、AI 任務進度). 未儲存 → 儲存中 → 已儲存 cross-fades
 * its text and icon and takes its new width smoothly, never flashing; when an
 * AI analysis finishes, the progress card fades out and the result comes in.
 * QC_E2E_MOTION=on QC_E2E_VIDEO=<dir> records it at normal speed; QC065_SHOTS=<dir>
 * saves the Reduce Motion frame.
 */

const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const CLIP = fileURLToPath(new URL('../fixtures/media/portrait-8s.webm', import.meta.url));
const GEMINI_KEY = 'AIzaFakeQc065E2eKey0123456789';
const RESULT = videoResult({});
const nav = (page: Page) => page.getByRole('navigation', { name: '主導航' });
const saveChip = (page: Page) => page.locator('.tab-pane:not([hidden]) .save-status .save-chip');

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC065_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc065-${name}.png`) });
}

async function typeAndSave(page: Page, text: string): Promise<void> {
  await page.locator('.tab-pane:not([hidden]) [contenteditable="true"]').first().click();
  await page.keyboard.type(text);
  await expect(saveChip(page)).toHaveText('已儲存', { timeout: 10_000 });
}

test('儲存狀態：只留一個標籤，最後是「已儲存」', async ({ desktop }) => {
  test.skip(motionOn, 'the recording run below covers it at normal speed');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await backend.client.works.create({
    title: '京都散步路線',
    markdown: '# 京都\n',
    source: 'mac-app',
  });
  await page.reload();
  await page.locator('.card-grid .wcard', { hasText: '京都散步路線' }).click();
  await typeAndSave(page, '早晨的竹林。');
  // Test mode: the old label is gone at once, never two side by side.
  await expect(saveChip(page).locator('.save-chip__in')).toHaveCount(1);
});

test('儲存狀態與 AI 完成的動效錄影（正常速度）與減少動態效果', async ({ desktop }) => {
  test.skip(!motionOn, 'records motion only with QC_E2E_MOTION=on');
  const { page, backend, geminiVideo } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await backend.client.works.create({
    title: '京都散步路線',
    markdown: '# 京都\n',
    source: 'mac-app',
  });
  const clip = (
    await backend.client.assets.upload({ data: readFileSync(CLIP), filename: 'arashiyama.webm' })
  ).asset;
  backend.db
    .prepare('UPDATE assets SET duration = 8, width = 360, height = 640 WHERE id = ?')
    .run(clip.id);
  await backend.client.ai.setKey('gemini', GEMINI_KEY);
  geminiVideo.generateReplies.push({ body: RESULT });
  // Keep the job running for a moment (about 40 × 20 ms polls) so the progress card shows.
  geminiVideo.processingPolls = 40;
  await page.reload();
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop =
    videoDir === '' ? null : await startScreencast(page, videoDir, 'qc065-area6-ai-save');

  // 未儲存 → 儲存中 → 已儲存: the label cross-fades and the chip resizes smoothly.
  await page.locator('.card-grid .wcard', { hasText: '京都散步路線' }).click();
  await typeAndSave(page, '早晨的竹林，');
  await typeAndSave(page, '光從葉間落下。');
  await expect(saveChip(page).locator('.save-chip__in')).toHaveCount(1);

  // An AI analysis: the progress card fades out and the result comes in.
  await nav(page).getByRole('button', { name: 'AI 工作台', exact: true }).click();
  const main = page.locator('main.page--aiw');
  await main.getByRole('button', { name: '選擇視頻' }).first().click();
  await page
    .getByRole('dialog', { name: '選擇視頻' })
    .locator('.aiw-pick__item', { hasText: 'arashiyama.webm' })
    .click();
  await main.getByRole('button', { name: '分析', exact: true }).click();
  await page
    .getByRole('dialog', { name: /Google/ })
    .getByRole('button', { name: /同意並上傳分析|上傳並分析/ })
    .click();
  await expect(main.locator('.aiw__done')).toBeVisible({ timeout: 15_000 });
  await expect(main.locator('.aiw__run')).toHaveCount(0);
  await main.locator('.aiw__done').hover();
  if (stop !== null) test.info().annotations.push({ type: 'video', description: await stop() });

  // Reduce Motion: the result only fades in (no scale).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page.evaluate<string>(
      "getComputedStyle(document.querySelector('.aiw__done')).animationName",
    ),
  ).toBe('none');
  await shot(page, 'area6-reduced-ai-result');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
