import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-054 New API 模型下拉: the list is asked from the relay only when opened
 * or refreshed; chat models by default, 顯示全部 for the rest; type to filter,
 * ↑↓↩ to pick (not while the IME composes); a typed ID still saves; 不在中轉站
 * 清單中 and 費用無法預估 marks; relay errors with technical details; and a
 * Base URL without /v1 gets a one-click suggestion before saving. The relay
 * is the local fake AI server.
 * Set QC054_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

const BASE_URL = 'https://relay.example.test/v1';
const FAKE_KEY = 'fake-new-api-key-qc054';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC054_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc054-${name}.png`) });
}
const shooting = () => (process.env['QC054_SHOTS'] ?? '') !== '';

const list = (data: string[]) => ({
  body: { object: 'list', data: data.map((id) => ({ id, object: 'model' })) },
});

const COMPOSING_ENTER = `(() => {
  const el = document.activeElement;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
})()`;

test('New API 模型：打開才查詢、只列對話／顯示全部、搜尋與鍵盤選取、手動輸入、標記、錯誤、Base URL 建議', async ({
  desktop,
}) => {
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await backend.client.ai.setKey('new-api', FAKE_KEY, BASE_URL);
  const { notice } = backend.ai.providerStatus('new-api');
  await backend.client.ai.consent('new-api', notice.version, notice.credential_id ?? undefined);
  upstream.modelsReply = list([
    'gpt-4o-mini',
    'claude-sonnet-5-5',
    'gpt-image-2',
    'text-embedding-3-small',
    'deepseek-chat',
  ]);

  // 設定 v4 (QC-057): AI 服務 → 供應商 → New API's detail.
  const newApi: Locator = page.locator('.set-md__detail');
  const field = newApi.getByRole('combobox', { name: '文字模型', exact: true });
  const options = page.getByRole('listbox', { name: '中轉站提供的模型' }).getByRole('option');
  const savedModel = async () =>
    (await backend.client.ai.providers()).items.find((p) => p.provider === 'new-api')?.text_model;

  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '設定', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '設定分類' })
    .getByRole('button', { name: 'AI 服務', exact: true })
    .click();
  await page.locator('.set-pv', { hasText: 'New API' }).click();
  await expect(field).toHaveValue('gpt-4o-mini');

  await test.step('頁面載入不查詢；打開下拉才查，預設只列對話模型', async () => {
    expect(upstream.modelRequests).toBe(0);
    await newApi.getByRole('button', { name: '顯示模型清單' }).click();
    await expect(options).toHaveCount(3);
    expect(upstream.modelRequests).toBe(1);
    await expect(options.first()).toContainText('claude-sonnet-5-5');
    await expect(options.filter({ hasText: 'gpt-4o-mini' })).toContainText('目前使用');
    await expect(newApi.getByText('3 / 5 個')).toBeVisible();
    await shot(page, 'zh-Hant-1-list');
    await newApi.getByRole('checkbox', { name: '顯示全部模型' }).check();
    await expect(options).toHaveCount(5);
    await expect(options.filter({ hasText: 'gpt-image-2' })).toContainText('圖片');
  });

  await test.step('輸入篩選、↓↩ 選取；組字中的 ↩ 不選；沒有價格時標「費用無法預估」，儲存', async () => {
    await field.fill('claude');
    await expect(options).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(COMPOSING_ENTER);
    await expect(options).toHaveCount(1);
    await expect(field).toHaveValue('claude');
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue('claude-sonnet-5-5');
    await expect(options).toHaveCount(0);
    await expect(newApi.getByText('費用無法預估', { exact: true })).toBeVisible();
    await shot(page, 'zh-Hant-2-unpriced');
    await newApi.getByRole('button', { name: '儲存模型' }).click();
    await expect.poll(savedModel).toBe('claude-sonnet-5-5');
    // Reopening reuses the list already fetched (the service caches it anyway).
    expect(upstream.modelRequests).toBe(1);
  });

  await test.step('手動輸入清單外的模型：標「不在中轉站清單中」，仍可儲存', async () => {
    await field.fill('my-relay-alias');
    await expect(newApi.getByText('不在中轉站清單中', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await shot(page, 'zh-Hant-3-not-in-list');
    await newApi.getByRole('button', { name: '儲存模型' }).click();
    await expect.poll(savedModel).toBe('my-relay-alias');
    // The custom model in use stays listed even with 只列對話.
    await newApi.getByRole('button', { name: '顯示模型清單' }).click();
    await newApi.getByRole('checkbox', { name: '顯示全部模型' }).uncheck();
    await expect(options).toHaveCount(3);
    await field.fill('');
    await expect(options.filter({ hasText: 'my-relay-alias' })).toHaveCount(0);
  });

  await test.step('重新整理：略過快取再查一次，新模型出現', async () => {
    upstream.modelsReply = list(['gpt-4o-mini', 'claude-sonnet-5-5', 'qwen-max']);
    await newApi.getByRole('button', { name: '重新整理' }).click();
    await expect(options.filter({ hasText: 'qwen-max' })).toHaveCount(1);
    expect(upstream.modelRequests).toBe(2);
  });

  await test.step('中轉站拒絕金鑰：三語原因加技術細節，可以手動輸入', async () => {
    upstream.modelsReply = { status: 401, body: { error: { message: 'invalid key' } } };
    await newApi.getByRole('button', { name: '重新整理' }).click();
    const alert = newApi.getByRole('alert').filter({ hasText: '無法取得模型清單' });
    await expect(alert).toContainText('中轉站拒絕了這組金鑰（HTTP 401）');
    await alert.getByText('技術細節').click();
    await expect(alert).toContainText('ai_key_invalid · status=401');
    await expect(alert).not.toContainText(FAKE_KEY);
    await shot(page, 'zh-Hant-4-error');
    await page.keyboard.press('Escape');
  });

  await test.step('Base URL 少了 /v1：存檔前建議正確網址，一鍵採用', async () => {
    await newApi.getByRole('button', { name: '更換', exact: true }).click();
    const base = newApi.getByLabel('New API Base URL', { exact: true });
    await base.fill('https://relay.example.test');
    await newApi.getByLabel('New API 金鑰', { exact: true }).fill(FAKE_KEY);
    const suggest = newApi.getByText('少了 /v1？建議改成 https://relay.example.test/v1');
    await expect(suggest).toBeVisible();
    await shot(page, 'zh-Hant-5-base-url');
    await newApi.getByRole('button', { name: '改用這個網址' }).click();
    await expect(base).toHaveValue('https://relay.example.test/v1');
    await expect(suggest).toHaveCount(0);
    // A pasted endpoint is caught on save too.
    await base.fill('https://relay.example.test/v1/chat/completions');
    await newApi.getByRole('button', { name: '存到鑰匙圈', exact: true }).click();
    await expect(
      newApi.getByText('少了 /v1？建議改成 https://relay.example.test/v1'),
    ).toBeVisible();
    await newApi.getByRole('button', { name: '改用這個網址' }).click();
    await newApi.getByRole('button', { name: '存到鑰匙圈', exact: true }).click();
    await expect(newApi.getByRole('button', { name: '更換', exact: true })).toBeVisible();
  });

  if (shooting()) {
    await test.step('截圖：简体、English、深色', async () => {
      upstream.modelsReply = list(['gpt-4o-mini', 'claude-sonnet-5-5', 'gpt-image-2', 'qwen-max']);
      for (const lang of ['zh-Hans', 'en'] as const) {
        await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
        await page.locator('.mcombo__toggle').click();
        await page.locator('.mcombo__refresh').click();
        await expect(page.locator('.mcombo__opt').first()).toBeVisible();
        await shot(page, `${lang}-list`);
        await page.keyboard.press('Escape');
      }
      await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.locator('.mcombo__toggle').click();
      await shot(page, 'dark-list');
      await page.emulateMedia({ colorScheme: null });
    });
  }
});
