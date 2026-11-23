import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { videoResult } from '../../services/mac-server/test/fake-gemini-video.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-046 視頻作品 (PT-20261121-001 「v3 · 視頻作品」): pick a video, play it
 * (←→ 5 s), take the cover from a frame (grabbed in the App, uploaded as an
 * image), shared copy that 抖音 can override, Gemini understanding with the
 * cost and an explicit tick before anything is sent, suggestions adopted
 * through a diff and undone; long video, over 2 GB, uploading and a failed
 * analysis. Gemini is a local fake; nothing reaches Google.
 * Set QC046_SHOTS=<dir> to also save screenshots for the acceptance record.
 *
 * `fixtures/media/portrait-8s.webm` (360×640, 8 s, VP9, 120 KB) was made once with
 * `ffmpeg -f lavfi -i testsrc2=size=360x640:rate=15:duration=8 -vf hue=h=t*40
 *  -c:v libvpx-vp9 -b:v 120k -an`; tests read the file and never run ffmpeg.
 */

const CLIP = fileURLToPath(new URL('../fixtures/media/portrait-8s.webm', import.meta.url));
const GEMINI_KEY = 'AIzaFakeQc046E2eKey0123456789';

/**
 * A right panel holds the AI results, and the 預覽 split the 340 px phone, without
 * scrolling sideways; the phone is not cut off (same rule as QC-049).
 */
