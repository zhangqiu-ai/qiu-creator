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
  // 設定 v4 (QC-057): AI 服務 is its own page; providers are a list and a detail.
  const pv = (name: string) => page.locator('.set-pv', { hasText: name });
  const detail = page.locator('.set-md__detail');
  const openAiSettings = async (provider: string) => {
    await settingsButton.click();
    await page
      .getByRole('navigation', { name: '設定分類' })
      // The name gains the status dot's label (「AI 服務 AI 服務有待處理的項目」) once the
      // providers load; match its start so the click does not race that (QC-081).
      .getByRole('button', { name: /^AI 服務/ })
      .click();
    await pv(provider).click();
  };
  const openWork = async () => {
    await nav.getByRole('button', { name: '全部作品', exact: true }).click();
    await page
      .getByRole('region', { name: '作品', exact: true })
      .getByRole('button', { name: new RegExp(WORK_TITLE) })
      .click();
  };
  const panel = page.getByRole('complementary', { name: 'AI 改寫' });
  // QC-075: the panel switches the model (grouped by ready provider), not the provider.
  const modelButton = panel.getByRole('button', { name: '模型', exact: true });
  const rewrite = panel.getByRole('button', { name: '改寫全文', exact: true });

  await test.step('儲存 New API 設定後仍需獨立確認使用告知', async () => {
    await openAiSettings('New API');
    await expect(pv('New API')).toContainText('未設定');
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

    await detail.getByLabel('New API Base URL', { exact: true }).fill(BASE_URL);
    await detail.getByLabel('New API 金鑰', { exact: true }).fill(FAKE_KEY);
    await detail.getByRole('button', { name: '存到鑰匙圈', exact: true }).click();
    await expect(pv('New API')).toContainText('待確認告知');
    await expect(detail.getByRole('combobox', { name: '文字模型', exact: true })).toHaveValue(
      DEFAULT_MODEL,
    );

    await openWork();
    await expect(panel.getByText('尚未確認雲端 AI 使用告知', { exact: true })).toBeVisible();
    await expect(rewrite).toBeDisabled();
    expect(upstream.seen).toHaveLength(0);
  });

  await test.step('確認各自的告知後，從 GPT 切換到 New API 並顯示改寫候選', async () => {
    await openAiSettings('New API');
    const notice = detail.getByRole('group', { name: 'New API 使用告知', exact: true });
    await notice.getByRole('button', { name: '我已了解，啟用', exact: true }).click();
    // Ready, and nothing tested yet: tests only run when 測試連線 is pressed.
    await expect(pv('New API')).toContainText('未測試');
    const { items } = await backend.client.ai.providers();
    expect(items.find(({ provider }) => provider === 'openai')?.consent).toEqual(gpt.consent);

    await pv('GPT').click();
    await detail.getByLabel('GPT API 金鑰', { exact: true }).fill('fake-openai-key');
    await detail.getByRole('button', { name: '存到鑰匙圈', exact: true }).click();
    await expect(pv('GPT')).toContainText('未測試');

    await openWork();
    // The relay lists its models (QC-054); the menu shows them under New API.
    upstream.modelsReply = { body: { data: [{ id: DEFAULT_MODEL }, { id: 'deepseek-v4' }] } };
    await modelButton.click();
    const models = panel.getByRole('listbox', { name: '模型' });
    await expect(models.getByRole('group', { name: 'GPT' })).toBeVisible();
    await models
      .getByRole('group', { name: 'New API' })
      .getByRole('option', { name: DEFAULT_MODEL })
      .click();
    await expect(modelButton).toContainText(`New API · ${DEFAULT_MODEL}`);
    await rewrite.click();
    await expect(panel.getByText(CANDIDATE, { exact: true })).toBeVisible();
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.for('new-api')).toMatchObject([{ body: { model: DEFAULT_MODEL } }]);
    expect((await backend.client.works.get(work.id)).markdown).toBe(ORIGINAL);
  });
});
