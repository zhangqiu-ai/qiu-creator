import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-068 搜尋高亮: what the search typed is marked live in card titles, list
 * rows, article excerpts and the asset library, with the matching the search
 * uses (letter case alike); nothing is marked while an IME is still
 * composing. Set QC068_SHOTS=<dir> to save screenshots.
 */

/** Whether `inner` is drawn entirely within `outer`'s box (so clamping or ellipsis left it visible). */
async function insideOf(inner: Locator, outer: Locator): Promise<boolean> {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (a === null || b === null) return false;
  return (
    a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height
  );
}

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
  await c.works.create({
    title: '春季選題筆記',
    markdown: `# 春季選題筆記\n\n${'這一季想寫的題目先列在這裡，之後再慢慢整理。'.repeat(8)}最後一站是鬱金香花田，早上光線最好。`,
    source: 'mac-app',
  });
  await c.works.create({ title: 'ＡＩ 工作流程', markdown: '', source: 'mac-app' });
  await c.assets.upload({ data: await pngBytes(64, 64, '#2F4FCF'), filename: '常用封面.png' });
  await c.assets.upload({ data: await pngBytes(64, 64, '#9E4428'), filename: 'kyoto.png' });
  await page.reload();
  await expect(grid(page).locator('.wcard')).toHaveCount(5);

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

  await test.step('簡體搜尋找得到繁體內文：卡片顯示命中的那段', async () => {
    await search(page).fill('郁金香');
    await expect(grid(page).locator('.wcard')).toHaveCount(1);
    const passage = grid(page).locator('.wcard__text-body');
    await expect(passage).toContainText('鬱金香花田');
    await expect(passage.locator('mark.hit')).toHaveText('鬱金香');
    // The hit is inside the clamped cover, not cut off below it.
    expect(await insideOf(passage.locator('mark.hit'), grid(page).locator('.wcard__cover'))).toBe(
      true,
    );
    await shot(page, '5-body-hit');
  });

  await test.step('兩個字也比對內文；全形與半形一致', async () => {
    await search(page).fill('花田');
    await expect(grid(page).locator('.wcard')).toHaveCount(1);
    await expect(grid(page).locator('.wcard__text-body mark.hit')).toHaveText('花田');
    await search(page).fill('ai');
    await expect(grid(page).locator('.wcard')).toHaveCount(1);
    await expect(grid(page).locator('.wcard__title mark.hit')).toHaveText('ＡＩ');
  });

  await test.step('列表檢視：只有內文命中時，列上顯示命中的那段', async () => {
    await search(page).fill('郁金香');
    await page.getByRole('button', { name: '列表' }).click();
    await expect(grid(page).locator('.hitline--row mark.hit')).toHaveText('鬱金香');
    expect(
      await insideOf(
        grid(page).locator('.hitline--row mark.hit'),
        grid(page).locator('.hitline--row'),
      ),
    ).toBe(true);
    await shot(page, '6-list-body-hit');
    await page.getByRole('button', { name: '網格' }).click();
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
    await expect(grid(page).locator('.wcard')).toHaveCount(5);
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

test('拼音搜尋（QC-079）：首字母與全拼標出對應的中文字；高亮是醒目的黃色，淺深色都清楚', async ({
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
    title: '春季選題筆記',
    markdown: '# 春季選題筆記\n\n先列題目。',
    source: 'mac-app',
  });
  await c.assets.upload({ data: await pngBytes(64, 64, '#2F4FCF'), filename: '常用封面.png' });
  await page.reload();
  await expect(grid(page).locator('.wcard')).toHaveCount(3);
  const shots = process.env['QC079_SHOTS'];
  const shot79 = async (name: string) => {
    if (shots === undefined || shots === '') return;
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `qc079-${name}.png`) });
  };

  await test.step('首字母 cy：標題標出「常用」；正文要 4 個字母以上才比對，所以摘要不標', async () => {
    await search(page).fill('cy');
    await expect(grid(page).locator('.wcard')).toHaveCount(2);
    await expect(grid(page).locator('.wcard__title mark.hit')).toHaveText(['常用', '常用']);
    await expect(grid(page).locator('.wcard__text-body mark.hit')).toHaveCount(0);
    await shot79('1-initials-light');
  });

  await test.step('黃色高亮、深色字（淺色）', async () => {
    const style = await page.evaluate<{ bg: string; fg: string }>(`(() => {
      const s = getComputedStyle(document.querySelector('.wcard__title mark.hit'));
      return { bg: s.backgroundColor, fg: s.color };
    })()`);
    expect(style).toEqual({ bg: 'rgb(255, 224, 61)', fg: 'rgb(28, 27, 25)' });
  });

  await test.step('全拼 changyong：正文也比對，摘要標出「常用」', async () => {
    await search(page).fill('changyong');
    await expect(grid(page).locator('.wcard__title mark.hit')).toHaveCount(2);
    await expect(grid(page).locator('.wcard__text-body mark.hit')).toHaveText(['常用']);
    // Traditional characters go through Simplified to their pinyin: 選題筆記 → xtbj.
    await search(page).fill('xtbj');
    await expect(grid(page).locator('.wcard')).toHaveCount(1);
    await expect(grid(page).locator('.wcard__title mark.hit')).toHaveText('選題筆記');
  });

  await test.step('黃色高亮、深色字（深色）', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await search(page).fill('cy');
    await expect(grid(page).locator('.wcard__title mark.hit')).toHaveText(['常用', '常用']);
    const style = await page.evaluate<{ bg: string; fg: string }>(`(() => {
      const s = getComputedStyle(document.querySelector('.wcard__title mark.hit'));
      return { bg: s.backgroundColor, fg: s.color };
    })()`);
    expect(style).toEqual({ bg: 'rgb(242, 201, 76)', fg: 'rgb(22, 22, 21)' });
    await shot79('2-initials-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await test.step('素材庫：名稱的拼音首字母 cyfm 標出「常用封面」', async () => {
    await page
      .getByRole('navigation', { name: '主導航' })
      .getByRole('button', { name: '素材庫', exact: true })
      .click();
    await page.locator('main input[type="search"]').fill('cyfm');
    await expect(page.locator('.atile__name mark.hit')).toHaveText('常用封面');
    await shot79('3-assets');
  });
});