async function expectSideFits(page: Page, selector = '.vw__side'): Promise<void> {
  const measure = `(() => {
    const side = document.querySelector('.tab-pane:not([hidden]) ${selector}');
    const phone = side.querySelector('.pv-phone');
    const rect = side.getBoundingClientRect();
    const visibleRight = rect.left + side.clientLeft + side.clientWidth;
    return {
      scrollsSideways: side.scrollWidth > side.clientWidth,
      phoneClipped: phone !== null && phone.getBoundingClientRect().right > visibleRight,
    };
  })()`;
  await expect
    .poll(() => page.evaluate<{ scrollsSideways: boolean; phoneClipped: boolean }>(measure))
    .toEqual({ scrollsSideways: false, phoneClipped: false });
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC046_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc046-${name}.png`) });
}

const editor = (page: Page): Locator => page.locator('.tab-pane:not([hidden]) main.vw');
const side = (page: Page): Locator => editor(page).getByRole('complementary', { name: 'AI 理解' });
/** QC-076: 抖音 and 視頻號 copy versions live in the shared 預覽 split. */
const preview = (page: Page): Locator =>
  editor(page).getByRole('complementary', { name: '平台預覽' });

async function newVideoWork(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '全部作品', exact: true })
    .click();
  await page.keyboard.press('Meta+n');
  await page.getByRole('menu', { name: '新建作品' }).getByRole('menuitem').first().focus();
  await page.keyboard.press('3');
  await expect(editor(page)).toBeVisible();
}

async function pickClip(page: Page, name: string): Promise<void> {
  await editor(page).getByRole('button', { name: '從素材庫選' }).click();
  await page
    .getByRole('complementary', { name: '素材抽屜' })
    .getByRole('option', { name: `插入 ${name}` })
    .click();
  await expect(editor(page).locator('video.vw__video')).toBeVisible();
}

const playerTime = (page: Page) =>
  editor(page)
    .locator('video.vw__video')
    .evaluate((el) => (el as unknown as { currentTime: number }).currentTime);

test('視頻：選視頻、播放與 ←→、截取封面、共用與抖音文案、Gemini 理解與採用建議', async ({
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
  geminiVideo.generateReplies.push({ body: videoResult({}) });

  await test.step('新建選單選 3 建立視頻作品，尚未選視頻', async () => {
    await newVideoWork(page);
    await expect(editor(page).getByText('尚未選視頻')).toBeVisible();
    await shot(page, 'zh-Hant-1-empty');
  });

  await test.step('從素材庫選視頻；←→ 前後 5 秒', async () => {
    await pickClip(page, 'arashiyama.webm');
    await expect(editor(page).locator('.vw__frame img')).toHaveCount(8);
    await editor(page).locator('.vw__player').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => playerTime(page)).toBe(5);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => playerTime(page)).toBe(0);
  });

  const work = (await backend.client.works.list({ type: 'video' })).items[0];
  if (work === undefined) throw new Error('no video work');

  await test.step('從幀條選一格當封面：App 截圖並上傳成素材', async () => {
    await editor(page).getByRole('button', { name: '0:03 的畫面' }).click();
    await expect(
      page.locator('[data-toast]').filter({ hasText: '已把 0:03 的畫面設為封面' }),
    ).toBeVisible();
    await expect(editor(page).locator('.vw__crops img')).toHaveCount(2);
    await expect
      .poll(async () => {
        const c = (await backend.client.works.get(work.id)).media?.cover;
        return c?.kind === 'image' ? c.item.asset_id : null;
      })
      .not.toBeNull();
    const detail = await backend.client.works.get(work.id);
    const coverId = detail.media?.cover?.kind === 'image' ? detail.media.cover.item.asset_id : null;
    if (coverId === null) throw new Error('no cover');
    const asset = await backend.client.assets.get(coverId);
    expect(asset.kind).toBe('image');
    expect(asset.original_name).toMatch(/^cover-0m03s\.jpg$/);
    expect([asset.width, asset.height]).toEqual([360, 640]);
  });

  await test.step('文案：編輯頁只有共用文案；抖音版本在預覽分欄裡改寫（QC-076）', async () => {
    await editor(page)
      .locator('#vw-title-' + work.id)
      .fill('嵐山竹林：清晨人最少的時段與散步路線');
    // The editor has no platform copy tabs any more, only the shared copy.
    await expect(editor(page).getByRole('tablist', { name: '文案' })).toHaveCount(0);
    // A count chip is an indicator; clicking it opens that platform in the preview.
    await editor(page).getByRole('button', { name: '視頻號 18/16' }).click();
    await expect(preview(page).getByRole('tab', { name: /視頻號/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Only the two video platforms are offered.
    await expect(preview(page).getByRole('tablist', { name: '平台' }).getByRole('tab')).toHaveText([
      /抖音/,
      /視頻號/,
    ]);
    await preview(page).getByRole('tab', { name: /抖音/ }).click();
    await preview(page)
      .getByRole('tablist', { name: '畫面' })
      .getByRole('tab', { name: '發布編輯' })
      .click();
    const publish = preview(page).locator('.pv-page:not([inert]) [data-screen="publish"]');
    const title = publish.getByRole('textbox', { name: '標題' });
    // QC-084: the platform follows the shared copy until its title is changed here.
    await expect(title).toHaveValue('嵐山竹林：清晨人最少的時段與散步路線');
    await expect(publish.getByText('跟隨原稿', { exact: true })).toBeVisible();
    await title.fill('清晨嵐山竹林散步');
    await expect
      .poll(async () => (await backend.client.variants.get(work.id, 'douyin')).title)
      .toBe('清晨嵐山竹林散步');
    expect((await backend.client.variants.get(work.id, 'douyin')).title_source).toBe('override');
    await expect(preview(page).locator('.pv-phone')).toBeVisible();
    await expectSideFits(page, '.pv-split__body');
    await shot(page, 'zh-Hant-10-preview');
    await expect(editor(page).locator('#vw-title-' + work.id)).toHaveValue(
      '嵐山竹林：清晨人最少的時段與散步路線',
    );
    await preview(page).getByRole('button', { name: '關閉預覽' }).click();
    await expect(preview(page)).toHaveCount(0);
  });

  await test.step('Gemini：先看預估、勾選同意才送出，分析後出現摘要與待核驗的時間點', async () => {
    await side(page).getByRole('button', { name: '分析視頻' }).click();
    const dialog = page.getByRole('dialog', { name: /Google/ });
    const send = dialog.getByRole('button', { name: /同意並上傳|上傳並分析/ });
    await expect(send).toBeDisabled();
    // The estimate is shown before anything can be sent.
    await expect(dialog.getByRole('term').filter({ hasText: '最多花費' })).toBeVisible();
    await shot(page, 'zh-Hant-3-confirm');
    await dialog.getByRole('checkbox', { name: /我了解視頻會上傳到/ }).check();
    await expect(send).toBeEnabled();
    expect(geminiVideo.starts).toHaveLength(0);
    await send.click();
    await expect(side(page).getByRole('heading', { name: '摘要' })).toBeVisible();
    expect(geminiVideo.starts).toHaveLength(1);
    await expect(side(page).getByText('待核驗').first()).toBeVisible();
    await expect(side(page).getByText('超出片長').first()).toBeVisible();
    await side(page)
      .getByRole('button', { name: /0:03 竹林入口/ })
      .click();
    await expect.poll(() => playerTime(page)).toBe(3);
  });

  await test.step('採用簡介建議：先看 diff，採用後可復原', async () => {
    await side(page)
      .locator('.vw__sugg')
      .filter({ hasText: '早上七點前的竹林' })
      .getByRole('button', { name: '查看並採用' })
      .click();
    const dialog = page.getByRole('dialog', { name: '採用簡介建議' });
    await expect(dialog.locator('.ins')).toContainText('早上七點前的竹林');
    await shot(page, 'zh-Hant-4-adopt-diff');
    await dialog.getByRole('button', { name: '採用' }).click();
    await expect(editor(page).locator('#vw-desc-' + work.id)).toHaveValue(
      '早上七點前的竹林幾乎沒有人。',
    );
    const revisions = await backend.client.works.revisions(work.id);
    expect(revisions.items[0]?.source).toBe('ai_accepted');
    // The AI results fit the side panel.
    await expectSideFits(page);
    await shot(page, 'zh-Hant-2-editor');
    // QC-076: the understanding panel no longer has title suggestions or a 預覽 tab.
    await expect(side(page).getByRole('heading', { name: '標題建議' })).toHaveCount(0);
    await expect(side(page).getByRole('tab')).toHaveCount(0);
    await page
      .locator('[data-toast]')
      .filter({ hasText: '已採用 AI 建議' })
      .getByRole('button', { name: '復原' })
      .click();
    await expect(editor(page).locator('#vw-desc-' + work.id)).toHaveValue('');
  });

  await test.step('三語與深色截圖', async () => {
    for (const lang of ['zh-Hans', 'en'] as const) {
      await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
      await expect(editor(page)).toHaveAttribute(
        'aria-label',
        lang === 'en' ? 'Edit video work' : '编辑视频作品',
      );
      await shot(page, `${lang}-2-editor`);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'en-5-editor-dark');
    await page.evaluate(`window.creatorhub.setLanguage('zh-Hant')`);
    await shot(page, 'zh-Hant-5-editor-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });
});

test('視頻：長視頻預設低解析度、超過 2 GB 無法分析、分析失敗可重試、上傳中鎖住封面與分析', async ({
  desktop,
}) => {
  const { page, backend, geminiVideo } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await backend.client.ai.setKey('gemini', GEMINI_KEY);
  const data = readFileSync(CLIP);
  const long = (await backend.client.assets.upload({ data, filename: 'long-talk.webm' })).asset;
  // Same bytes, so the service would reuse the file: make the copy differ by one byte.
  const bigData = Buffer.concat([data, Buffer.from([0])]);
  const big = (await backend.client.assets.upload({ data: bigData, filename: 'raw-4k.webm' }))
    .asset;
  backend.db.prepare('UPDATE assets SET duration = 7200 WHERE id = ?').run(long.id);
  backend.db
    .prepare('UPDATE assets SET duration = 600, bytes = ? WHERE id = ?')
    .run(3 * 1024 * 1024 * 1024, big.id);

  await test.step('長視頻：提示預設低解析度分析全片，確認框已勾選低解析度', async () => {
    await newVideoWork(page);
    await pickClip(page, 'long-talk.webm');
    await expect(side(page).getByText(/超過 1 小時：預設用低解析度分析全片/)).toBeVisible();
    await side(page).getByRole('button', { name: '分析視頻' }).click();
    const dialog = page.getByRole('dialog', { name: /Google/ });
    await expect(dialog.getByRole('checkbox', { name: /低解析度/ })).toBeChecked();
    await shot(page, 'zh-Hant-6-long');
    await dialog.getByRole('button', { name: '取消' }).click();
  });

  await test.step('超過 2 GB：說明無法分析，不送出任何東西', async () => {
    await editor(page).getByRole('button', { name: '更換視頻' }).click();
    await page
      .getByRole('complementary', { name: '素材抽屜' })
      .getByRole('option', { name: '插入 raw-4k.webm' })
      .click();
    await expect(side(page).getByText(/超過 Gemini 的 2 GB 上限，無法分析/)).toBeVisible();
    await expect(side(page).getByRole('button', { name: '分析視頻' })).toHaveCount(0);
    await shot(page, 'zh-Hant-7-too-large');
  });

  await test.step('分析失敗：顯示原因與技術細節，可以重試', async () => {
    await editor(page).getByRole('button', { name: '更換視頻' }).click();
    await page
      .getByRole('complementary', { name: '素材抽屜' })
      .getByRole('option', { name: '插入 long-talk.webm' })
      .click();
    geminiVideo.failProcessing = true;
    await side(page).getByRole('button', { name: '分析視頻' }).click();
    const dialog = page.getByRole('dialog', { name: /Google/ });
    await dialog.getByRole('checkbox', { name: /我了解視頻會上傳到/ }).check();
    await dialog.getByRole('button', { name: /同意並上傳|上傳並分析/ }).click();
    const failed = side(page)
      .getByRole('alert')
      .filter({ hasText: /分析失敗|失敗/ });
    await expect(failed).toBeVisible();
    await expect(failed.getByRole('button', { name: '重試' })).toBeVisible();
    await shot(page, 'zh-Hant-8-failed');
    geminiVideo.failProcessing = false;
    geminiVideo.generateReplies.push({ body: videoResult({}) });
    await failed.getByRole('button', { name: '重試' }).click();
    await expect(side(page).getByRole('heading', { name: '摘要' })).toBeVisible();
  });

  await test.step('上傳中：封面與分析暫停，可以取消', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qc046-upload-'));
    try {
      // 120 MB goes up in 8 MB tus chunks: long enough to see the uploading state.
      const file = path.join(dir, 'big-upload.webm');
      const fd = openSync(file, 'w');
      writeSync(fd, data);
      const block = Buffer.alloc(8 * 1024 * 1024, 7);
      for (let i = 0; i < 15; i += 1) writeSync(fd, block);
      closeSync(fd);
      await newVideoWork(page);
      await editor(page).locator('input[type="file"][accept="video/*"]').setInputFiles(file);
      const status = editor(page).getByRole('status', { name: /正在上傳「big-upload\.webm」/ });
      await expect(status).toBeVisible();
      await expect(status).toContainText('上傳完成前，封面與 AI 理解暫停使用');
      await expect(editor(page).getByRole('button', { name: '用目前畫面' })).toBeDisabled();
      await shot(page, 'zh-Hant-9-uploading');
      await status.getByRole('button', { name: '取消' }).click();
      await expect(editor(page).getByText('尚未選視頻')).toBeVisible();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('視頻：金鑰在開著的頁面之後才設定，AI 面板跟著更新（QC-055）', async ({ desktop }) => {
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const clip = (
    await backend.client.assets.upload({ data: readFileSync(CLIP), filename: 'arashiyama.webm' })
  ).asset;
  backend.db
    .prepare('UPDATE assets SET duration = 8, width = 360, height = 640 WHERE id = ?')
    .run(clip.id);

  await test.step('沒有金鑰：面板要求前往設定', async () => {
    await newVideoWork(page);
    await pickClip(page, 'arashiyama.webm');
    await expect(side(page).getByText('未設定 Gemini 金鑰')).toBeVisible();
    await expect(side(page).getByRole('button', { name: '分析視頻' })).toHaveCount(0);
  });

  await test.step('離開再回到這個分頁：金鑰與同意在別處完成後，面板讀到新狀態', async () => {
    await page
      .getByRole('navigation', { name: '主導航' })
      .getByRole('button', { name: '全部作品', exact: true })
      .click();
    await backend.client.ai.setKey('gemini', GEMINI_KEY);
    const gemini = (await backend.client.ai.providers()).items.find((p) => p.provider === 'gemini');
    if (gemini === undefined) throw new Error('no gemini provider');
    await backend.client.ai.consent('gemini', gemini.notice.version);
    await page.getByRole('button', { name: /^未命名 創作中 視頻/ }).click();
    await expect(side(page).getByRole('button', { name: '分析視頻' })).toBeVisible();
    await expect(side(page).getByText('未設定 Gemini 金鑰')).toHaveCount(0);
  });

  await test.step('視窗回到前景：金鑰被移除後，面板也會更新', async () => {
    await backend.client.ai.deleteKey('gemini');
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await expect(side(page).getByText('未設定 Gemini 金鑰')).toBeVisible();
    await backend.client.ai.setKey('gemini', GEMINI_KEY);
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await expect(side(page).getByRole('button', { name: '分析視頻' })).toBeVisible();
  });
});
