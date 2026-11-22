import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-065 area 5, 設定與 AI (DESIGN.md 動效 · 分段控制、AI 分頁指示器、頁面切換、
 * 測試連線、AI 任務進度): a segment's or the AI tab's highlight glides to the new
 * choice, a settings category fades in, the connection-test card grows to its
 * result and the result icon comes in from 0.9. In test mode nothing glides.
 * QC_E2E_MOTION=on QC_E2E_VIDEO=<dir> records it at normal speed; QC065_SHOTS=<dir>
 * saves the Reduce Motion frame.
 */

const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const models = (ids: string[]) => ({
  body: { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) },
});

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC065_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc065-${name}.png`) });
}

function at(page: Page) {
  const nav = page.getByRole('navigation', { name: '主導航' });
  const cats = page.getByRole('navigation', { name: '設定分類' });
  return {
    nav,
    cat: (name: RegExp): Locator => cats.getByRole('button', { name }),
    view: page.getByRole('group', { name: '檢視' }),
    detail: page.locator('.set-md__detail'),
    result: page.locator('#ai-test-result'),
  };
}

test('設定與 AI：分段切換、設定分類、測試連線（測試模式不滑動）', async ({ desktop }) => {
  test.skip(motionOn, 'the recording run below covers it at normal speed');
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await backend.client.works.create({ title: '京都散步路線', markdown: '', source: 'mac-app' });
  await page.reload();
  const ui = at(page);

  await ui.view.getByRole('button', { name: '列表' }).click();
  await expect(ui.view.getByRole('button', { name: '列表' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await ui.view.getByRole('button', { name: '網格' }).click();
  // Test mode: the highlight jumps; no gliding copy is ever left behind.
  await expect(page.locator('.seg-glide')).toHaveCount(0);
  await expect(page.locator('[data-gliding]')).toHaveCount(0);

  await ui.nav.getByRole('button', { name: '設定', exact: true }).click();
  await ui.cat(/^本機服務/).click();
  await expect(ui.cat(/^本機服務/)).toHaveAttribute('aria-current', 'page');
  await ui.cat(/^AI 服務/).click();
  const row = page.locator('.set-pv', { hasText: 'GPT' });
  await row.click();
  await ui.detail.getByLabel('GPT API 金鑰').fill('sk-fake-openai-qc065');
  await ui.detail.getByRole('button', { name: '存到鑰匙圈' }).click();
  await expect(ui.result).toContainText('尚未測試');
  upstream.modelsReply = models(['gpt-5.5', 'gpt-5.5-mini']);
  await ui.detail.getByRole('button', { name: '測試連線' }).click();
  await expect(ui.result).toContainText('連線正常');
});

test('設定與 AI 動效錄影（正常速度）與減少動態效果', async ({ desktop }) => {
  test.skip(!motionOn, 'records motion only with QC_E2E_MOTION=on');
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await backend.client.works.create({
    title: '京都散步路線',
    markdown: '# 京都\n',
    source: 'mac-app',
  });
  await backend.client.works.create({ title: '秋日紅葉', type: 'image', source: 'mac-app' });
  await page.reload();
  const ui = at(page);
  await expect(page.locator('.card-grid .wcard')).toHaveCount(2);
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop =
    videoDir === '' ? null : await startScreencast(page, videoDir, 'qc065-area5-settings-ai');

  // Segments: the highlight glides to the new choice, then hands back to the real one.
  // (QC-069: the library's type filter is a popover now; its view switch is the segment.)
  for (const name of ['列表', '網格', '列表', '網格']) {
    await ui.view.getByRole('button', { name }).click();
    await expect(page.locator('.seg-glide')).toHaveCount(0);
  }
  await expect(page.locator('[data-gliding]')).toHaveCount(0);

  // The AI panel's tab underline glides between 改寫 and 圖片 (標題 moved to the preview, QC-076).
  await page.locator('.card-grid .wcard', { hasText: '京都散步路線' }).click();
  const aiTabs = page.getByRole('tablist', { name: 'AI' });
  await aiTabs.getByRole('tab', { name: '圖片' }).click();
  await aiTabs.getByRole('tab', { name: '改寫' }).click();
  await expect(page.locator('.seg-glide')).toHaveCount(0);

  // Settings: each category fades in; the test card grows to its result.
  await ui.nav.getByRole('button', { name: '設定', exact: true }).click();
  for (const name of [/^本機服務/, /^外觀/, /^AI 服務/]) {
    await ui.cat(name).click();
    await expect(ui.cat(name)).toHaveAttribute('aria-current', 'page');
  }
  await page.locator('.set-pv', { hasText: 'GPT' }).click();
  await ui.detail.getByLabel('GPT API 金鑰').fill('sk-fake-openai-qc065');
  await ui.detail.getByRole('button', { name: '存到鑰匙圈' }).click();
  await expect(ui.result).toContainText('尚未測試');
  upstream.modelsReply = { ...models(['gpt-5.5', 'gpt-5.5-mini', 'gpt-image-2']), delayMs: 600 };
  await ui.detail.getByRole('button', { name: '測試連線' }).click();
  await expect(ui.result).toContainText('連線正常');
  upstream.modelsReply = { status: 401, body: { error: { message: 'bad key' } } };
  await ui.detail.getByRole('button', { name: '測試連線' }).click();
  await expect(ui.result).toContainText('金鑰');
  await ui.result.hover();
  if (stop !== null) test.info().annotations.push({ type: 'video', description: await stop() });

  // Reduce Motion: segments switch without gliding.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ui.nav.getByRole('button', { name: '全部作品', exact: true }).click();
  await ui.view.getByRole('button', { name: '列表' }).click();
  expect(await page.locator('.seg-glide').count()).toBe(0);
  await shot(page, 'area5-reduced-segment');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
