import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-068 搜尋高亮: what the search typed is marked live in card titles, list
 * rows, article excerpts and the asset library, with the matching the search
 * uses (letter case alike); nothing is marked while an IME is still
 * composing. Set QC068_SHOTS=<dir> to save screenshots.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC068_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc068-${name}.png`) });
}

const grid = (page: Page) => page.getByRole('region', { name: '作品', exact: true });
const marks = (page: Page) => grid(page).locator('mark.hit');
const search = (page: Page) => page.locator('main .page__header input[type="search"]');

/** Type `pinyin` as an IME still composing it (Chromium's events), without ending the composition. */
const composing = (pinyin: string) => `(() => {
  const el = document.activeElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  set.call(el, ${JSON.stringify(pinyin)});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: ${JSON.stringify(pinyin)}, inputType: 'insertCompositionText' }));
})()`;
/** End the composition with `text` chosen. */
const commit = (text: string) => `(() => {
  const el = document.activeElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: ${JSON.stringify(text)}, inputType: 'insertCompositionText' }));
  el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: ${JSON.stringify(text)} }));
})()`;

test('搜尋：卡片標題、列表列、摘要、素材名稱即時標出關鍵字；輸入法組字中不標', async ({
  desktop,
}) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const c = backend.client;
  await c.works.create({
    title: '常用 Markdown 模板',
    markdown: '# 常用 Markdown 模板\n\n開頭寫常用的段落結構。',
    source: 'mac-app',
  });
  await c.works.create({ title: '旅行常用清單', type: 'image', source: 'mac-app' });
  await c.works.create({
    title: 'change log',
    markdown: '# change log\n\n版本紀錄',
    source: 'mac-app',
  });
  await c.assets.upload({ data: await pngBytes(64, 64, '#2F4FCF'), filename: '常用封面.png' });
  await c.assets.upload({ data: await pngBytes(64, 64, '#9E4428'), filename: 'kyoto.png' });
  await page.reload();
  await expect(grid(page).locator('.wcard')).toHaveCount(3);

  await test.step('輸入「常用」：命中的標題和摘要都標出', async () => {
    await search(page).fill('常用');
    await expect(grid(page).locator('.wcard')).toHaveCount(2);
    const titles = grid(page).locator('.wcard__title mark.hit');
    await expect(titles).toHaveCount(2);
    await expect(titles.first()).toHaveText('常用');
    // The article's excerpt (its body, after the heading) marks its hit too.
    await expect(grid(page).locator('.wcard__text-body mark.hit')).toHaveText(['常用']);
    await shot(page, '1-grid');
  });

  await test.step('大小寫一致：輸入 markdown，標出 Markdown', async () => {
    await search(page).fill('markdown');
    await expect(grid(page).locator('.wcard')).toHaveCount(1);
    await expect(grid(page).locator('.wcard__title mark.hit')).toHaveText('Markdown');
  });

  await test.step('列表檢視也標出', async () => {
    await search(page).fill('常用');
    await page.getByRole('button', { name: '列表' }).click();
    const rows = grid(page).locator('.tbl__name mark.hit');
    await expect(rows).toHaveCount(2);
    await shot(page, '2-list');
    await page.getByRole('button', { name: '網格' }).click();
  });

  await test.step('輸入法組字中不標，選字後才標', async () => {
    await search(page).fill('');
    await expect(grid(page).locator('.wcard')).toHaveCount(3);
    await search(page).focus();
    await page.evaluate(composing('chang'));
    await expect(search(page)).toHaveValue('chang');
    // "chang" would mark "change log" if the composition counted.
    await expect(marks(page)).toHaveCount(0);
    await page.evaluate(commit('常用'));
    await expect(grid(page).locator('.wcard__title mark.hit')).toHaveCount(2);
  });

  await test.step('素材庫：名稱即時標出', async () => {
    await page
      .getByRole('navigation', { name: '主導航' })
      .getByRole('button', { name: '素材庫', exact: true })
      .click();
    await page.locator('main input[type="search"]').fill('常用');
    const hit = page.locator('.atile__name mark.hit');
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveText('常用');
    await shot(page, '3-assets');
  });

  await test.step('深色模式', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('.atile__name mark.hit')).toBeVisible();
    await shot(page, '4-assets-dark');
  });
});
