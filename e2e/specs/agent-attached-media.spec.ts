import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { createClient } from '../../packages/api-client/src/index.js';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-102: what an agent attaches to an image or video work (the requests of
 * MCP `work_attach_asset`) shows in the open editor and on the library cards.
 * Set QC102_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

const CLIP = fileURLToPath(new URL('../fixtures/media/portrait-8s.webm', import.meta.url));

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC102_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc102-${name}.png`) });
}

test('Agent 掛上的圖片、視頻和封面在編輯頁與作品卡看得到', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  // QC-103/QC-111: agents here create works with Traditional titles, like
  // the user's own data in these screens; with the global 作品文字字體 set
  // to zh-Hant they stay as written (conversion has its own tests).
  await backend.client.settings.setTextScript({ script: 'zh-Hant' });
  const token = backend.tokens.create({ name: 'Gemini', scopes: ['read', 'import', 'write'] });
  const agent = createClient({ baseUrl: backend.baseUrl, token: token.secret });
  const picture = async (name: string, color: string) =>
    (await agent.assets.upload({ data: await pngBytes(600, 800, color), filename: name })).asset;

  const pictures = [
    await picture('a.png', '#9E4428'),
    await picture('b.png', '#3E4A57'),
    await picture('c.png', '#C49A3A'),
  ];
  const poster = await picture('poster.png', '#2E6B4F');
  const clip = (await agent.assets.upload({ data: readFileSync(CLIP), filename: 'walk.webm' }))
    .asset;
  const post = await agent.works.create(
    { title: '嵐山貼圖', type: 'image', description: '楓葉。' },
    { idempotencyKey: 'qc102-e2e-post' },
  );
  const film = await agent.works.create(
    { title: '嵐山短片', type: 'video' },
    { idempotencyKey: 'qc102-e2e-film' },
  );

  const nav = page.getByRole('navigation', { name: '主導航' });
  const card = (id: string) => page.locator(`[data-work-id="${id}"]`);
  const editor = page.locator('.tab-pane:not([hidden]) main');
  const toLibrary = () => nav.getByRole('button', { name: '全部作品', exact: true }).click();

  await test.step('貼圖：編輯頁開著，Agent 掛圖後圖片出現', async () => {
    await toLibrary();
    await card(post.id).dblclick();
    await expect(editor.getByRole('textbox', { name: '標題' })).toHaveValue('嵐山貼圖');
    const tiles = editor.locator('[data-image-tile]');
    await expect(tiles).toHaveCount(0);
    for (const asset of pictures) {
      await agent.workAssets.link(post.id, { asset_id: asset.id, role: 'body' });
    }
    await expect(tiles).toHaveCount(3);
    await expect(tiles.locator('img')).toHaveCount(3);
    await shot(page, '1-image-editor');
  });

  await test.step('視頻：Agent 掛視頻與封面後，播放器和封面出現', async () => {
    await toLibrary();
    await card(film.id).dblclick();
    await expect(editor.getByText('尚未選視頻')).toBeVisible();
    await expect(editor.getByText('尚無封面')).toHaveCount(2);
    await agent.workAssets.link(film.id, { asset_id: clip.id, role: 'video' });
    await agent.workAssets.link(film.id, { asset_id: poster.id, role: 'cover' });
    await expect(editor.locator('video')).toBeVisible();
    await expect(editor.getByText('尚未選視頻')).toHaveCount(0);
    await expect(editor.getByText('尚無封面')).toHaveCount(0);
    await shot(page, '2-video-editor');
  });

  await test.step('作品卡：兩個作品都有縮圖', async () => {
    await toLibrary();
    await expect(card(post.id).locator('img.wcard__media')).toBeVisible();
    await expect(card(post.id)).toContainText('3');
    await expect(card(film.id).locator('img.wcard__media')).toBeVisible();
    await shot(page, '3-library-cards');
  });
});
