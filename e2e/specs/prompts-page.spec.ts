import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { ok } from '../../services/mac-server/test/fake-ai.js';
import { test } from '../fixtures/desktop.js';

/*
 * QC-075 Prompt 庫 (approved prototype PT-20261122-003): built-ins are
 * read-only and can be copied; a custom prompt is written, saved and deleted
 * here; search marks the hits; AI drafts and rewrites a prompt as a candidate
 * that only 保留 writes; custom prompts export to JSON and import back, a
 * same name becoming a copy; with no custom prompts the editor is an empty
 * state with two actions.
 * Set QC075_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC075_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc075-${name}.png`) });
}

const nav = (page: Page): Locator => page.getByRole('navigation', { name: '主導航' });
const list = (page: Page): Locator => page.getByRole('region', { name: '指令清單' });
const editor = (page: Page): Locator => page.getByRole('region', { name: '指令編輯' });
const name = (page: Page): Locator => editor(page).getByRole('textbox', { name: '名稱' });
const content = (page: Page): Locator => editor(page).getByRole('textbox', { name: '內容' });

/** A prompt draft the fake AI replies with (the service reads it as JSON). */
const draft = (prompt: { name: string; scene: string; content: string }) =>
  ok('anthropic', JSON.stringify(prompt));

/*
 * The export hands the file to the download the browser starts from an anchor
 * click; here the blob and the file name are kept instead, so no save dialog
 * opens while the specs run.
 */
const CATCH_DOWNLOAD = `(() => {
  window.__qcFiles = [];
  window.__qcBlobs = [];
  const create = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    window.__qcBlobs.push(object);
    return create.call(URL, object);
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      window.__qcFiles.push(this.download);
      return;
    }
    return click.call(this);
  };
})()`;

const LAST_DOWNLOAD = `(async () => {
  const blob = window.__qcBlobs[window.__qcBlobs.length - 1];
  return { name: window.__qcFiles[window.__qcFiles.length - 1], text: await blob.text() };
})()`;

async function openPrompts(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: 'Prompt', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prompt' })).toBeVisible();
  await expect(list(page).getByRole('button', { name: /潤色/ })).toBeVisible();
}

async function setUp(desktop: Parameters<Parameters<typeof test>[2]>[0]['desktop']) {
  const { page, backend, upstream } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const c = backend.client;
  await c.ai.setKey('anthropic', 'fake-anthropic-key');
  await c.ai.consent('anthropic', backend.ai.providerStatus('anthropic').notice.version);
  await page.reload();
  await openPrompts(page);
  return { page, c, upstream };
}

