import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-063 側欄開關併進 LOGO: the standalone collapse button is gone; hovering or
 * keyboard-focusing the logo shows the panel icon and a tooltip with ⌃⌘S, a click
 * toggles the sidebar, the rail works the same way, the service dot stays.
 * Set QC063_SHOTS=<dir> to also save screenshots for the acceptance record.
 */

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['QC063_SHOTS'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `qc063-${name}.png`), clip: topLeft });
}
const topLeft = { x: 0, y: 0, width: 360, height: 220 };

// By class: the navigation's own name changes with the language.
const navOf = (page: Page): Locator => page.locator('nav.sb');
const navWidth = (page: Page): Promise<number> =>
  page.evaluate<number>("document.querySelector('nav.sb').getBoundingClientRect().width");

/** The panel icon's opacity (it fades in over 0.12 s) and the tooltip text and opacity. */
const swapOpacity = (page: Page): Promise<string> =>
  page.evaluate<string>("getComputedStyle(document.querySelector('.sb__logo-swap')).opacity");
const tipOpacity = (page: Page): Promise<string> =>
  page.evaluate<string>("getComputedStyle(document.querySelector('.sb__logo'), '::after').opacity");

test('側欄開關在 LOGO 上：懸停換圖示加提示、點擊收合與展開、鍵盤焦點、圖示列、三語與深色', async ({
  desktop,
}) => {
  const { page } = desktop;
  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = navOf(page);
  const logo = nav.getByRole('button', { name: '收起側欄' });
  await expect(logo).toBeVisible();

  await test.step('沒有獨立的開關按鈕；服務狀態點還在', async () => {
    await expect(page.locator('.sb__toggle')).toHaveCount(0);
    await expect(nav.getByRole('button', { name: '收起側欄' })).toHaveCount(1);
    await expect(logo).toHaveAttribute('aria-keyshortcuts', 'Control+Meta+S');
    await expect(logo).toHaveAttribute('data-tip', '收起側欄（⌃⌘S）');
    await expect(nav.locator('.sb__dot')).toBeVisible();
    expect(await swapOpacity(page)).toBe('0');
    await page.mouse.move(700, 500);
  });

  await test.step('懸停：LOGO 換成側欄圖示並出現提示', async () => {
    await logo.hover();
    await expect.poll(() => swapOpacity(page)).toBe('1');
    await expect.poll(() => tipOpacity(page)).toBe('1');
    await shot(page, 'zh-Hant-1-hover');
  });

  await test.step('點擊收起成圖示列，提示與名稱變成展開', async () => {
    await logo.click();
    await expect.poll(() => navWidth(page)).toBe(56);
    const expand = nav.getByRole('button', { name: '展開側欄' });
    await expect(expand).toHaveAttribute('data-tip', '展開側欄（⌃⌘S）');
    await expect(nav.locator('.sb__dot')).toBeVisible();
    await expand.hover();
    await expect.poll(() => swapOpacity(page)).toBe('1');
    await expect.poll(() => tipOpacity(page)).toBe('1');
    await shot(page, 'zh-Hant-2-rail-hover');
    await page.mouse.move(700, 500);
    await expect.poll(() => swapOpacity(page)).toBe('0');
    await expand.click();
    await expect.poll(() => navWidth(page)).toBeGreaterThan(200);
  });

  await test.step('鍵盤焦點也顯示同一個圖示，Enter 切換', async () => {
    await page.mouse.move(700, 500);
    await logo.focus();
    // Focus from a script is not :focus-visible; a key press makes it so.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => swapOpacity(page)).toBe('1');
    await expect.poll(() => tipOpacity(page)).toBe('1');
    await shot(page, 'zh-Hant-3-focus');
    await page.keyboard.press('Enter');
    await expect.poll(() => navWidth(page)).toBe(56);
    await page.keyboard.press('Control+Meta+s');
    await expect.poll(() => navWidth(page)).toBeGreaterThan(200);
  });

  await test.step('窄視窗固定圖示列：LOGO 停用，不換圖示', async () => {
    await page.setViewportSize({ width: 860, height: 800 });
    await expect.poll(() => navWidth(page)).toBe(56);
    const stuck = nav.getByRole('button', { name: '展開側欄' });
    await expect(stuck).toBeDisabled();
    await expect(stuck).toHaveAttribute('data-tip', '視窗較窄時固定為圖示列');
    await stuck.hover({ force: true });
    await expect.poll(() => swapOpacity(page)).toBe('0');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => navWidth(page)).toBeGreaterThan(200);
  });

  await test.step('簡體、English 與深色：名稱、提示與外觀', async () => {
    await page.evaluate("window.creatorhub.setLanguage('zh-Hans')");
    const hans = nav.getByRole('button', { name: '收起侧边栏' });
    await expect(hans).toHaveAttribute('data-tip', '收起侧边栏（⌃⌘S）');
    await hans.hover();
    await expect.poll(() => tipOpacity(page)).toBe('1');
    await shot(page, 'zh-Hans-4-hover');

    await page.evaluate("window.creatorhub.setLanguage('en')");
    const en = nav.getByRole('button', { name: 'Hide sidebar' });
    await expect(en).toHaveAttribute('data-tip', 'Hide sidebar (⌃⌘S)');
    await en.hover();
    await expect.poll(() => tipOpacity(page)).toBe('1');
    await shot(page, 'en-5-hover');

    // The theme follows the system by default; the renderer applies it, not the main process.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(() => page.evaluate<boolean>("matchMedia('(prefers-color-scheme: dark)').matches"))
      .toBe(true);
    await en.hover();
    await expect.poll(() => swapOpacity(page)).toBe('1');
    await shot(page, 'en-6-hover-dark');
    await en.click();
    await expect.poll(() => navWidth(page)).toBe(56);
    await nav.getByRole('button', { name: 'Show sidebar' }).hover();
    await expect.poll(() => tipOpacity(page)).toBe('1');
    await shot(page, 'en-7-rail-hover-dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate("window.creatorhub.setLanguage('zh-Hant')");
  });
});
