import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';
import { settleAfterDrop } from '../fixtures/dnd.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-065 area 4, 貼圖編輯 (DESIGN.md 動效 · 拖放): the image grid reorders with
 * dnd-kit sortable (the other tiles make room, the lifted copy settles where it
 * is dropped, Esc puts it back with nothing changed), and a new cover's badge
 * slides over from the old one. QC_E2E_MOTION=on QC_E2E_VIDEO=<dir> records it at
 * normal speed; QC065_SHOTS=<dir> saves the Reduce Motion frame.
 */

const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const COLORS = ['#C2410C', '#0F766E', '#1D4ED8', '#A16207', '#7E22CE', '#BE123C'];
const editor = (page: Page) => page.locator('.tab-pane:not([hidden]) main.post');
const tiles = (page: Page) => editor(page).locator('[data-image-tile]');

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC065_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc065-${name}.png`) });
}

/** Press on a tile, pass dnd-kit's 4 px threshold, glide to the target tile's left part. */
async function pickUp(page: Page, from: Locator, to: Locator, steps: number): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error('tile not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 - 8, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width / 3, b.y + b.height / 2, { steps });
}

async function openPost(
  page: Page,
  backend: Parameters<Parameters<typeof test>[2]>[0]['desktop']['backend'],
): Promise<{ order: () => Promise<(string | null)[]> }> {
  const ids: string[] = [];
  for (const [i, color] of COLORS.entries()) {
    const res = await backend.client.assets.upload({
      data: await pngBytes(600, 800, color),
      filename: `tile-${String(i + 1)}.png`,
    });
    ids.push(res.asset.id);
  }
  const created = await backend.client.works.create({
    title: '週末咖啡館',
    type: 'image',
    source: 'mac-app',
  });
  await backend.client.works.patch(created.id, {
    base_revision: created.current_revision_id,
    images: ids,
    cover: { asset_id: ids[0] ?? '' },
  });
  await page.reload();
  await page.locator('.card-grid .wcard', { hasText: '週末咖啡館' }).click();
  await expect(tiles(page)).toHaveCount(COLORS.length);
  const order = async () =>
    (await backend.client.works.get(created.id)).media?.images.map((i) => i.asset_id) ?? [];
  return { order };
}

test('貼圖格：拖曳排序、Esc 取消不變、換封面', async ({ desktop }) => {
  test.skip(motionOn, 'the recording run below covers it at normal speed');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const { order } = await openPost(page, backend);
  const before = await order();

  // Esc while dragging: nothing changes.
  await pickUp(page, tiles(page).nth(3), tiles(page).nth(0), 10);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await settleAfterDrop(page);
  expect(await order()).toEqual(before);

  // Drop the fourth image before the first.
  await pickUp(page, tiles(page).nth(3), tiles(page).nth(0), 10);
  await page.mouse.up();
  await settleAfterDrop(page);
  await expect
    .poll(order)
    .toEqual([before[3], before[0], before[1], before[2], before[4], before[5]]);

  // A new cover: the badge is on that tile, and only there.
  await tiles(page).nth(2).hover();
  await tiles(page).nth(2).getByRole('button', { name: '設為封面' }).click();
  await expect(tiles(page).nth(2).locator('.post__badge')).toHaveText('封面');
  await expect(editor(page).locator('.post__badge')).toHaveCount(1);
});

test('貼圖格動效錄影（正常速度）與減少動態效果', async ({ desktop }) => {
  test.skip(!motionOn, 'records motion only with QC_E2E_MOTION=on');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const { order } = await openPost(page, backend);
  const before = await order();
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop =
    videoDir === '' ? null : await startScreencast(page, videoDir, 'qc065-area4-image-post');

  await pickUp(page, tiles(page).nth(4), tiles(page).nth(1), 30);
  await page.mouse.up();
  await settleAfterDrop(page);
  await expect.poll(order).not.toEqual(before);
  await pickUp(page, tiles(page).nth(0), tiles(page).nth(3), 30);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await settleAfterDrop(page);
  for (const n of [3, 1]) {
    await tiles(page).nth(n).hover();
    await tiles(page).nth(n).getByRole('button', { name: '設為封面' }).click();
    await expect(tiles(page).nth(n).locator('.post__badge')).toHaveText('封面');
  }
  await tiles(page).nth(5).hover();
  if (stop !== null) test.info().annotations.push({ type: 'video', description: await stop() });

  // Reduce Motion: the lifted copy has no scale; the other tiles still make room.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pickUp(page, tiles(page).nth(5), tiles(page).nth(2), 10);
  await expect(page.locator('.post__tile--lifted')).toBeVisible();
  expect(
    await page.evaluate<string>(
      "getComputedStyle(document.querySelector('.post__tile--lifted')).transform",
    ),
  ).toBe('none');
  await shot(page, 'area4-reduced-tile-drag');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
