import { expect } from '@playwright/test';
import { ok } from '../../services/mac-server/test/fake-ai.js';
import { test } from '../fixtures/desktop.js';

const BASE_URL = 'https://relay.example.test/v1';
const FAKE_KEY = 'fake-new-api-key';
const DEFAULT_MODEL = 'gpt-4o-mini';
const WORK_TITLE = '雨後散步';
const ORIGINAL = '等雨停了，我們就出門走走。\n';
const CANDIDATE = '雨停後，我們出門散步。';

test('設定 New API、獨立確認使用告知，並切換供應商改寫', async ({ desktop }) => {
  const { page, backend, upstream } = desktop;
  const work = await backend.client.works.create({ title: WORK_TITLE, markdown: ORIGINAL });
  // Prior GPT consent without a configured GPT key.
  const { notice } = backend.ai.providerStatus('openai');
  const gpt = await backend.client.ai.consent('openai', notice.version);
  expect(gpt).toMatchObject({ consent: { version: notice.version }, ready: false });
  upstream.script('new-api', ok('new-api', CANDIDATE, DEFAULT_MODEL));

  const nav = page.getByRole('navigation', { name: '主導航' });
  const settingsButton = nav.getByRole('button', { name: '設定', exact: true });
  const settings = page.getByRole('region', { name: 'AI 服務' });
  const newApi = settings.getByRole('group', { name: 'New API', exact: true });
  const openWork = async () => {
    await nav.getByRole('button', { name: '作品庫', exact: true }).click();
    await page
      .getByRole('region', { name: '作品', exact: true })
      .getByRole('button', { name: new RegExp(WORK_TITLE) })
      .click();
  };
  const panel = page.getByRole('complementary', { name: 'AI 改寫' });
  const providerSelect = panel.getByRole('combobox', { name: '文字 AI 供應商', exact: true });
  const rewrite = panel.getByRole('button', { name: '改寫全文', exact: true });

  await test.step('儲存 New API 設定後仍需獨立確認使用告知', async () => {
    await settingsButton.click();
    await expect(newApi.getByRole('status')).toHaveText('未設定');
    const { items } = await backend.client.ai.providers();
    expect(items).toContainEqual(
      expect.objectContaining({
        provider: 'new-api',
        name: 'New API',
        text_model: DEFAULT_MODEL,
        ready: false,
        consent: null,
      }),
    );

    await newApi.getByRole('button', { name: '新增', exact: true }).click();
    await newApi.getByLabel('New API Base URL', { exact: true }).fill(BASE_URL);
    await newApi.getByLabel('New API API 金鑰', { exact: true }).fill(FAKE_KEY);
    await newApi.getByRole('button', { name: '存到鑰匙圈', exact: true }).click();
    await expect(newApi.getByRole('status')).toHaveText('待確認告知');
    await expect(newApi.getByLabel('New API 文字模型 ID', { exact: true })).toHaveValue(
      DEFAULT_MODEL,
    );

    await openWork();
    await expect(panel.getByText('尚未確認雲端 AI 使用告知', { exact: true })).toBeVisible();
    await expect(rewrite).toBeDisabled();
    await expect(providerSelect).toHaveCount(0);
    expect(upstream.seen).toHaveLength(0);
  });

  await test.step('確認各自的告知後，從 GPT 切換到 New API 並顯示改寫候選', async () => {
    await settingsButton.click();
    const notice = newApi.getByRole('group', { name: 'New API 使用告知', exact: true });
    await notice.getByRole('button', { name: '我已了解，啟用', exact: true }).click();
    await expect(newApi.getByRole('status')).toHaveText('鑰匙圈 · 已啟用');
    const { items } = await backend.client.ai.providers();
    expect(items.find(({ provider }) => provider === 'openai')?.consent).toEqual(gpt.consent);

    const gptRow = settings.getByRole('group', { name: 'GPT', exact: true });
    await gptRow.getByRole('button', { name: '新增', exact: true }).click();
    await gptRow.getByLabel('GPT API 金鑰', { exact: true }).fill('fake-openai-key');
    await gptRow.getByRole('button', { name: '存到鑰匙圈', exact: true }).click();
    await expect(gptRow.getByRole('status')).toHaveText('鑰匙圈 · 已啟用');

    await openWork();
    await expect(providerSelect).toHaveValue('openai');
    await providerSelect.selectOption('new-api');
    await expect(providerSelect).toHaveValue('new-api');
    await rewrite.click();
    await expect(panel.getByText(CANDIDATE, { exact: true })).toBeVisible();
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.for('new-api')).toMatchObject([{ body: { model: DEFAULT_MODEL } }]);
    expect((await backend.client.works.get(work.id)).markdown).toBe(ORIGINAL);
  });
});
