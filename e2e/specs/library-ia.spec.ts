import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-069 作品庫與項目頁精簡、側欄重新分組 (PT-20261122-001):
 * - the sidebar goes scopes (全部作品, 未分類) → 項目 → 素材 → 工具, with
 *   最近刪除 and 設定 in its foot;
 * - one header row: title, one light line of counts, search, 篩選, view, 新建;
 *   type and status live in the 篩選 popover (faceted counts, 0 dimmed), and
 *   the filters in use show as removable chips;
 * - while searching or filtering the line says 「N 個結果 · 共 M 個」;
 * - a search with no result keeps the search and offers to clear it or to look
 *   in every work;
 * - cards name their project (colour, first name, +N; not the project being
 *   viewed); the list has a 項目 column; new projects take the colours in turn.
 * Set QC069_SHOTS=<dir> to save screenshots.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC069_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc069-${name}.png`) });
}

const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const grid = (page: Page) => page.getByRole('region', { name: '作品', exact: true });
const card = (page: Page, title: string) =>
  grid(page).locator('.wcard', { has: page.locator('.wcard__title', { hasText: title }) });
const sub = (page: Page) => page.locator('main .page__sub');
const filterButton = (page: Page) => page.locator('main .fmenu__btn');
const option = (page: Page, group: '類型' | '狀態', name: RegExp) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name });

test('作品庫精簡：側欄分組、一行頁首、篩選彈出層、結果數一致、項目標籤', async ({ desktop }) => {
  test.setTimeout(90_000);
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const c = backend.client;
  const kyoto = await c.projects.create({ name: '京都旅行', color: 2 });
  const cook = await c.projects.create({ name: '一人食系列', color: 5 });
  const style = await c.projects.create({ name: '2026 秋冬穿搭與通勤系列企劃', color: 7 });
  const make = async (
    title: string,
    extra: { type?: 'image' | 'video'; markdown?: string; status?: 'in_review' | 'ready' },
    projects: string[],
  ) => {
    const w =
      extra.type === undefined
        ? await c.works.create({ title, markdown: extra.markdown ?? '', source: 'mac-app' })
        : await c.works.create({ title, type: extra.type, source: 'mac-app' });
    if (extra.status !== undefined)
      await c.works.patch(w.id, { base_revision: w.current_revision_id, status: extra.status });
    if (projects.length > 0) await c.projects.batchWorks({ work_ids: [w.id], add: projects });
    return w;
  };
  await make('京都紅葉季七日慢遊路線', { type: 'image', status: 'in_review' }, [kyoto.id]);
  await make('一人食：15 分鐘番茄牛腩飯', { type: 'video' }, [cook.id]);
  await make(
    '嵐山竹林清晨拍攝筆記',
    { markdown: '# 嵐山竹林清晨拍攝筆記\n\n六點前的竹林幾乎沒有人，逆光拍會比順光好看。' },
    [kyoto.id],
  );
  await make(
    '伏見稻荷：避開人潮的時段',
    {
      markdown: '# 伏見稻荷\n\n清晨六點前與傍晚五點後，千本鳥居幾乎沒有人。',
      status: 'ready',
    },
    [kyoto.id, cook.id, style.id],
  );
  await make('秋冬通勤穿搭 5 套', { type: 'image' }, [style.id]);
  await make('2026 年最順手的寫作工具', { markdown: '# 寫作工具\n\n打開就能寫。' }, []);
  await page.reload();

  await test.step('側欄：全部作品、未分類 → 項目 → 素材 → 工具；底部是最近刪除與設定', async () => {
    const groups = nav(page).getByRole('group');
    await expect(groups).toHaveText([
      /全部作品.*6.*未分類.*1/,
      /項目/,
      /素材庫.*匯入任務/,
      /AI 工作台.*平台預覽/,
    ]);
    await expect(nav(page).locator('.sb__foot')).toContainText('最近刪除');
    await expect(nav(page).locator('.sb__foot')).toContainText('設定');
    await expect(nav(page).getByRole('button', { name: '全部作品' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // No more 「創作」 or 「AI」 headings.
    await expect(nav(page).locator('.sb__grp-h', { hasText: /^(創作|AI)$/ })).toHaveCount(0);
  });

  await test.step('全部作品：一行頁首，淡字寫作品數；卡片顯示所屬項目', async () => {
    await expect(page.locator('main h1')).toHaveText('全部作品');
    await expect(sub(page)).toHaveText('6 個作品');
    // The old rows are gone: no type segments, status chips or 最近刪除 chip on the page.
    await expect(page.locator('main .filters')).toHaveCount(0);
    await expect(page.locator('main .proj-overview')).toHaveCount(0);
    const label = card(page, '伏見稻荷').locator('.plabel');
    await expect(label).toHaveText('京都旅行+2');
    await expect(label).toHaveAttribute(
      'title',
      '京都旅行、一人食系列、2026 秋冬穿搭與通勤系列企劃',
    );
    await expect(card(page, '寫作工具').locator('.plabel')).toHaveCount(0);
    // A long name is cut, never wider than the card.
    const long = card(page, '秋冬通勤穿搭').locator('.plabel');
    const box = await long.boundingBox();
    const cardBox = await card(page, '秋冬通勤穿搭').boundingBox();
    expect(box !== null && cardBox !== null && box.x + box.width <= cardBox.x + cardBox.width).toBe(
      true,
    );
    await shot(page, '1-all');
  });

  await test.step('篩選：類型與狀態在一個彈出層，數量是分面計數，0 停用', async () => {
    // Esc closes it at once, even before focus has moved into it.
    await filterButton(page).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '篩選' })).toHaveCount(0);
    await expect(filterButton(page)).toBeFocused();
    await filterButton(page).click();
    await expect(option(page, '類型', /^全部/)).toContainText('6');
    await expect(option(page, '類型', /^文章/)).toContainText('3');
    await expect(option(page, '狀態', /^待審核/)).toContainText('1');
    await expect(option(page, '狀態', /^已發布/)).toBeDisabled();
    await shot(page, '2-filter-open');
    await option(page, '狀態', /^創作中/).click();
    // Type counts follow the chosen status.
    await expect(option(page, '類型', /^文章/)).toContainText('2');
    await option(page, '類型', /^貼圖/).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '篩選' })).toHaveCount(0);
    await expect(filterButton(page)).toHaveAccessibleName('篩選，已套用 2 項');
    await expect(sub(page)).toHaveText('1 個結果 · 共 6 個');
    const chips = page.getByRole('group', { name: '目前篩選' });
    await expect(chips.locator('.afilters__chip')).toHaveText(['貼圖', '創作中']);
    await expect(grid(page).locator('.wcard')).toHaveCount(1);
    await shot(page, '3-filtered');
    await chips.getByRole('button', { name: '移除「貼圖」' }).click();
    // Every 創作中 work: four of the six.
    await expect(grid(page).locator('.wcard')).toHaveCount(4);
    await chips.getByRole('button', { name: '清除篩選' }).click();
    await expect(page.getByRole('group', { name: '目前篩選' })).toHaveCount(0);
    await expect(sub(page)).toHaveText('6 個作品');
  });

  await test.step('項目頁：不重複目前項目的標籤；淡字有素材連結；列表有「項目」欄', async () => {
    await nav(page)
      .getByRole('button', { name: /^京都旅行/ })
      .click();
    await expect(page.locator('main h1')).toHaveText('京都旅行');
    await expect(sub(page)).toContainText('3 個作品');
    await expect(sub(page).getByRole('button', { name: /個素材/ })).toBeVisible();
    // Only the other projects: 一人食系列 +1, and nothing on works only in 京都旅行.
    await expect(card(page, '伏見稻荷').locator('.plabel')).toHaveText('一人食系列+1');
    await expect(card(page, '嵐山竹林').locator('.plabel')).toHaveCount(0);
    await shot(page, '4-project');
    await page.getByRole('button', { name: '列表' }).click();
    await expect(grid(page).getByRole('columnheader', { name: '項目' })).toBeVisible();
    await expect(
      grid(page).locator('tr', { hasText: '嵐山竹林' }).locator('.tbl__proj'),
    ).toHaveText('—');
    await shot(page, '5-list');
    await page.getByRole('button', { name: '網格' }).click();
  });

  await test.step('搜尋：淡字改成結果數；只命中內文時標題下有「內文」；無結果可在全部作品中搜尋', async () => {
    const search = page.locator('main input[type="search"]');
    await search.fill('鳥居');
    await expect(sub(page)).toHaveText('1 個結果 · 共 3 個');
    await expect(sub(page).getByRole('button')).toHaveCount(0);
    await search.fill('紅葉');
    await expect(grid(page).locator('.wcard')).toHaveCount(1);
    await search.fill('牛腩');
    await expect(page.getByText('沒有符合「牛腩」的作品')).toBeVisible();
    await shot(page, '6-search-empty');
    await page.getByRole('button', { name: '在全部作品中搜尋' }).click();
    await expect(page.locator('main h1')).toHaveText('全部作品');
    await expect(grid(page).locator('.wcard')).toHaveCount(1);
    await expect(card(page, '牛腩').locator('.wcard__title mark.hit')).toHaveText('牛腩');
    await search.fill('');
  });

  await test.step('最近刪除在側欄底部，打開後頁首是標題與 30 天說明', async () => {
    const gone = (await c.works.list({ q: '寫作工具', limit: 1 })).items[0];
    if (gone === undefined) throw new Error('no work to delete');
    await c.works.batch({
      action: 'trash',
      items: [{ id: gone.id, base_revision: gone.current_revision_id }],
    });
    const trash = nav(page).locator('.sb__foot').getByRole('button', { name: '最近刪除' });
    await expect(trash).toContainText('1');
    await trash.click();
    await expect(page.locator('main h1')).toHaveText('最近刪除');
    await expect(sub(page)).toContainText('30 天後自動永久刪除');
    await expect(page.locator('main input[type="search"]')).toHaveCount(0);
    await expect(page.locator('.card-grid .wcard')).toHaveCount(1);
    await expect(trash).toHaveAttribute('aria-current', 'page');
    await shot(page, '7-trash');
  });

  await test.step('新項目的顏色依序輪替', async () => {
    await nav(page).getByRole('button', { name: '新建項目', exact: true }).first().click();
    await page.keyboard.type('書房改造');
    await page.keyboard.press('Enter');
    await expect(nav(page).getByRole('button', { name: /^書房改造/ })).toBeVisible();
    const created = (await c.projects.list()).items.find((p) => p.name === '書房改造');
    // Three projects existed, so the fourth takes the fourth colour.
    expect(created?.color).toBe(3);
  });

  await test.step('English 與简体：篩選彈出層與側欄', async () => {
    await nav(page).getByRole('button', { name: '全部作品' }).click();
    const langs = [
      { lang: 'en', filter: 'Filter', type: 'Type', status: 'Status', all: 'All posts' },
      { lang: 'zh-Hans', filter: '筛选', type: '类型', status: '状态', all: '全部作品' },
    ] as const;
    for (const L of langs) {
      await page.evaluate(`window.creatorhub.setLanguage('${L.lang}')`);
      await expect(page.locator('main h1')).toHaveText(L.all);
      await page.locator('main .fmenu__btn').click();
      const pop = page.getByRole('dialog', { name: L.filter });
      await expect(pop.getByRole('radiogroup', { name: L.type })).toBeVisible();
      await expect(pop.getByRole('radiogroup', { name: L.status })).toBeVisible();
      await shot(page, `9-filter-${L.lang}`);
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);
    }
    await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
  });

  await test.step('深色模式', async () => {
    await nav(page).getByRole('button', { name: '全部作品' }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await filterButton(page).click();
    await expect(page.getByRole('dialog', { name: '篩選' })).toBeVisible();
    await shot(page, '8-dark');
    await page.keyboard.press('Escape');
  });
});
