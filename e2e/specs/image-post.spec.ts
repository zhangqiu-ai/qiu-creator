import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';
import { collapseSide, sidePane, showSideTab } from '../fixtures/side.js';
import { chooseFilter, filterCount, filterOption } from '../fixtures/library.js';

/*
 * QC-045 貼圖 (PT-20261121-001 「v3 · 新建」「v3 · 貼圖編輯」): 新建 with a
 * type menu, the image grid (library, upload, ⌘V, keyboard reorder, remove
 * with 復原), platform limits that only warn, the cover dialog, a missing
 * file replaced from the library, the 預覽 split (QC-076), and library thumbnails.
 * Set QC045_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC045_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc045-${name}.png`) });
}

/**
 * The simulated phone is scaled into the sidebar's 預覽 tab (QC-085): no
 * horizontal scrollbar, and the phone's right edge inside the panel (QC-049, QC-076).
 */
async function expectPreviewFits(page: Page): Promise<void> {
  // QC-084: the phone is scaled to fit the stage; the stage never scrolls.
  const measure = `(() => {
    const stage = document.querySelector('.tab-pane:not([hidden]) .pv-stage');
    const phone = stage.querySelector('.pv-phone');
    const s = stage.getBoundingClientRect();
    const p = phone.getBoundingClientRect();
    return {
      scrollsSideways: stage.scrollWidth > stage.clientWidth,
      phoneClipped: p.right > s.right + 0.5 || p.left < s.left - 0.5,
    };
  })()`;
  await expect
    .poll(() => page.evaluate<{ scrollsSideways: boolean; phoneClipped: boolean }>(measure))
    .toEqual({ scrollsSideways: false, phoneClipped: false });
}

function nav(page: Page): Locator {
  return page.getByRole('navigation', { name: '主導航' });
}

const editor = (page: Page) => page.locator('.tab-pane:not([hidden]) main.post');
const tiles = (page: Page) => editor(page).locator('[data-image-tile]');

/** A pasted canvas image, dispatched like ⌘V (page-side code as a string: no DOM types here). */
const PASTE_PNG = `(async () => {
  const c = document.createElement('canvas');
  c.width = 300; c.height = 400;
  const g = c.getContext('2d'); g.fillStyle = '#7a3fbf'; g.fillRect(0, 0, 300, 400);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`;

const COLORS = [
  '#9E4428',
  '#3E4A57',
  '#C49A3A',
  '#2E6B4F',
  '#7B3A6B',
  '#355C9A',
  '#A8532E',
  '#4F6B2E',
  '#6B2E2E',
  '#2E5F6B',
  '#8A6E3A',
];

