import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { videoResult } from '../../services/mac-server/test/fake-gemini-video.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-056 AI 工作台版面: the left column (setup, 最近任務, 用量) and the result
 * column scroll on their own, so scrolling a long result never moves the
 * setup or leaves the left side empty; the result has section jumps; picking
 * a recent job shows that run (succeeded or failed, with 重試) and marks it;
 * the layout holds from 1280 to 1920 wide. Gemini is a local fake.
 * Set QC056_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

const CLIP = fileURLToPath(new URL('../fixtures/media/portrait-8s.webm', import.meta.url));
const GEMINI_KEY = 'AIzaFakeQc056E2eKey0123456789';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC056_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc056-${name}.png`) });
}
const shooting = () => (process.env['QC056_SHOTS'] ?? '') !== '';

/** A result long enough that the result column scrolls a lot. */
const LONG = videoResult({
  summary: Array.from({ length: 6 }, () => '清晨的嵐山竹林幾乎沒有遊客，光線從竹葉間落下。').join(
    '',
  ),
  key_moments: Array.from({ length: 14 }, (_, i) => ({
    time_seconds: i * 0.5,
    label: `第 ${String(i + 1)} 個時間點`,
    description: '鏡頭沿著竹林步道往前推進，可以作為段落轉場。',
  })),
  title_suggestions: Array.from({ length: 6 }, (_, i) => `清晨的嵐山竹林（版本 ${String(i + 1)}）`),
  description_suggestions: Array.from(
    { length: 5 },
    (_, i) => `第 ${String(i + 1)} 種簡介：早上七點前的竹林幾乎沒有人，適合慢慢走。`,
  ),
});

const main = (page: Page): Locator => page.locator('main.page--aiw');
const results = (page: Page): Locator => main(page).locator('.aiw__result');
const jobs = (page: Page): Locator =>
  main(page).getByRole('region', { name: '最近任務' }).getByRole('listitem');

/** Run an analysis from the workbench and wait until it ends (done or failed). */
async function analyze(page: Page, again: boolean): Promise<void> {
  await main(page)
    .getByRole('button', { name: again ? '重新分析' : '分析', exact: true })
    .click();
  const reuse = page.getByRole('dialog', { name: /已分析過/ });
  if (again && (await reuse.count()) > 0) {
    await reuse.getByRole('button', { name: '重新分析' }).click();
  }
  await page
    .getByRole('dialog', { name: /Google/ })
    .getByRole('button', { name: /同意並上傳分析|上傳並分析/ })
    .click();
}

/** Where the left column's analyse button and 用量 card sit, and how the page scrolls. */
interface Layout {
  pageScrolls: boolean;
  sideways: boolean;
  runTop: number;
  usageBottom: number;
  viewport: number;
  resultWidth: number;
  resultScrollable: boolean;
}

/** Page-side code as a string: the e2e project has no DOM types. */
const MEASURE = `(() => {
  const page = document.querySelector('main.page--aiw');
  const side = document.querySelector('.aiw__side');
  const result = document.querySelector('.aiw__result');
  const usage = document.querySelector('.aiw__usage');
  const run = side.querySelector('.aiw__setup .btn--primary');
  return {
    pageScrolls: page.scrollHeight > page.clientHeight + 1 || page.scrollTop > 0,
    sideways: document.documentElement.scrollWidth > window.innerWidth,
    runTop: Math.round(run.getBoundingClientRect().top),
    usageBottom: Math.round(usage.getBoundingClientRect().bottom),
    viewport: window.innerHeight,
    resultWidth: Math.round(result.getBoundingClientRect().width),
    resultScrollable: result.scrollHeight > result.clientHeight,
  };
})()`;

async function layout(page: Page): Promise<Layout> {
  return page.evaluate<Layout>(MEASURE);
}

test('AI 工作台：左欄固定、結果獨立捲動、段落跳轉、最近任務選中與失敗重試、1280–1920 寬', async ({
  desktop,
}) => {
  const { page, backend, geminiVideo } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const clip = (
    await backend.client.assets.upload({ data: readFileSync(CLIP), filename: 'arashiyama.webm' })
  ).asset;
  backend.db
    .prepare('UPDATE assets SET duration = 8, width = 360, height = 640 WHERE id = ?')
    .run(clip.id);
  await backend.client.ai.setKey('gemini', GEMINI_KEY);
  geminiVideo.generateReplies.push({ body: LONG });

  await test.step('選視頻並分析，得到很長的結果', async () => {
    await page
      .getByRole('navigation', { name: '主導航' })
      .getByRole('button', { name: 'AI 工作台', exact: true })
      .click();
    await main(page).getByRole('button', { name: '選擇視頻' }).first().click();
    await page
      .getByRole('dialog', { name: '選擇視頻' })
      .locator('.aiw-pick__item', { hasText: 'arashiyama.webm' })
      .click();
    await analyze(page, false);
    await expect(results(page).getByRole('heading', { name: '摘要' })).toBeVisible();
    await expect(jobs(page)).toHaveCount(1);
  });

  await test.step('捲動結果：頁面本身不捲，左欄的按鈕與用量都不動', async () => {
    const before = await layout(page);
    expect(before.pageScrolls).toBe(false);
    expect(before.resultScrollable).toBe(true);
    expect(before.usageBottom).toBeLessThanOrEqual(before.viewport);
    await shot(page, 'zh-Hant-1-before-scroll');
    await results(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const after = await layout(page);
    expect(after.runTop).toBe(before.runTop);
    expect(after.usageBottom).toBe(before.usageBottom);
    expect(after.pageScrolls).toBe(false);
    // The section bar stays at the top of the result column.
    const navTop = await main(page)
      .getByRole('navigation', { name: '結果段落' })
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const columnTop = await results(page).evaluate((el) =>
      Math.round(el.getBoundingClientRect().top),
    );
    expect(Math.abs(navTop - columnTop)).toBeLessThanOrEqual(2);
    await expect(main(page).getByRole('button', { name: '簡介建議' })).toHaveAttribute(
      'aria-current',
      'location',
    );
    await shot(page, 'zh-Hant-2-after-scroll');
  });

  await test.step('段落跳轉：點「時間點」捲到該段並標為目前位置', async () => {
    const nav = main(page).getByRole('navigation', { name: '結果段落' });
    await expect(nav.getByRole('button')).toHaveText([
      '摘要',
      '時間點',
      '封面建議',
      '標題建議',
      '簡介建議',
    ]);
    await nav.getByRole('button', { name: '時間點' }).click();
    await expect(nav.getByRole('button', { name: '時間點' })).toHaveAttribute(
      'aria-current',
      'location',
    );
    await expect
      .poll(async () => {
        const top = await results(page).evaluate((el) => el.getBoundingClientRect().top);
        const block = await page
          .locator('#aiw-sec-moments')
          .evaluate((el) => el.getBoundingClientRect().top);
        return Math.round(block - top);
      })
      .toBeLessThan(80);
    await nav.getByRole('button', { name: '摘要' }).click();
    await expect.poll(() => results(page).evaluate((el) => el.scrollTop)).toBeLessThan(5);
  });

  await test.step('失敗的任務：顯示原因與重試，在最近任務中標為正在顯示', async () => {
    geminiVideo.failProcessing = true;
    await analyze(page, true);
    const failed = results(page).getByRole('alert').filter({ hasText: '分析失敗' });
    await expect(failed).toBeVisible();
    await expect(jobs(page)).toHaveCount(2);
    const current = main(page).locator('.aiw__job[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText('失敗');
    await shot(page, 'zh-Hant-3-failed-selected');
  });

  await test.step('點成功的任務看該次結果，再點回失敗的任務重試', async () => {
    const succeeded = main(page).locator('.aiw__job--open').filter({ hasNotText: '失敗' });
    await succeeded.click();
    await expect(results(page).getByRole('heading', { name: '摘要' })).toBeVisible();
    await expect(succeeded).toHaveAttribute('aria-current', 'true');
    await expect(results(page)).toContainText('第 14 個時間點');

    const failedRow = main(page).locator('.aiw__job--open').filter({ hasText: '失敗' });
    await failedRow.click();
    await expect(failedRow).toHaveAttribute('aria-current', 'true');
    const failed = results(page).getByRole('alert').filter({ hasText: '分析失敗' });
    await expect(failed).toBeVisible();
    geminiVideo.failProcessing = false;
    geminiVideo.generateReplies.push({ body: videoResult({}) });
    await failed.getByRole('button', { name: '重試' }).click();
    await expect(results(page).getByRole('heading', { name: '摘要' })).toBeVisible();
    await expect(results(page)).toContainText('清晨的嵐山竹林');
  });

  await test.step('1280 與 1920 寬：兩欄都成立，沒有橫向捲動', async () => {
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 860 });
      await expect
        .poll(async () => {
          const l = await layout(page);
          return { pageScrolls: l.pageScrolls, sideways: l.sideways, wide: l.resultWidth >= 600 };
        })
        .toEqual({ pageScrolls: false, sideways: false, wide: true });
      await shot(page, `zh-Hant-4-width-${String(width)}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  if (shooting()) {
    await test.step('截圖：用量展開、简体、English、深色', async () => {
      await main(page).locator('.aiw__usage summary').click();
      await shot(page, 'zh-Hant-5-usage-open');
      for (const lang of ['zh-Hans', 'en'] as const) {
        await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
        await results(page).evaluate((el) => {
          el.scrollTop = el.scrollHeight / 2;
        });
        await shot(page, `${lang}-scrolled`);
      }
      await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot(page, 'dark-scrolled');
      await page.emulateMedia({ colorScheme: null });
    });
  }
});
