import { expect } from '@playwright/test';
import { test } from '../fixtures/desktop.js';

/*
 * QC-060: an e2e run stays in the background. The App has no Dock icon, its window is
 * visible but never took focus, and the folder picker answers without a native dialog.
 */
test('e2e 在背景執行：沒有 Dock 圖示、視窗不搶焦點、不跳原生對話框', async ({ desktop }) => {
  const { app, page } = desktop;
  await expect(page.getByRole('navigation', { name: '主導航' })).toBeVisible();
  const state = await app.evaluate(({ app: electron, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {
      dockVisible: electron.dock?.isVisible() ?? false,
      windowVisible: win?.isVisible() ?? false,
      windowFocused: win?.isFocused() ?? true,
    };
  });
  expect(state).toEqual({ dockVisible: false, windowVisible: true, windowFocused: false });
  // The picker would block on a native dialog; here it answers at once with "nothing picked".
  expect(await page.evaluate('window.creatorhub.pickFolder()')).toBeNull();
});
