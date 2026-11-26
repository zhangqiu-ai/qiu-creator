import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-104 視頻全屏: the native `<video controls>` fullscreen button did nothing
 * because the main process denied every web permission, `fullscreen` included.
 * Each player (素材庫 inspector, 素材庫大圖預覽, 視頻作品編輯頁) now enters HTML
 * fullscreen and Esc leaves it. The e2e window stays hidden, so fullscreen fills
 * that window (`disableHtmlFullscreenWindowResize` in background runs) instead of
 * a macOS fullscreen Space; the real Space switch is checked by hand.
 */

const CLIP = fileURLToPath(new URL('../fixtures/media/portrait-8s.webm', import.meta.url));

/** Class of the element in HTML fullscreen, or null. */
const fullscreenClass = (page: Page): Promise<string | null> =>
  page.evaluate<string | null>('document.fullscreenElement?.className ?? null');

/** What the native fullscreen button does; resolves only when the request is allowed. */
async function enterFullscreen(page: Page, video: Locator, className: string): Promise<void> {
  await expect(video).toBeVisible();
  await video.evaluate((v) =>
    (v as unknown as { requestFullscreen(): Promise<void> }).requestFullscreen(),
  );
  await expect.poll(() => fullscreenClass(page)).toBe(className);
}

async function escapeFullscreen(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect.poll(() => fullscreenClass(page)).toBeNull();
}

test('視頻全屏：素材庫、大圖預覽、視頻作品；Esc 退出', async ({ desktop }) => {
  const { page, backend } = desktop;
  await backend.client.assets.upload({ data: readFileSync(CLIP), filename: 'clip.webm' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '素材庫', exact: true })
    .click();
  const tile = page.locator('.atile', { hasText: 'clip.webm' });
  await expect(tile).toBeVisible();

  await test.step('素材庫右側預覽的視頻可全屏，Esc 退出', async () => {
    await tile.click();
    await enterFullscreen(page, page.locator('video.viewer__media'), 'viewer__media');
    await escapeFullscreen(page);
  });

  await test.step('大圖預覽的視頻可全屏；Esc 只退出全屏，再按一次才關預覽', async () => {
    const viewer = page.getByRole('dialog', { name: /大圖預覽/ });
    await tile.dblclick();
    await enterFullscreen(page, viewer.locator('video'), 'lightbox__video');
    await escapeFullscreen(page);
    // Focus comes back to the 大圖預覽 (not the page body), so the next Esc reaches it.
    await expect(viewer).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(tile).toBeFocused();
  });

  await test.step('視頻作品編輯頁的播放器可全屏，Esc 退出', async () => {
    await page
      .getByRole('navigation', { name: '主導航' })
      .getByRole('button', { name: '全部作品', exact: true })
      .click();
    await page.keyboard.press('Meta+n');
    await page.getByRole('menu', { name: '新建作品' }).getByRole('menuitem').first().focus();
    await page.keyboard.press('3');
    const editor = page.locator('.tab-pane:not([hidden]) main.vw');
    await editor.getByRole('button', { name: '從素材庫選' }).click();
    await page
      .getByRole('complementary', { name: '素材抽屜' })
      .getByRole('option', { name: '插入 clip.webm' })
      .click();
    const video = editor.locator('video.vw__video');
    const className = (await video.getAttribute('class')) ?? '';
    await enterFullscreen(page, video, className);
    await escapeFullscreen(page);
    await expect(video).toBeVisible();
    await expect(editor.locator('.vw__player')).toBeFocused();
  });
});