test('內建唯讀可複製、自訂指令的建立與儲存、搜尋高亮、刪除確認與空狀態', async ({ desktop }) => {
  test.setTimeout(90_000);
  const { page, c } = await setUp(desktop);

  await test.step('沒有自訂指令：空狀態只有兩個動作', async () => {
    await expect(page.getByText('6 個內建 · 0 個自訂')).toBeVisible();
    const empty = editor(page);
    await expect(empty.getByText('還沒有自訂指令')).toBeVisible();
    await expect(empty.getByRole('button', { name: '新建指令' })).toBeVisible();
    await expect(empty.getByRole('button', { name: '用 AI 生成' })).toBeVisible();
    await shot(page, '1-empty');
  });

  await test.step('內建指令唯讀，「複製成自訂」後才能改', async () => {
    await list(page).getByRole('button', { name: /潤色/ }).click();
    await expect(name(page)).toHaveValue('潤色');
    await expect(name(page)).toHaveJSProperty('readOnly', true);
    await expect(content(page)).toHaveJSProperty('readOnly', true);
    await expect(editor(page).getByText('內建', { exact: true })).toBeVisible();
    // Read-only: no AI suggestion box and no delete on a built-in.
    await expect(editor(page).getByRole('textbox', { name: '請 AI 改寫這條指令' })).toHaveCount(0);
    await expect(editor(page).getByRole('button', { name: '刪除' })).toHaveCount(0);
    await expect(editor(page).getByRole('button', { name: '插入 {選取}' })).toBeDisabled();
    await shot(page, '2-builtin');

    await editor(page).getByRole('button', { name: '複製成自訂' }).click();
    await expect(page.getByText('已複製成自訂指令')).toBeVisible();
    await expect(name(page)).toHaveValue('潤色（副本）');
    await expect(name(page)).toHaveJSProperty('readOnly', false);
    await expect(page.getByText('6 個內建 · 1 個自訂')).toBeVisible();
    expect((await c.ai.prompts.list()).items.filter((p) => !p.builtin)).toHaveLength(1);
  });

  await test.step('新建指令：名稱、變數膠囊插入、自動儲存', async () => {
    // The page header's 新建指令 (the empty state's is the same wording).
    await page
      .getByRole('main', { name: 'Prompt' })
      .getByRole('button', { name: '新建指令' })
      .first()
      .click();
    await expect(name(page)).toHaveValue('');
    await name(page).fill('小紅書口吻');
    await content(page).click();
    await page.keyboard.type('把 ');
    await editor(page).getByRole('button', { name: '插入 {選取}' }).click();
    await page.keyboard.type(' 改寫成小紅書口吻。');
    await expect(content(page)).toHaveValue('把 {選取} 改寫成小紅書口吻。');
    await expect(editor(page).getByText('已儲存')).toBeVisible();
    await expect(list(page).getByRole('button', { name: /小紅書口吻/ })).toBeVisible();
    await expect(page.getByText('6 個內建 · 2 個自訂')).toBeVisible();
    const saved = (await c.ai.prompts.list()).items.find((p) => p.name === '小紅書口吻');
    expect(saved?.content).toBe('把 {選取} 改寫成小紅書口吻。');
    await shot(page, '3-custom');
  });

  await test.step('分組與用在：改了也自動儲存', async () => {
    // 分組 takes free text with the groups in use as suggestions (a combobox).
    await editor(page).getByLabel('分組').fill('小紅書');
    await editor(page)
      .getByRole('group', { name: '用在' })
      .getByRole('button', { name: '全文', exact: true })
      .click();
    await expect(editor(page).getByText('已儲存')).toBeVisible();
    await expect
      .poll(async () => {
        const saved = (await c.ai.prompts.list()).items.find((p) => p.name === '小紅書口吻');
        return [saved?.group, saved?.scene];
      })
      .toEqual(['小紅書', 'full']);
    await expect(list(page).getByText('小紅書', { exact: true })).toBeVisible();
  });

  await test.step('排序：⌥↑ 把指令往前移，順序存回服務', async () => {
    await list(page)
      .getByRole('button', { name: /小紅書口吻/ })
      .click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect
      .poll(async () =>
        (await c.ai.prompts.list()).items.filter((p) => !p.builtin).map((p) => p.name),
      )
      .toEqual(['小紅書口吻', '潤色（副本）']);
  });

  await test.step('搜尋：命中的字標出來', async () => {
    await list(page).getByRole('searchbox', { name: '搜尋指令' }).fill('口吻');
    await expect(list(page).locator('mark.hit')).toHaveCount(2); // the name and the content line
    await expect(list(page).locator('mark.hit').first()).toHaveText('口吻');
    await expect(list(page).getByRole('button', { name: /潤色（副本）/ })).toHaveCount(0);
    await shot(page, '4-search');
    await list(page).getByRole('searchbox', { name: '搜尋指令' }).fill('');
    await expect(list(page).getByRole('button', { name: /潤色（副本）/ })).toBeVisible();
  });

  await test.step('刪除：先確認，之後清單不再有它', async () => {
    await list(page)
      .getByRole('button', { name: /潤色（副本）/ })
      .click();
    await editor(page).getByRole('button', { name: '刪除' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('刪除「潤色（副本）」？')).toBeVisible();
    await shot(page, '5-delete');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(list(page).getByRole('button', { name: /潤色（副本）/ })).toBeVisible();

    await editor(page).getByRole('button', { name: '刪除' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '刪除' }).click();
    await expect(page.getByText('已刪除「潤色（副本）」')).toBeVisible();
    await expect(list(page).getByRole('button', { name: /潤色（副本）/ })).toHaveCount(0);
    await expect(page.getByText('6 個內建 · 1 個自訂')).toBeVisible();
  });
});

test('AI 建議：候選以 diff 出現，捨棄不寫入、保留才寫入', async ({ desktop }) => {
  test.setTimeout(90_000);
  const { page, c, upstream } = await setUp(desktop);

  await test.step('依描述生成新指令：候選是 diff，捨棄什麼都不寫', async () => {
    await editor(page).getByRole('button', { name: '用 AI 生成' }).click();
    upstream.script(
      'anthropic',
      draft({
        name: '小紅書口吻',
        scene: 'selection',
        content: '把 {選取} 改寫成小紅書口吻：短句、每 2–3 句分段。',
      }),
    );
    await editor(page).getByRole('textbox', { name: '描述你要的指令' }).fill('改成小紅書口吻');
    await editor(page).getByRole('button', { name: '生成' }).click();
    const candidate = page.getByRole('group', { name: 'AI 候選' }).first();
    await expect(candidate).toBeVisible();
    await expect(candidate.locator('ins.ins')).toContainText('小紅書口吻');
    await expect(editor(page).getByText('有候選未保留')).toBeVisible();
    await shot(page, '6-candidate-new');

    await editor(page).getByRole('button', { name: /捨棄/ }).click();
    await expect(page.getByRole('group', { name: 'AI 候選' })).toHaveCount(0);
    await expect(content(page)).toHaveValue('');
    expect((await c.ai.prompts.list()).items.filter((p) => !p.builtin)).toHaveLength(0);
  });

  await test.step('重新生成後保留：才寫成自訂指令', async () => {
    upstream.script(
      'anthropic',
      draft({
        name: '小紅書口吻',
        scene: 'selection',
        content: '把 {選取} 改寫成小紅書口吻：短句、每 2–3 句分段。',
      }),
    );
    await editor(page).getByRole('button', { name: '生成' }).click();
    await expect(page.getByRole('group', { name: 'AI 候選' }).first()).toBeVisible();
    await editor(page).getByRole('button', { name: /保留/ }).click();
    await expect(page.getByText('已保留，寫入指令')).toBeVisible();
    await expect(name(page)).toHaveValue('小紅書口吻');
    await expect(content(page)).toHaveValue('把 {選取} 改寫成小紅書口吻：短句、每 2–3 句分段。');
    await expect
      .poll(async () => (await c.ai.prompts.list()).items.filter((p) => !p.builtin).length)
      .toBe(1);
  });

  await test.step('請 AI 改寫這條指令：diff 有刪除也有新增，保留後寫回', async () => {
    upstream.script(
      'anthropic',
      draft({
        name: '小紅書口吻',
        scene: 'selection',
        content: '把 {選取} 改寫成小紅書口吻：短句、每 2–3 句分段。最後問讀者一句。',
      }),
    );
    await editor(page)
      .getByRole('textbox', { name: '請 AI 改寫這條指令' })
      .fill('最後加一句互動提問');
    await editor(page).getByRole('button', { name: '改寫' }).click();
    const candidate = page.getByRole('group', { name: 'AI 候選' }).first();
    await expect(candidate).toBeVisible();
    await expect(candidate.locator('ins.ins')).toContainText('最後問讀者一句。');
    await shot(page, '7-candidate-rewrite');
    await editor(page).getByRole('button', { name: /保留/ }).click();
    await expect(content(page)).toHaveValue(
      '把 {選取} 改寫成小紅書口吻：短句、每 2–3 句分段。最後問讀者一句。',
    );
    await expect
      .poll(async () => {
        const saved = (await c.ai.prompts.list()).items.find((p) => p.name === '小紅書口吻');
        return [saved?.content, saved?.revision];
      })
      .toEqual(['把 {選取} 改寫成小紅書口吻：短句、每 2–3 句分段。最後問讀者一句。', 2]);
  });
});

test('匯出與匯入：同名另存副本，不覆蓋', async ({ desktop }) => {
  test.setTimeout(90_000);
  const { page, c } = await setUp(desktop);
  await c.ai.prompts.create({
    name: '小紅書口吻',
    content: '把 {選取} 改寫成小紅書口吻。',
    group: '小紅書',
  });
  await page.reload();
  await openPrompts(page);
  await page.evaluate(CATCH_DOWNLOAD);

  await test.step('匯出全部自訂指令：一個 JSON 檔', async () => {
    await page.getByRole('button', { name: '更多操作' }).click();
    await shot(page, '8-io-menu');
    await page.getByRole('menuitem', { name: '匯出全部自訂指令' }).click();
    await expect(page.getByText('已匯出 1 條指令')).toBeVisible();
    const file = await page.evaluate<{ name: string; text: string }>(LAST_DOWNLOAD);
    expect(file.name).toMatch(/^prompts-\d{4}-\d{2}-\d{2}\.json$/);
    const parsed = JSON.parse(file.text) as {
      version: number;
      prompts: { name: string; content: string; group?: string }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.prompts).toEqual([
      expect.objectContaining({
        name: '小紅書口吻',
        content: '把 {選取} 改寫成小紅書口吻。',
        group: '小紅書',
      }),
    ]);
    test.info().annotations.push({ type: 'export', description: file.name });

    // Import the file back: the file picker is the system's, so the chosen file
    // is handed to the same hidden input the menu item opens.
    await page.locator('input[type=file]').setInputFiles({
      name: file.name,
      mimeType: 'application/json',
      buffer: Buffer.from(file.text, 'utf8'),
    });
    await expect(page.getByText('已匯入 1 條指令，1 條同名另存副本')).toBeVisible();
    await expect(list(page).getByRole('button', { name: /小紅書口吻（副本）/ })).toBeVisible();
    const items = (await c.ai.prompts.list()).items.filter((p) => !p.builtin);
    expect(items.map((p) => p.name)).toEqual(['小紅書口吻', '小紅書口吻（副本）']);
    // The prompt that was already there is untouched.
    expect(items[0]?.revision).toBe(1);
    await shot(page, '9-imported');
  });
});

test('Prompt 頁：淺色、深色與 English 都排得下', async ({ desktop }) => {
  test.setTimeout(90_000);
  const { page, c } = await setUp(desktop);
  await c.ai.prompts.create({
    name: '小紅書口吻',
    content: '把 {選取} 改寫成小紅書口吻：短句、每 2–3 句分段。使用 {語言}。',
    group: '小紅書',
  });
  await c.ai.prompts.create({
    name: '公眾號開頭鉤子',
    content: '依 {全文} 寫三個公眾號開頭段落。使用 {語言}。',
    group: '公眾號',
    scene: 'full',
  });
  await page.reload();
  await openPrompts(page);
  await expect(page.getByText('6 個內建 · 2 個自訂')).toBeVisible();
  await shot(page, '10-light');

  const openSettings = async () => {
    await nav(page)
      .getByRole('button', { name: /設定|Settings/ })
      .click();
  };

  await test.step('深色', async () => {
    await openSettings();
    await page
      .getByRole('radiogroup', { name: '主題' })
      .getByRole('radio', { name: '深色' })
      .click();
    await expect
      .poll(() => page.evaluate<string | null>('document.documentElement.dataset.theme ?? null'))
      .toBe('dark');
    await openPrompts(page);
    await list(page)
      .getByRole('button', { name: /小紅書口吻/ })
      .click();
    await expect(content(page)).toHaveValue(/小紅書口吻/);
    await shot(page, '11-dark');
  });

  await test.step('English', async () => {
    await openSettings();
    await page
      .getByRole('radiogroup', { name: '語言' })
      .getByRole('radio', { name: 'English' })
      .click();
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Prompts' }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Prompts', exact: true })
      .click();
    await expect(page.getByText('6 built-in · 2 custom')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Prompts' })).toBeVisible();
    await page
      .getByRole('region', { name: 'Prompts' })
      .getByRole('button', { name: /小紅書口吻/ })
      .click();
    await expect(page.getByRole('region', { name: 'Prompt editor' })).toBeVisible();
    await shot(page, '12-english-dark');
  });
});