test('貼圖：新建選類型、加圖、上限提示、鍵盤排序、移除復原、標題字數、封面、預覽分欄', async ({
  desktop,
}) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const names = COLORS.map((_, i) => `photo-${String(i + 1).padStart(2, '0')}.png`);
  for (const [i, color] of COLORS.entries()) {
    await backend.client.assets.upload({
      data: await pngBytes(600, 800, color),
      filename: names[i] ?? 'x.png',
    });
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qc045-finder-'));
  const finderFile = path.join(dir, 'finder-upload.png');
  writeFileSync(finderFile, await pngBytes(600, 800, '#224466'));

  try {
    await test.step('新建選單：⌘N 開啟，視頻先停用，↓↩ 建立貼圖', async () => {
      await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
      await page.keyboard.press('Meta+n');
      const menu = page.getByRole('menu', { name: '新建作品' });
      await expect(menu.getByRole('menuitem')).toHaveCount(3);
      // QC-046 enabled video works.
      await expect(menu.getByRole('menuitem', { name: /視頻/ })).toHaveAttribute(
        'aria-disabled',
        'false',
      );
      await expect(menu.getByRole('menuitem', { name: /文章/ })).toBeFocused();
      await shot(page, 'zh-Hant-1-new-menu');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(editor(page)).toBeVisible();
      await expect(editor(page).getByRole('textbox', { name: '標題' })).toHaveValue('未命名');
    });

    await test.step('從素材庫加 10 張、上傳 1 張、⌘V 貼上 1 張', async () => {
      await editor(page).getByRole('button', { name: '素材庫' }).click();
      const drawer = page.getByRole('complementary', { name: '素材抽屜' });
      for (const name of names.slice(0, 10)) {
        await drawer.getByRole('option', { name: `插入 ${name}` }).click();
      }
      await expect(tiles(page)).toHaveCount(10);
      await editor(page).locator('input[type="file"]').setInputFiles(finderFile);
      await expect(tiles(page)).toHaveCount(11, { timeout: 15_000 });
      await page.evaluate(PASTE_PNG);
      await expect(tiles(page)).toHaveCount(12, { timeout: 15_000 });
      await expect(editor(page).getByRole('status').filter({ hasText: '已儲存' })).toBeVisible();
    });

    await test.step('上限只提示：第 10 張起標示視頻號，儲存照常', async () => {
      await expect(tiles(page).nth(8)).not.toHaveClass(/post__tile--over/);
      await expect(tiles(page).nth(9)).toHaveClass(/post__tile--over/);
      await expect(tiles(page).nth(9)).toHaveAttribute('aria-label', /超過視頻號的張數上限/);
      await expect(editor(page).getByText(/只是提示，不會阻擋儲存/)).toBeVisible();
      await expect(editor(page).getByText('視頻號 12/9')).toBeVisible();
      await expect(editor(page).getByText('小紅書 12/18')).toBeVisible();
    });

    const work = (await backend.client.works.list({ type: 'image' })).items[0];
    if (work === undefined) throw new Error('no image work');
    const order = async () =>
      (await backend.client.works.get(work.id)).media?.images.map((i) => i.asset_id) ?? [];

    await test.step('鍵盤：⌥→ 移動，⌫ 移除後復原', async () => {
      const before = await order();
      await tiles(page).first().focus();
      await page.keyboard.press('Alt+ArrowRight');
      await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)]);
      await expect(tiles(page).nth(1)).toBeFocused();
      await page.keyboard.press('Backspace');
      await expect(tiles(page)).toHaveCount(11);
      await expect.poll(order).toEqual([before[1], ...before.slice(2)]);
      await page
        .locator('[data-toast]')
        .filter({ hasText: '已移除第 2 張' })
        .getByRole('button', { name: '復原' })
        .click();
      await expect(tiles(page)).toHaveCount(12);
      await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)]);
    });

    await test.step('標題各平台字數、描述字數', async () => {
      await editor(page)
        .getByRole('textbox', { name: '標題' })
        .fill('週末咖啡館探店筆記：三家巷弄小店');
      await editor(page)
        .getByRole('textbox', { name: '描述' })
        .fill('三家店各有特色，第二家的手沖最好喝。');
      await expect(editor(page).getByText('視頻號 16/16')).toBeVisible();
      await expect(editor(page).getByText('18/1,000 字')).toBeVisible();
      await expect
        .poll(async () => (await backend.client.works.get(work.id)).description)
        .toBe('三家店各有特色，第二家的手沖最好喝。');
    });

    await test.step('封面設置：選第 3 張，三種裁切預覽', async () => {
      await editor(page).getByRole('button', { name: '封面設置' }).click();
      const dialog = page.getByRole('dialog', { name: '封面設置' });
      await dialog.getByRole('radio', { name: '第 3 張' }).click();
      await expect(dialog.locator('.post__crop')).toHaveCount(3);
      await shot(page, 'zh-Hant-3-cover');
      await dialog.getByRole('button', { name: '使用這張' }).click();
      await expect(tiles(page).nth(2).locator('.post__badge')).toHaveText('封面');
      const third = (await order())[2];
      await expect
        .poll(async () => {
          const cover = (await backend.client.works.get(work.id)).media?.cover;
          return cover?.kind === 'image' ? cover.item.asset_id : null;
        })
        .toBe(third);
    });

    await test.step('張數膠囊點一下打開該平台的預覽分欄（QC-076）', async () => {
      // The asset drawer is open; the chip closes it and opens the preview on that platform.
      await editor(page)
        .getByRole('button', { name: /^視頻號 12\/9$/ })
        .click();
      const side = sidePane(page).getByRole('complementary', { name: '平台預覽' });
      await expect(side.getByRole('tab', { name: /視頻號/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      // QC-084: no version to create; the platform follows the post at once.
      await expect(side.locator('.pv-phone')).toBeVisible();
      await expectPreviewFits(page);
      await shot(page, 'zh-Hant-2-editor');
      await side.getByRole('tab', { name: '小紅書' }).click();
      await expect(side.getByRole('tab', { name: '小紅書' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await collapseSide(page);
      await expect(side).toBeHidden();
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('貼圖：檔案遺失後重新指定、作品庫類型篩選與縮圖、三語與深色', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const names = COLORS.map((_, i) => `photo-${String(i + 1).padStart(2, '0')}.png`);
  const ids: string[] = [];
  for (const [i, color] of COLORS.entries()) {
    const res = await backend.client.assets.upload({
      data: await pngBytes(600, 800, color),
      filename: names[i] ?? 'x.png',
    });
    ids.push(res.asset.id);
  }
  const created = await backend.client.works.create({
    title: '週末咖啡館探店筆記：三家巷弄小店',
    type: 'image',
    description: '三家店各有特色，第二家的手沖最好喝。',
    source: 'mac-app',
  });
  const work = await backend.client.works.patch(created.id, {
    base_revision: created.current_revision_id,
    images: ids.slice(0, 10),
    cover: { asset_id: ids[2] ?? '' },
  });
  await backend.client.works.create({ title: '一篇文章', markdown: '# 文章\n', source: 'mac-app' });

  await test.step('檔案遺失：刪掉一張的實體檔，重新開啟後可重新指定', async () => {
    const detail = await backend.client.works.get(work.id);
    expect(detail.media?.images).toHaveLength(10);
    const lost = detail.media?.images[4];
    if (lost === undefined) throw new Error('no fifth image');
    unlinkSync(path.join(backend.home, 'library', 'works', work.id, lost.path));
    await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    await page
      .getByRole('region', { name: '作品', exact: true })
      .getByRole('button', { name: /週末咖啡館/ })
      .click();
    const missing = tiles(page).nth(4);
    await expect(missing).toContainText('檔案遺失');
    await shot(page, 'zh-Hant-6-missing');
    await missing.getByRole('button', { name: '重新指定' }).click();
    await page
      .getByRole('complementary', { name: '素材抽屜' })
      .getByRole('option', { name: `插入 ${names[10] ?? ''}` })
      .click();
    await expect(tiles(page).nth(4)).not.toContainText('檔案遺失');
    await expect
      .poll(async () => (await backend.client.works.get(work.id)).media?.images[4]?.status)
      .toBe('present');
  });

  await test.step('兩則提示同時出現時上下堆疊，不重疊', async () => {
    await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    await page
      .getByRole('region', { name: '作品', exact: true })
      .getByRole('button', { name: /一篇文章/ })
      .click();
    // Opening fetches the work first: wait for its tab before switching back.
    await expect(page.getByRole('textbox', { name: '標題' })).toHaveValue('一篇文章');
    await page.keyboard.press('Meta+1');
    await expect(editor(page)).toBeVisible();
    // The editor's notice (復原) and then a tab notice (關閉其他).
    await tiles(page).first().focus();
    await page.keyboard.press('Backspace');
    await page.getByRole('button', { name: '全部分頁（2）' }).click();
    await page.getByRole('button', { name: /關閉其他分頁/ }).click();
    const toasts = page.locator('[data-toast]');
    await expect(toasts).toHaveCount(2);
    await expect(toasts.nth(0)).toContainText('已移除第 1 張');
    await expect(toasts.nth(1)).toContainText('已關閉 1 個分頁');
    const upper = await toasts.nth(0).boundingBox();
    const lower = await toasts.nth(1).boundingBox();
    if (upper === null || lower === null) throw new Error('toasts not rendered');
    // Stacked, the newest lowest; no overlap.
    expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y);
    await shot(page, 'zh-Hant-8-two-notices');
    await toasts.nth(0).getByRole('button', { name: '復原' }).click();
    await expect(tiles(page)).toHaveCount(10);
  });

  await test.step('預覽分欄：超出張數上限在平台分頁加橘點、張數變橘（QC-048、QC-084）', async () => {
    await showSideTab(page, '預覽');
    const tab = page.getByRole('tablist', { name: '平台' }).getByRole('tab', { name: /視頻號/ });
    await tab.click();
    // The platform follows the post (images and cover from its front matter).
    await expect(tab.getByRole('img', { name: '超出上限' })).toBeVisible();
    await page
      .getByRole('tablist', { name: '畫面' })
      .getByRole('tab', { name: '發布編輯' })
      .click();
    await expect(
      page
        .locator('.pv-page:not([inert]) [data-screen="publish"]')
        .getByText(/10 \/ 9/)
        .first(),
    ).toBeVisible();
    await page.evaluate("window.creatorhub.setLanguage('en')");
    await expect(
      page.locator('.pv-tab[aria-selected="true"]').getByRole('img', { name: 'Over the limit' }),
    ).toBeVisible();
    await shot(page, 'en-7-preview-warnings');
    await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
  });

  await test.step('作品庫：類型篩選帶數量，卡片顯示第一張圖與張數', async () => {
    await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    expect(await filterCount(page, '類型', /^貼圖/)).toBe('1');
    await chooseFilter(page, '類型', /^貼圖/);
    const card = page.getByRole('region', { name: '作品', exact: true }).getByRole('button', {
      name: /週末咖啡館/,
    });
    // QC-061: the card shows the service's signed card image, and it really decodes.
    const media = card.locator('img.wcard__media');
    await expect(media).toHaveAttribute('src', /\/media\/v1\/works\/[^/]+\/thumbnail\?/);
    await expect
      .poll(() =>
        media.evaluate(
          (el) =>
            (el as unknown as { complete: boolean; naturalWidth: number }).complete &&
            (el as unknown as { naturalWidth: number }).naturalWidth > 0,
        ),
      )
      .toBe(true);
    await expect(card).toContainText('10 張');
    // QC-069: a type with no works is dimmed in 篩選 and cannot be picked.
    expect(await filterCount(page, '類型', /^視頻/)).toBe('0');
    await expect(filterOption(page, '類型', /^視頻/)).toBeDisabled();
    await page.keyboard.press('Escape');
    await chooseFilter(page, '類型', /^全部/);
    await shot(page, 'zh-Hant-4-library');
  });

  await test.step('三語與深色截圖', async () => {
    await page
      .getByRole('region', { name: '作品', exact: true })
      .getByRole('button', { name: /週末咖啡館/ })
      .click();
    await expect(editor(page)).toBeVisible();
    // The sidebar from the step above is still open: hide it for the editor screenshots.
    await collapseSide(page);
    for (const lang of ['zh-Hans', 'en'] as const) {
      await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
      await expect(editor(page)).toHaveAttribute(
        'aria-label',
        lang === 'en' ? 'Edit image post' : '编辑贴图',
      );
      await shot(page, `${lang}-2-editor`);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'en-5-editor-dark');
    await page.evaluate(`window.creatorhub.setLanguage('zh-Hant')`);
    await shot(page, 'zh-Hant-5-editor-dark');
  });
});
