import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-108 素材檢視 (PT-20261126-001 方案 B 圖庫檢視): a click shows the asset in
 * the main area with a faint info line and an 84px strip; ← → move and stop at
 * the ends; I brings up the info card (closed each time the view opens) and
 * Esc closes it first, then goes back to the grid at the same scroll position
 * with focus on the card. Pictures fit the stage and zoom (⌘= ⌘0, double-click);
 * Space opens the full-window preview for pictures and text and plays audio and
 * video; Markdown reads laid out, with 顯示原始文字 in 更多; video cards get a
 * frame as their thumbnail. Set QC108_SHOTS=<dir> for the acceptance shots.
 */

const CLIP = fileURLToPath(new URL('../fixtures/media/portrait-8s.webm', import.meta.url));

const NOTE = `# 京都秋季七日行程・旁白稿

第二版，配合 0:00–1:18 的第一段畫面。

## 第一天：嵐山

清晨六點半的竹林還沒什麼人。這一段我想讓畫面慢一點，**先停在竹梢**，再往下帶到步道。

> 旁白在這裡停兩秒，讓環境音出來。

- 入口到奧社：約 40 分鐘
- 四之辻可以看到市區夜景
`;

/** One second of a quiet 440 Hz tone, 8 kHz mono 16-bit PCM. */
function toneWav(): Buffer {
  const rate = 8000;
  const samples = rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 2000), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC108_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc108-${name}.png`) });
}

/** The grid's scroll position (the page's scrolling area). */
const gridScroll = (page: Page): Promise<number> =>
  page.evaluate<number>("document.querySelector('.page__main').scrollTop");

async function scrollGrid(page: Page, to: 'top' | 'end'): Promise<void> {
  await page.evaluate(
    `(() => { const el = document.querySelector('.page__main'); el.scrollTop = ${
      to === 'top' ? '0' : 'el.scrollHeight'
    }; })()`,
  );
}

const COLORS = ['#9E4428', '#5E4130', '#3E4A57', '#7A6A58', '#2F3B34', '#55606A', '#B5793A'];

test('素材檢視：圖庫檢視、資訊卡、← →、Esc 回網格、四種內容、視頻縮圖', async ({ desktop }) => {
  const { page, backend } = desktop;
  const c = backend.client;
  // Enough pictures for the grid to scroll; the last ones are the interesting kinds.
  for (let i = 0; i < 34; i++) {
    const n = String(i + 1).padStart(2, '0');
    await c.assets.upload({
      // Sizes differ, so no two files dedupe into one asset.
      data: await pngBytes(
        i === 0 ? 1600 : 160 + i,
        i === 0 ? 1000 : 120,
        COLORS[i % COLORS.length] ?? '#888',
      ),
      filename: `photo-${n}.png`,
    });
  }
  const clip = (await c.assets.upload({ data: readFileSync(CLIP), filename: 'clip.webm' })).asset;
  backend.db
    .prepare('UPDATE assets SET duration = 8, width = 360, height = 640 WHERE id = ?')
    .run(clip.id);
  const note = (await c.assets.upload({ data: Buffer.from(NOTE, 'utf8'), filename: '旁白稿.md' }))
    .asset;
  await c.assets.upload({ data: toneWav(), filename: 'tone.wav' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '素材庫', exact: true })
    .click();
  const tile = (name: string) => page.locator('button.atile', { hasText: name });
  const viewer = page.getByRole('region', { name: /^素材檢視：/ });
  const card = page.getByRole('group', { name: '素材資訊' });
  const strip = viewer.getByRole('navigation', { name: '素材縮圖條' });
  const pos = viewer.locator('.aview__pos');
  const total = 37;
  await expect(tile('photo-01.png')).toBeVisible();

  await test.step('網格佔滿寬度，沒有側欄；視頻卡片有畫面縮圖', async () => {
    await expect(page.getByRole('complementary')).toHaveCount(0);
    const frame = tile('clip.webm').locator('img[data-frame="video"]');
    await expect(frame).toBeVisible({ timeout: 15_000 });
    expect(await frame.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);
    await shot(page, '01-grid');
  });

  await test.step('單擊進入檢視：內容佔滿舞台、淡化資訊一行、縮圖條；資訊卡預設收起', async () => {
    await tile('photo-01.png').click();
    await expect(viewer).toBeVisible();
    await expect(viewer).toBeFocused();
    await expect(pos).toHaveText(new RegExp(`^\\d+ / ${String(total)}$`));
    const line = viewer.locator('.aview__line');
    await expect(line).toContainText('photo-01.png');
    await expect(line).toContainText('1600 × 1000');
    await expect(line).toContainText('未引用');
    await expect(strip.getByRole('button')).toHaveCount(total);
    await expect(strip.locator('[aria-current="true"]')).toHaveAccessibleName('photo-01.png');
    await expect(card).toHaveCount(0);
    // The picture fits the stage (enlarged past its thumbnail, never cropped).
    const fig = viewer.locator('.aview__figure');
    await expect(viewer.locator('img[data-original="true"]')).toBeVisible({ timeout: 10_000 });
    await fig.evaluate((el) =>
      Promise.all(
        (el as unknown as { getAnimations(): { finished: Promise<unknown> }[] })
          .getAnimations()
          .map((a) => a.finished),
      ),
    );
    const stage = await viewer.locator('.aview__zoom').boundingBox();
    const fit = await fig.boundingBox();
    if (stage === null || fit === null) throw new Error('no box');
    expect(fit.width).toBeLessThanOrEqual(stage.width + 1);
    expect(fit.height).toBeLessThanOrEqual(stage.height + 1);
    expect(Math.max(fit.width / stage.width, fit.height / stage.height)).toBeGreaterThan(0.98);
    await shot(page, '02-image');

    // Zoom as in the full-window preview: ⌘= grows, ⌘0 fits again, double-click toggles 100%.
    await page.keyboard.press('Meta+=');
    await expect.poll(async () => (await fig.boundingBox())?.width ?? 0).toBeGreaterThan(fit.width);
    await page.keyboard.press('Meta+0');
    await expect.poll(async () => (await fig.boundingBox())?.width ?? 0).toBeCloseTo(fit.width, 0);
    await fig.dblclick();
    await expect.poll(async () => (await fig.boundingBox())?.width ?? 0).toBeCloseTo(1600, 0);
    await fig.dblclick();
    await expect.poll(async () => (await fig.boundingBox())?.width ?? 0).toBeCloseTo(fit.width, 0);
  });

  await test.step('I 浮出資訊卡，再按收起；Esc 先關資訊卡', async () => {
    await page.keyboard.press('i');
    await expect(card).toBeVisible();
    await expect(card.getByLabel('名稱')).toHaveValue('photo-01.png');
    await expect(card.getByLabel('替代文字')).toBeVisible();
    await expect(viewer.getByRole('button', { name: '資訊', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The card floats over the content: the picture keeps its size.
    const before = await viewer.locator('.aview__figure').boundingBox();
    expect(before).not.toBeNull();
    await shot(page, '03-info');
    await page.keyboard.press('i');
    await expect(card).toHaveCount(0);
    await page.keyboard.press('i');
    await card.getByLabel('備註').fill('封面候選');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(viewer).toBeVisible();
    await expect
      .poll(async () => (await c.assets.list({ q: 'photo-01' })).items[0]?.note)
      .toBe('封面候選');
  });

  await test.step('← → 切換並在頭尾停住，縮圖條跟著；點縮圖條也能切換', async () => {
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft');
    await expect(pos).toHaveText(`1 / ${String(total)}`);
    await page.keyboard.press('ArrowRight');
    await expect(pos).toHaveText(`2 / ${String(total)}`);
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
    await expect(pos).toHaveText(`${String(total)} / ${String(total)}`);
    await strip.getByRole('button').nth(4).click();
    await expect(pos).toHaveText(`5 / ${String(total)}`);
    await expect(strip.getByRole('button').nth(4)).toHaveAttribute('aria-current', 'true');
    // The card stays closed when the view opens again.
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  });

  await test.step('Esc 回網格：保留捲動位置，焦點回到原卡片', async () => {
    await scrollGrid(page, 'end');
    const scrolled = await gridScroll(page);
    expect(scrolled).toBeGreaterThan(100);
    const last = page.locator('button.atile').last();
    await last.click();
    await expect(viewer).toBeVisible();
    await expect(card).toHaveCount(0);
    await viewer.getByRole('button', { name: '回到素材庫' }).click();
    await expect(viewer).toHaveCount(0);
    expect(await gridScroll(page)).toBe(scrolled);
    await expect(last).toBeFocused();
  });

  await test.step('音訊：大尺寸播放器，空白鍵播放與暫停', async () => {
    await tile('tone.wav').click();
    const audio = viewer.locator('audio');
    await expect(audio).toBeVisible();
    await expect
      .poll(() => audio.evaluate((a) => (a as unknown as { readyState: number }).readyState))
      .toBeGreaterThan(0);
    await shot(page, '04-audio');
    const paused = () => audio.evaluate((a) => (a as unknown as { paused: boolean }).paused);
    await page.keyboard.press(' ');
    await expect.poll(paused).toBe(false);
    await page.keyboard.press(' ');
    await expect.poll(paused).toBe(true);
  });

  await test.step('視頻：完整控制的播放器，空白鍵播放', async () => {
    await strip.getByRole('button', { name: 'clip.webm' }).click();
    await viewer.focus();
    await expect(viewer).toHaveAttribute('data-asset-id', clip.id);
    const video = viewer.locator('video.aview__video');
    await expect(video).toHaveAttribute('controls', '');
    await expect
      .poll(() => video.evaluate((v) => (v as unknown as { readyState: number }).readyState))
      .toBeGreaterThan(0);
    await shot(page, '05-video');
    const paused = () => video.evaluate((v) => (v as unknown as { paused: boolean }).paused);
    await page.keyboard.press(' ');
    await expect.poll(paused).toBe(false);
    await page.keyboard.press(' ');
    await expect.poll(paused).toBe(true);
  });

  await test.step('Markdown：排版閱讀、字數；更多 › 顯示原始文字；空白鍵開全視窗', async () => {
    await strip.getByRole('button', { name: '旁白稿.md' }).click();
    await expect(viewer).toHaveAttribute('data-asset-id', note.id);
    const doc = viewer.locator('.md-read');
    await expect(doc.getByRole('heading', { level: 1 })).toHaveText('京都秋季七日行程・旁白稿');
    await expect(doc.getByRole('heading', { level: 2 })).toHaveText('第一天：嵐山');
    await expect(doc.locator('strong')).toHaveText('先停在竹梢');
    await expect(doc.locator('blockquote')).toContainText('旁白在這裡停兩秒');
    await expect(doc.getByRole('listitem')).toHaveCount(2);
    await expect(viewer.locator('.aview__line')).toContainText(/\d+ 字/);
    await shot(page, '06-markdown');

    await viewer.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: '顯示原始文字' }).click();
    await expect(viewer.locator('.aview__raw')).toContainText('**先停在竹梢**');
    await viewer.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: '顯示排版' }).click();
    await expect(viewer.locator('.aview__raw')).toHaveCount(0);

    await viewer.focus();
    await page.keyboard.press(' ');
    const full = page.getByRole('dialog', { name: /大圖預覽/ });
    await expect(full).toBeVisible();
    await expect(full.locator('.md-read h1')).toHaveText('京都秋季七日行程・旁白稿');
    await page.keyboard.press('Escape');
    await expect(full).toHaveCount(0);
    await expect(viewer).toBeVisible();
  });

  await test.step('圖片空白鍵開全視窗預覽（QC-077），Esc 回到檢視', async () => {
    await strip.getByRole('button', { name: 'photo-01.png' }).click();
    await viewer.focus();
    await page.keyboard.press(' ');
    const full = page.getByRole('dialog', { name: /大圖預覽/ });
    await expect(full).toBeVisible();
    await expect(full).toContainText('photo-01.png');
    await page.keyboard.press('Escape');
    await expect(full).toHaveCount(0);
    await expect(viewer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  });

  await test.step('深色：圖片＋資訊卡、視頻、多選', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await tile('photo-02.png').click();
    await page.keyboard.press('i');
    await expect(card).toBeVisible();
    await shot(page, '07-info-dark');
    await page.keyboard.press('Escape');
    await viewer.locator('[aria-label="clip.webm"]').click();
    await expect(viewer).toHaveAttribute('data-asset-id', clip.id);
    await shot(page, '08-video-dark');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await scrollGrid(page, 'top');
    await tile('photo-03.png').click({ modifiers: ['Meta'] });
    await tile('photo-05.png').click({ modifiers: ['Meta'] });
    await expect(viewer).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '已選 2' })).toBeVisible();
    await shot(page, '09-multi-dark');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '已選 2' })).toHaveCount(0);
  });

  await test.step('檢視中刪除跳到下一個；回收站點名稱進同一個檢視，工具換成恢復與永久刪除', async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    await tile('photo-04.png').click();
    await page.keyboard.press('Meta+Backspace');
    await expect(page.locator('.toast')).toContainText('已移到回收站');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.aview__line')).not.toContainText('photo-04.png');
    await page.keyboard.press('Escape');
    await page
      .getByRole('group', { name: '範圍' })
      .getByRole('button', { name: /回收站/ })
      .click();
    await page
      .getByRole('list', { name: '已刪除的素材' })
      .getByRole('button', { name: 'photo-04.png', exact: true })
      .click();
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: '恢復' })).toBeVisible();
    await expect(viewer.getByRole('button', { name: '永久刪除' })).toBeVisible();
    await shot(page, '10-trash-viewer');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
  });
});
