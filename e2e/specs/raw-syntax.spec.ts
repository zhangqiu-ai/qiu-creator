import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-072: switching to 視覺 never asks. HTML, footnotes, reference links and
 * math are kept as read-only raw nodes and written back byte-for-byte; an
 * <img> shows as a picture. QC072_SHOTS=<dir> saves screenshots.
 */

const IMG = '<img height="120" width="200" src="assets/a.png" />';
const DOC = [
  '# 有特殊語法的文章',
  '',
  IMG,
  '',
  '段落裡有 <span style="color:red">HTML</span>，與腳註[^1]。',
  '',
  '[^1]: 腳註內容。',
  '',
  '[參照連結][ref]',
  '',
  '[ref]: https://example.com',
  '',
  '$$',
  'a_b * c^2',
  '$$',
  '',
  '尾段。',
  '',
].join('\n');

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC072_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc072-${name}.png`) });
}

test('切換到視覺不再詢問；HTML、腳註、參照、數學原樣保留；img 顯示為圖片', async ({ desktop }) => {
  const { page, backend } = desktop;
  const c = backend.client;
  await page.setViewportSize({ width: 1440, height: 900 });
  const work = await c.works.create({ title: '特殊語法', markdown: DOC, source: 'mac-app' });
  const assets = path.join(backend.home, 'library', 'works', work.id, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(assets, 'a.png'), await pngBytes(400, 240, '#3E4A57'));
  await page.reload();
  await page.locator('.card-grid .wcard', { hasText: '特殊語法' }).click();

  const pane = page.locator('.tab-pane:not([hidden])');
  const content = pane.locator('.qc-md-editor__content');
  await expect(content).toBeVisible();
  // It opens in visual mode, and the picture is a picture.
  const img = content.locator('.qc-raw img');
  await expect(img).toHaveAttribute('src', /^http/);
  await expect
    .poll(() => img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth))
    .toBeGreaterThan(0);
  await expect(img).toHaveAttribute('width', '200');
  await shot(page, '01-visual-img');

  // 原始碼 → 視覺 in one click each, no confirmation, nothing rewritten.
  await pane.getByRole('button', { name: '原始碼', exact: true }).click();
  await expect(pane.locator('textarea.qc-md-editor__source')).toHaveValue(DOC);
  await pane.getByRole('button', { name: '視覺', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(content).toBeVisible();
  expect((await c.works.get(work.id)).markdown).toBe(DOC);
  await shot(page, '02-switched-back');

  // An edit elsewhere saves; every raw piece comes back unchanged.
  await content.getByText('尾段。').click();
  await page.keyboard.press('End');
  await page.keyboard.type('新增');
  await expect.poll(async () => (await c.works.get(work.id)).markdown).toContain('尾段。新增');
  const saved = (await c.works.get(work.id)).markdown;
  for (const raw of [
    IMG,
    '<span style="color:red">HTML</span>',
    '[^1]: 腳註內容。',
    '[參照連結][ref]',
    '[ref]: https://example.com',
    '$$\na_b * c^2\n$$',
  ]) {
    expect(saved).toContain(raw);
  }
  await shot(page, '03-edited');
});
