import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { fail } from '../../services/mac-server/test/fake-ai.js';
import { test } from '../fixtures/desktop.js';

/**
 * QC-043: text the service used to send in 繁體中文 (AI failure details,
 * backup failure details, the first-use notice) follows the interface
 * language; the raw technical detail sits under a collapsed 「技術細節」, and a
 * language switch does not ask for consent again.
 *
 * Set QC043_SHOTS=<dir> to save the screenshots for the acceptance record.
 */

const FAKE_KEY = 'sk-proj-fake-key-0123456789';
const TITLE = '雨後散步';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC043_SHOTS'];
  if (dir === undefined || dir === '') return;
  await page.screenshot({ path: path.join(dir, `qc043-${name}.png`) });
}

test('服務端文字跟隨介面語言：English 的 AI 錯誤、简体的備份錯誤', async ({ desktop }) => {
  const { page, backend, upstream } = desktop;
  const c = backend.client;
  await c.works.create({ title: TITLE, markdown: `# ${TITLE}\n\n等雨停了，我們就出門走走。\n` });
  await c.ai.setKey('openai', FAKE_KEY);
  const { notice } = backend.ai.providerStatus('openai');
  const consented = await c.ai.consent('openai', notice.version);
  upstream.script('openai', fail('openai', 401, `invalid key ${FAKE_KEY}`));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });

  const pick = async (navName: string, settings: string, language: string, card: string) => {
    await page
      .getByRole('navigation', { name: navName })
      .getByRole('button', { name: settings, exact: true })
      .click();
    await page
      .getByRole('radiogroup', { name: language, exact: true })
      .getByRole('radio', { name: new RegExp(card) })
      .click();
  };

  await test.step('切到 English：已確認的告知不需再確認', async () => {
    await pick('主導航', '設定', '語言', 'English');
    const gpt = page
      .getByRole('region', { name: 'AI services' })
      .getByRole('group', { name: 'GPT', exact: true });
    await expect(gpt.getByRole('status')).toHaveText('Keychain · on');
    await expect(gpt.getByRole('button', { name: 'I understand, turn it on' })).toHaveCount(0);
    const { items } = await c.ai.providers();
    expect(items.find((p) => p.provider === 'openai')).toMatchObject({
      consent: consented.consent,
      ready: true,
    });
  });

  await test.step('English：AI 失敗卡用英文類別，技術細節預設收起', async () => {
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(TITLE) }).click();
    const panel = page.getByRole('complementary', { name: 'AI rewrite' });
    await panel.getByRole('button', { name: 'Rewrite all', exact: true }).click();
    const alert = panel.getByRole('alert');
    await expect(alert).toContainText('Generation failed · The API key is invalid');
    await expect(alert).not.toContainText(/金鑰|密钥|已撤銷/);
    const details = alert.locator('details.tech-details');
    await expect(details).not.toHaveAttribute('open');
    await expect(details.getByText('HTTP 401', { exact: false })).toBeHidden();
    await details.getByText('Technical details', { exact: true }).click();
    await expect(details).toHaveAttribute('open');
    await expect(details.locator('pre')).toContainText('HTTP 401');
    await expect(details.locator('pre')).not.toContainText(FAKE_KEY);
    expect(upstream.for('openai')).toHaveLength(1);
    await shot(page, 'en-ai-failure');
  });

  await test.step('切到简体中文：備份失敗的類別句與技術細節', async () => {
    await pick('Main navigation', 'Settings', 'Language', '简体中文');
    const dir = path.join(backend.home, 'backups');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500); // the copy cannot be written
    try {
      const section = page.getByRole('region', { name: '备份与还原' });
      await section.getByRole('button', { name: '立即备份', exact: true }).click();
      const alert = section.getByRole('alert');
      await expect(alert).toContainText('备份失败，没有生成副本');
      await expect(alert).toContainText('没有写入备份文件夹的权限。');
      await expect(alert).not.toContainText(/備份|權限/);
      const details = alert.locator('details.tech-details');
      await expect(details).not.toHaveAttribute('open');
      await details.getByText('技术细节', { exact: true }).click();
      await expect(details.locator('pre')).not.toBeEmpty();
      await alert.scrollIntoViewIfNeeded();
      await shot(page, 'zh-Hans-backup-failure');
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
