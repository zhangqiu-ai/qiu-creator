import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { ok } from '../../services/mac-server/test/fake-ai.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-040: scrolling the editor must never slide the toolbar, the AI tabs or
 * the page header over the text. The text and the AI panel scroll on their
 * own; the editor body itself never scrolls.
 * Set QC040_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

const WORK_TITLE = '長文捲動測試';
const PARAGRAPH =
  '在信息時代，標題的結構對內容呈現很重要。層級劃分幫助讀者理解主題，並有序地獲取信息。清單讓重點更突出，適合用在報告和建議書裡。';
const ORIGINAL = Array.from(
  { length: 24 },
  (_, i) => `## 第 ${String(i + 1)} 節\n\n${PARAGRAPH}\n`,
).join('\n');
// Every sentence changes, so the candidate has dozens of hunks: far taller than the window.
const CANDIDATE = ORIGINAL.replaceAll('。', '，並且讓段落讀起來更加順暢自然。');

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (b === null) throw new Error(`${selector} is not rendered`);
  return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width };
}

/** The checks that failed before QC-040, for the current mode and window size. */
async function expectNothingCovered(page: Page, label: string): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  // The body never scrolls: only the text and the panel do.
  // Page-side code as strings: the e2e project has no DOM types.
  const bodyScrollTop = await page.evaluate<number>(
    "document.querySelector('.editor__body').scrollTop",
  );
  expect(bodyScrollTop, label).toBe(0);

  const body = await box(page, '.editor__body');
  const doc = await box(page, '.editor__doc');
  const meta = await box(page, '.editor__meta');
  // The text column starts under the header and the meta row, inside the window.
  expect(doc.top, label).toBeGreaterThanOrEqual(meta.bottom - 1);
  expect(doc.top, label).toBeGreaterThanOrEqual(body.top - 1);
  expect(doc.bottom, label).toBeLessThanOrEqual(viewport.height + 1);

  // The topmost thing visible in the text column is the toolbar (visual) or
  // the source editor, never text drawn above the column.
  const visualToolbar = page.locator('.editor__doc [role="toolbar"]');
  if (await visualToolbar.isVisible()) {
    const toolbar = await box(page, '.editor__doc [role="toolbar"]');
    expect(toolbar.top, `${label}: toolbar in view`).toBeGreaterThanOrEqual(doc.top - 1);
    expect(toolbar.bottom, `${label}: toolbar in view`).toBeLessThanOrEqual(doc.bottom);
    // Just under the toolbar is the text, not the toolbar or something above it.
    const x = (toolbar.left + toolbar.right) / 2;
    const y = toolbar.bottom + 24;
    const under = await page.evaluate<boolean>(
      `document.elementFromPoint(${String(x)}, ${String(y)})?.closest('.qc-md-editor__content') != null`,
    );
    expect(under, `${label}: text starts below the toolbar`).toBe(true);
  }

  const panel = page.locator('.panel.ai');
  if (await panel.isVisible()) {
    const p = await box(page, '.panel.ai');
    const tabs = await box(page, '.ai__tabs');
    expect(p.top, `${label}: panel inside the body`).toBeGreaterThanOrEqual(body.top - 1);
    expect(p.bottom, `${label}: panel inside the window`).toBeLessThanOrEqual(viewport.height + 1);
    expect(tabs.top, `${label}: AI tabs pinned`).toBeGreaterThanOrEqual(p.top - 1);
    expect(tabs.bottom, `${label}: AI tabs pinned`).toBeLessThanOrEqual(p.bottom);
  }
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC040_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc040-${name}.png`) });
}

async function wheel(page: Page, selector: string, deltaY: number): Promise<void> {
  const b = await box(page, selector);
  await page.mouse.move((b.left + b.right) / 2, Math.min(b.bottom - 20, b.top + 200));
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, deltaY / 6);
  await page.waitForTimeout(150);
}

test('捲動正文與 AI 面板時，工具列與分頁列不會蓋住內容', async ({ desktop }) => {
  const { page, backend, upstream } = desktop;
  await backend.client.works.create({ title: WORK_TITLE, markdown: ORIGINAL });
  await backend.client.ai.setKey('anthropic', 'fake-anthropic-key');
  const { notice } = backend.ai.providerStatus('anthropic');
  await backend.client.ai.consent('anthropic', notice.version);
  upstream.script('anthropic', ok('anthropic', CANDIDATE));

  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole('navigation', { name: '主導航' });
  await nav.getByRole('button', { name: '作品庫', exact: true }).click();
  await page
    .getByRole('region', { name: '作品', exact: true })
    .getByRole('button', { name: new RegExp(WORK_TITLE) })
    .click();
  const panel = page.getByRole('complementary', { name: 'AI 改寫' });
  await panel.getByRole('button', { name: '改寫全文', exact: true }).click();
  await expect(panel.locator('.ai__hunk').first()).toBeVisible();

  await test.step('視覺模式：捲動正文與面板', async () => {
    await wheel(page, '.editor__doc', 1800);
    await wheel(page, '.panel.ai', 1500);
    await shot(page, 'visual-scrolled');
    await expectNothingCovered(page, 'visual');
    // The panel scrolls far enough to show its last candidate hunk.
    await wheel(page, '.panel.ai', 20_000);
    const p = await box(page, '.panel.ai');
    const last = await box(page, '.ai__hunk >> nth=-1');
    expect(last.bottom).toBeLessThanOrEqual(p.bottom + 1);
    await expectNothingCovered(page, 'visual, panel at the end');
  });

  await test.step('原始碼模式', async () => {
    await page.getByRole('button', { name: '原始碼', exact: true }).click();
    await expect(page.locator('.qc-md-editor__source')).toBeVisible();
    await wheel(page, '.editor__doc', 1800);
    await shot(page, 'source-scrolled');
    await expectNothingCovered(page, 'source');
    await page.getByRole('button', { name: '視覺', exact: true }).click();
  });

  await test.step('窄視窗：上下排列，各自捲動', async () => {
    for (const size of [
      { width: 1000, height: 800 },
      { width: 760, height: 800 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(200);
      await wheel(page, '.editor__doc', 1500);
      await wheel(page, '.panel.ai', 1500);
      await shot(page, `narrow-${String(size.width)}`);
      await expectNothingCovered(page, `${String(size.width)}px`);
    }
  });
});
