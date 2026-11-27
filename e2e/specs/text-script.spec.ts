import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-109 作品文字字體 (on the QC-103 API): 設定 › Agent 與 MCP picks 簡體 or 繁體
 * for the text agents write into works (default 簡體, saved at once); 項目設定
 * can follow the global setting or pick one itself (saved with 儲存). Both
 * say that only new text from agents is converted. QC109_SHOTS=<dir> saves
 * the acceptance shots.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC109_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc109-${name}.png`) });
}

const NOTE = '只影響 Agent 送來的新內容；你自己寫的字和已有作品不會被轉換。';

test('作品文字字體：全域設定與項目覆寫', async ({ desktop }) => {
  const { page, backend } = desktop;
  const c = backend.client;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const kyoto = await c.projects.create({ name: '京都旅行' });
  await page.reload();
  const nav = page.getByRole('navigation', { name: '主導航' });

  await test.step('設定 › Agent 與 MCP：預設簡體，選繁體立即儲存', async () => {
    await nav.getByRole('button', { name: '設定', exact: true }).click();
    await page
      .getByRole('navigation', { name: '設定分類' })
      .getByRole('button', { name: /Agent 與 MCP/ })
      .click();
    const group = page.getByRole('radiogroup', { name: '作品文字字體' });
    await expect(group.getByRole('radio', { name: '簡體' })).toBeChecked();
    await expect(group.getByRole('radio', { name: '繁體' })).not.toBeChecked();
    await expect(page.locator('.ag-script')).toContainText('預設值');
    await expect(page.locator('.ag-script')).toContainText(NOTE);
    await shot(page, '1-settings-default');

    await group.getByRole('radio', { name: '繁體' }).click();
    await expect(group.getByRole('radio', { name: '繁體' })).toBeChecked();
    await expect.poll(async () => (await c.settings.textScript()).script).toBe('zh-Hant');
    expect((await c.settings.textScript()).updated_at).not.toBeNull();
    await expect(page.locator('.ag-script')).not.toContainText('預設值');
    // The choice itself shows what was saved (QC-115).
    await expect(page.locator('[data-toast]').filter({ hasText: '作品文字字體' })).toHaveCount(0);

    // Arrow keys move the choice, as in the other segmented settings.
    await group.getByRole('radio', { name: '繁體' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(group.getByRole('radio', { name: '簡體' })).toBeFocused();
    await expect.poll(async () => (await c.settings.textScript()).script).toBe('zh-Hans');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await c.settings.textScript()).script).toBe('zh-Hant');
    // A quick change of mind while the first save is on its way: the last pick wins.
    // Both saves go out in order, so wait for the second one (a newer updated_at).
    const before = (await c.settings.textScript()).updated_at;
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await expect(group.getByRole('radio', { name: '繁體' })).toBeChecked();
    await expect
      .poll(async () => {
        const now = await c.settings.textScript();
        return now.script === 'zh-Hant' && now.updated_at !== before;
      })
      .toBe(true);
    await shot(page, '2-settings-hant');

    // It is read back from the service, not remembered by the page.
    await page.reload();
    await nav.getByRole('button', { name: '設定', exact: true }).click();
    await expect(
      page.getByRole('radiogroup', { name: '作品文字字體' }).getByRole('radio', { name: '繁體' }),
    ).toBeChecked();
  });

  await test.step('項目設定：跟隨全域（繁體）→ 簡體 → 跟隨全域，儲存才寫入', async () => {
    const open = async () => {
      await page.locator('[data-project-row]').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: '項目設定…' }).click();
      return page.getByRole('dialog', { name: '項目設定 · 京都旅行' });
    };
    let dialog = await open();
    const group = dialog.getByRole('radiogroup', { name: '作品文字字體' });
    await expect(group.getByRole('radio', { name: '跟隨全域（繁體）' })).toBeChecked();
    await expect(dialog).toContainText(NOTE);
    await group.getByRole('radio', { name: '簡體' }).click();
    await shot(page, '3-project-hans');
    // Nothing is written before 儲存.
    expect((await c.projects.get(kyoto.id)).text_script ?? null).toBeNull();
    await dialog.getByRole('button', { name: '儲存' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await c.projects.get(kyoto.id)).text_script).toBe('zh-Hans');

    dialog = await open();
    await expect(
      dialog.getByRole('radiogroup', { name: '作品文字字體' }).getByRole('radio', { name: '簡體' }),
    ).toBeChecked();
    await dialog
      .getByRole('radiogroup', { name: '作品文字字體' })
      .getByRole('radio', { name: '跟隨全域（繁體）' })
      .click();
    await dialog.getByRole('button', { name: '儲存' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await c.projects.get(kyoto.id)).text_script).toBeNull();

    // Saving only the description leaves the project's script as it was.
    await c.projects.patch(kyoto.id, {
      base_revision: (await c.projects.get(kyoto.id)).revision,
      text_script: 'zh-Hant',
    });
    await page.reload();
    dialog = await open();
    await expect(
      dialog.getByRole('radiogroup', { name: '作品文字字體' }).getByRole('radio', { name: '繁體' }),
    ).toBeChecked();
    await dialog.getByRole('textbox', { name: '描述' }).fill('京都七日行');
    await dialog.getByRole('button', { name: '儲存' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await c.projects.get(kyoto.id)).description).toBe('京都七日行');
    expect((await c.projects.get(kyoto.id)).text_script).toBe('zh-Hant');
  });

  await test.step('深色截圖', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await nav.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.getByRole('radiogroup', { name: '作品文字字體' })).toBeVisible();
    await shot(page, '4-settings-dark');
  });
});
