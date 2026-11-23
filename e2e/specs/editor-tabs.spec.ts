import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { ok } from '../../services/mac-server/test/fake-ai.js';
import { test } from '../fixtures/desktop.js';
import { settleAfterDrop } from '../fixtures/dnd.js';

/*
 * QC-047 多分頁編輯 (PT-20261121-001): several works open in tabs; switching
 * keeps each tab's mode, draft, caret, scroll and side panel; closing a tab
 * whose save failed asks first and can be undone; the tabs come back after a
 * restart with only the active one loaded; ⌘1–9, ⌘⇧[ ], ⌘W and the menu bar.
 * Set QC047_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

const PARAGRAPH =
  '分頁讓幾篇稿子可以並排寫，切換時每一篇都停在原本的位置，草稿與游標都還在，不必重新找。';
const LONG = Array.from(
  { length: 30 },
  (_, i) => `## 第 ${String(i + 1)} 節\n\n${PARAGRAPH}\n`,
).join('\n');

function nav(page: Page): Locator {
  return page.getByRole('navigation', { name: '主導航' });
}

function tabBar(page: Page, name = '已開啟的作品'): Locator {
  return page.getByRole('tablist', { name });
}

function tab(page: Page, title: string, bar = '已開啟的作品'): Locator {
  return tabBar(page, bar).getByRole('tab', { name: new RegExp(`^${title}`) });
}

async function openFromLibrary(page: Page, title: string): Promise<void> {
  await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
  await page
    .getByRole('region', { name: '作品', exact: true })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await expect(page.getByRole('textbox', { name: '標題' })).toHaveValue(title);
}

async function selectedTitles(page: Page): Promise<string[]> {
  return tabBar(page).getByRole('tab', { selected: true }).locator('.tab__title').allInnerTexts();
}

async function order(page: Page): Promise<string[]> {
  return tabBar(page).locator('.tab__title').allInnerTexts();
}

async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click();
  }, id);
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC047_SHOTS'];
  if (dir === undefined || dir === '') return;
  await page.screenshot({ path: path.join(dir, `qc047-${name}.png`) });
}

test('開多個作品、切換保留狀態、重複開啟、快捷鍵與選單', async ({ desktop }) => {
  const { page, app, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [title, markdown] of [
    ['甲篇長文', LONG],
    ['乙篇草稿', `${PARAGRAPH}\n`],
    ['丙篇筆記', `${PARAGRAPH}\n`],
  ] as const) {
    await backend.client.works.create({ title, markdown });
  }
  await openFromLibrary(page, '甲篇長文');
  await openFromLibrary(page, '乙篇草稿');
  await openFromLibrary(page, '丙篇筆記');
  await expect(tabBar(page).getByRole('tab')).toHaveCount(3);
  expect(await order(page)).toEqual(['甲篇長文', '乙篇草稿', '丙篇筆記']);
  expect(await selectedTitles(page)).toEqual(['丙篇筆記']);

  await test.step('切換時保留模式、草稿、游標與捲動', async () => {
    await page.keyboard.press('Meta+1');
    expect(await selectedTitles(page)).toEqual(['甲篇長文']);
    await page.getByRole('button', { name: '原始碼', exact: true }).click();
    const source = page.getByRole('textbox', { name: '內文' });
    await expect(source).toBeVisible();
    await source.evaluate((el) => {
      const ta = el as unknown as {
        focus: () => void;
        setSelectionRange: (a: number, b: number) => void;
      };
      ta.focus();
      ta.setSelectionRange(10, 10);
    });
    await page.keyboard.type('Q');
    await source.evaluate((el) => {
      (el as unknown as { scrollTop: number }).scrollTop = 600;
    });
    const scrolled = await source.evaluate(
      (el) => (el as unknown as { scrollTop: number }).scrollTop,
    );
    expect(scrolled).toBeGreaterThan(300);

    // ⌘⇧] to 乙, whose history panel is opened; then back with ⌘⇧[.
    await page.keyboard.press('Meta+Shift+BracketRight');
    expect(await selectedTitles(page)).toEqual(['乙篇草稿']);
    await expect(page.getByRole('textbox', { name: '標題' })).toHaveValue('乙篇草稿');
    await page.getByRole('button', { name: '歷史', exact: true }).click();
    await expect(page.getByRole('button', { name: '歷史', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await page.keyboard.press('Meta+Shift+BracketLeft');
    expect(await selectedTitles(page)).toEqual(['甲篇長文']);
    await expect(source).toBeVisible();
    await expect(source).toHaveValue(/^.{10}Q/s);
    // Put back on the next frame.
    await expect
      .poll(() =>
        source.evaluate((el) => (el as unknown as { selectionStart: number }).selectionStart),
      )
      .toBe(11);
    await expect
      .poll(() => source.evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop))
      .toBe(scrolled);

    // Scroll and switch in the same task, before the scroll event fires: still restored.
    await source.evaluate((el) => {
      (el as unknown as { scrollTop: number }).scrollTop = 900;
      const ev = { key: ']', code: 'BracketRight', metaKey: true, shiftKey: true, bubbles: true };
      const w = globalThis as unknown as {
        dispatchEvent: (e: unknown) => void;
        KeyboardEvent: new (type: string, init: unknown) => unknown;
      };
      w.dispatchEvent(new w.KeyboardEvent('keydown', ev));
    });
    expect(await selectedTitles(page)).toEqual(['乙篇草稿']);
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect
      .poll(() => source.evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop))
      .toBe(900);
    // The caret comes back one frame after the scroll position: wait for it before moving it,
    // or the restore lands on top of the next step's selection.
    await expect
      .poll(() =>
        source.evaluate((el) => (el as unknown as { selectionStart: number }).selectionStart),
      )
      .toBe(11);

    // Type and switch in the same task, before selectionchange fires: the caret is still kept
    // (QC-059; the event arrives later than the shortcut when the machine is busy).
    await source.evaluate((el) => {
      const ta = el as unknown as {
        focus: () => void;
        setSelectionRange: (a: number, b: number) => void;
      };
      ta.focus();
      ta.setSelectionRange(20, 20);
    });
    await source.evaluate(() => {
      const w = globalThis as unknown as {
        document: { execCommand: (c: string, u: boolean, v: string) => boolean };
        dispatchEvent: (e: unknown) => void;
        KeyboardEvent: new (type: string, init: unknown) => unknown;
      };
      w.document.execCommand('insertText', false, 'Z');
      w.dispatchEvent(
        new w.KeyboardEvent('keydown', {
          key: ']',
          code: 'BracketRight',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(await selectedTitles(page)).toEqual(['乙篇草稿']);
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect
      .poll(() =>
        source.evaluate((el) => (el as unknown as { selectionStart: number }).selectionStart),
      )
      .toBe(21);

    await tab(page, '乙篇草稿').click();
    await expect(page.getByRole('button', { name: '歷史', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByRole('button', { name: '視覺', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  await test.step('⌘9 跳到最後一個；原生選單有分頁項目且可以用', async () => {
    await page.keyboard.press('Meta+9');
    expect(await selectedTitles(page)).toEqual(['丙篇筆記']);
    await clickMenu(app, 'tab-jump-1');
    await expect.poll(() => selectedTitles(page)).toEqual(['甲篇長文']);
    await clickMenu(app, 'tab-next');
    await expect.poll(() => selectedTitles(page)).toEqual(['乙篇草稿']);
    const labels = await app.evaluate(({ Menu }) =>
      ['tab-close', 'tab-previous', 'tab-next', 'tab-jump-9'].map(
        (id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.label ?? null,
      ),
    );
    expect(labels).toEqual(['關閉分頁', '顯示上一個分頁', '顯示下一個分頁', '最後一個分頁']);
  });

  await test.step('重複開啟：聚焦既有分頁並提示', async () => {
    await openFromLibrary(page, '甲篇長文');
    await expect(tabBar(page).getByRole('tab')).toHaveCount(3);
    expect(await selectedTitles(page)).toEqual(['甲篇長文']);
    await expect(
      page.getByRole('status').filter({ hasText: '「甲篇長文」已經開啟' }),
    ).toBeVisible();
    // The draft opened again is the one in the tab, not a fresh copy.
    await expect(page.getByRole('textbox', { name: '內文' })).toHaveValue(/^.{10}Q/s);
  });

  await test.step('分頁列上用 ←→ 切換，焦點留在分頁列', async () => {
    await tab(page, '甲篇長文').focus();
    await page.keyboard.press('ArrowRight');
    expect(await selectedTitles(page)).toEqual(['乙篇草稿']);
    await expect(tab(page, '乙篇草稿')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    expect(await selectedTitles(page)).toEqual(['丙篇筆記']);
  });

  await test.step('拖曳排序', async () => {
    // dnd-kit (QC-065) starts on pointer moves past 4 px, then the other tabs move aside.
    const from = await tab(page, '丙篇筆記').boundingBox();
    const to = await tab(page, '甲篇長文').boundingBox();
    if (from === null || to === null) throw new Error('tabs not visible');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 - 10, from.y + from.height / 2, { steps: 3 });
    await page.mouse.move(to.x + 8, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    // dnd-kit stops clicks for a moment after a drop; the next step clicks, so wait for it.
    await settleAfterDrop(page);
    await expect.poll(() => order(page)).toEqual(['丙篇筆記', '甲篇長文', '乙篇草稿']);
    // ⌘1 follows the new order.
    await page.keyboard.press('Meta+1');
    expect(await selectedTitles(page)).toEqual(['丙篇筆記']);
  });

  await test.step('全部分頁選單：搜尋、狀態、⌘ 編號、關閉其他', async () => {
    await page.getByRole('button', { name: '全部分頁（3）' }).click();
    const menu = page.getByRole('dialog', { name: '全部分頁' });
    await expect(menu.getByRole('option')).toHaveCount(3);
    await expect(menu.getByRole('option').first()).toContainText('⌘1');
    await page.keyboard.type('乙篇');
    await expect(menu.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    expect(await selectedTitles(page)).toEqual(['乙篇草稿']);

    // 甲's edit is autosaved by now, so nothing is left unsaved.
    await expect(tabBar(page).locator('.tab--unsaved')).toHaveCount(0);
    await page.getByRole('button', { name: '全部分頁（3）' }).click();
    await page.getByRole('button', { name: /關閉其他分頁/ }).click();
    // 甲's edit was autosaved, so 關閉其他 closes it as well.
    await expect(tabBar(page).getByRole('tab')).toHaveCount(1);
    expect(await order(page)).toEqual(['乙篇草稿']);
    await expect(page.getByRole('status').filter({ hasText: '已關閉 2 個分頁' })).toBeVisible();
  });

  await test.step('⌘W 關閉最後一個分頁，回到作品庫', async () => {
    await page.keyboard.press('Meta+w');
    await expect(tabBar(page)).toBeHidden();
    await expect(page.getByRole('main', { name: '作品庫' })).toBeVisible();
  });
});

test('關閉未存的分頁：先問，預設取消，不儲存後可以重新開啟', async ({ desktop }) => {
  const { page, backend } = desktop;
  await backend.client.works.create({ title: '未存測試', markdown: `${PARAGRAPH}\n` });
  await backend.client.works.create({ title: '另一篇', markdown: `${PARAGRAPH}\n` });
  await openFromLibrary(page, '另一篇');
  await openFromLibrary(page, '未存測試');
  // A blank title cannot be saved: the edit stays unsaved.
  const title = page.getByRole('textbox', { name: '標題' });
  await title.fill('');
  await expect(page.getByRole('alert').filter({ hasText: '標題不可空白' })).toBeVisible();
  await expect(tabBar(page).locator('.tab--unsaved')).toHaveCount(1);

  await page.keyboard.press('Meta+w');
  const dialog = page.getByRole('dialog', { name: '「未命名」有未儲存的修改' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: '重試儲存' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('還是沒有儲存成功，修改仍保留在分頁裡');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tabBar(page).getByRole('tab')).toHaveCount(2);

  await page.keyboard.press('Meta+w');
  await page
    .getByRole('dialog', { name: '「未命名」有未儲存的修改' })
    .getByRole('button', { name: '不儲存並關閉' })
    .click();
  await expect(tabBar(page).getByRole('tab')).toHaveCount(1);
  expect(await selectedTitles(page)).toEqual(['另一篇']);
  // Nothing reached the service.
  const works = await backend.client.works.list({});
  expect(works.items.map((w) => w.title).sort()).toEqual(['另一篇', '未存測試']);

  await page
    .getByRole('status')
    .filter({ hasText: '已關閉「未命名」' })
    .getByRole('button', { name: '重新開啟' })
    .click();
  await expect(tabBar(page).getByRole('tab')).toHaveCount(2);
  expect(await order(page)).toEqual(['另一篇', '未命名']);
  // The discarded edit is back, still unsaved.
  await expect(page.getByRole('textbox', { name: '標題' })).toHaveValue('');
  await expect(tabBar(page).locator('.tab--unsaved')).toHaveCount(1);
});

test('最多同時載入 8 個編輯器；重開 App 恢復全部分頁，只載入作用中的分頁', async ({ desktop }) => {
  const { page, backend, profile, relaunch } = desktop;
  const titles = Array.from({ length: 9 }, (_, i) => `第${String(i + 1)}篇`);
  for (const t of titles)
    await backend.client.works.create({ title: t, markdown: `${PARAGRAPH}\n` });
  for (const t of titles) await openFromLibrary(page, t);
  await expect(tabBar(page).getByRole('tab')).toHaveCount(9);
  await expect(page.locator('.tab-pane')).toHaveCount(8);
  // The least recently used (第1篇) was unloaded and shows in italics.
  await expect(tabBar(page).locator('.tab--unloaded .tab__title')).toHaveText(['第1篇']);
  await tab(page, '第1篇').click();
  await expect(page.getByRole('textbox', { name: '標題' })).toHaveValue('第1篇');
  await expect(tabBar(page).locator('.tab--unloaded .tab__title')).toHaveText(['第2篇']);
  // Switch to source mode in 第1篇: the mode is restored after the restart.
  await page.getByRole('button', { name: '原始碼', exact: true }).click();

  // Saved to the app preferences (debounced).
  await expect
    .poll(() => {
      const prefs = JSON.parse(readFileSync(path.join(profile, 'preferences.json'), 'utf8')) as {
        tabs?: { items: { title: string; mode: string | null }[]; active: string | null };
      };
      return prefs.tabs?.items.map((i) => `${i.title}:${String(i.mode)}`) ?? [];
    })
    .toEqual(titles.map((t) => `${t}:${t === '第1篇' ? 'source' : 'visual'}`));

  const again = await relaunch();
  const p2 = again.page;
  await expect(tabBar(p2).getByRole('tab')).toHaveCount(9);
  await expect(p2.getByRole('status').filter({ hasText: '已恢復上次的 9 個分頁' })).toBeVisible();
  await expect(p2.locator('.tab-pane')).toHaveCount(1);
  await expect(tabBar(p2).locator('.tab--unloaded')).toHaveCount(8);
  await expect(p2.getByRole('textbox', { name: '標題' })).toHaveValue('第1篇');
  await expect(p2.getByRole('textbox', { name: '內文' })).toBeVisible();
  // Others load when clicked.
  await tab(p2, '第5篇').click();
  await expect(p2.getByRole('textbox', { name: '標題' })).toHaveValue('第5篇');
  await expect(p2.locator('.tab-pane')).toHaveCount(2);
  await p2.keyboard.press('Meta+9');
  await expect(p2.getByRole('textbox', { name: '標題' })).toHaveValue('第9篇');

  // 全部關閉 from the notice.
  await p2
    .getByRole('status')
    .filter({ hasText: '已恢復上次的 9 個分頁' })
    .getByRole('button', { name: '全部關閉' })
    .click();
  await expect(tabBar(p2)).toBeHidden();
});

test('切換語言：兩個分頁的編輯器工具列都換成新語言，草稿與游標不變', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const a = await backend.client.works.create({ title: '語言甲', markdown: `${PARAGRAPH}\n` });
  const b = await backend.client.works.create({ title: '語言乙', markdown: `${PARAGRAPH}\n` });
  await openFromLibrary(page, '語言甲');
  await openFromLibrary(page, '語言乙');
  const pane = (title: string) => page.locator(`.tab-pane:has(input[value="${title}"])`);
  // A draft in each tab: typed at the end of the visual text.
  for (const title of ['語言甲', '語言乙']) {
    await tab(page, title).click();
    await pane(title).locator('.qc-md-editor__content p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(title === '語言甲' ? 'AAA' : 'BBB');
  }
  for (const title of ['語言甲', '語言乙']) {
    await expect(pane(title).locator('.qc-md-editor__content')).toContainText(
      title === '語言甲' ? 'AAA' : 'BBB',
    );
    // The block type menu names the caret's block: 內文 (paragraph).
    await expect(pane(title).locator('.editor__doc [role="toolbar"]')).toContainText('內文');
  }

  await page.evaluate("window.creatorhub.setLanguage('en')");
  await expect(tabBar(page, 'Open works')).toBeVisible();
  // Both editors, the one in front and the one in the background, are relabelled in place.
  for (const title of ['語言甲', '語言乙']) {
    const toolbar = pane(title).locator('.editor__doc [role="toolbar"]');
    await expect(toolbar).toContainText('Paragraph');
    await expect(toolbar).not.toContainText('內文');
    await expect(pane(title).locator('.qc-md-editor__content')).toContainText(
      title === '語言甲' ? 'AAA' : 'BBB',
    );
  }
  // Still the same draft and caret: typing continues where it was.
  await page.keyboard.type('C');
  await expect(pane('語言乙').locator('.qc-md-editor__content p').last()).toHaveText(/BBBC$/);
  await page.keyboard.press('Meta+1');
  await expect(pane('語言甲').getByRole('textbox', { name: 'Title' })).toHaveValue('語言甲');
  await expect(pane('語言甲').locator('.qc-md-editor__content p').last()).toHaveText(/AAA$/);
  // The drafts reach the service as typed: nothing was lost or rewritten by the switch.
  await expect
    .poll(async () => (await backend.client.works.get(a.id)).markdown)
    .toBe(`${PARAGRAPH}AAA\n`);
  await expect
    .poll(async () => (await backend.client.works.get(b.id)).markdown)
    .toBe(`${PARAGRAPH}BBBC\n`);
  await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
});

test('截圖：三種語言與深色', async ({ desktop }) => {
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const titles = [
    '春季穿搭的五個重點與搭配清單',
    '週末咖啡館探店筆記',
    '新手攝影：光線怎麼看',
    '讀書會第十二期整理',
    '旅行預算表與行前清單',
    '產品發布會現場紀錄',
    '年度回顧草稿',
    '城市散步路線',
    '早餐食譜合集',
    '冬季護膚心得',
  ];
  for (const t of titles) await backend.client.works.create({ title: t, markdown: LONG });
  await backend.client.ai.setKey('anthropic', 'fake-anthropic-key');
  const { notice } = backend.ai.providerStatus('anthropic');
  await backend.client.ai.consent('anthropic', notice.version);
  upstream.script('anthropic', ok('anthropic', LONG.replaceAll('。', '，讀起來更順。')));
  for (const t of titles) await openFromLibrary(page, t);
  // 第二篇 gets an AI candidate (★ on its tab), the fourth a title that cannot be saved (dot).
  await tab(page, titles[1] ?? '').click();
  const panel = page.getByRole('complementary', { name: 'AI 改寫' });
  await panel.getByRole('button', { name: '改寫全文', exact: true }).click();
  await expect(panel.locator('.ai__hunk').first()).toBeVisible();
  await expect(tabBar(page).locator('.tab__ai')).toHaveCount(1);
  await tab(page, titles[3] ?? '').click();
  await page.getByRole('textbox', { name: '標題' }).fill('');
  await expect(tabBar(page).locator('.tab--unsaved')).toHaveCount(1);
  await tab(page, titles[2] ?? '').click();

  const bars = { 'zh-Hant': '已開啟的作品', 'zh-Hans': '已打开的作品', en: 'Open works' } as const;
  for (const lang of ['zh-Hant', 'zh-Hans', 'en'] as const) {
    await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
    await expect(tabBar(page, bars[lang])).toBeVisible();
    await shot(page, `${lang}-1-tabs`);
  }
  await page.getByRole('button', { name: 'All tabs (10)' }).click();
  await expect(page.getByRole('dialog', { name: 'All tabs' })).toBeVisible();
  await shot(page, 'en-2-all-tabs');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'en-3-tabs-dark');
  await page.evaluate(`window.creatorhub.setLanguage('zh-Hant')`);
  await page.keyboard.press('Meta+4');
  await page.keyboard.press('Meta+w');
  await expect(page.getByRole('dialog', { name: '「未命名」有未儲存的修改' })).toBeVisible();
  await shot(page, 'zh-Hant-4-close-unsaved-dark');
});
