import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/**
 * QC-042 介面多語言: switching 設定 → 外觀 → 語言 applies at once, with no
 * restart, to the sidebar, the settings page, the editor and the native menu
 * bar; the choice is saved in the main process's preferences.
 *
 * Set QC042_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

type Lang = 'zh-Hant' | 'zh-Hans' | 'en';

const L: Record<
  Lang,
  {
    card: string;
    library: string;
    settings: string;
    assets: string;
    appearance: string;
    language: string;
    insert: string;
    menu: string[];
  }
> = {
  'zh-Hant': {
    card: '繁體中文',
    library: '全部作品',
    settings: '設定',
    assets: '素材庫',
    appearance: '外觀',
    language: '語言',
    insert: '插入',
    menu: ['qiu-creator', '檔案', '編輯', '顯示方式', '視窗'],
  },
  'zh-Hans': {
    card: '简体中文',
    library: '全部作品',
    settings: '设置',
    assets: '素材库',
    appearance: '外观',
    language: '语言',
    insert: '插入',
    menu: ['qiu-creator', '文件', '编辑', '显示', '窗口'],
  },
  en: {
    card: 'English',
    library: 'All posts',
    settings: 'Settings',
    assets: 'Assets',
    appearance: 'Appearance',
    language: 'Language',
    insert: 'Insert',
    menu: ['qiu-creator', 'File', 'Edit', 'View', 'Window'],
  },
};

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC042_SHOTS'];
  if (dir === undefined || dir === '') return;
  await page.screenshot({ path: path.join(dir, `qc042-${name}.png`) });
}

async function menuLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? []);
}

function nav(page: Page, lang: Lang) {
  return page.getByRole('navigation', {
    name: lang === 'en' ? 'Main navigation' : /主導航|主导航/,
  });
}

test('語言：三種語言即時切換，側欄、設定頁、編輯器與原生選單一起變', async ({ desktop }) => {
  const { page, app, profile, backend } = desktop;
  const c = backend.client;
  await c.works.create({
    title: '京都紅葉季七日慢遊',
    markdown: '# 京都紅葉季七日慢遊\n\n清晨的嵐山竹林。\n',
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });

  const pickLanguage = async (from: Lang, to: Lang) => {
    await nav(page, from).getByRole('button', { name: L[from].settings, exact: true }).click();
    const group = page.getByRole('radiogroup', { name: L[from].language, exact: true });
    await group.getByRole('radio', { name: new RegExp(L[to].card) }).click();
    // The page switched in place: the group now carries the new language's name.
    const after = page.getByRole('radiogroup', { name: L[to].language, exact: true });
    await expect(after.getByRole('radio', { name: new RegExp(L[to].card) })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  };

  const checkAndShoot = async (lang: Lang) => {
    const n = nav(page, lang);
    // Sidebar and <html lang> switched in place.
    await expect(n.getByRole('button', { name: L[lang].library, exact: true })).toBeVisible();
    await expect(n.getByRole('button', { name: L[lang].assets, exact: true })).toBeVisible();
    expect(await page.evaluate('document.documentElement.lang')).toBe(lang);
    // The native menu bar was rebuilt in the same language.
    await expect.poll(() => menuLabels(app)).toEqual(L[lang].menu);

    // 1. Sidebar and the library.
    await n.getByRole('button', { name: L[lang].library, exact: true }).click();
    await expect(page.getByRole('button', { name: /京都紅葉季七日慢遊/ })).toBeVisible();
    await shot(page, `${lang}-1-library`);

    // 2. 設定 → 外觀 with the language cards.
    await n.getByRole('button', { name: L[lang].settings, exact: true }).click();
    await expect(page.getByRole('heading', { name: L[lang].settings, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: L[lang].appearance, level: 1 })).toBeVisible();
    await expect(
      page.getByRole('radiogroup', { name: L[lang].language, exact: true }),
    ).toBeVisible();
    await shot(page, `${lang}-2-settings`);

    // 3. The editor with the insert menu open.
    await n.getByRole('button', { name: L[lang].library, exact: true }).click();
    await page.getByRole('button', { name: /京都紅葉季七日慢遊/ }).click();
    await page.getByRole('button', { name: L[lang].insert, exact: true }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await shot(page, `${lang}-3-editor-insert`);
    await page.keyboard.press('Escape');
  };

  await test.step('繁體中文（既有安裝升級後的語言）', async () => {
    await checkAndShoot('zh-Hant');
  });

  await test.step('切到简体中文：不重開，原地切換', async () => {
    await pickLanguage('zh-Hant', 'zh-Hans');
    await checkAndShoot('zh-Hans');
  });

  await test.step('切到 English，並記在偏好裡', async () => {
    await pickLanguage('zh-Hans', 'en');
    await checkAndShoot('en');
    const prefs = JSON.parse(readFileSync(path.join(profile, 'preferences.json'), 'utf8')) as {
      language?: string;
    };
    expect(prefs.language).toBe('en');
  });

  await test.step('English 深色截圖', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await nav(page, 'en').getByRole('button', { name: 'All posts', exact: true }).click();
    await shot(page, 'en-4-library-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await test.step('跟隨系統：用 macOS 偏好語言的第一順位', async () => {
    await pickLanguage('en', 'zh-Hant');
    const group = page.getByRole('radiogroup', { name: '語言', exact: true });
    await group.getByRole('radio').first().click();
    const expected = await app.evaluate(({ app: a }) => a.getPreferredSystemLanguages());
    const first = (expected[0] ?? 'en').toLowerCase();
    const want: Lang = first.startsWith('zh')
      ? /hant|tw|hk|mo/.test(first)
        ? 'zh-Hant'
        : 'zh-Hans'
      : 'en';
    await expect.poll(() => page.evaluate('document.documentElement.lang')).toBe(want);
    await expect.poll(() => menuLabels(app)).toEqual(L[want].menu);
    const prefs = JSON.parse(readFileSync(path.join(profile, 'preferences.json'), 'utf8')) as {
      language?: string;
    };
    expect(prefs.language).toBe('system');
  });
});
