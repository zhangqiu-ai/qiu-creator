import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';
import { trashRow } from '../fixtures/library.js';

/*
 * QC-062 作品庫的項目 (PT-20261121-003): 未分類 and 項目 in the sidebar,
 * creating and renaming a project, dragging works onto it with dnd-kit (add, never move), dragging rows to reorder,
 * the 項目 ▸ checkboxes (mixed for a mixed selection) with 復原, colour dots
 * on cards, a project's page with its counts and assets link, a new work
 * made inside a project joining it, 所屬項目 in the editor, and deleting a
 * project (works stay, 復原 brings it back) with 回收站 saying where a
 * deleted work was.
 * Set QC062_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC062_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc062-${name}.png`) });
}

const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const works = (page: Page) => page.getByRole('region', { name: '作品', exact: true });
const card = (page: Page, title: string) =>
  works(page).locator('.wcard', { has: page.locator('.wcard__title', { hasText: title }) });
/** 復原 in the toast that says `text` (several undoable toasts can be stacked). */
const undo = (page: Page, text: string) =>
  page.locator('.toast', { hasText: text }).getByRole('button', { name: '復原' });
const row = (page: Page, name: string) =>
  nav(page).locator('[data-project-row]', { hasText: name });

/** dnd-kit drags on pointer moves: press, move past its 5 px threshold, glide over, release. */
async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error('drag target not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test('作品庫項目：側欄、拖放加入、勾選、項目頁、編輯器、刪除與復原', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;

  const leaf = (
    await c.assets.upload({ data: await pngBytes(600, 400, '#B8862B'), filename: 'leaf.png' })
  ).asset;
  const kyoto = await c.works.create({
    title: '京都散步路線',
    markdown: '# 京都\n',
    source: 'mac-app',
  });
  await c.works.create({ title: '秋天的咖啡店', markdown: '', source: 'mac-app' });
  await c.works.create({ title: '相機入門筆記', markdown: '', source: 'mac-app' });
  const { src } = await c.works.attachMedia(kyoto.id, leaf.id);
  const fresh = await c.works.get(kyoto.id);
  await c.works.patch(kyoto.id, {
    base_revision: fresh.current_revision_id,
    markdown: `# 京都\n\n![葉](${src})\n`,
  });

  await page.reload();
  await expect(nav(page).getByRole('button', { name: '未分類' })).toContainText('3');

  await test.step('側欄＋新建項目，F2 重新命名', async () => {
    await nav(page).getByRole('button', { name: '新建項目', exact: true }).first().click();
    await page.keyboard.type('秋季選題');
    await page.keyboard.press('Enter');
    await expect(page.locator('.page__title')).toHaveText('秋季選題');
    await expect(row(page, '秋季選題')).toHaveAttribute('aria-current', 'page');
    await row(page, '秋季選題').focus();
    await page.keyboard.press('F2');
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('秋季');
    await page.keyboard.press('Enter');
    await expect(row(page, '秋季')).toBeVisible();
    await expect(page.getByText('這個項目還沒有作品')).toBeVisible();
    await shot(page, '1-empty-project');
  });

  await test.step('拖到側欄的項目：加入，不移動；復原只拿回新加的', async () => {
    await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    await drag(page, card(page, '京都散步路線'), row(page, '秋季'));
    await expect(page.getByText('已加入「秋季」')).toBeVisible();
    await expect(row(page, '秋季')).toContainText('1');
    // Still in 全部作品: a project is a label, not a folder.
    await expect(card(page, '京都散步路線')).toBeVisible();
    await expect(card(page, '京都散步路線').locator('.plabel')).toHaveText('秋季');
    await expect(nav(page).getByRole('button', { name: '未分類' })).toContainText('2');
    await shot(page, '2-dropped');
  });

  await test.step('多選右鍵 項目 ▸ 勾選是半選，按一下全部加入，復原', async () => {
    await card(page, '京都散步路線').click({ modifiers: ['Meta'] });
    await card(page, '秋天的咖啡店').click({ modifiers: ['Meta'] });
    await card(page, '秋天的咖啡店').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '項目' }).hover();
    const box = page.getByRole('menuitemcheckbox', { name: '秋季' });
    await expect(box).toHaveAttribute('aria-checked', 'mixed');
    await shot(page, '3-mixed-menu');
    await box.click();
    await expect(page.getByText('1 個作品已加入「秋季」')).toBeVisible();
    await expect(row(page, '秋季')).toContainText('2');
    await undo(page, '1 個作品已加入「秋季」').click();
    await expect(row(page, '秋季')).toContainText('1');
    await page.keyboard.press('Escape');
  });

  await test.step('項目頁：作品數、素材連結、在項目裡新建的作品自動加入', async () => {
    await row(page, '秋季').click();
    // QC-069: the overview row became one light line by the title.
    const sub = page.locator('main .page__sub');
    await expect(sub).toContainText('1 個作品');
    await expect(sub.getByRole('button', { name: '1 個素材' })).toBeVisible();
    await shot(page, '4-project-page');
    await sub.getByRole('button', { name: '1 個素材' }).click();
    await expect(page.getByText('用在「秋季」')).toBeVisible();
    await expect(page.locator('.atile')).toHaveCount(1);
    await expect(page.locator('.atile__name')).toHaveText('leaf.png');
    await shot(page, '5-used-assets');
    await page.getByRole('button', { name: '回到「秋季」' }).click();
    await expect(page.locator('.page__title')).toHaveText('秋季');
    await page.getByRole('main').getByRole('button', { name: '新建', exact: true }).click();
    await page.getByRole('menuitem', { name: /文章/ }).click();
    await expect(row(page, '秋季')).toContainText('2');
  });

  await test.step('編輯器：所屬項目標籤，× 移出，項目 搜尋後新建', async () => {
    const tags = page.locator('.ptags');
    await expect(tags.locator('.ptags__tag', { hasText: '秋季' })).toBeVisible();
    await tags.getByRole('button', { name: '項目', exact: true }).click();
    await page.keyboard.type('旅行');
    await expect(page.getByRole('option', { name: /新建「旅行」/ })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(tags.locator('.ptags__tag', { hasText: '旅行' })).toBeVisible();
    await shot(page, '6-editor-tags');
    await page.keyboard.press('Escape');
    await tags.getByRole('button', { name: '從「旅行」移出' }).click();
    await expect(tags.locator('.ptags__tag', { hasText: '旅行' })).toHaveCount(0);
  });

  await test.step('拖曳側欄的項目列排序（滑鼠與鍵盤）', async () => {
    const names = () => nav(page).locator('[data-project-row] .sb__label').allTextContents();
    expect(await names()).toEqual(['秋季', '旅行']);
    await drag(page, row(page, '旅行'), row(page, '秋季'));
    await expect.poll(names).toEqual(['旅行', '秋季']);
    expect((await backend.client.projects.list()).items.map((p) => p.name)).toEqual([
      '旅行',
      '秋季',
    ]);
    // Keyboard: Space picks the row up, ↓ moves it, Space puts it down; Esc cancels with no change.
    await row(page, '旅行').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect.poll(names).toEqual(['旅行', '秋季']);
    await row(page, '旅行').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await expect.poll(names).toEqual(['秋季', '旅行']);
    // Space on a row never opened it: still in the editor.
    await expect(page.locator('.ptags')).toBeVisible();
  });

  await test.step('刪除項目：作品留下、說明幾個會回到未分類、可復原', async () => {
    await row(page, '秋季').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '刪除項目…' }).click();
    const dialog = page.getByRole('dialog', { name: '刪除項目「秋季」？' });
    await expect(dialog).toContainText('2 個作品會留在作品庫');
    await shot(page, '7-delete-dialog');
    await dialog.getByRole('button', { name: '刪除項目' }).click();
    await expect(row(page, '秋季')).toHaveCount(0);
    // The editor in front drops the deleted project's tag; 復原 brings both back.
    const tag = page.locator('.ptags .ptags__tag', { hasText: '秋季' });
    await expect(tag).toHaveCount(0);
    await undo(page, '已刪除項目「秋季」').click();
    await expect(row(page, '秋季')).toBeVisible();
    await expect(tag).toHaveCount(1);
  });

  await test.step('回收站寫出原本所在的項目', async () => {
    await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    await card(page, '京都散步路線').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /刪除…/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /刪除/ }).last().click();
    await trashRow(page).click();
    await expect(page.getByText('原本在：秋季')).toBeVisible();
    await shot(page, '8-trash-from');
  });
});
