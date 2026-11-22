import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-038 設定 v2 (PT-20261119-001 「v2 · 設定」): category list with in-page
 * anchors, theme cards that apply at once and are remembered, backups
 * showing 3 before 「全部 N 份」.
 * Set QC038_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC038_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc038-${name}.png`) });
}

// Page-side code as strings: the e2e project has no DOM types.
const pinnedTheme = (page: Page) =>
  page.evaluate<string | null>('document.documentElement.dataset.theme ?? null');
const pageBackground = (page: Page) =>
  page.evaluate<string>('getComputedStyle(document.body).backgroundColor');
const LIGHT_BG = 'rgb(246, 245, 241)';
const DARK_BG = 'rgb(22, 22, 21)';

test('設定：分類導覽、主題即時套用並記住、備份預設 3 份', async ({ desktop }) => {
  const { page, backend } = desktop;
  for (let i = 0; i < 5; i += 1) await backend.client.backups.create();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });

  const openSettings = async () => {
    await page
      .getByRole('navigation', { name: '主導航' })
      .getByRole('button', { name: '設定', exact: true })
      .click();
    await expect(page.getByRole('radiogroup', { name: '主題' })).toBeVisible();
  };
  await openSettings();
  const cats = page.getByRole('navigation', { name: '設定分類' });
  const themes = page.getByRole('radiogroup', { name: '主題' });

  await test.step('六個分類，預設跟隨系統', async () => {
    await expect(cats.getByRole('button')).toHaveText([
      '外觀',
      '本機服務',
      '備份與還原',
      'AI 服務',
      '資料夾',
      '關於',
    ]);
    await expect(cats.getByRole('button', { name: '外觀' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(cats.getByRole('img', { name: '服務正常' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: '主導航' }).getByRole('button', { name: '一切正常' }),
    ).toBeVisible();
    await expect(themes.getByRole('radio', { name: /跟隨系統/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await pinnedTheme(page)).toBeNull();
    expect(await pageBackground(page)).toBe(LIGHT_BG);
    await shot(page, '01-settings-light');
  });

  await test.step('選深色：整頁立即變深，重新開啟後仍是深色', async () => {
    await themes.getByRole('radio', { name: '深色' }).click();
    expect(await pinnedTheme(page)).toBe('dark');
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
    await shot(page, '02-settings-dark');
    await page.reload();
    await openSettings();
    await expect(themes.getByRole('radio', { name: '深色' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await pinnedTheme(page)).toBe('dark');
    expect(await pageBackground(page)).toBe(DARK_BG);
  });

  await test.step('方向鍵切換主題；跟隨系統顯示目前的外觀', async () => {
    await themes.getByRole('radio', { name: '深色' }).focus();
    await page.keyboard.press('ArrowRight');
    const system = themes.getByRole('radio', { name: /跟隨系統/ });
    await expect(system).toHaveAttribute('aria-checked', 'true');
    await expect(system).toBeFocused();
    expect(await pinnedTheme(page)).toBeNull();
    await expect(system).toContainText(/目前(淺色|深色)/);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(themes.getByRole('radio', { name: '淺色' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect.poll(() => pageBackground(page)).toBe(LIGHT_BG);
  });

  await test.step('分類各自一頁：切換只換右側、焦點到頁標題、分類欄不動（QC-057）', async () => {
    await cats.getByRole('button', { name: '備份與還原' }).click();
    const backup = page.getByRole('heading', { level: 1, name: '備份與還原' });
    await expect(backup).toBeFocused();
    await expect(cats.getByRole('button', { name: '備份與還原' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(themes).toHaveCount(0);
    const navBox = await cats.boundingBox();
    expect(navBox?.y ?? -1).toBeGreaterThan(0);
    await cats.getByRole('button', { name: '關於' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '關於' })).toBeFocused();
    expect((await cats.boundingBox())?.y).toBe(navBox?.y);
    await cats.getByRole('button', { name: '外觀' }).click();
    await expect(themes).toBeVisible();
  });

  await test.step('備份清單預設 3 份，可展開與收起', async () => {
    await cats.getByRole('button', { name: '備份與還原' }).click();
    const list = page.getByRole('list', { name: '最近備份' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await page.getByRole('button', { name: '全部 5 份' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(5);
    await shot(page, '03-backups-expanded-light');
    await page.getByRole('button', { name: '收起', exact: true }).click();
    await expect(list.getByRole('listitem')).toHaveCount(3);
  });

  await test.step('深色與窄視窗截圖', async () => {
    await cats.getByRole('button', { name: '外觀' }).click();
    await themes.getByRole('radio', { name: '深色' }).click();
    await cats.getByRole('button', { name: '備份與還原' }).click();
    await shot(page, '04-backups-dark');
    await cats.getByRole('button', { name: 'AI 服務' }).click();
    await shot(page, '05-ai-dark');
    await page.setViewportSize({ width: 900, height: 760 });
    await cats.getByRole('button', { name: '外觀' }).click();
    await shot(page, '06-narrow-dark');
    await themes.getByRole('radio', { name: '淺色' }).click();
    await shot(page, '07-narrow-light');
  });

  await test.step('服務停止時分類上的狀態點變紅', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await backend.close();
    await cats.getByRole('button', { name: '本機服務' }).click();
    await page.getByRole('button', { name: '重新檢查' }).click();
    await expect(cats.getByRole('img', { name: '服務異常' })).toBeVisible();
    // One source: the sidebar dot says the same thing at the same time.
    await expect(
      page
        .getByRole('navigation', { name: '主導航' })
        .getByRole('button', { name: '本機服務未回應' }),
    ).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '未回應' })).toBeVisible();
    await shot(page, '08-service-down-light');
  });
});
