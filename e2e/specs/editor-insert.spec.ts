import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-039 插入素材 (PT-20261119-001 「v2 · 編輯器：插入素材」): 插入 menu, the
 * asset drawer (⌘⇧I), `/`, ⌘V paste (uploading → inserted, and failed with
 * 移除), a Finder drop at a block, in visual and source mode; the files and
 * the Markdown are checked on the service side.
 * Set QC039_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

/** Wait until the editor shows `n` real images (they load after the insert remounts the editor). */
async function imagesShown(page: Page, n: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate<number>(
          'document.querySelectorAll(\'.qc-md-editor__content img[src^="http"]\').length',
        ),
      {
        timeout: 15_000,
      },
    )
    .toBeGreaterThanOrEqual(n);
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC039_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc039-${name}.png`) });
}

// Page-side code as strings: the e2e project has no DOM types.
const PASTE_PNG = `(async () => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const g = c.getContext('2d'); g.fillStyle = '#2f4fcf'; g.fillRect(0, 0, 640, 360);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
  const target = document.querySelector('.qc-md-editor__content') ?? document.querySelector('textarea.qc-md-editor__source');
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`;
const PASTE_BROKEN = `(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['this is not an image'], 'broken.png', { type: 'image/png' }));
  const target = document.querySelector('.qc-md-editor__content') ?? document.querySelector('textarea.qc-md-editor__source');
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`;
/**
 * The drop frame and the editor's visible area below the sticky toolbar, in
 * viewport coordinates, plus the scroll offset.
 */
const DROP_GEOMETRY = `(() => {
  const doc = document.querySelector('.editor__doc');
  const r = doc.getBoundingClientRect();
  const top = r.top + doc.clientTop;
  const bar = doc.querySelector('[role="toolbar"]');
  const below = bar === null ? top : bar.getBoundingClientRect().bottom;
  const f = document.querySelector('.drop').getBoundingClientRect();
  return {
    scrollTop: doc.scrollTop,
    frame: { x: f.x, y: f.y, width: f.width, height: f.height },
    visible: { x: r.left + doc.clientLeft + 8, y: below + 8, width: doc.clientWidth - 16, height: top + doc.clientHeight - below - 16 },
  };
})()`;
interface DropGeometry {
  scrollTop: number;
  frame: { x: number; y: number; width: number; height: number };
  visible: { x: number; y: number; width: number; height: number };
}
function expectFrameOnVisibleArea(g: DropGeometry): void {
  expect(g.frame.x).toBeCloseTo(g.visible.x, 0);
  expect(g.frame.y).toBeCloseTo(g.visible.y, 0);
  expect(g.frame.width).toBeCloseTo(g.visible.width, 0);
  expect(g.frame.height).toBeCloseTo(g.visible.height, 0);
}
/** Drag over the editor at a viewport y (dragover only). */
const dragOverAt = (clientY: number) => `(() => {
  const dt = new DataTransfer();
  for (const f of document.getElementById('qc039-picker').files) dt.items.add(f);
  const doc = document.querySelector('.editor__doc');
  const at = { clientX: doc.getBoundingClientRect().left + 200, clientY: ${String(clientY)}, bubbles: true, cancelable: true, dataTransfer: dt };
  document.elementFromPoint(at.clientX, at.clientY).dispatchEvent(new DragEvent('dragover', at));
})()`;
/** Drag the files of #qc039-picker over (and optionally onto) the n-th block of the text. */
const dragFiles = (block: number, release: boolean) => `(() => {
  const files = document.getElementById('qc039-picker').files;
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const el = document.querySelector('.qc-md-editor__content').children[${String(block)}];
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + 20, clientY: r.top + 2, bubbles: true, cancelable: true, dataTransfer: dt };
  el.dispatchEvent(new DragEvent('dragenter', at));
  el.dispatchEvent(new DragEvent('dragover', at));
  if (${String(release)}) el.dispatchEvent(new DragEvent('drop', at));
})()`;

test('插入素材：選單、抽屜、斜線、貼上、Finder 拖入，視覺與原始碼', async ({ desktop }) => {
  const { page, backend } = desktop;
  const c = backend.client;
  const work = await c.works.create({
    title: '書房改造',
    markdown: '# 書房改造\n\n剛搬進來時。\n\n主機搬出房間。\n',
  });
  await c.assets.upload({ data: await pngBytes(640, 400, '#9E4428'), filename: 'kyoto.png' });
  const assetsDir = path.join(backend.home, 'library', 'works', work.id, 'assets');
  const md = async () => (await c.works.get(work.id)).markdown;
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'qc039-finder-')));
  const finderFile = path.join(tmp, 'desk-after.png');
  writeFileSync(finderFile, await pngBytes(640, 360, '#3E4A57'));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '全部作品', exact: true })
    .click();
  await page
    .getByRole('region', { name: '作品', exact: true })
    .getByRole('button', { name: /書房改造/ })
    .click();
  const content = page.locator('.qc-md-editor__content');
  await expect(content).toBeVisible();

  try {
    await test.step('插入選單', async () => {
      await page.getByRole('button', { name: '插入', exact: true }).click();
      const menu = page.getByRole('menu', { name: '插入' });
      await expect(menu.getByRole('menuitem', { name: /從素材庫/ })).toBeFocused();
      await expect(menu).toContainText('⌘V 貼上剪貼簿圖片');
      await shot(page, '01-insert-menu');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    });

    await test.step('素材抽屜（⌘⇧I）：點選插入到游標所在段落之後', async () => {
      await content.getByText('剛搬進來時。').click();
      await page.keyboard.press('Meta+Shift+I');
      const drawer = page.getByRole('complementary', { name: '素材抽屜' });
      await expect(drawer.getByPlaceholder('搜尋素材')).toBeFocused();
      await drawer.getByRole('option', { name: '插入 kyoto.png' }).click();
      await expect.poll(md).toContain('![](assets/kyoto.png)');
      const text = await md();
      expect(text.indexOf('剛搬進來時。')).toBeLessThan(text.indexOf('![](assets/kyoto.png)'));
      expect(text.indexOf('![](assets/kyoto.png)')).toBeLessThan(text.indexOf('主機搬出房間。'));
      expect(existsSync(path.join(assetsDir, 'kyoto.png'))).toBe(true);
      await imagesShown(page, 1);
      await shot(page, '02-drawer-inserted');
    });

    await test.step('斜線指令：空行輸入 / 插入分隔線', async () => {
      // Click the blank right end of the paragraph: the caret lands at the end of its text.
      const para = content.locator('p', { hasText: '主機搬出房間。' });
      const box = await para.boundingBox();
      await para.click({ position: { x: (box?.width ?? 10) - 4, y: (box?.height ?? 10) / 2 } });
      await page.keyboard.press('Enter');
      await page.keyboard.press('/');
      const list = page.getByRole('listbox', { name: '插入指令' });
      await expect(list.getByRole('option')).toHaveCount(3);
      await shot(page, '03-slash');
      await page.keyboard.type('分隔');
      await expect(list.getByRole('option')).toHaveCount(1);
      await page.keyboard.press('Enter');
      await expect.poll(md).toMatch(/主機搬出房間。\n\n---\n/);
    });

    await test.step('⌘V 貼上：上傳後插入並加入素材庫', async () => {
      await content.getByText('剛搬進來時。').click();
      await page.evaluate(PASTE_PNG);
      await expect.poll(md).toMatch(/!\[\]\(assets\/貼上的圖片-\d\d\.\d\d\.png\)/);
      const pasted = readdirSync(assetsDir).filter((f) => f.startsWith('貼上的圖片'));
      expect(pasted).toHaveLength(1);
      const lib = await c.assets.list({ limit: 50 });
      expect(lib.items.some((a) => a.original_name?.startsWith('貼上的圖片'))).toBe(true);
      await expect(page.locator('.pending__card')).toHaveCount(0);
      await imagesShown(page, 2);
    });

    await test.step('貼上失敗：卡片留在視窗，可移除', async () => {
      const before = await md();
      await page.evaluate(PASTE_BROKEN);
      const failed = page.locator('.pending__card--bad');
      await expect(failed).toContainText('上傳失敗');
      await expect(failed).toContainText('broken.png');
      await expect(failed.getByRole('button', { name: '重試' })).toBeVisible();
      await shot(page, '04-paste-failed');
      await failed.getByRole('button', { name: '移除' }).click();
      await expect(failed).toHaveCount(0);
      expect(await md()).toBe(before);
    });

    await test.step('Finder 拖入：插入線指出位置，放開後插在該段之前', async () => {
      await page.evaluate(`(() => {
        const i = document.createElement('input');
        i.type = 'file'; i.id = 'qc039-picker'; i.multiple = true; i.style.display = 'none';
        document.body.appendChild(i);
      })()`);
      await page.locator('#qc039-picker').setInputFiles(finderFile);
      // Block 2 is 「剛搬進來時。」's paragraph? Find it rather than assume.
      const index = await page.evaluate<number>(
        "[...document.querySelector('.qc-md-editor__content').children].findIndex((e) => e.textContent.includes('主機搬出房間'))",
      );
      await page.evaluate(dragFiles(index, false));
      await expect(page.locator('.drop__badge')).toContainText('放開以插入 1 個檔案');
      await expect(page.locator('.drop__line')).toBeVisible();
      await imagesShown(page, 2);
      // Review fix: the frame covers what is on screen (below the toolbar, even
      // inset), not the top of the scrolled content.
      const g = await page.evaluate<DropGeometry>(DROP_GEOMETRY);
      expect(g.scrollTop).toBeGreaterThan(0);
      expectFrameOnVisibleArea(g);
      await shot(page, '05-finder-drop');
      // Holding the pointer near the top edge scrolls up (the last block is
      // already at the bottom); near the bottom edge it scrolls down again. The
      // frame stays on the visible area throughout.
      for (let i = 0; i < 5; i++) await page.evaluate(dragOverAt(g.frame.y + 6));
      const up = await page.evaluate<DropGeometry>(DROP_GEOMETRY);
      expect(up.scrollTop).toBeLessThan(g.scrollTop);
      expectFrameOnVisibleArea(up);
      const bottom = up.frame.y + up.frame.height - 6;
      for (let i = 0; i < 5; i++) await page.evaluate(dragOverAt(bottom));
      const down = await page.evaluate<DropGeometry>(DROP_GEOMETRY);
      expect(down.scrollTop).toBeGreaterThan(up.scrollTop);
      expectFrameOnVisibleArea(down);
      await page.evaluate(dragFiles(index, true));
      await expect.poll(md).toContain('![](assets/desk-after.png)');
      const text = await md();
      expect(text.indexOf('![](assets/desk-after.png)')).toBeLessThan(
        text.indexOf('主機搬出房間。'),
      );
      expect(existsSync(path.join(assetsDir, 'desk-after.png'))).toBe(true);
      expect(existsSync(finderFile)).toBe(true);
    });

    await test.step('原始碼模式：貼上與斜線也能用', async () => {
      await page.getByRole('button', { name: '原始碼', exact: true }).click();
      const source = page.locator('textarea.qc-md-editor__source');
      await expect(source).toBeVisible();
      await source.click();
      await page.keyboard.press('Meta+ArrowDown');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.press('/');
      await expect(page.getByRole('listbox', { name: '插入指令' })).toBeVisible();
      await page.keyboard.type('分隔');
      await page.keyboard.press('Enter');
      await expect.poll(async () => ((await md()).match(/^---$/gm) ?? []).length).toBe(2);
      const before = ((await md()).match(/assets\/貼上的圖片/g) ?? []).length;
      await source.click();
      await page.evaluate(PASTE_PNG);
      await expect
        .poll(async () => ((await md()).match(/assets\/貼上的圖片/g) ?? []).length)
        .toBe(before + 1);
      await shot(page, '06-source-mode');
      await page.getByRole('button', { name: '視覺', exact: true }).click();
    });

    await test.step('深色截圖', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.getByRole('button', { name: '插入', exact: true }).click();
      await page.getByRole('menuitem', { name: /從素材庫/ }).click();
      await expect(page.getByRole('complementary', { name: '素材抽屜' })).toBeVisible();
      await imagesShown(page, 4);
      await shot(page, '07-drawer-dark');
      await page.getByRole('button', { name: '插入', exact: true }).click();
      await shot(page, '08-insert-menu-dark');
      await page.keyboard.press('Escape');
    });

    await test.step('刪除已插入的素材：文章裡是複本，文案說明不受影響', async () => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page
        .getByRole('navigation', { name: '主導航' })
        .getByRole('button', { name: '素材庫', exact: true })
        .click();
      await page.getByRole('button', { name: 'kyoto.png，圖片' }).click();
      await page
        .getByRole('complementary', { name: '素材資訊' })
        .getByRole('button', { name: '移到最近刪除' })
        .click();
      const dialog = page.getByRole('dialog', { name: '移到最近刪除？' });
      await expect(dialog).toContainText('被 1 件作品引用');
      await expect(dialog).toContainText('文章中的圖片是獨立複本，不受影響');
      await expect(dialog).not.toContainText('缺圖');
      await shot(page, '09-delete-copy-wording');
      await dialog.getByRole('button', { name: '取消' }).click();
      await expect(dialog).toHaveCount(0);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('外部掛載的作品：插入停用並說明，外部資料夾不被寫入', async ({ desktop }) => {
  const { page, backend } = desktop;
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'qc039-ext-')));
  try {
    writeFileSync(path.join(folder, '外部筆記.md'), '# 外部筆記\n\n內文\n');
    await backend.client.mounts.create({ path: folder, name: '寫作' });
    await expect
      .poll(async () => (await backend.client.works.list({ limit: 20 })).items.length)
      .toBe(1);
    await page
      .getByRole('navigation', { name: '主導航' })
      .getByRole('button', { name: '全部作品', exact: true })
      .click();
    await page
      .getByRole('region', { name: '作品', exact: true })
      .getByRole('button', { name: /外部筆記/ })
      .click();
    const button = page.getByRole('button', { name: '插入', exact: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /外部掛載的作品/);
    await page.locator('.qc-md-editor__content').click();
    await page.evaluate(PASTE_PNG);
    await page.waitForTimeout(500);
    expect(readdirSync(folder)).toEqual(['外部筆記.md']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
