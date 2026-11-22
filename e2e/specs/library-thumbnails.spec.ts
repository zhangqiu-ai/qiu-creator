import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-061 作品庫卡片縮圖: an image post shows its first image, an article its
 * first Markdown image or else a text preview, a video a frame (here the test
 * service has no ffmpeg, so the App grabs the frame off-screen and uploads it;
 * the list never holds a <video>), and a card whose image is gone shows its
 * icon and the missing-media badge, never a blank.
 * Set QC061_SHOTS=<dir> to also save screenshots; CREATORHUB_E2E_APP runs it
 * against a packaged build.
 */

const CLIP = fileURLToPath(new URL('../fixtures/media/portrait-8s.webm', import.meta.url));

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC061_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc061-${name}.png`) });
}

const grid = (page: Page): Locator => page.locator('.card-grid');
const card = (page: Page, title: string): Locator =>
  grid(page).locator('.wcard', { has: page.locator('.wcard__title', { hasText: title }) });

/** True once the card's <img> has decoded a real picture. */
async function imageShown(c: Locator): Promise<boolean> {
  const img = c.locator('img.wcard__media');
  if ((await img.count()) === 0) return false;
  return img.evaluate(
    (el) =>
      (el as unknown as { complete: boolean; naturalWidth: number }).complete &&
      (el as unknown as { naturalWidth: number }).naturalWidth > 0,
  );
}

test('作品庫卡片：貼圖、文章圖片、文字預覽、視頻幀、缺檔退回圖示', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;

  const red = (
    await c.assets.upload({ data: await pngBytes(900, 600, '#C2410C'), filename: 'maple.png' })
  ).asset;
  const teal = (
    await c.assets.upload({ data: await pngBytes(600, 800, '#0F766E'), filename: 'lake.png' })
  ).asset;
  const clip = (await c.assets.upload({ data: readFileSync(CLIP), filename: 'arashiyama.webm' }))
    .asset;
  backend.db
    .prepare('UPDATE assets SET duration = 8, width = 360, height = 640 WHERE id = ?')
    .run(clip.id);

  const post = await c.works.create({ title: '秋日紅葉', type: 'image', source: 'mac-app' });
  await c.works.patch(post.id, {
    base_revision: post.current_revision_id,
    images: [red.id, teal.id],
  });

  const withImage = await c.works.create({
    title: '湖邊散步',
    markdown: '# 湖邊散步\n\n開頭。\n',
    source: 'mac-app',
  });
  const { src } = await c.works.attachMedia(withImage.id, teal.id);
  const fresh = await c.works.get(withImage.id);
  await c.works.patch(withImage.id, {
    base_revision: fresh.current_revision_id,
    markdown: `# 湖邊散步\n\n開頭。\n\n![湖](${src})\n`,
  });

  await c.works.create({
    title: '早晨寫作習慣',
    markdown:
      '# 早晨寫作習慣\n\n每天早上七點起床，先寫三百字再看手機。**不求寫好**，只求寫下。寫完之後泡一杯咖啡，把昨天的段落讀一遍，刪掉多餘的形容詞。',
    source: 'mac-app',
  });
  await c.works.create({ title: '空白草稿', markdown: '', source: 'mac-app' });

  const video = await c.works.create({ title: '嵐山竹林', type: 'video', source: 'mac-app' });
  await c.works.patch(video.id, {
    base_revision: video.current_revision_id,
    video_asset_id: clip.id,
  });

  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '作品庫', exact: true })
    .click();
  await expect(grid(page).locator('.wcard')).toHaveCount(5);

  await test.step('貼圖與文章的圖片都顯示真正的縮圖，列表裡沒有 <video>', async () => {
    await expect.poll(() => imageShown(card(page, '秋日紅葉'))).toBe(true);
    await expect.poll(() => imageShown(card(page, '湖邊散步'))).toBe(true);
    await expect(grid(page).locator('video')).toHaveCount(0);
  });

  await test.step('沒有圖片的文章用文字預覽（不重複標題、去掉 Markdown），空白的文章用圖示', async () => {
    const text = card(page, '早晨寫作習慣').locator('.wcard__text');
    await expect(text).toContainText('每天早上七點起床');
    await expect(text).toContainText('不求寫好');
    await expect(text).not.toContainText('**');
    await expect(text).not.toContainText('早晨寫作習慣');
    const empty = card(page, '空白草稿');
    await expect(empty.locator('img')).toHaveCount(0);
    await expect(empty.locator('.wcard__cover svg')).toBeVisible();
  });

  await test.step('視頻：服務沒有 ffmpeg，App 在畫面外截幀上傳，卡片換成那一幀', async () => {
    await expect.poll(() => imageShown(card(page, '嵐山竹林')), { timeout: 15_000 }).toBe(true);
    await expect(card(page, '嵐山竹林')).toContainText('0:08');
    const listed = (await c.works.list({ limit: 10 })).items.find((w) => w.id === video.id);
    expect(listed?.card_image).toMatchObject({ needs_frame: false });
    await expect(grid(page).locator('video')).toHaveCount(0);
    await shot(page, 'zh-Hant-1-grid');
  });

  await test.step('圖片檔不見了：顯示圖示與缺少媒體徽章，不留空白', async () => {
    // An image post's files are in its front matter (works.get().media), not Markdown references.
    const detail = await c.works.get(post.id);
    for (const image of detail.media?.images ?? []) {
      rmSync(path.join(backend.home, 'library', 'works', post.id, image.path), { force: true });
    }
    await page.reload();
    await expect(grid(page).locator('.wcard')).toHaveCount(5);
    const broken = card(page, '秋日紅葉');
    await expect(broken.locator('.wcard__badge--bad')).toBeVisible();
    await expect.poll(() => imageShown(broken)).toBe(false);
    await expect(broken.locator('.wcard__cover svg').first()).toBeVisible();
    await shot(page, 'zh-Hant-2-missing');
  });

  if ((process.env['QC061_SHOTS'] ?? '') !== '') {
    await test.step('截圖：English 與深色', async () => {
      await page.evaluate("window.creatorhub.setLanguage('en')");
      await shot(page, 'en-grid');
      await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot(page, 'dark-grid');
      await page.emulateMedia({ colorScheme: null });
    });
  }
});
