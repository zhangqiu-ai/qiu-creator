import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-082: the New API relay cannot list its models (503). The model menu
 * still lists New API with its stored model, says 「清單讀取失敗，使用已存模型」
 * with the reason, and the stored model can be picked.
 * QC082_SHOTS=<dir> saves screenshots.
 */

const STORED = 'gpt-4o-mini';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC082_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc082-${name}.png`) });
}

test('中轉站清單讀取失敗：New API 仍列出已存模型，提示原因，可以選', async ({ desktop }) => {
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const c = backend.client;
  const relay = await c.ai.setKey(
    'new-api',
    'sk-relay-fake-0123456789',
    'https://relay.invalid/v1',
  );
  await c.ai.consent('new-api', relay.notice.version, relay.notice.credential_id ?? '');
  upstream.modelsReply = { status: 503, body: { error: { message: 'down' } } };
  await c.works.create({
    title: '京都散步',
    markdown: '# 京都散步\n\n第一段。\n',
    source: 'mac-app',
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

  const panel = page.getByRole('complementary', { name: 'AI' });
  await panel.getByRole('button', { name: '模型', exact: true }).click();
  const list = panel.getByRole('listbox', { name: '模型' });
  const group = list.getByRole('group', { name: 'New API' });
  await expect(group.getByRole('note')).toContainText('清單讀取失敗，使用已存模型');
  await expect(group.getByRole('note')).toContainText('服務暫時無法使用');
  await expect(group.getByRole('option', { name: STORED })).toBeEnabled();
  // The panel's model menu opens towards the left, inside the window (no sideways scroll).
  const box = await list.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1440);
  expect(await page.evaluate<number>("document.querySelector('.panel.ai')?.scrollLeft ?? 0")).toBe(
    0,
  );
  await shot(page, '1-fallback');

  await group.getByRole('option', { name: STORED }).click();
  await expect
    .poll(async () => (await c.ai.preferences()).last_models['rewrite'])
    .toEqual({ provider: 'new-api', model: STORED });
  await expect(panel.getByRole('button', { name: '模型', exact: true })).toContainText(
    `New API · ${STORED}`,
  );

  await page.emulateMedia({ colorScheme: 'dark' });
  await panel.getByRole('button', { name: '模型', exact: true }).click();
  await expect(list.getByRole('note')).toBeVisible();
  await shot(page, '2-fallback-dark');
});
