import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-037 素材庫 v2 (PT-20261119-001 「v2 · 素材庫：刪除與編輯」): editing with
 * autosave and conflicts, delete rules (unreferenced, referenced, external),
 * 復原, 回收站, multi-select batch. The system Trash is the fixture's fake.
 * QC-108: a click shows the asset in the gallery view; the fields live in its
 * info card (I or 「資訊」), deleting there moves on to the next asset.
 * Set QC037_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC037_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc037-${name}.png`) });
}

test('素材庫：編輯、刪除規則、復原、回收站與批次', async ({ desktop }) => {
  const { page, backend, systemTrash } = desktop;
  const c = backend.client;
  const up = async (name: string, color: string) =>
    (await c.assets.upload({ data: await pngBytes(64, 48, color), filename: name })).asset;
  const kyoto = await up('kyoto.png', '#9E4428');
  const coffee = await up('coffee.png', '#5E4130');
  const desk = await up('desk.png', '#3E4A57');
  const outfit = await up('outfit.png', '#7A6A58');
  const work = await c.works.create({ title: '京都紅葉季七日慢遊', markdown: '正文\n' });
  await c.workAssets.link(work.id, { asset_id: desk.id, role: 'cover' });

  // An external folder with two pictures (indexed in place).
  // Real path: macOS tmp is a symlink (/var → /private/var) and the service stores real paths.
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'qc037-mount-')));
  writeFileSync(path.join(folder, 'tools-cover.png'), await pngBytes(64, 48, '#2F3B34'));
  writeFileSync(path.join(folder, 'ulysses-screen.png'), await pngBytes(64, 48, '#55606A'));
  // Mounted media becomes an asset when a mounted work's Markdown uses it (QC-010).
  writeFileSync(
    path.join(folder, '工具評測.md'),
    '# 工具評測\n\n![](tools-cover.png)\n\n![](ulysses-screen.png)\n',
  );
  await c.mounts.create({ path: folder, name: '寫作' });
  let mounted: string | undefined;
  await expect
    .poll(async () => {
      mounted = (await c.works.list({ limit: 50 })).items.find((w) => w.title === '工具評測')?.id;
      return mounted !== undefined;
    })
    .toBe(true);
  await c.works.media(mounted ?? '');
  await expect
    .poll(async () => (await c.assets.list({ limit: 50 })).items.filter((a) => a.mount_id).length)
    .toBe(2);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '素材庫', exact: true })
    .click();
  const tile = (name: string) => page.getByRole('button', { name: `${name}，圖片` });
  const viewer = page.getByRole('region', { name: /^素材檢視：/ });
  const inspector = page.getByRole('group', { name: '素材資訊' });
  const toast = page.locator('.toast');
  /** Show an asset large and bring up its info card. */
  const open = async (name: string) => {
    await tile(name).click();
    await expect(viewer).toBeVisible();
    await page.keyboard.press('i');
    await expect(inspector).toBeVisible();
  };
  /** Esc closes the card, then the view; the grid is back. */
  const back = async () => {
    while ((await viewer.count()) > 0) {
      await page.keyboard.press('Escape');
    }
    await expect(viewer).toHaveCount(0);
  };

  try {
    await test.step('編輯名稱、標籤、替代文字、備註，自動儲存', async () => {
      await open('kyoto.png');
      await inspector.getByLabel('名稱').fill('嵐山竹林・清晨');
      await inspector.getByLabel('新增標籤').fill('京都');
      await inspector.getByLabel('新增標籤').press('Enter');
      await inspector.getByLabel('替代文字').fill('清晨嵐山竹林小徑');
      await inspector.getByLabel('備註').fill('封面候選');
      await inspector.getByLabel('備註').blur();
      await expect(inspector.getByRole('status').filter({ hasText: '已儲存' })).toBeVisible();
      await expect
        .poll(async () => {
          const a = await c.assets.get(kyoto.id);
          return [a.display_name, a.tags, a.alt_text, a.note];
        })
        .toEqual(['嵐山竹林・清晨', ['京都'], '清晨嵐山竹林小徑', '封面候選']);
      await expect(viewer.locator('.aview__line')).toContainText('嵐山竹林・清晨');
      await expect(viewer.locator('.aview__line')).toContainText('#京都');
      await shot(page, '01-edit-light');
    });

    await test.step('別處同時改同一欄：不覆蓋，讓使用者選', async () => {
      const before = await c.assets.get(kyoto.id);
      await inspector.getByLabel('備註').fill('這是我的備註');
      // Saved elsewhere before this window's autosave fires.
      await c.assets.update(kyoto.id, { base_revision: before.revision, note: '別處的備註' });
      await inspector.getByLabel('備註').blur();
      const conflict = inspector.getByRole('alert').filter({ hasText: '已在別處被修改' });
      await expect(conflict).toContainText('備註');
      expect((await c.assets.get(kyoto.id)).note).toBe('別處的備註');
      await shot(page, '02-edit-conflict');
      await conflict.getByRole('button', { name: '用我的' }).click();
      await expect.poll(async () => (await c.assets.get(kyoto.id)).note).toBe('這是我的備註');
      await expect(inspector.getByRole('status').filter({ hasText: '已儲存' })).toBeVisible();
      await back();
      await expect(tile('嵐山竹林・清晨')).toBeFocused();
    });

    await test.step('未引用的託管素材：直接移到回收站，可復原；檢視跳到下一個', async () => {
      await tile('outfit.png').click();
      await expect(viewer).toHaveAttribute('data-asset-id', outfit.id);
      await page.keyboard.press('Meta+Backspace');
      await expect(toast).toContainText('已移到回收站');
      // The view stays open on a neighbour instead of going back to the grid.
      await expect(viewer).toBeVisible();
      await expect(viewer).not.toHaveAttribute('data-asset-id', outfit.id);
      await shot(page, '03-deleted-undo-toast');
      await toast.getByRole('button', { name: '復原' }).click();
      await expect.poll(async () => (await c.assets.get(outfit.id)).deleted_at).toBeNull();
      await back();
      await expect(tile('outfit.png')).toBeVisible();
    });

    await test.step('被引用的素材：列出作品並確認', async () => {
      await tile('desk.png').click();
      await viewer.getByRole('button', { name: '移到回收站' }).click();
      const dialog = page.getByRole('dialog', { name: '移到回收站？' });
      await expect(dialog).toContainText('被 1 件作品引用');
      // Linked directly (not an attach copy): the article really loses the image.
      await expect(dialog).toContainText('會顯示為缺圖');
      await expect(dialog.getByRole('button', { name: /京都紅葉季七日慢遊/ })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
      await shot(page, '04-delete-referenced');
      await dialog.getByRole('button', { name: '移到回收站' }).click();
      await expect(toast).toContainText('作品顯示為缺圖');
      expect((await c.assets.get(desk.id)).removal).toBe('trashed');
      await back();
    });

    await test.step('外部素材：預設只移出素材庫；勾選才移到垃圾桶', async () => {
      await tile('tools-cover.png').click();
      await viewer.getByRole('button', { name: '移出素材庫…' }).click();
      let dialog = page.getByRole('dialog', { name: '移出素材庫？' });
      await expect(dialog.getByRole('radio', { name: /只從素材庫移除/ })).toBeChecked();
      await shot(page, '05-delete-external');
      await dialog.getByRole('button', { name: '移出', exact: true }).click();
      await expect(toast).toContainText('原檔未動');
      expect(existsSync(path.join(folder, 'tools-cover.png'))).toBe(true);
      expect(systemTrash.moved).toEqual([]);
      await back();

      await tile('ulysses-screen.png').click();
      await viewer.getByRole('button', { name: '移出素材庫…' }).click();
      dialog = page.getByRole('dialog', { name: '移出素材庫？' });
      await dialog.getByRole('radio', { name: /原檔也移到系統垃圾桶/ }).check();
      await dialog.getByRole('button', { name: '移到垃圾桶' }).click();
      await expect(toast).toContainText('原檔已移到系統垃圾桶');
      expect(systemTrash.moved).toEqual([path.join(folder, 'ulysses-screen.png')]);
      expect(existsSync(path.join(folder, 'ulysses-screen.png'))).toBe(false);
      await back();
    });

    await test.step('多選：批次加標籤與移除', async () => {
      await tile('嵐山竹林・清晨').click({ modifiers: ['Meta'] });
      await tile('coffee.png').click({ modifiers: ['Meta'] });
      const bar = page.getByRole('toolbar', { name: '批次操作' });
      // ⌘-click picks without opening the view; the actions are in the header, no side panel.
      await expect(page.getByRole('heading', { name: '已選 2' })).toBeVisible();
      await expect(viewer).toHaveCount(0);
      await expect(page.getByRole('complementary')).toHaveCount(0);
      await expect(bar.getByRole('button', { name: '在 Finder 顯示' })).toBeVisible();
      await shot(page, '06-multi-select');
      await bar.getByRole('button', { name: '加標籤' }).click();
      let dialog = page.getByRole('dialog', { name: '為 2 個素材加標籤' });
      await dialog.getByRole('textbox').fill('精選, 2026');
      await dialog.getByRole('button', { name: '加上' }).click();
      await expect.poll(async () => (await c.assets.get(coffee.id)).tags).toEqual(['精選', '2026']);
      expect((await c.assets.get(kyoto.id)).tags).toEqual(['京都', '精選', '2026']);

      await tile('嵐山竹林・清晨').click({ modifiers: ['Meta'] });
      await tile('coffee.png').click({ modifiers: ['Meta'] });
      await page.keyboard.press('Meta+Backspace');
      dialog = page.getByRole('dialog', { name: '移除 2 個素材？' });
      await expect(dialog).toContainText('移到回收站');
      await dialog.getByRole('button', { name: '移除' }).click();
      await expect(toast).toContainText('已移除 2 個素材');
      // esc clears a selection.
      await tile('outfit.png').click({ modifiers: ['Meta'] });
      await expect(bar).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(bar).toHaveCount(0);
    });

    await test.step('回收站：恢復、永久刪除、清空', async () => {
      await page
        .getByRole('group', { name: '範圍' })
        .getByRole('button', { name: /回收站/ })
        .click();
      const list = page.getByRole('list', { name: '已刪除的素材' });
      await expect(list.getByRole('listitem')).toHaveCount(5);
      await expect(list.getByRole('listitem').filter({ hasText: 'desk.png' })).toContainText(
        '30 天',
      );
      await shot(page, '07-trash-light');
      await list
        .getByRole('listitem')
        .filter({ hasText: 'desk.png' })
        .getByRole('button', { name: '恢復' })
        .click();
      await expect(toast).toContainText('已恢復到原位置');
      await expect(list.getByRole('listitem')).toHaveCount(4);
      // Restored with its reference to the work.
      expect((await c.workAssets.list(work.id)).items.map((i) => i.asset.id)).toContain(desk.id);

      // A click on a name shows it in the view, with 恢復 and 永久刪除 as its tools.
      await list.getByRole('button', { name: '嵐山竹林・清晨', exact: true }).click();
      await expect(viewer).toBeVisible();
      await expect(viewer.getByRole('button', { name: '恢復' })).toBeVisible();
      await expect(viewer.getByRole('button', { name: '資訊', exact: true })).toHaveCount(0);
      await shot(page, '07b-trash-viewer');
      await viewer.getByRole('button', { name: '恢復' }).click();
      await expect(toast).toContainText('已恢復到原位置');
      await expect.poll(async () => (await c.assets.get(kyoto.id)).deleted_at).toBeNull();
      await back();
      await expect(list.getByRole('listitem')).toHaveCount(3);

      await list
        .getByRole('listitem')
        .filter({ hasText: 'coffee.png' })
        .getByRole('button', { name: '永久刪除' })
        .click();
      let dialog = page.getByRole('dialog', { name: '永久刪除這個素材？' });
      await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
      await dialog.getByRole('button', { name: '永久刪除' }).click();
      await expect(list.getByRole('listitem')).toHaveCount(2);

      await page.getByRole('button', { name: '清空' }).click();
      dialog = page.getByRole('dialog', { name: '永久刪除 2 個素材？' });
      await dialog.getByRole('button', { name: '永久刪除' }).click();
      await expect(page.getByText('回收站是空的')).toBeVisible();
    });

    await test.step('深色截圖', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.getByRole('group', { name: '範圍' }).getByRole('button', { name: '全部' }).click();
      await open('desk.png');
      await shot(page, '08-inspector-dark');
      await back();
      await tile('outfit.png').click({ modifiers: ['Meta'] });
      await tile('desk.png').click({ modifiers: ['Meta'] });
      await shot(page, '09-multi-dark');
      await page.keyboard.press('Escape');
      await tile('outfit.png').click();
      await page.keyboard.press('Meta+Backspace');
      await expect(toast).toContainText('已移到回收站');
      await back();
      await page
        .getByRole('group', { name: '範圍' })
        .getByRole('button', { name: /回收站/ })
        .click();
      await shot(page, '10-trash-dark');
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
