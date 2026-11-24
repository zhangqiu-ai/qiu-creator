import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The work editor's right sidebar (QC-085): 預覽, AI, 歷史, 素材 are its
 * tabs. Specs that used the old 預覽 / 歷史 buttons bring a tab forward here.
 */

/** The visible work tab's sidebar. */
export function editorSide(page: Page): Locator {
  return page.locator('.tab-pane:not([hidden]) section.side');
}

/** The sidebar's panel area of the visible work tab (all its tabs' content). */
export function sidePane(page: Page): Locator {
  return page.locator('.tab-pane:not([hidden]) .side__body');
}

/**
 * Bring a sidebar tab forward, opening the sidebar when it is collapsed.
 * `name` is the tab's label in the current language (預覽, AI, 歷史, 素材, …).
 */
export async function showSideTab(page: Page, name: string): Promise<void> {
  const side = editorSide(page);
  await expect(side).toBeVisible();
  const label = new RegExp(`^${name}`);
  const tab = side.getByRole('tab', { name: label });
  if (!(await tab.isVisible())) {
    await side.locator('.side__rail').getByRole('button', { name: label }).click();
  }
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Hide the sidebar (its collapse button); the editor keeps the room. */
export async function collapseSide(page: Page): Promise<void> {
  const side = editorSide(page);
  const button = side.locator('.side__collapse');
  if (await button.isVisible()) await button.click();
  await expect(side.locator('.side__panel')).toBeHidden();
}
