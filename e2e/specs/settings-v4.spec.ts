import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-057 設定 v4 (PT-20261121-002): one page per category (remembered, ⌘,
 * from the app menu), and AI 服務 in four tabs — providers as a list and a
 * detail with 測試連線 (passed, invalid key, quota, cancel), the Base URL
 * shown and fixed with one click, 用途 defaults, 用量, and 隱私. Every
 * provider is the local fake AI server; nothing reaches a real service.
 * Set QC057_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

const BASE_URL = 'https://relay.example.test/v1';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC057_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc057-${name}.png`) });
}
const shooting = () => (process.env['QC057_SHOTS'] ?? '') !== '';

const models = (ids: string[]) => ({
  body: { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) },
});

test('設定 v4：每個分類一頁並記住、⌘,、AI 服務四分頁與測試連線', async ({ desktop }) => {
  const { page, app, backend, upstream } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole('navigation', { name: '主導航' });
  const cats = page.getByRole('navigation', { name: '設定分類' });
  const cat = (name: string): Locator => cats.getByRole('button', { name, exact: true });
  const h1 = (name: string): Locator => page.getByRole('heading', { level: 1, name });

  await test.step('每個分類一頁：切換只換右側，焦點到頁標題，重新開啟時回到上次的分類', async () => {
    await nav.getByRole('button', { name: '設定', exact: true }).click();
    await expect(h1('外觀')).toBeVisible();
    await expect(cat('外觀')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.set-page h1')).toHaveCount(1);
    await cat('備份與還原').click();
    await expect(h1('備份與還原')).toBeFocused();
    await expect(page.getByRole('radiogroup', { name: '主題' })).toHaveCount(0);
    await expect(page.locator('.set-page h1')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '立即備份' })).toBeVisible();
    await shot(page, 'zh-Hant-1-backup');
    await nav.getByRole('button', { name: '作品庫', exact: true }).click();
    await nav.getByRole('button', { name: '設定', exact: true }).click();
    await expect(h1('備份與還原')).toBeVisible();
  });

  await test.step('⌘,（App 選單「設定…」）打開設定', async () => {
    await nav.getByRole('button', { name: '作品庫', exact: true }).click();
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('tab-settings');
      if (item?.accelerator !== 'CommandOrControl+,') throw new Error('no ⌘, item');
      item.click();
    });
    await expect(h1('備份與還原')).toBeVisible();
  });

  await cat('AI 服務').click();
  const tabs = page.getByRole('tablist', { name: 'AI 服務' });
  const list = page.getByRole('list').filter({ has: page.locator('.set-pv') });
  const row = (name: string): Locator => list.locator('.set-pv', { hasText: name });
  const detail = page.locator('.set-md__detail');
  const result = page.locator('#ai-test-result');

  await test.step('四個分頁；供應商清單與詳情並排，空狀態「先存入金鑰」', async () => {
    await expect(tabs.getByRole('tab')).toHaveText(['供應商', '用途', '用量', '隱私']);
    await expect(list.locator('.set-pv')).toHaveCount(5);
    await expect(row('本地模型')).toBeDisabled();
    await row('GPT').click();
    await expect(row('GPT')).toHaveAttribute('aria-current', 'true');
    await expect(row('GPT')).toContainText('未設定');
    await expect(detail.getByRole('heading', { name: 'GPT' })).toBeVisible();
    await expect(result).toContainText('先存入金鑰');
    await expect(detail.getByRole('button', { name: '測試連線' })).toBeDisabled();
    await shot(page, 'zh-Hant-2-empty');
  });

  await test.step('存入金鑰後未測試；測試成功顯示延遲與模型數，並說明額度要實際使用才知道', async () => {
    await detail.getByLabel('GPT API 金鑰').fill('sk-fake-openai-qc057');
    await detail.getByRole('button', { name: '存到鑰匙圈' }).click();
    await expect(detail.getByText(/^已設定 · /)).toBeVisible();
    await expect(row('GPT')).toContainText('待確認告知');
    await expect(result).toContainText('尚未測試');
    upstream.modelsReply = models(['gpt-5.5', 'gpt-5.5-mini', 'gpt-image-2']);
    await detail.getByRole('button', { name: '測試連線' }).click();
    await expect(result).toContainText('連線正常');
    await expect(result).toContainText('額度是否足夠，要等實際使用時才知道');
    await expect(result.locator('dd').nth(1)).toHaveText('3');
    // A key that works but whose notice is not confirmed still says so in the list.
    await expect(row('GPT')).toContainText('待確認告知');
    await detail.getByRole('button', { name: '我已了解，啟用' }).click();
    await expect(row('GPT')).toContainText('連線正常 · 剛剛');
    await shot(page, 'zh-Hant-3-ok');
  });

  await test.step('金鑰無效：原因、更換金鑰、技術詳情（不含金鑰），左側與分類都標紅', async () => {
    upstream.modelsReply = { status: 401, body: { error: { message: 'bad key' } } };
    await detail.getByRole('button', { name: '測試連線' }).click();
    await expect(result).toContainText('金鑰無效');
    await expect(result).toContainText('OpenAI 拒絕了這個金鑰');
    await expect(result.locator('code')).toContainText('ai_key_invalid · HTTP 401');
    await expect(result).not.toContainText('sk-fake-openai-qc057');
    await expect(row('GPT')).toContainText('金鑰無效');
    await expect(cats.getByRole('img', { name: 'AI 服務有連線問題' })).toBeVisible();
    await shot(page, 'zh-Hant-4-bad-key');
    await result.getByRole('button', { name: '更換金鑰' }).click();
    await expect(detail.getByLabel('GPT API 金鑰')).toBeFocused();
    await detail.getByRole('button', { name: '取消' }).click();
  });

  await test.step('額度不足（402）與取消測試', async () => {
    upstream.modelsReply = { status: 402, body: { error: { message: 'insufficient_quota' } } };
    await detail.getByRole('button', { name: '測試連線' }).click();
    await expect(result).toContainText('額度不足');
    await expect(row('GPT')).toContainText('額度不足');
    await expect(cats.getByRole('img', { name: 'AI 服務有待處理的項目' })).toBeVisible();
    await shot(page, 'zh-Hant-5-quota');
    upstream.modelsReply = { ...models(['gpt-5.5']), delayMs: 3000 };
    await detail.getByRole('button', { name: '測試連線' }).click();
    await expect(result).toContainText('正在連線');
    await expect(row('GPT')).toContainText('測試中');
    await detail.getByRole('button', { name: '取消' }).click();
    await expect(result).not.toContainText('正在連線');
    upstream.modelsReply = models(['gpt-5.5', 'gpt-5.5-mini']);
  });

  await test.step('New API：Base URL 少了 /v1 一鍵改正；存好後顯示完整 Base URL', async () => {
    await row('New API').click();
    await detail.getByLabel('New API Base URL').fill('https://relay.example.test');
    await detail.getByLabel('New API API 金鑰').fill('fake-new-api-key-qc057');
    await detail.getByRole('button', { name: '存到鑰匙圈' }).click();
    await detail.getByRole('button', { name: '改用這個網址' }).click();
    await expect(detail.getByLabel('New API Base URL')).toHaveValue(BASE_URL);
    await detail.getByLabel('New API API 金鑰').fill('fake-new-api-key-qc057');
    await detail.getByRole('button', { name: '存到鑰匙圈' }).click();
    await expect(detail.getByText(BASE_URL, { exact: true })).toBeVisible();
    await expect(detail.getByText('內容送到 你的中轉站 relay.example.test')).toBeVisible();
    await shot(page, 'zh-Hant-6-new-api');
  });

  await test.step('用途：預設供應商存到服務；視頻理解鎖定 Gemini', async () => {
    await tabs.getByRole('tab', { name: '用途' }).click();
    await page.getByLabel('文字改寫').selectOption('openai');
    await expect.poll(async () => (await backend.client.ai.defaults()).rewrite).toBe('openai');
    await expect(page.getByText('僅 Gemini')).toBeVisible();
    await shot(page, 'zh-Hant-7-use');
  });

  await test.step('用量與隱私；管理跳回供應商詳情', async () => {
    await tabs.getByRole('tab', { name: '用量' }).click();
    await expect(page.getByText('依參考價格估算，以供應商帳單為準。')).toBeVisible();
    await page.getByLabel('每月提醒金額').fill('20');
    await page.getByRole('button', { name: '儲存', exact: true }).click();
    await expect(page.getByText('提醒金額 $20.00')).toBeVisible();
    await shot(page, 'zh-Hant-8-usage');
    await tabs.getByRole('tab', { name: '隱私' }).click();
    const newApi = page.locator('.set-row[data-provider="new-api"]');
    await expect(newApi).toContainText('你的中轉站 relay.example.test');
    await expect(page.getByRole('switch', { name: '僅本地模型' })).toBeDisabled();
    await shot(page, 'zh-Hant-9-privacy');
    await newApi.getByRole('button', { name: '管理 New API' }).click();
    await expect(tabs.getByRole('tab', { name: '供應商' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(detail.getByRole('heading', { name: 'New API' })).toBeVisible();
  });

  await test.step('方向鍵切換分頁', async () => {
    await tabs.getByRole('tab', { name: '供應商' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: '用途' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: '用途' })).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', { name: '供應商' }).click();
  });

  if (shooting()) {
    await test.step('截圖：简体、English、深色、窄視窗', async () => {
      await row('GPT').click();
      for (const lang of ['zh-Hans', 'en'] as const) {
        await page.evaluate(`window.creatorhub.setLanguage('${lang}')`);
        await page.locator('.set-md__detail .set-ph .btn').click();
        await expect(page.locator('#ai-test-result')).toHaveClass(/set-test--ok/);
        await shot(page, `${lang}-ai`);
      }
      await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot(page, 'dark-ai');
      await page.setViewportSize({ width: 900, height: 800 });
      await shot(page, 'dark-narrow-ai');
      await page.emulateMedia({ colorScheme: null });
      await page.setViewportSize({ width: 1440, height: 900 });
    });
  }
});
