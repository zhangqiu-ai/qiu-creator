import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';
import { trashRow } from '../fixtures/library.js';

/*
 * QC-052 作品庫: compact cards (six to a row at 1440), in-place rename on a
 * card, a list row and a tab (↩ / esc / blur; ↩ while the IME composes does
 * not commit), right-click menus with 改狀態 and 復原, 在新分頁開啟, and
 * ⌘ / ⇧ / ⌘A selection with the batch bar.
 * Set QC052_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC052_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc052-${name}.png`) });
}
const shooting = () => (process.env['QC052_SHOTS'] ?? '') !== '';

function nav(page: Page): Locator {
  return page.getByRole('navigation', { name: '主導航' });
}
const works = (page: Page) => page.getByRole('region', { name: '作品', exact: true });
const card = (page: Page, title: string) =>
  works(page).locator('.wcard', { has: page.locator('.wcard__title', { hasText: title }) });
/** Any language: the region's name is translated. */
const anyCard = (page: Page, title: string) =>
  page.locator('.card-grid .wcard', { has: page.locator('.wcard__title', { hasText: title }) });
const tabBar = (page: Page) => page.getByRole('tablist', { name: '已開啟的作品' });

/** A ↩ that the IME is still composing with, as Chromium delivers it. */
const COMPOSING_ENTER = `(() => {
  const el = document.activeElement;
  el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true }));
  el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '稿' }));
})()`;

const TITLES = [
  '京都散步路線',
  '秋天的咖啡店',
  '一週料理備忘',
  '相機入門筆記',
  '旅行打包清單',
  '早晨寫作習慣',
  '城市夜景拍法',
  '週末市集紀錄',
];

