import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { ok } from '../../services/mac-server/test/fake-ai.js';
import { pngBytes } from '../../services/mac-server/test/fixtures.js';
import { test } from '../fixtures/desktop.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-074: an AI candidate takes real room in the article. With an image right
 * under the paragraph, an 擴寫 candidate that grows pushes the image down (no
 * overlap), a 縮寫 candidate that is shorter lets it come back up; in source
 * mode the candidate is in the side panel and the text is not covered. The
 * image placeholder waits with one quiet signal and the image fades in.
 * QC_E2E_MOTION=on QC_E2E_VIDEO=<dir> records it; QC074_SHOTS=<dir> saves screenshots.
 */

const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const LONG = '第一段寫紅葉與寺廟，清晨的光很好。'.repeat(1);
const EXPANDED =
  '第一段寫紅葉與寺廟，清晨的光線很柔和，沿著石階往上走，楓葉一層一層地落在青苔上。'.repeat(4);
const SHORTENED = '紅葉與寺廟。';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC074_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc074-${name}.png`) });
}

const content = (page: Page): Locator => page.locator('.qc-md-editor__content');
const toolbar = (page: Page): Locator => page.getByRole('toolbar', { name: 'AI 工具' });
const panel = (page: Page): Locator => page.getByRole('complementary', { name: 'AI' });

async function selectInVisual(page: Page, text: string): Promise<void> {
  const found = await page.evaluate<boolean>(`(() => {
    const root = document.querySelector('.qc-md-editor__content');
    root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    root.focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const i = n.textContent.indexOf(${JSON.stringify(text)});
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + ${String(text.length)});
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      window.dispatchEvent(new MouseEvent('mouseup'));
      return true;
    }
    return false;
  })()`);
  expect(found).toBe(true);
}

/**
 * Sample every frame for `ms`: the smallest gap between the live candidate
 * (not a leaving copy, which is inert) and the image under it; null when no
 * frame had a candidate.
 */
function minGapOverFrames(page: Page, ms: number): Promise<number | null> {
  return page.evaluate<number | null>(`new Promise((resolve) => {
    let min = null;
    const t0 = performance.now();
    const f = () => {
      const img = document.querySelector('.qc-md-editor__content img');
      const parts = [...document.querySelectorAll('.inline-ai__text:not([inert]), .inline-ai__text:not([inert]) *')];
      if (img && parts.length > 0) {
        const bottom = Math.max(...parts.map((e) => e.getBoundingClientRect().bottom));
        const gap = img.getBoundingClientRect().top - bottom;
        min = min === null ? gap : Math.min(min, gap);
      }
      if (performance.now() - t0 < ${String(ms)}) requestAnimationFrame(f);
      else resolve(min);
    };
    requestAnimationFrame(f);
  })`);
}

/** The image under the paragraph must start below everything the candidate draws. */
async function noOverlap(page: Page): Promise<{ candidateBottom: number; imageTop: number }> {
  return page.evaluate<{ candidateBottom: number; imageTop: number }>(`(() => {
    const img = document.querySelector('.qc-md-editor__content img');
    const parts = [...document.querySelectorAll('.inline-ai__text, .inline-ai__text *')];
    const bottom = Math.max(...parts.map((e) => e.getBoundingClientRect().bottom));
    return { candidateBottom: bottom, imageTop: img.getBoundingClientRect().top };
  })()`);
}

async function setUp(desktop: Parameters<Parameters<typeof test>[2]>[0]['desktop'], width = 1440) {
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width, height: 900 });
  const c = backend.client;
  await c.ai.setKey('anthropic', 'fake-anthropic-key');
  await c.ai.consent('anthropic', backend.ai.providerStatus('anthropic').notice.version);
  const relay = await c.ai.setKey(
    'new-api',
    'sk-relay-fake-0123456789',
    'https://relay.invalid/v1',
  );
  await c.ai.consent('new-api', relay.notice.version, relay.notice.credential_id ?? '');
  upstream.modelsReply = { body: { data: [{ id: 'gpt-image-1' }] } };
  const work = await c.works.create({
    title: '京都散步',
    markdown: `# 京都散步\n\n${LONG}\n\n第二段寫竹林。\n`,
    source: 'mac-app',
  });
  const asset = await c.assets.upload({
    data: await pngBytes(640, 360, '#2C8A80'),
    filename: 'leaf.png',
  });
  const { src } = await c.works.attachMedia(work.id, asset.asset.id);
  const fresh = await c.works.get(work.id);
  await c.works.patch(work.id, {
    base_revision: fresh.current_revision_id,
    markdown: `# 京都散步\n\n${LONG}\n\n![紅葉](${src})\n\n第二段寫竹林。\n`,
  });
  await page.reload();
  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '全部作品', exact: true })
    .click();
  await page
    .getByRole('region', { name: '作品', exact: true })
    .getByRole('button', { name: /京都散步/ })
    .click();
  await expect(content(page).locator('img')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate<number>("document.querySelector('.qc-md-editor__content img').naturalWidth"),
    )
    .toBeGreaterThan(0);
  return { page, upstream, c, work };
}

