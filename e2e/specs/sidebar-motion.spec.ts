import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';
import { startScreencast } from '../fixtures/screencast.js';

/*
 * QC-068 側欄收合／展開 (DESIGN.md 動效 · 側欄收合): the sidebar takes its new
 * width at once and the change is drawn with transform and opacity only. A
 * still, inert copy of the old sidebar slides (collapsing) or fades (expanding)
 * over the real one, the content slides with it (`moderate` / `inOut`), and the
 * width never changes frame by frame. Reduce Motion: only a fade. In test mode
 * nothing is copied.
 * QC_E2E_MOTION=on runs the in-flight checks at normal speed; with
 * QC_E2E_VIDEO=<dir> it also records them. QC068_SHOTS=<dir> saves a mid-flight frame.
 */

const motionOn = process.env['QC_E2E_MOTION'] === 'on';
const nav = (page: Page) => page.getByRole('navigation', { name: '主導航' });

interface Frame {
  width: number;
  ghost: boolean;
  ghostHidden: boolean;
  ghostTransform: string;
  ghostOpacity: string;
  navTransform: string;
  mainTransform: string;
}

/** Click the sidebar toggle and sample every frame for `ms`. */
function toggleAndSample(page: Page, ms: number): Promise<Frame[]> {
  return page.evaluate<Frame[]>(`new Promise((resolve) => {
    const frames = [];
    const navEl = document.querySelector('nav.sb:not(.sb--ghost)');
    navEl.querySelector('.sb__logo').click();
    const start = performance.now();
    const sample = () => {
      const real = document.querySelector('nav.sb:not(.sb--ghost)');
      const ghost = document.querySelector('.sb--ghost');
      frames.push({
        width: real.getBoundingClientRect().width,
        ghost: ghost !== null,
        ghostHidden: ghost !== null && ghost.getAttribute('aria-hidden') === 'true' && ghost.inert,
        ghostTransform: ghost === null ? 'none' : getComputedStyle(ghost).transform,
        ghostOpacity: ghost === null ? '' : getComputedStyle(ghost).opacity,
        navTransform: getComputedStyle(real).transform,
        mainTransform: getComputedStyle(document.querySelector('.shell__main')).transform,
      });
      if (performance.now() - start < ${String(ms)}) requestAnimationFrame(sample);
      else resolve(frames);
    };
    requestAnimationFrame(sample);
  })`);
}

const moving = (t: string) => t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC068_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc068-${name}.png`) });
}

test('側欄收合：測試模式下直接到位，不留副本', async ({ desktop }) => {
  test.skip(motionOn, 'the run below covers it at normal speed');
  const { page } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await nav(page).getByRole('button', { name: '收起側欄' }).click();
  await expect(nav(page).getByRole('button', { name: '展開側欄' })).toBeVisible();
  await expect(page.locator('.sb--ghost')).toHaveCount(0);
  await nav(page).getByRole('button', { name: '展開側欄' }).click();
  await expect(page.locator('.sb--ghost')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '主導航' })).toHaveCount(1);
});

test('側欄收合與展開：寬度一次到位，只用 transform 與透明度過渡；減少動態效果只淡化', async ({
  desktop,
}) => {
  test.skip(!motionOn, 'runs the transition only with QC_E2E_MOTION=on');
  const { page, backend } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const title of ['京都散步路線', '秋天的咖啡店', '相機入門筆記'])
    await backend.client.works.create({ title, markdown: `# ${title}\n\n正文`, source: 'mac-app' });
  await page.reload();
  await expect(page.locator('.card-grid .wcard')).toHaveCount(3);
  const videoDir = process.env['QC_E2E_VIDEO'] ?? '';
  const stop = videoDir === '' ? null : await startScreencast(page, videoDir, 'qc068-sidebar');

  await test.step('收合：寬度一次到位，副本左移淡出，內容跟著平移', async () => {
    const frames = await toggleAndSample(page, 400);
    // Never re-laid out frame by frame: every frame has the rail's final width.
    expect(new Set(frames.map((f) => f.width))).toEqual(new Set([56]));
    const flight = frames.filter((f) => f.ghost);
    expect(flight.length).toBeGreaterThan(3);
    expect(flight.every((f) => f.ghostHidden)).toBe(true);
    expect(flight.some((f) => moving(f.ghostTransform))).toBe(true);
    expect(frames.some((f) => moving(f.mainTransform))).toBe(true);
    // Done: the copy is gone and nothing is left moved.
    const last = frames[frames.length - 1];
    expect(last?.ghost).toBe(false);
    expect(moving(last?.mainTransform ?? 'none')).toBe(false);
    await expect(nav(page)).toHaveCount(1);
  });

  await test.step('展開：側欄從左滑入，圖示列副本淡出', async () => {
    const frames = await toggleAndSample(page, 400);
    expect(new Set(frames.map((f) => f.width))).toEqual(new Set([232]));
    expect(frames.some((f) => moving(f.navTransform))).toBe(true);
    expect(frames.some((f) => moving(f.mainTransform))).toBe(true);
    expect(frames.filter((f) => f.ghost).every((f) => f.ghostHidden)).toBe(true);
    const last = frames[frames.length - 1];
    expect(last?.ghost).toBe(false);
    expect(moving(last?.navTransform ?? 'none')).toBe(false);
  });

  await test.step('動畫途中再按：從新的狀態接續，不留副本', async () => {
    await page.evaluate("document.querySelector('nav.sb .sb__logo').click()");
    const frames = await toggleAndSample(page, 400);
    expect(new Set(frames.map((f) => f.width))).toEqual(new Set([232]));
    await expect(page.locator('.sb--ghost')).toHaveCount(0);
  });

  await test.step('減少動態效果：沒有位移，只有副本淡出', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const frames = await toggleAndSample(page, 300);
    expect(new Set(frames.map((f) => f.width))).toEqual(new Set([56]));
    expect(frames.some((f) => f.ghost)).toBe(true);
    expect(frames.some((f) => moving(f.ghostTransform))).toBe(false);
    expect(frames.some((f) => moving(f.navTransform))).toBe(false);
    expect(frames.some((f) => moving(f.mainTransform))).toBe(false);
    await expect(page.locator('.sb--ghost')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  await test.step('錄影用：正常速度各來回一次', async () => {
    await nav(page).getByRole('button', { name: '展開側欄' }).click();
    await page.waitForTimeout(600);
    await nav(page).getByRole('button', { name: '收起側欄' }).click();
    await page.waitForTimeout(120);
    await shot(page, 'sidebar-midflight');
    await page.waitForTimeout(600);
    await nav(page).getByRole('button', { name: '展開側欄' }).click();
    await page.waitForTimeout(600);
  });
  await stop?.();
});
