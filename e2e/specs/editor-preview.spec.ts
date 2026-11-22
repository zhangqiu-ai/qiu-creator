import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { ok } from '../../services/mac-server/test/fake-ai.js';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-076 平台預覽 moved into the work editor (PT-20261122-004): 「預覽」 (⌘⇧P)
 * opens a right split, mutually exclusive with the AI panel, history and the
 * asset drawer. Inside: the four platform tabs with status dots, that
 * platform's own version (version line, title with its limit, text, cover,
 * tags), its phone simulation, 重新從原稿產生 behind a confirmation, AI 標題
 * (candidates applied with 復原) and AI 封面 at the platform's ratio (保留 sets
 * only that platform's cover). Narrow windows use one column with a 版本｜手機
 * switch. Both AI providers are local fakes; nothing leaves the machine.
 * QC076_SHOTS=<dir> saves screenshots.
 */

const IMAGE_MODEL = 'gpt-image-1';
const MD = [
  '# 我把書房改成剪輯室：半年後的取捨',
  '',
  '今年三月，我把十坪的書房改成剪輯室。改動最多的反而是光。',
  '',
  '第二個改動是聲音。搬走一半的書之後，錄旁白的回音明顯變大。',
  '',
].join('\n');

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC076_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc076-${name}.png`) });
}

const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const editor = (page: Page): Locator => page.locator('.tab-pane:not([hidden]) main.editor');
const split = (page: Page): Locator =>
  editor(page).getByRole('complementary', { name: '平台預覽' });
/** The split by class, for the steps that change the interface language. */
const splitEl = (page: Page): Locator => editor(page).locator('.pv-split');
const aiPanel = (page: Page): Locator => editor(page).getByRole('complementary', { name: 'AI' });
const previewButton = (page: Page): Locator =>
  editor(page).getByRole('button', { name: '預覽', exact: true });

/** The width of the split, as laid out. */
function splitWidth(page: Page): Promise<number> {
  return page.evaluate<number>(
    "document.querySelector('.tab-pane:not([hidden]) .pv-split').getBoundingClientRect().width",
  );
}

async function images(...colors: string[]) {
  const data = await Promise.all(
    colors.map(async (c) => ({ b64_json: (await pngBytes(300, 400, c)).toString('base64') })),
  );
  return { body: { created: 1, data } };
}

async function setUp(desktop: Parameters<Parameters<typeof test>[2]>[0]['desktop'], width = 1600) {
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width, height: 960 });
  await page.emulateMedia({ colorScheme: 'light' });
  const c = backend.client;
  // Titles go to Claude, covers to the New API relay; both are local fakes.
  await c.ai.setKey('anthropic', 'fake-anthropic-key');
  await c.ai.consent('anthropic', backend.ai.providerStatus('anthropic').notice.version);
  const relay = await c.ai.setKey(
    'new-api',
    'sk-relay-fake-0123456789',
    'https://relay.invalid/v1',
  );
  await c.ai.consent('new-api', relay.notice.version, relay.notice.credential_id ?? '');
  upstream.modelsReply = { body: { data: [{ id: IMAGE_MODEL }] } };
  const work = await c.works.create({
    title: '我把書房改成剪輯室：半年後的取捨',
    markdown: MD,
    source: 'mac-app',
  });
  await page.reload();
  await nav(page).getByRole('button', { name: '全部作品', exact: true }).click();
  await page
    .getByRole('region', { name: '作品', exact: true })
    .getByRole('button', { name: /書房改成剪輯室/ })
    .click();
  await expect(page.locator('.qc-md-editor__content')).toContainText('十坪的書房');
  return { page, c, upstream, work };
}

test('預覽分欄：平台切換、版本表單、AI 標題與 AI 封面、與其他右側面板互斥', async ({ desktop }) => {
  test.setTimeout(120_000);
  const { page, c, upstream, work } = await setUp(desktop);

  await test.step('⌘⇧P 打開右側分欄（寬 720），AI 面板讓位', async () => {
    await expect(aiPanel(page)).toBeVisible();
    await expect(previewButton(page)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Meta+Shift+p');
    await expect(split(page)).toBeVisible();
    await expect(previewButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(aiPanel(page)).toHaveCount(0);
    expect(await splitWidth(page)).toBeCloseTo(720, -1);
    // The simulation says it is one.
    await expect(split(page)).toContainText('版面為模擬，實際呈現以平台為準。');
  });

  await test.step('四個平台都還沒有版本：狀態點與「從原稿建立」', async () => {
    const tabs = split(page).getByRole('tablist', { name: '平台' });
    await expect(tabs.getByRole('tab')).toHaveText([/小紅書/, /公眾號/, /抖音/, /視頻號/]);
    // Every tab carries the 尚未建立 dot.
    await expect(tabs.getByRole('img', { name: '無版本' })).toHaveCount(4);
    await shot(page, 'zh-Hant-1-not-created');
    await split(page).getByRole('button', { name: '從原稿建立' }).click();
    await expect(split(page).locator('.pv-vline')).toContainText('小紅書版本');
    await expect(split(page).locator('.pv-vline')).toContainText('不影響原稿');
    await expect(tabs.getByRole('img', { name: '無版本' })).toHaveCount(3);
    await shot(page, 'zh-Hant-2-xhs');
  });

  await test.step('←→ 換平台；標題超出上限只警告，不阻擋', async () => {
    const tabs = split(page).getByRole('tablist', { name: '平台' });
    await tabs.getByRole('tab', { name: /小紅書/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: /公眾號/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.getByRole('tab', { name: /小紅書/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const title = split(page).getByRole('textbox', { name: '標題' });
    await title.fill('我把十坪的書房改成剪輯室：半年後的取捨與後悔清單');
    // 小紅書 allows 20 characters; the count and the hint warn, the value is kept.
    await expect(split(page).getByText('24/20')).toBeVisible();
    await expect(split(page).getByText('超出 4 字，預覽已截斷')).toBeVisible();
    await expect(tabs.getByRole('img', { name: '超出上限' })).toHaveCount(1);
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).title)
      .toBe('我把十坪的書房改成剪輯室：半年後的取捨與後悔清單');
    await shot(page, 'zh-Hant-3-over-limit');
  });

  await test.step('AI 標題：依平台上限產生候選，點一個即套用，可復原', async () => {
    upstream.script(
      'anthropic',
      ok(
        'anthropic',
        JSON.stringify({
          xiaohongshu: {
            titles: ['書房改剪輯室的 3 個後悔', '書房變剪輯室：先處理光', '剪輯室改造半年心得'],
          },
        }),
      ),
    );
    await split(page).getByRole('button', { name: 'AI 標題' }).click();
    const list = split(page).getByRole('listbox', { name: '標題候選' });
    await expect(list).toBeVisible();
    await expect(list).toContainText('小紅書 · 上限 20 字');
    await expect(list.getByRole('option')).toHaveCount(3);
    await shot(page, 'zh-Hant-4-title-candidates');
    await list.getByRole('option', { name: /先處理光/ }).click();
    await expect(split(page).getByRole('textbox', { name: '標題' })).toHaveValue(
      '書房變剪輯室：先處理光',
    );
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).title)
      .toBe('書房變剪輯室：先處理光');
    // 復原 puts the earlier title back.
    await split(page).getByRole('button', { name: '復原' }).click();
    await expect(split(page).getByRole('textbox', { name: '標題' })).toHaveValue(
      '我把十坪的書房改成剪輯室：半年後的取捨與後悔清單',
    );
    // The original was never touched.
    expect((await c.works.get(work.id)).title).toBe('我把書房改成剪輯室：半年後的取捨');
  });

  await test.step('AI 封面：比例固定為平台的 3:4，4 張候選，保留只改這個平台的封面', async () => {
    upstream.imageReplies.push(await images('#9E4428', '#3E4A57', '#5E7A8A', '#B8862B'));
    await split(page).getByRole('button', { name: 'AI 封面' }).click();
    await expect(split(page).getByText('小紅書 · 3:4')).toBeVisible();
    // The prompt comes from this platform's title and text.
    await expect(split(page).getByRole('textbox', { name: '提示詞' })).toHaveValue(/書房/);
    await expect(split(page).getByText('費用無法預估')).toBeVisible();
    await shot(page, 'zh-Hant-5-cover-prompt');
    await split(page)
      .getByRole('button', { name: /生成 4 張/ })
      .click();
    const ask = page.getByRole('dialog', { name: '這次生成的費用無法預估' });
    await expect(ask).toContainText(IMAGE_MODEL);
    await ask.getByRole('button', { name: '仍要生成' }).click();
    const cells = split(page).locator('.pv-cover-cell');
    await expect(cells).toHaveCount(4);
    await expect(cells.first().locator('img')).toBeVisible();
    await shot(page, 'zh-Hant-6-cover-candidates');
    await split(page).getByRole('button', { name: '封面候選 2' }).click();
    await expect(split(page).getByText('已選一張 · 保留後成為這個平台的封面')).toBeVisible();
    await split(page).getByRole('button', { name: '保留' }).click();
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).cover_asset_id)
      .not.toBeNull();
    // Only 小紅書 got a cover; the original keeps its own text and no front-matter cover.
    expect((await c.works.get(work.id)).markdown).not.toMatch(/cover:/);
    await expect(split(page).getByRole('button', { name: '用作品封面' })).toHaveCount(0);
    await shot(page, 'zh-Hant-7-cover-kept');
  });

  await test.step('重新從原稿產生：先確認，取消不改任何東西', async () => {
    const before = await c.variants.get(work.id, 'xiaohongshu');
    await split(page).getByRole('button', { name: '重新從原稿產生' }).click();
    const dialog = page.getByRole('dialog', { name: '重新產生小紅書版本？' });
    await expect(dialog).toContainText('舊版本留在歷史裡');
    await shot(page, 'zh-Hant-8-redraft');
    await dialog.getByRole('button', { name: '取消' }).click();
    expect((await c.variants.get(work.id, 'xiaohongshu')).revision).toBe(before.revision);
    await split(page).getByRole('button', { name: '重新從原稿產生' }).click();
    await page
      .getByRole('dialog', { name: '重新產生小紅書版本？' })
      .getByRole('button', { name: '重新產生' })
      .click();
    await expect
      .poll(async () => (await c.variants.get(work.id, 'xiaohongshu')).title)
      .toBe('我把書房改成剪輯室：半年後的取捨');
  });

  await test.step('和 AI 面板、歷史、素材抽屜互斥', async () => {
    await expect(split(page)).toBeVisible();
    await editor(page).getByRole('button', { name: '歷史' }).click();
    await expect(split(page)).toHaveCount(0);
    await expect(editor(page).getByRole('complementary', { name: '版本歷史' })).toBeVisible();
    await previewButton(page).click();
    await expect(split(page)).toBeVisible();
    await page.keyboard.press('Meta+Shift+i');
    await expect(split(page)).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: '素材抽屜' })).toBeVisible();
    await page.keyboard.press('Meta+Shift+i');
    await previewButton(page).click();
    await expect(split(page)).toBeVisible();
    // 關閉預覽 closes it and the AI panel comes back.
    await split(page).getByRole('button', { name: '關閉預覽' }).click();
    await expect(split(page)).toHaveCount(0);
    await expect(aiPanel(page)).toBeVisible();
  });
});

test('預覽分欄：窄視窗單欄加「版本｜手機」切換；深色與三語', async ({ desktop }) => {
  test.setTimeout(120_000);
  const { page, c, work } = await setUp(desktop, 1280);

  await test.step('窄視窗：分欄 400 寬、單欄，頂部「版本｜手機」切換', async () => {
    await previewButton(page).click();
    await expect(split(page)).toBeVisible();
    expect(await splitWidth(page)).toBeCloseTo(400, -1);
    await split(page).getByRole('button', { name: '從原稿建立' }).click();
    const view = split(page).getByRole('group', { name: '檢視' });
    await expect(view.getByRole('button', { name: '版本' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // One column: the form, and the phone only after switching.
    await expect(split(page).getByRole('textbox', { name: '標題' })).toBeVisible();
    await expect(split(page).locator('.pp-phone')).toHaveCount(0);
    await shot(page, 'zh-Hant-9-narrow-form');
    await view.getByRole('button', { name: '手機' }).click();
    await expect(split(page).locator('.pp-phone')).toBeVisible();
    await expect(split(page).getByRole('textbox', { name: '標題' })).toHaveCount(0);
    await shot(page, 'zh-Hant-10-narrow-phone');
    await view.getByRole('button', { name: '版本' }).click();
  });

  await test.step('視窗變寬就回到兩欄', async () => {
    await page.setViewportSize({ width: 1600, height: 960 });
    await expect(split(page).getByRole('group', { name: '檢視' })).toHaveCount(0);
    await expect(split(page).getByRole('textbox', { name: '標題' })).toBeVisible();
    await expect(split(page).locator('.pp-phone')).toBeVisible();
  });

  await test.step('深色與三語', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'zh-Hant-11-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    for (const lang of ['zh-Hans', 'en'] as const) {
      await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
      await expect(splitEl(page)).toHaveAttribute(
        'aria-label',
        lang === 'en' ? 'Platform preview' : '平台预览',
      );
      await expect(
        splitEl(page).getByRole('button', {
          name: lang === 'en' ? 'AI titles' : 'AI 标题',
        }),
      ).toBeVisible();
      await shot(page, `${lang}-12-preview`);
    }
    await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
    // The work itself was never written by anything in the preview.
    expect((await c.works.get(work.id)).title).toBe('我把書房改成剪輯室：半年後的取捨');
  });
});
