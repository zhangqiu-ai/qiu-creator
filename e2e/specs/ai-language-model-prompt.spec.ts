import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { ok } from '../../services/mac-server/test/fake-ai.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-075 (PT-20261122-003): the selection toolbar and the 改寫 panel switch
 * the output language and the model (global, saved on the Mac, the two
 * places agree), the toolbar's 「Prompt」 (⌘K) picks a library prompt —
 * recent first, other scenes shown but disabled — or takes a typed
 * instruction and can save it as a prompt; candidates say their language
 * and model, and 「prompt 指定」 when the prompt chose them.
 * QC075_SHOTS=<dir> saves screenshots.
 */

const MD = [
  '# 京都散步',
  '',
  '第一段寫紅葉與寺廟，清晨的光很好。',
  '',
  '第二段寫竹林小徑。',
  '',
].join('\n');

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC075_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc075-${name}.png`) });
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

async function setUp(desktop: Parameters<Parameters<typeof test>[2]>[0]['desktop']) {
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const c = backend.client;
  await c.ai.setKey('anthropic', 'fake-anthropic-key');
  await c.ai.consent('anthropic', backend.ai.providerStatus('anthropic').notice.version);
  const relay = await c.ai.setKey(
    'new-api',
    'sk-relay-fake-0123456789',
    'https://relay.invalid/v1',
  );
  await c.ai.consent('new-api', relay.notice.version, relay.notice.credential_id ?? '');
  upstream.modelsReply = { body: { data: [{ id: 'deepseek-v4' }, { id: 'kimi-k3' }] } };
  // Two custom prompts: one for selected text (with its own language), one for images.
  await c.ai.prompts.create({
    name: '小紅書口吻',
    content: '把{選取}改成小紅書口吻，加一點 emoji。',
    scene: 'selection',
    group: '小紅書',
    language: 'zh-Hans',
  });
  await c.ai.prompts.create({ name: '水彩插畫', content: '水彩風格的插畫', scene: 'image' });
  await c.works.create({ title: '京都散步', markdown: MD, source: 'mac-app' });
  await page.reload();
  await page
    .getByRole('navigation', { name: '主導航' })
    .getByRole('button', { name: '全部作品', exact: true })
    .click();
  await page
    .getByRole('region', { name: '作品', exact: true })
    .getByRole('button', { name: /京都散步/ })
    .click();
  await expect(content(page)).toContainText('第一段寫紅葉');
  return { page, c, upstream };
}

test('語言與模型：工具列與面板同步、存在服務端；候選標示語言與模型', async ({ desktop }) => {
  test.setTimeout(120_000);
  const { page, c, upstream } = await setUp(desktop);

  await test.step('工具列的語言選單：跟隨原文寫出偵測結果；改成简体中文後全域保存', async () => {
    await selectInVisual(page, '紅葉與寺廟');
    await expect(toolbar(page)).toBeVisible();
    await toolbar(page).getByRole('button', { name: '輸出語言' }).click();
    const list = toolbar(page).getByRole('listbox', { name: '輸出語言' });
    await expect(list.getByRole('option', { name: /跟隨原文/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(list.getByRole('option', { name: /跟隨原文/ })).toContainText('這段是繁體中文');
    await shot(page, '1-language');
    await list.getByRole('option', { name: '簡體中文' }).click();
    await expect(page.getByText('之後的 AI 文字用簡體中文')).toBeVisible();
    await expect.poll(async () => (await c.ai.preferences()).output_language).toBe('zh-Hans');
    await expect(toolbar(page).getByRole('button', { name: '輸出語言' })).toHaveText('簡中');
    // The panel shows the same choice.
    await expect(panel(page).getByRole('button', { name: '輸出語言' })).toHaveText('簡體中文');
  });

  await test.step('模型選單：只列就緒的供應商，選 New API 的模型後改寫送到它', async () => {
    await selectInVisual(page, '紅葉與寺廟');
    await toolbar(page).getByRole('button', { name: '模型' }).click();
    const list = toolbar(page).getByRole('listbox', { name: '模型' });
    await expect(list.getByRole('group', { name: 'Claude' })).toBeVisible();
    await expect(list.getByRole('group', { name: 'New API' })).toBeVisible();
    await toolbar(page).getByRole('searchbox', { name: '搜尋模型' }).fill('kimi');
    await expect(list.getByRole('option')).toHaveCount(1);
    await shot(page, '2-model');
    await list.getByRole('option', { name: 'kimi-k3' }).click();
    await expect
      .poll(async () => (await c.ai.preferences()).last_models['rewrite'])
      .toEqual({
        provider: 'new-api',
        model: 'kimi-k3',
      });
    await expect(panel(page).getByRole('button', { name: '模型' })).toContainText('kimi-k3');

    upstream.script('new-api', ok('new-api', '第一段寫紅葉與古寺，清晨的光線柔和。', 'kimi-k3'));
    await selectInVisual(page, '紅葉與寺廟');
    await toolbar(page).getByRole('button', { name: '潤色' }).click();
    await expect(page.locator('.inline-ai__diff')).toBeVisible();
    const sent = JSON.stringify(upstream.for('new-api').at(-1)?.body ?? {});
    expect(sent).toContain('kimi-k3');
    const bar = page.locator('.inline-ai .cand-bar');
    await expect(bar).toContainText('簡中');
    await expect(bar).toContainText('New API · kimi-k3');
    await shot(page, '3-candidate');
    await content(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await expect(page.locator('.inline-ai__diff')).toHaveCount(0);
  });
});

test('Prompt 快選：⌘K、最近使用置頂、其他場景停用、直接輸入與存成 prompt', async ({ desktop }) => {
  test.setTimeout(120_000);
  const { page, c, upstream } = await setUp(desktop);

  await test.step('⌘K 打開；圖片用的指令看得到但停用；搜尋可用拼音', async () => {
    await selectInVisual(page, '紅葉與寺廟');
    await expect(toolbar(page)).toBeVisible();
    await page.keyboard.press('Meta+k');
    const search = toolbar(page).getByRole('combobox', { name: '搜尋 prompt，或直接輸入指令' });
    await expect(search).toBeFocused();
    const list = toolbar(page).getByRole('listbox', { name: 'Prompt' });
    await expect(list.getByRole('option', { name: /小紅書口吻/ })).toBeVisible();
    await expect(list.getByRole('option', { name: /水彩插畫/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // The selection is near the top: the toolbar with the picker goes below it, inside the window.
    await expect
      .poll(async () => (await toolbar(page).boundingBox())?.y ?? -1)
      .toBeGreaterThanOrEqual(0);
    await shot(page, '4-picker');
    await search.fill('xhs');
    await expect(list.getByRole('option', { name: /小紅書口吻/ }).locator('mark')).toHaveText(
      '小紅書',
    );
  });

  await test.step('套用 prompt：送出指令內容；候選標「prompt 指定」與它的語言', async () => {
    upstream.script('anthropic', ok('anthropic', '第一段寫紅葉與寺廟✨清晨的光超好～'));
    // Typed text comes first (↩ would send it as an instruction); the prompt is picked from the list.
    await toolbar(page)
      .getByRole('listbox', { name: 'Prompt' })
      .getByRole('option', { name: /小紅書口吻/ })
      .click();
    await expect(page.locator('.inline-ai__diff')).toBeVisible();
    const sent = JSON.stringify(upstream.for('anthropic').at(-1)?.body ?? {});
    expect(sent).toContain('小紅書口吻');
    const bar = page.locator('.inline-ai .cand-bar');
    await expect(bar).toContainText('小紅書口吻');
    await expect(bar).toContainText('prompt 指定');
    await expect(bar).toContainText('簡中');
    await content(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await expect(page.locator('.inline-ai__diff')).toHaveCount(0);
  });

  await test.step('用過的 prompt 置頂在「最近使用」', async () => {
    await selectInVisual(page, '竹林小徑');
    await toolbar(page).getByRole('button', { name: 'Prompt' }).click();
    const list = toolbar(page).getByRole('listbox', { name: 'Prompt' });
    await expect(list.locator('.qpop__hd').first()).toHaveText('最近使用');
    await expect(list.getByRole('option').first()).toContainText('小紅書口吻');
  });

  await test.step('直接輸入：第一項以「…」送出，第二項存成 prompt', async () => {
    const search = toolbar(page).getByRole('combobox', { name: '搜尋 prompt，或直接輸入指令' });
    await search.fill('改成第一人稱，語氣輕鬆');
    const list = toolbar(page).getByRole('listbox', { name: 'Prompt' });
    await expect(list.getByRole('option').nth(0)).toContainText('以「改成第一人稱，語氣輕鬆」送出');
    await list.getByRole('option', { name: '存成 prompt…' }).click();
    const name = toolbar(page).getByRole('textbox', { name: '名稱' });
    await expect(name).toBeFocused();
    await name.fill('第一人稱輕鬆語氣');
    await shot(page, '5-save');
    await toolbar(page).getByRole('button', { name: '儲存' }).click();
    await expect(page.getByText('已存成 prompt「第一人稱輕鬆語氣」')).toBeVisible();
    await expect
      .poll(async () => (await c.ai.prompts.list()).items.map((p) => p.name))
      .toContain('第一人稱輕鬆語氣');
    const saved = (await c.ai.prompts.list()).items.find((p) => p.name === '第一人稱輕鬆語氣');
    expect(saved?.content).toBe('改成第一人稱，語氣輕鬆');
    expect(saved?.scene).toBe('selection');
  });

  await test.step('面板：自訂指令也在 Prompt 膠囊裡，「管理」打開 Prompt 頁', async () => {
    await page.keyboard.press('Escape');
    await expect(panel(page).getByRole('button', { name: '小紅書口吻' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: '第一人稱輕鬆語氣' })).toBeVisible();
    await shot(page, '6-panel');
    await panel(page).getByRole('button', { name: '管理' }).click();
    await expect(page.getByRole('heading', { name: 'Prompt', level: 1 })).toBeVisible();
  });
});
