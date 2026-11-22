import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-077 素材庫大圖預覽 (Quick Look): open with double-click, space or the
 * inspector picture; close with Esc, space or the backdrop; ← → move; zoom with
 * ⌘= ⌘- ⌘0 and double-click; drag pans; video plays; focus returns to the card.
 * Runs with motion off (default) and with QC_E2E_MOTION=on (it then grows from
 * the thumbnail). QC077_SHOTS=<dir> saves screenshots.
 */

const CLIP = fileURLToPath(new URL('../fixtures/media/portrait-8s.webm', import.meta.url));

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC077_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc077-${name}.png`) });
}

const box = async (target: Locator) => {
  const b = await target.boundingBox();
  if (b === null) throw new Error('no box');
  return b;
};

test('素材庫大圖預覽：開啟、關閉、切換、縮放、平移、視頻、焦點', async ({ desktop }) => {
  const { page, backend } = desktop;
  const c = backend.client;
  await c.assets.upload({ data: await pngBytes(2400, 1600, '#9E4428'), filename: 'big.png' });
  await c.assets.upload({ data: await pngBytes(640, 480, '#5E4130'), filename: 'small.png' });
  await c.assets.upload({ data: readFileSync(CLIP), filename: 'clip.webm' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '素材庫', exact: true })
    .click();
  const tile = (name: string) => page.locator('.atile', { hasText: name });
  await expect(tile('big.png')).toBeVisible();
  await expect(tile('clip.webm')).toBeVisible();
  const viewer = page.getByRole('dialog', { name: /大圖預覽/ });

  await test.step('雙擊開啟；先縮圖後原圖；Esc 關閉且焦點回到卡片', async () => {
    await tile('big.png').dblclick();
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText('big.png');
    await expect(viewer).toContainText('2400 × 1600');
    await expect(viewer.locator('.lightbox__pos')).toHaveText(/^\d+ \/ 3$/);
    await expect(viewer.locator('img[data-original="true"]')).toBeVisible({ timeout: 10_000 });
    await shot(page, '01-open');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(tile('big.png')).toBeFocused();
  });

  await test.step('空白鍵開啟與關閉；點遮罩關閉；詳情預覽圖點擊開啟', async () => {
    await tile('small.png').click();
    await page.keyboard.press(' ');
    await expect(viewer).toBeVisible();
    await page.keyboard.press(' ');
    await expect(viewer).toHaveCount(0);
    await expect(tile('small.png')).toBeFocused();

    await tile('small.png').dblclick();
    await expect(viewer).toBeVisible();
    await page.mouse.click(30, 700); // the backdrop, away from the picture
    await expect(viewer).toHaveCount(0);

    await page.locator('.viewer__preview--image img').click();
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText('small.png');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  });

  await test.step('←→ 切換同一篩選下的素材，在頭尾停住', async () => {
    await tile('big.png').dblclick();
    await expect(viewer).toBeVisible();
    const pos = viewer.locator('.lightbox__pos');
    const first = Number(((await pos.textContent()) ?? '').split(' / ')[0]);
    await page.keyboard.press('ArrowRight');
    await expect(pos).toHaveText(new RegExp(`^${String(Math.min(3, first + 1))} / 3$`));
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    await expect(pos).toHaveText('1 / 3');
    await expect(viewer.getByRole('button', { name: '上一個' })).toHaveCount(0);
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await expect(pos).toHaveText('3 / 3');
    await expect(viewer.getByRole('button', { name: '下一個' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  await test.step('縮放：⌘= ⌘- ⌘0、雙擊在適應與 100% 間切換、拖曳平移', async () => {
    await tile('big.png').dblclick();
    await expect(viewer.locator('img[data-original="true"]')).toBeVisible({ timeout: 10_000 });
    const fig = viewer.locator('.lightbox__figure');
    // With motion on the picture grows from its thumbnail first: measure once it has landed.
    await fig.evaluate((el) =>
      Promise.all(
        (el as unknown as { getAnimations(): { finished: Promise<unknown> }[] })
          .getAnimations()
          .map((a) => a.finished),
      ),
    );
    const fit = await box(fig);
    expect(fit.width).toBeLessThan(1440);
    await page.keyboard.press('Meta+=');
    const bigger = await box(fig);
    expect(bigger.width).toBeGreaterThan(fit.width);
    await page.keyboard.press('Meta+-');
    expect((await box(fig)).width).toBeCloseTo(fit.width, 0);
    await page.keyboard.press('Meta+=');
    await page.keyboard.press('Meta+0');
    expect((await box(fig)).width).toBeCloseTo(fit.width, 0);

    await fig.dblclick();
    await expect.poll(async () => (await box(fig)).width).toBeCloseTo(2400, 0);
    await shot(page, '02-zoom-100');
    const before = await box(fig);
    await page.mouse.move(700, 450);
    await page.mouse.down();
    await page.mouse.move(540, 380, { steps: 5 });
    await page.mouse.up();
    const after = await box(fig);
    expect(after.x).toBeLessThan(before.x);
    expect(after.y).toBeLessThan(before.y);
    await fig.dblclick();
    await expect.poll(async () => (await box(fig)).width).toBeCloseTo(fit.width, 0);
    await page.keyboard.press('Escape');
  });

  await test.step('視頻在預覽中播放', async () => {
    await tile('clip.webm').dblclick();
    await expect(viewer.locator('video')).toBeVisible();
    await expect
      .poll(() =>
        viewer
          .locator('video')
          .evaluate((v) => (v as unknown as { readyState: number }).readyState),
      )
      .toBeGreaterThan(0);
    await shot(page, '03-video');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  });

  await test.step('減少動態效果：仍可開啟與關閉', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await tile('small.png').dblclick();
    await expect(viewer).toBeVisible();
    await shot(page, '04-reduced-motion');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  });
});