test('作品庫：卡片縮小、原地改名、右鍵選單、改狀態復原、多選', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  for (const [i, title] of TITLES.entries()) {
    await c.works.create(
      i % 3 === 1
        ? { title, type: 'image', source: 'mac-app' }
        : i % 3 === 2
          ? { title, type: 'video', source: 'mac-app' }
          : { title, markdown: `# ${title}\n\n正文`, source: 'mac-app' },
    );
  }
  const byTitle = async (title: string) => {
    const w = (await c.works.list({ limit: 50 })).items.find((x) => x.title === title);
    if (w === undefined) throw new Error(`no work ${title}`);
    return w;
  };

  await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
  await expect(works(page).locator('.wcard')).toHaveCount(TITLES.length);

  await test.step('1440 寬時一列至少 6 張卡片', async () => {
    const tops = await works(page)
      .locator('.wcard')
      .evaluateAll((els) =>
        els.map((el) =>
          Math.round(
            (
              el as unknown as { getBoundingClientRect: () => { top: number } }
            ).getBoundingClientRect().top,
          ),
        ),
      );
    const firstRow = tops.filter((top) => top === tops[0]).length;
    expect(firstRow).toBeGreaterThanOrEqual(6);
    await shot(page, 'zh-Hant-1-grid');
  });

  await test.step('雙擊卡片標題改名：組字中的 ↩ 不提交，esc 取消，↩ 儲存', async () => {
    await card(page, '京都散步路線').locator('.wcard__title').dblclick();
    const field = works(page).getByRole('textbox', { name: '重新命名「京都散步路線」' });
    await expect(field).toBeFocused();
    // Double-clicking never opened the work.
    await expect(tabBar(page)).toHaveCount(0);
    await field.fill('京都散步');
    await page.evaluate(COMPOSING_ENTER);
    await expect(field).toBeVisible();
    await shot(page, 'zh-Hant-2-rename-card');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(card(page, '京都散步路線')).toBeFocused();
    expect((await byTitle('京都散步路線')).title).toBe('京都散步路線');

    await card(page, '京都散步路線').locator('.wcard__title').dblclick();
    await field.fill('京都散步・秋');
    await page.keyboard.press('Enter');
    await expect(card(page, '京都散步・秋')).toBeVisible();
    await expect.poll(async () => (await byTitle('京都散步・秋')).title).toBe('京都散步・秋');
  });

  await test.step('改名失焦即儲存；清空名稱不送出', async () => {
    await card(page, '秋天的咖啡店').locator('.wcard__title').dblclick();
    const field = works(page).getByRole('textbox', { name: '重新命名「秋天的咖啡店」' });
    await field.fill('   ');
    await page.keyboard.press('Enter');
    await expect(card(page, '秋天的咖啡店')).toBeVisible();
    await card(page, '秋天的咖啡店').locator('.wcard__title').dblclick();
    await field.fill('秋天的咖啡店 二訪');
    await page.locator('.page__title').click();
    await expect.poll(async () => (await byTitle('秋天的咖啡店 二訪')).status).toBe('drafting');
  });

  await test.step('右鍵選單：改狀態子選單，鍵盤可操作，給復原', async () => {
    await card(page, '一週料理備忘').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '「一週料理備忘」的操作' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([
      '開啟',
      '在新分頁開啟',
      '重新命名',
      '改狀態',
      '項目',
      '刪除…⌘⌫',
    ]);
    await expect(menu.getByRole('menuitem', { name: '開啟', exact: true })).toBeFocused();
    await menu.getByRole('menuitem', { name: '改狀態' }).hover();
    const sub = page.getByRole('menu', { name: '改狀態' });
    await expect(sub).toBeVisible();
    await expect(sub.getByRole('menuitemradio', { name: '創作中' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await shot(page, 'zh-Hant-3-menu-status');
    // Keyboard: 改狀態 has focus from the hover; → opens it, ↓↓ to the third status, ↩ picks.
    await page.keyboard.press('ArrowRight');
    await expect(sub.getByRole('menuitemradio').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    const toast = page.getByRole('status').filter({ hasText: '「一週料理備忘」已改為' });
    await expect(toast).toBeVisible();
    await expect.poll(async () => (await byTitle('一週料理備忘')).status).toBe('ready');
    await expect(card(page, '一週料理備忘').locator('.chip').first()).toHaveText('待發布');
    await shot(page, 'zh-Hant-4-status-undo');
    await toast.getByRole('button', { name: '復原' }).click();
    await expect.poll(async () => (await byTitle('一週料理備忘')).status).toBe('drafting');
    await expect(card(page, '一週料理備忘').locator('.chip').first()).toHaveText('創作中');
  });

  await test.step('esc 關閉選單並把焦點還給卡片；在新分頁開啟不離開作品庫', async () => {
    await card(page, '相機入門筆記').click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await card(page, '相機入門筆記').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '在新分頁開啟' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '已在新分頁開啟「相機入門筆記」' }),
    ).toBeVisible();
    await expect(works(page)).toBeVisible();
  });

  await test.step('⌘ 點選、⇧ 點選範圍、⌘A 全選、esc 取消；選取時右鍵作用於全部', async () => {
    await card(page, '旅行打包清單').click({ modifiers: ['Meta'] });
    await card(page, '城市夜景拍法').click({ modifiers: ['Meta'] });
    const bar = page.getByRole('toolbar', { name: '已選 2 個' });
    await expect(bar).toBeVisible();
    await expect(card(page, '旅行打包清單')).toHaveClass(/wcard--selected/);
    // Still in 作品庫: ⌘-click never opens.
    await expect(works(page)).toBeVisible();
    // ⇧ from the anchor (the last ⌘-click, 城市夜景拍法) to the first card: everything between.
    const shown = await works(page).locator('.wcard__title').allInnerTexts();
    const from = shown.indexOf('城市夜景拍法');
    const target = shown[0] === '城市夜景拍法' ? shown.at(-1) : shown[0];
    if (target === undefined) throw new Error('no cards');
    const span = Math.abs(shown.indexOf(target) - from) + 1;
    await card(page, target).click({ modifiers: ['Shift'] });
    await expect(page.getByRole('toolbar', { name: `已選 ${String(span)} 個` })).toBeVisible();
    await expect(card(page, target)).toHaveClass(/wcard--selected/);
    await card(page, '城市夜景拍法').click({ button: 'right' });
    const many = page.getByRole('menu', { name: `已選 ${String(span)} 個作品的操作` });
    await expect(many.getByRole('menuitem')).toHaveText([
      '改狀態',
      '項目',
      '加標籤…',
      '移除標籤…',
      '刪除…⌘⌫',
    ]);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Meta+a');
    await expect(
      page.getByRole('toolbar', { name: `已選 ${String(TITLES.length)} 個` }),
    ).toBeVisible();
    await shot(page, 'zh-Hant-5-select-all');
    await page.getByRole('toolbar').getByRole('button', { name: '改狀態' }).click();
    await page.getByRole('menuitemradio', { name: '待審核' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: `${String(TITLES.length)} 個作品已改為「待審核」` }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        (await c.works.list({ limit: 50 })).items.every((w) => w.status === 'in_review'),
      )
      .toBe(true);
    await page.getByRole('status').getByRole('button', { name: '復原' }).click();
    await expect
      .poll(
        async () =>
          (await c.works.list({ limit: 50 })).items.filter((w) => w.status === 'in_review').length,
      )
      .toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('toolbar')).toHaveCount(0);
  });

  await test.step('列表檢視：雙擊標題改名，右鍵同樣可用', async () => {
    await page.getByRole('button', { name: '列表' }).click();
    const row = works(page).getByRole('row', { name: /早晨寫作習慣/ });
    await row.locator('.tbl__name').dblclick();
    const field = works(page).getByRole('textbox', { name: '重新命名「早晨寫作習慣」' });
    await field.fill('晨間寫作');
    await shot(page, 'zh-Hant-6-rename-row');
    await page.keyboard.press('Enter');
    await expect(works(page).getByRole('row', { name: /晨間寫作/ })).toBeVisible();
    await expect.poll(async () => (await byTitle('晨間寫作')).title).toBe('晨間寫作');
    await works(page)
      .getByRole('row', { name: /晨間寫作/ })
      .click({ button: 'right' });
    await expect(page.getByRole('menu', { name: '「晨間寫作」的操作' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '網格' }).click();
  });

  await test.step('分頁：雙擊改名（開著的編輯器同步），右鍵關閉其他', async () => {
    await card(page, '旅行打包清單').locator('.wcard__cover').click();
    await expect(tabBar(page)).toBeVisible();
    const active = tabBar(page).getByRole('tab', { selected: true });
    await expect(active).toContainText('旅行打包清單');
    await active.locator('.tab__title').dblclick();
    const field = tabBar(page).getByRole('textbox', { name: '重新命名「旅行打包清單」' });
    await expect(field).toBeFocused();
    await field.fill('打包清單');
    await shot(page, 'zh-Hant-7-rename-tab');
    await page.keyboard.press('Enter');
    await expect(active.locator('.tab__title')).toHaveText('打包清單');
    await expect(page.getByRole('textbox', { name: '標題' })).toHaveValue('打包清單');
    await expect.poll(async () => (await byTitle('打包清單')).title).toBe('打包清單');

    // The background tab from 在新分頁開啟 is there; rename it without loading it.
    const background = tabBar(page).getByRole('tab', { name: /^相機入門筆記/ });
    await background.locator('.tab__title').dblclick();
    await tabBar(page).getByRole('textbox').fill('相機筆記');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await byTitle('相機筆記')).title).toBe('相機筆記');

    await tabBar(page)
      .getByRole('tab', { name: /^打包清單/ })
      .click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '分頁「打包清單」的操作' });
    await expect(menu.getByRole('menuitem')).toHaveText(['重新命名', '關閉分頁⌘W', '關閉其他分頁']);
    await shot(page, 'zh-Hant-8-tab-menu');
    await menu.getByRole('menuitem', { name: '關閉其他分頁' }).click();
    await expect(tabBar(page).getByRole('tab')).toHaveCount(1);
    await expect(tabBar(page).getByRole('tab')).toContainText('打包清單');
  });

  if (shooting()) {
    await test.step('截圖：簡中、English、深色', async () => {
      await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
      await expect(works(page)).toBeVisible();
      for (const lang of ['zh-Hans', 'en'] as const) {
        await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
        await anyCard(page, '城市夜景拍法').click({ modifiers: ['Meta'] });
        await anyCard(page, '一週料理備忘').click({ modifiers: ['Meta'] });
        await anyCard(page, '一週料理備忘').click({ button: 'right' });
        await page.locator('.ctx-menu .ctx-menu__item[data-sub]').hover();
        await expect(page.locator('.ctx-menu--sub')).toBeVisible();
        await shot(page, `${lang}-menu`);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      }
      await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
      await page.emulateMedia({ colorScheme: 'dark' });
      await anyCard(page, '城市夜景拍法').click({ modifiers: ['Meta'] });
      await anyCard(page, '秋天的咖啡店 二訪').click({ modifiers: ['Meta'] });
      await anyCard(page, '秋天的咖啡店 二訪').click({ button: 'right' });
      await shot(page, 'dark-menu');
      await page.keyboard.press('Escape');
      await page.emulateMedia({ colorScheme: null });
    });
  }
});

