import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';
import { chooseFilter, filterButton, filterOption, trashRow } from '../fixtures/library.js';

/*
 * QC-067 作品庫分頁: with more works than one page, the library loads the
 * rest as its end scrolls into view, so the oldest work is reachable; the
 * type and status counts are the service's totals for the whole filter; ⌘A
 * selects every work matching the filter (not only those loaded) and a batch
 * action changes them all. Set QC067_SHOTS=<dir> to save screenshots.
 */

const ARTICLES = 180;
const POSTS = 140;
const ALL = ARTICLES + POSTS;

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC067_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc067-${name}.png`) });
}

const grid = (page: Page) => page.getByRole('region', { name: '作品', exact: true });
const cards = (page: Page) => grid(page).locator('.wcard');
/** The count beside a type or status in 篩選 (QC-069); leaves the popover open. */
async function expectCount(
  page: Page,
  group: '類型' | '狀態',
  name: RegExp,
  n: number,
): Promise<void> {
  if ((await page.getByRole('dialog', { name: '篩選' }).count()) === 0)
    await filterButton(page).click();
  await expect(filterOption(page, group, name).locator('.fmenu__n')).toHaveText(String(n));
}
const closeFilter = (page: Page) => page.keyboard.press('Escape');
const total = (page: Page) => page.locator('main .page__sub');

/** Scroll the list to its end until no page is left to load. */
async function scrollToEnd(
  page: Page,
  expected: number,
  list: (p: Page) => Locator = cards,
): Promise<void> {
  let loaded = await list(page).count();
  while (loaded < expected) {
    // Page-side code as a string: the e2e project has no DOM types.
    await page.evaluate(
      "(() => { const el = document.querySelector('main.page'); el.scrollTop = el.scrollHeight; })()",
    );
    // The next page arrives on its own once the end of the list is in view.
    await expect.poll(() => list(page).count()).toBeGreaterThan(loaded);
    loaded = await list(page).count();
  }
  await expect(list(page)).toHaveCount(expected);
}

test('作品庫：超過一頁時捲到底載入全部、數量是全體、⌘A 選取篩選下的全部並批量修改', async ({
  desktop,
}) => {
  test.setTimeout(120_000);
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  // Oldest first, so the newest (last created) shows first.
  for (let i = 1; i <= ARTICLES; i += 1)
    await c.works.create({
      title: `文章 ${String(i).padStart(3, '0')}`,
      markdown: '',
      source: 'mac-app',
    });
  for (let i = 1; i <= POSTS; i += 1)
    await c.works.create({
      title: `貼圖 ${String(i).padStart(3, '0')}`,
      type: 'image',
      source: 'mac-app',
    });
  await page.reload();

  await test.step('一開始只載入第一頁，標題旁是全部的數量', async () => {
    await expect(cards(page)).toHaveCount(60);
    await expect(total(page)).toHaveText(`${String(ALL)} 個作品`);
    await expectCount(page, '類型', /^全部/, ALL);
    await expectCount(page, '類型', /^文章/, ARTICLES);
    await expectCount(page, '類型', /^貼圖/, POSTS);
    await expectCount(page, '狀態', /^創作中/, ALL);
    await shot(page, '1-first-page');
    await closeFilter(page);
  });

  await test.step('捲到底：一頁一頁載入，看得到最舊的作品', async () => {
    await scrollToEnd(page, ALL);
    await expect(grid(page).getByText('文章 001', { exact: true })).toBeVisible();
    await shot(page, '2-oldest');
  });

  await test.step('篩選「貼圖」：數量正確，捲到底是全部貼圖', async () => {
    await chooseFilter(page, '類型', /^貼圖/);
    await expect(total(page)).toHaveText(`${String(POSTS)} 個結果 · 共 ${String(ALL)} 個`);
    await expectCount(page, '狀態', /^全部/, POSTS);
    await closeFilter(page);
    await scrollToEnd(page, POSTS);
    await expect(grid(page).getByText('貼圖 001', { exact: true })).toBeVisible();
    await chooseFilter(page, '類型', /^全部/);
    await expect(cards(page)).toHaveCount(60);
  });

  await test.step('⌘A 選取篩選下的全部（不只已載入），批量改狀態改到全部', async () => {
    await chooseFilter(page, '類型', /^文章/);
    await expect(cards(page)).toHaveCount(60);
    await page.locator('main .page__title').click();
    await page.keyboard.press('Meta+a');
    const bar = page.getByRole('toolbar', { name: `已選 ${String(ARTICLES)} 個` });
    await expect(bar).toBeVisible();
    await shot(page, '3-select-all');
    await bar.getByRole('button', { name: '改狀態' }).click();
    await page.getByRole('menuitemradio', { name: '待審核' }).click();
    // Every article changed, including those never loaded.
    await expect
      .poll(
        async () => (await c.works.list({ type: 'article', status: 'in_review', limit: 1 })).total,
      )
      .toBe(ARTICLES);
    await expectCount(page, '狀態', /^待審核/, ARTICLES);
    await expectCount(page, '狀態', /^創作中/, 0);
    await closeFilter(page);
    await chooseFilter(page, '類型', /^全部/);
    await expectCount(page, '狀態', /^創作中/, POSTS);
    await closeFilter(page);
  });

  await test.step('⌘A 後刪除：篩選下的全部都進回收站', async () => {
    await chooseFilter(page, '類型', /^貼圖/);
    await expect(cards(page)).toHaveCount(60);
    await page.locator('main .page__title').click();
    await page.keyboard.press('Meta+a');
    await expect(page.getByRole('toolbar', { name: `已選 ${String(POSTS)} 個` })).toBeVisible();
    await page.keyboard.press('Meta+Backspace');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /移到回收站|刪除/ })
      .last()
      .click();
    await expect
      .poll(async () => (await c.works.list({ scope: 'trash', limit: 1 })).total)
      .toBe(POSTS);
    await expect(total(page)).toHaveText(`0 個結果 · 共 ${String(ARTICLES)} 個`);
    await expect(trashRow(page)).toHaveText(`回收站${String(POSTS)}`);
  });

  await test.step('回收站也分頁；⌘A 選取全部刪除的作品', async () => {
    await trashRow(page).click();
    const trashCards = (p: Page) => p.locator('.card-grid .wcard');
    await expect(trashCards(page)).toHaveCount(60);
    await scrollToEnd(page, POSTS, trashCards);
    await page.locator('main .page__title').click();
    await page.keyboard.press('Meta+a');
    await expect(page.getByRole('toolbar', { name: `已選 ${String(POSTS)} 個` })).toBeVisible();
    await shot(page, '4-trash-select-all');
  });
});