test('擴寫變長時把下方圖片推下去、縮寫變短時收回；原始碼模式不蓋文字', async ({ desktop }) => {
  test.setTimeout(90_000);
  // A narrow window, as in the report: the candidate's bar wraps onto two lines.
  const { page, upstream } = await setUp(desktop, 1120);
  const imageTopBefore = (await content(page).locator('img').boundingBox())?.y ?? 0;

  await test.step('擴寫：候選比原文長，下方的圖片往下讓，不重疊', async () => {
    upstream.script('anthropic', ok('anthropic', EXPANDED));
    await selectInVisual(page, '紅葉與寺廟');
    await toolbar(page).getByRole('button', { name: '擴寫' }).click();
    await expect(page.locator('.inline-ai__diff')).toBeVisible();
    await expect
      .poll(async () => {
        const m = await noOverlap(page);
        return m.imageTop - m.candidateBottom;
      })
      .toBeGreaterThanOrEqual(0);
    const pushed = (await content(page).locator('img').boundingBox())?.y ?? 0;
    expect(pushed).toBeGreaterThan(imageTopBefore + 40);
    await shot(page, '1-expanded');
    await content(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await expect(page.locator('.inline-ai__diff')).toHaveCount(0);
    // Back where it was once the candidate is gone.
    await expect
      .poll(async () => Math.round((await content(page).locator('img').boundingBox())?.y ?? 0))
      .toBe(Math.round(imageTopBefore));
  });

  await test.step('縮寫：候選比原文短，圖片跟著收回，仍不重疊', async () => {
    upstream.script('anthropic', ok('anthropic', SHORTENED));
    await selectInVisual(page, '紅葉與寺廟');
    await toolbar(page).getByRole('button', { name: '縮寫' }).click();
    await expect(page.locator('.inline-ai__diff')).toBeVisible();
    const m = await noOverlap(page);
    expect(m.imageTop - m.candidateBottom).toBeGreaterThanOrEqual(0);
    await shot(page, '2-shortened');
    await content(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
  });

  await test.step('原始碼模式：候選在面板，文字不被蓋住', async () => {
    upstream.script('anthropic', ok('anthropic', EXPANDED));
    await page.getByRole('button', { name: '原始碼', exact: true }).click();
    await page.evaluate(`(() => {
      const t = document.querySelector('.qc-md-editor__source');
      t.focus();
      const i = t.value.indexOf('紅葉與寺廟');
      t.setSelectionRange(i, i + 5);
      window.dispatchEvent(new MouseEvent('mouseup'));
    })()`);
    await toolbar(page).getByRole('button', { name: '擴寫' }).click();
    await expect(panel(page).locator('.ai__hunk').first()).toBeVisible();
    await expect(page.locator('.inline-ai__text')).toHaveCount(0);
    await shot(page, '3-source');
  });
});

test('動效錄影：配圖等待與淡入、擴寫讓位與縮寫收回（正常速度）', async ({ desktop }) => {
  test.skip(!motionOn, 'records motion only with QC_E2E_MOTION=on');
  test.setTimeout(90_000);
  const { page, upstream } = await setUp(desktop);
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop = videoDir === '' ? null : await startScreencast(page, videoDir, 'qc074-ai-motion');

  upstream.imageReplies.push({
    body: {
      created: 1,
      data: [{ b64_json: (await pngBytes(640, 360, '#9E4428')).toString('base64') }],
    },
    delayMs: 2500,
  });
  await selectInVisual(page, '第二段寫竹林');
  await toolbar(page).getByRole('button', { name: '配圖' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '仍要生成' }).click();
  await expect(page.locator('.imgslot img')).toBeVisible();
  await page.waitForTimeout(900); // pacing for the recording
  await page.locator('.imgslot-wrap').getByRole('button', { name: '捨棄' }).click();
  await expect(page.locator('.imgslot')).toHaveCount(0);

  upstream.script('anthropic', { ...ok('anthropic', EXPANDED), delayMs: 800 });
  await selectInVisual(page, '紅葉與寺廟');
  // Every frame while the candidate comes in: the image is never under it.
  const growing = minGapOverFrames(page, 2000);
  await toolbar(page).getByRole('button', { name: '擴寫' }).click();
  await expect(page.locator('.inline-ai__diff')).toBeVisible();
  expect(await growing).toBeGreaterThanOrEqual(0);
  const m = await noOverlap(page);
  expect(m.imageTop - m.candidateBottom).toBeGreaterThanOrEqual(0);
  await content(page).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  upstream.script('anthropic', { ...ok('anthropic', SHORTENED), delayMs: 600 });
  await selectInVisual(page, '紅葉與寺廟');
  const shrinking = minGapOverFrames(page, 1800);
  await toolbar(page).getByRole('button', { name: '縮寫' }).click();
  await expect(page.locator('.inline-ai__diff')).toBeVisible();
  expect(await shrinking).toBeGreaterThanOrEqual(0);
  await page.waitForTimeout(600); // pacing for the recording
  if (stop !== null) test.info().annotations.push({ type: 'video', description: await stop() });
});