test('作品庫：刪除確認與復原、批量標籤、分頁關閉、回收站還原與永久刪除、外部作品原檔不動', async ({
  desktop,
}) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'qc052-ext-')));
  const externalFile = path.join(folder, '外部筆記.md');
  writeFileSync(externalFile, '# 外部筆記\n\n內文\n');
  try {
    for (const title of ['春季選題', '夏日清單', '秋天散步', '冬至食譜']) {
      await c.works.create({ title, markdown: `# ${title}`, source: 'mac-app' });
    }
    await c.mounts.create({ path: folder, name: '寫作' });
    await expect.poll(async () => (await c.works.list({ limit: 20 })).items.length).toBe(5);
    const active = async () => (await c.works.list({ limit: 50 })).items;
    const byTitle = async (title: string) => {
      const w = (await active()).find((x) => x.title === title);
      if (w === undefined) throw new Error(`no work ${title}`);
      return w;
    };
    const trashChip = () => trashRow(page);

    await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    await expect(works(page).locator('.wcard')).toHaveCount(5);
    await expect(trashChip()).toHaveText('回收站');

    await test.step('右鍵刪除：確認框寫明可還原 30 天，刪除後可復原', async () => {
      await card(page, '春季選題').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^刪除…/ }).click();
      const dialog = page.getByRole('dialog', { name: '刪除「春季選題」？' });
      await expect(dialog).toContainText('會移到回收站，30 天內可以還原');
      await expect(dialog.getByRole('button', { name: '刪除', exact: true })).toBeFocused();
      await shot(page, 'zh-Hant-9-delete-confirm');
      await page.keyboard.press('Enter');
      await expect(card(page, '春季選題')).toHaveCount(0);
      await expect(trashChip()).toHaveText('回收站1');
      const toast = page.getByRole('status').filter({ hasText: '已刪除「春季選題」' });
      await expect(toast).toBeVisible();
      await shot(page, 'zh-Hant-10-deleted-undo');
      await toast.getByRole('button', { name: '復原' }).click();
      await expect(card(page, '春季選題')).toBeVisible();
      await expect
        .poll(async () => (await c.works.list({ scope: 'trash', limit: 5 })).total)
        .toBe(0);
    });

    await test.step('批量加標籤（組字中的 ↩ 不套用）與復原，再移除標籤', async () => {
      await card(page, '夏日清單').click({ modifiers: ['Meta'] });
      await card(page, '秋天散步').click({ modifiers: ['Meta'] });
      await page.getByRole('toolbar').getByRole('button', { name: '加標籤…' }).click();
      const dialog = page.getByRole('dialog', { name: '為 2 個作品加標籤' });
      const field = dialog.getByRole('textbox', { name: '標籤' });
      await expect(field).toBeFocused();
      await field.fill('京都，旅行');
      await page.evaluate(
        COMPOSING_ENTER.replace(
          "el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true }));",
          '',
        ),
      );
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('#京都 #旅行');
      await shot(page, 'zh-Hant-11-add-tags');
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await byTitle('夏日清單')).tags).toEqual(['京都', '旅行']);
      expect((await byTitle('秋天散步')).tags).toEqual(['京都', '旅行']);
      await page
        .getByRole('status')
        .filter({ hasText: '已為 2 個作品加上標籤' })
        .getByRole('button', { name: '復原' })
        .click();
      await expect.poll(async () => (await byTitle('夏日清單')).tags).toEqual([]);

      await page.getByRole('toolbar').getByRole('button', { name: '加標籤…' }).click();
      await page.getByRole('dialog').getByRole('textbox').fill('京都');
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await byTitle('秋天散步')).tags).toEqual(['京都']);
      await page.getByRole('toolbar').getByRole('button', { name: '移除標籤…' }).click();
      const remove = page.getByRole('dialog', { name: '從 2 個作品移除標籤' });
      await remove.getByRole('checkbox', { name: '#京都' }).check();
      await remove.getByRole('button', { name: '套用' }).click();
      await expect.poll(async () => (await byTitle('秋天散步')).tags).toEqual([]);
    });

    await test.step('⌘⌫ 刪除兩個選取的作品；開著的分頁一起關閉', async () => {
      await page.keyboard.press('Escape');
      await card(page, '冬至食譜').click({ button: 'right' });
      await page.getByRole('menuitem', { name: '在新分頁開啟' }).click();
      await expect(page.getByRole('tablist', { name: '已開啟的作品' })).toHaveCount(0);
      await card(page, '夏日清單').click({ modifiers: ['Meta'] });
      await card(page, '冬至食譜').click({ modifiers: ['Meta'] });
      await page.keyboard.press('Meta+Backspace');
      const dialog = page.getByRole('dialog', { name: '刪除 2 個作品？' });
      await dialog.getByRole('button', { name: '刪除', exact: true }).click();
      await expect(trashChip()).toHaveText('回收站2');
      await expect(page.getByRole('toolbar')).toHaveCount(0);
      expect((await active()).map((w) => w.title).sort()).toEqual([
        '外部筆記',
        '春季選題',
        '秋天散步',
      ]);
      // The background tab of 冬至食譜 closed with it.
      await card(page, '秋天散步').locator('.wcard__cover').click();
      await expect(tabBar(page).getByRole('tab')).toHaveCount(1);
      await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
    });

    await test.step('外部作品：只從作品庫移除，原檔不動', async () => {
      await card(page, '外部筆記').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^刪除…/ }).click();
      const dialog = page.getByRole('dialog', { name: '刪除「外部筆記」？' });
      await expect(dialog).toContainText('外部資料夾的作品只會從作品庫移除，原檔留在原處。');
      await expect(
        dialog.getByRole('checkbox', { name: /原檔也移到 macOS 垃圾桶/ }),
      ).not.toBeChecked();
      await dialog.getByRole('button', { name: '刪除', exact: true }).click();
      await expect(trashChip()).toHaveText('回收站3');
      expect(existsSync(externalFile)).toBe(true);
      expect(desktop.systemTrash.moved).toEqual([]);
    });

    await test.step('回收站：剩餘天數、還原、永久刪除（取消先有焦點）、清空', async () => {
      await trashChip().click();
      const list = page.getByRole('region', { name: '已刪除的作品' });
      await expect(list.locator('.wcard')).toHaveCount(3);
      await expect(list.locator('.wcard', { hasText: '夏日清單' })).toContainText('30 天後刪除');
      await expect(list.locator('.wcard', { hasText: '外部筆記' })).toContainText(
        '只從作品庫移除，原檔未動',
      );
      await shot(page, 'zh-Hant-12-trash');

      await list.locator('.wcard', { hasText: '夏日清單' }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: '還原' }).click();
      await expect(list.locator('.wcard')).toHaveCount(2);
      // The card left 回收站: no notice (QC-115).
      await expect(page.locator('[data-toast]').filter({ hasText: '已還原' })).toHaveCount(0);
      expect((await byTitle('夏日清單')).deleted_at ?? null).toBeNull();

      await list.locator('.wcard', { hasText: '冬至食譜' }).click();
      await page.getByRole('toolbar').getByRole('button', { name: '永久刪除…' }).click();
      const purge = page.getByRole('dialog', { name: '永久刪除「冬至食譜」？' });
      await expect(purge).toContainText('無法復原');
      await expect(purge.getByRole('button', { name: '取消' })).toBeFocused();
      await shot(page, 'zh-Hant-13-purge-confirm');
      await purge.getByRole('button', { name: '永久刪除' }).click();
      await expect(list.locator('.wcard')).toHaveCount(1);
      await expect(page.locator('[data-toast]').filter({ hasText: '已永久刪除' })).toHaveCount(0);

      await page.getByRole('button', { name: '清空回收站' }).click();
      const empty = page.getByRole('dialog', { name: '清空回收站？' });
      await expect(empty).toContainText('1 個作品會永久刪除');
      await empty.getByRole('button', { name: '清空回收站' }).click();
      await expect(page.getByText('回收站是空的')).toBeVisible();
      expect((await c.works.list({ scope: 'trash', limit: 5 })).total).toBe(0);
      // Purging an unindexed external work never touches its file.
      expect(existsSync(externalFile)).toBe(true);

      await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
      await expect(trashChip()).toHaveText('回收站');
      await expect(works(page).locator('.wcard')).toHaveCount(3);
    });

    if (shooting()) {
      await test.step('截圖：回收站的簡中、English、深色', async () => {
        for (const title of ['春季選題', '秋天散步']) {
          const w = await byTitle(title);
          await c.works.trash(w.id, { base_revision: w.current_revision_id });
        }
        await trashChip().click();
        // Notices keep the language they were shown in; clear them before switching.
        const closers = page.locator('.toast button[aria-label]');
        while ((await closers.count()) > 0) await closers.first().click();
        for (const lang of ['zh-Hans', 'en'] as const) {
          await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
          await page.locator('.card-grid .wcard').first().click();
          await shot(page, `${lang}-trash`);
        }
        await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
        await page.emulateMedia({ colorScheme: 'dark' });
        await shot(page, 'dark-trash');
        await page.emulateMedia({ colorScheme: null });
      });
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
